import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { io, Socket } from 'socket.io-client';
import { BookingService } from '../src/booking/booking.service';
import { MailService } from '../src/notifications/mail.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { createBusiness, registerUser, startApp, stopApp, TestContext } from './setup';

let ctx: TestContext;
let mail: MailService;
let notifications: NotificationsService;

beforeAll(async () => {
  ctx = await startApp();
  mail = ctx.app.get(MailService);
  notifications = ctx.app.get(NotificationsService);
}, 180_000);

afterAll(() => stopApp(ctx));

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const dateIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });

async function slotsOn(slug: string, serviceId: string, date: string) {
  const res = await ctx.http().get(`/api/v1/public/businesses/${slug}/availability`).query({ serviceId, date }).expect(200);
  return res.body.slots as { start: string }[];
}

async function bookIn(days: number) {
  const biz = await createBusiness(ctx);
  const [slot] = await slotsOn(biz.slug, biz.serviceId, dateIn(days));
  const client = await registerUser(ctx, 'Ana Pérez');
  const res = await ctx
    .http()
    .post('/api/v1/bookings')
    .auth(client.token, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({ businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start })
    .expect(201);
  return { biz, client, booking: res.body as { id: string; start: string } };
}

describe('emails y recordatorios', () => {
  it('al confirmar: email con link de cancelación y recordatorio programado 24 h antes', async () => {
    const { booking } = await bookIn(3);

    const sent = await waitFor(() =>
      ctx.prisma.notification.findFirst({ where: { bookingId: booking.id, type: 'BOOKING_CONFIRMED', status: 'SENT' } }),
    );
    expect(sent).toBeTruthy();
    const email = mail.outbox.find((m) => m.subject.startsWith('Turno confirmado') && m.html.includes('cancelar?token='));
    expect(email?.html).toContain('Ana');

    const job = await waitFor(() => notifications.reminders.getJob(booking.id));
    const fireAt = job.timestamp + (job.opts.delay ?? 0);
    const expected = new Date(booking.start).getTime() - 24 * 3_600_000;
    expect(Math.abs(fireAt - expected)).toBeLessThan(5_000);
  });

  it('al cancelar se borra el recordatorio y se avisa por email', async () => {
    const { booking, client } = await bookIn(3);
    await waitFor(() => notifications.reminders.getJob(booking.id));

    await ctx.http().post(`/api/v1/bookings/${booking.id}/cancel`).auth(client.token, { type: 'bearer' }).expect(200);

    await waitFor(() => ctx.prisma.notification.findFirst({ where: { bookingId: booking.id, type: 'BOOKING_CANCELLED' } }));
    expect(await notifications.reminders.getJob(booking.id)).toBeUndefined();
  });

  it('al reprogramar se reemplaza el recordatorio (un solo job por turno)', async () => {
    const { biz, booking, client } = await bookIn(3);
    await waitFor(() => notifications.reminders.getJob(booking.id));
    const [, , newSlot] = await slotsOn(biz.slug, biz.serviceId, dateIn(4));

    await ctx
      .http()
      .post(`/api/v1/bookings/${booking.id}/reschedule`)
      .auth(client.token, { type: 'bearer' })
      .send({ start: newSlot.start })
      .expect(200);

    const job = await waitFor(async () => {
      const j = await notifications.reminders.getJob(booking.id);
      return j?.data.start === newSlot.start ? j : null;
    });
    expect(job.data.start).toBe(newSlot.start);
    await waitFor(() => ctx.prisma.notification.findFirst({ where: { bookingId: booking.id, type: 'BOOKING_RESCHEDULED' } }));
  });

  it('el worker manda el recordatorio, y lo saltea si el turno se movió', async () => {
    const { booking } = await bookIn(3);
    await waitFor(() => notifications.reminders.getJob(booking.id));
    await notifications.reminders.remove(booking.id);

    // Disparo inmediato con el horario correcto → se envía
    await notifications.reminders.add('send-reminder', { bookingId: booking.id, start: booking.start }, { jobId: booking.id });
    await waitFor(() => ctx.prisma.notification.findFirst({ where: { bookingId: booking.id, type: 'BOOKING_REMINDER' } }));

    // Job viejo con otro horario → no se envía de nuevo
    const stale = await notifications.reminders.add(
      'send-reminder',
      { bookingId: booking.id, start: new Date(0).toISOString() },
      { jobId: `${booking.id}-stale` },
    );
    await waitFor(async () => (await stale.getState()) === 'completed' || (await notifications.reminders.getJob(stale.id!)) === undefined);
    expect(await ctx.prisma.notification.count({ where: { bookingId: booking.id, type: 'BOOKING_REMINDER' } })).toBe(1);
  });

  it('no programa recordatorio si el turno es en menos de 24 h', async () => {
    const biz = await createBusiness(ctx);
    const client = await registerUser(ctx);
    const today = await slotsOn(biz.slug, biz.serviceId, dateIn(0));
    const slot = today[0] ?? (await slotsOn(biz.slug, biz.serviceId, dateIn(1)))[0];
    if (new Date(slot.start).getTime() - Date.now() >= 24 * 3_600_000) return; // no hay slot cercano a esta hora
    const res = await ctx
      .http()
      .post('/api/v1/bookings')
      .auth(client.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start })
      .expect(201);
    await waitFor(() => ctx.prisma.notification.findFirst({ where: { bookingId: res.body.id, type: 'BOOKING_CONFIRMED' } }));
    expect(await notifications.reminders.getJob(res.body.id)).toBeUndefined();
  });
});

describe('agenda en tiempo real', () => {
  const connect = (token: string, businessId: string) =>
    new Promise<{ socket: Socket; ok: boolean }>((resolve) => {
      const socket = io(ctx.url, { auth: { token, businessId }, transports: ['websocket'], reconnection: false });
      socket.on('ready', () => resolve({ socket, ok: true }));
      socket.on('unauthorized', () => resolve({ socket, ok: false }));
    });

  it('el panel recibe el turno nuevo apenas se reserva', async () => {
    const biz = await createBusiness(ctx);
    const { socket, ok } = await connect(biz.owner.token, biz.businessId);
    expect(ok).toBe(true);
    const received = new Promise<{ type: string; bookingId: string }>((r) => socket.on('agenda', r));

    const [slot] = await slotsOn(biz.slug, biz.serviceId, dateIn(2));
    const client = await registerUser(ctx);
    const res = await ctx
      .http()
      .post('/api/v1/bookings')
      .auth(client.token, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send({ businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start })
      .expect(201);

    expect(await received).toMatchObject({ type: 'booking.confirmed', bookingId: res.body.id });
    socket.close();
  });

  it('rechaza a quien no pertenece al negocio', async () => {
    const a = await createBusiness(ctx);
    const b = await createBusiness(ctx);
    const { socket, ok } = await connect(b.owner.token, a.businessId);
    expect(ok).toBe(false);
    socket.close();
  });
});

describe('caché de disponibilidad', () => {
  it('cachea en Redis y se invalida al cambiar el horario', async () => {
    const biz = await createBusiness(ctx);
    const date = dateIn(2);
    expect((await slotsOn(biz.slug, biz.serviceId, date)).length).toBeGreaterThan(0);

    const redis = new Redis(process.env.REDIS_URL!);
    expect(await redis.exists(`avail:${biz.professionalId}:${date}`)).toBe(1);

    await biz.asOwner(ctx.http().put(`/api/v1/business/professionals/${biz.professionalId}/schedule`)).send({ ranges: [] }).expect(200);
    expect(await redis.exists(`avail:${biz.professionalId}:${date}`)).toBe(0);
    expect(await slotsOn(biz.slug, biz.serviceId, date)).toEqual([]);
    await redis.quit();
  });
});

describe('mark-no-shows', () => {
  it('pasa a NO_SHOW los confirmados que terminaron hace más de 24 h, y deja el resto', async () => {
    const biz = await createBusiness(ctx);
    const client = await registerUser(ctx);
    const make = (hoursAgo: number, status: 'CONFIRMED' | 'ATTENDED' = 'CONFIRMED') => {
      const start = new Date(Date.now() - hoursAgo * 3_600_000);
      const end = new Date(start.getTime() + 30 * 60_000);
      return ctx.prisma.booking.create({
        data: {
          businessId: biz.businessId,
          professionalId: biz.professionalId,
          serviceId: biz.serviceId,
          clientId: client.id,
          startsAt: start,
          endsAt: end,
          blockedUntil: end,
          status,
          priceCents: 1000,
          cancelToken: randomUUID(),
          idempotencyKey: randomUUID(),
        },
      });
    };
    const old = await make(48);
    const attended = await make(72, 'ATTENDED');
    const recent = await make(3);

    await ctx.app.get(BookingService).markNoShows();

    const status = async (id: string) => (await ctx.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(old.id)).toBe('NO_SHOW');
    expect(await status(attended.id)).toBe('ATTENDED');
    expect(await status(recent.id)).toBe('CONFIRMED');
  });
});
