import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { configureService } from '@turnos/common';
import { BookingEvent, BookingEventType, InternalBookingDetail, InternalMembership, TOPICS } from '@turnos/contracts';
import { envelope, KafkaService } from '@turnos/kafka';
import { Infra, startInfra, uuid, waitFor } from '@turnos/testing';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail.service';
import { NotificationsService } from '../src/notifications.service';
import { PrismaService } from '../src/prisma.service';

/** Hace de booking-service y auth-service: responde sus endpoints internos desde memoria. */
const bookings = new Map<string, InternalBookingDetail>();
const memberships = new Map<string, InternalMembership[]>();
let stub: Server;

let app: INestApplication;
let infra: Infra;
let prisma: PrismaService;
let mail: MailService;
let notifications: NotificationsService;
let url: string;

beforeAll(async () => {
  stub = createServer((req, res) => {
    const b = req.url?.match(/^\/internal\/bookings\/(.+)$/);
    const m = req.url?.match(/^\/internal\/users\/(.+)\/memberships$/);
    const body = b ? bookings.get(b[1]) : m ? (memberships.get(m[1]) ?? []) : undefined;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { message: 'no' }));
  });
  await new Promise<void>((r) => stub.listen(0, r));
  const stubUrl = `http://localhost:${(stub.address() as AddressInfo).port}`;
  process.env.BOOKING_URL = stubUrl;
  process.env.AUTH_URL = stubUrl;

  infra = await startInfra({ serviceDir: join(__dirname, '..'), postgres: true, redis: true, kafka: true });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureService(moduleRef.createNestApplication());
  await app.listen(0);
  url = await app.getUrl();
  prisma = app.get(PrismaService);
  mail = app.get(MailService);
  notifications = app.get(NotificationsService);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await infra?.stop();
  stub?.close();
});

function fakeBooking(daysAhead: number, overrides: Partial<InternalBookingDetail> = {}): InternalBookingDetail {
  const id = uuid();
  const start = new Date(Date.now() + daysAhead * 86_400_000);
  start.setUTCSeconds(0, 0);
  const b: InternalBookingDetail = {
    id,
    status: 'CONFIRMED',
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    cancelToken: `tok-${id}`,
    business: { id: uuid(), slug: 'barberia', name: 'Barbería', address: 'Calle 1', timezone: 'America/Argentina/Cordoba', cancellationHours: 12 },
    service: { name: 'Corte' },
    professional: { displayName: 'Lucía' },
    client: { id: uuid(), email: `${id}@test.dev`, fullName: 'Ana Pérez' },
    ...overrides,
  };
  bookings.set(id, b);
  return b;
}

const eventFor = (b: InternalBookingDetail, type: BookingEventType, extra: Partial<BookingEvent['payload']> = {}): BookingEvent =>
  envelope(type, b.business.id, {
    bookingId: b.id,
    professionalId: uuid(),
    clientId: b.client.id,
    start: b.start,
    end: b.end,
    status: b.status,
    ...extra,
  });

const count = (bookingId: string, type: string) => prisma.notification.count({ where: { bookingId, type: type as never } });

describe('emails y recordatorios', () => {
  it('booking.confirmed: email con link de cancelación y recordatorio 24 h antes', async () => {
    const b = fakeBooking(3);
    await notifications.handle(eventFor(b, 'booking.confirmed'));

    expect(await count(b.id, 'BOOKING_CONFIRMED')).toBe(1);
    const email = mail.outbox.find((m) => m.to === b.client.email)!;
    expect(email.subject).toBe('Turno confirmado en Barbería');
    expect(email.html).toContain(`cancelar?token=tok-${b.id}`);
    expect(email.html).toContain('Ana');

    const job = (await notifications.reminders.getJob(b.id))!;
    const fireAt = job.timestamp + (job.opts.delay ?? 0);
    expect(Math.abs(fireAt - (new Date(b.start).getTime() - 24 * 3_600_000))).toBeLessThan(5_000);
  });

  it('un evento repetido manda un solo email', async () => {
    const b = fakeBooking(3);
    const event = eventFor(b, 'booking.confirmed');
    await notifications.handle(event);
    await notifications.handle(event);
    expect(await count(b.id, 'BOOKING_CONFIRMED')).toBe(1);
  });

  it('cancelado: borra el recordatorio y avisa', async () => {
    const b = fakeBooking(3);
    await notifications.handle(eventFor(b, 'booking.confirmed'));
    await notifications.handle(eventFor(b, 'booking.cancelled', { cancelledBy: 'BUSINESS' }));
    expect(await notifications.reminders.getJob(b.id)).toBeUndefined();
    expect(mail.outbox.find((m) => m.to === b.client.email && m.subject.startsWith('Turno cancelado'))?.html).toContain('Barbería canceló');
  });

  it('reprogramado: reemplaza el recordatorio', async () => {
    const b = fakeBooking(3);
    await notifications.handle(eventFor(b, 'booking.confirmed'));
    const moved = { ...b, start: new Date(new Date(b.start).getTime() + 86_400_000).toISOString() };
    bookings.set(b.id, moved);
    await notifications.handle(eventFor(moved, 'booking.rescheduled'));
    expect((await notifications.reminders.getJob(b.id))!.data.start).toBe(moved.start);
    expect(await count(b.id, 'BOOKING_RESCHEDULED')).toBe(1);
  });

  it('el worker manda el recordatorio y lo saltea si el turno cambió', async () => {
    const b = fakeBooking(3);
    await notifications.reminders.add('send-reminder', { bookingId: b.id, start: b.start }, { jobId: b.id });
    await waitFor(async () => (await count(b.id, 'BOOKING_REMINDER')) === 1);

    const stale = await notifications.reminders.add('send-reminder', { bookingId: b.id, start: new Date(0).toISOString() }, { jobId: `${b.id}-x` });
    await waitFor(async () => (await notifications.reminders.getJob(stale.id!)) === undefined || (await stale.getState()) === 'completed');
    expect(await count(b.id, 'BOOKING_REMINDER')).toBe(1);
  });

  it('consume los eventos desde Kafka', async () => {
    const b = fakeBooking(2);
    const event = eventFor(b, 'booking.confirmed');
    await app.get(KafkaService).send(TOPICS.booking, [{ key: b.id, value: JSON.stringify(event) }]);
    await waitFor(async () => (await count(b.id, 'BOOKING_CONFIRMED')) === 1);
  });
});

describe('agenda en vivo', () => {
  const connect = (token: string, businessId: string) =>
    new Promise<{ socket: Socket; ok: boolean }>((resolve) => {
      const socket = io(url, { auth: { token, businessId }, transports: ['websocket'], reconnection: false });
      socket.on('ready', () => resolve({ socket, ok: true }));
      socket.on('unauthorized', () => resolve({ socket, ok: false }));
    });

  it('un miembro del negocio recibe los cambios; un extraño es rechazado', async () => {
    const b = fakeBooking(2);
    const ownerId = uuid();
    memberships.set(ownerId, [{ businessId: b.business.id, role: 'OWNER' }]);
    const jwt = app.get(JwtService);

    const stranger = await connect(await jwt.signAsync({ sub: uuid(), email: 'x@test.dev' }), b.business.id);
    expect(stranger.ok).toBe(false);
    stranger.socket.close();

    const { socket, ok } = await connect(await jwt.signAsync({ sub: ownerId, email: 'o@test.dev' }), b.business.id);
    expect(ok).toBe(true);
    const received = new Promise<{ type: string; bookingId: string }>((r) => socket.on('agenda', r));
    await app.get(KafkaService).send(TOPICS.booking, [{ key: b.id, value: JSON.stringify(eventFor(b, 'booking.confirmed')) }]);
    expect(await received).toMatchObject({ type: 'booking.confirmed', bookingId: b.id });
    socket.close();
  });
});
