import { AuthEvent } from '@turnos/contracts';
import { envelope } from '@turnos/kafka';
import { asUser, uuid, viaGateway, waitFor } from '@turnos/testing';
import Redis from 'ioredis';
import { BookingService } from '../src/booking.service';
import { Ctx, createBusiness, dateIn, feed, registerClient, slotsOn, startService, stopService } from './setup';

let ctx: Ctx;

beforeAll(async () => {
  ctx = await startService();
}, 240_000);

afterAll(() => stopService(ctx));

const book = (headers: Record<string, string>, body: object, key = uuid()) =>
  ctx.http().post('/api/v1/bookings').set(headers).set('Idempotency-Key', key).send(body);

describe('doble booking', () => {
  it('20 reservas en paralelo al mismo slot: solo una gana, el resto recibe 409', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const clients = await Promise.all(Array.from({ length: 20 }, (_, i) => registerClient(ctx, `Cliente ${i}`)));

    const responses = await Promise.all(
      clients.map((c) => book(c.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start })),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(19);
    expect(responses.find((r) => r.status === 409)!.body.code).toBe('SLOT_TAKEN');
    expect(await ctx.prisma.booking.count({ where: { professionalId: biz.professionalId } })).toBe(1);
  });

  it('el constraint de la base rechaza superposiciones aunque se saltee la API', async () => {
    const biz = await createBusiness(ctx);
    const client = await registerClient(ctx);
    const start = new Date('2030-01-07T12:00:00Z');
    const insert = (offsetMin: number) => {
      const s = new Date(start.getTime() + offsetMin * 60_000);
      const e = new Date(s.getTime() + 30 * 60_000);
      return ctx.prisma.booking.create({
        data: {
          businessId: biz.businessId,
          professionalId: biz.professionalId,
          serviceId: biz.serviceId,
          clientId: client.id,
          status: 'CONFIRMED',
          priceCents: 1000,
          startsAt: s,
          endsAt: e,
          blockedUntil: e,
          cancelToken: uuid(),
          idempotencyKey: uuid(),
        },
      });
    };
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => insert(0)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(insert(15)).rejects.toThrow();
    await expect(insert(30)).resolves.toBeDefined();
  });

  it('un turno cancelado libera el horario', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const a = await registerClient(ctx);
    const b = await registerClient(ctx);
    const body = { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start };

    const first = await book(a.headers, body).expect(201);
    await book(b.headers, body).expect(409);
    await ctx.http().post(`/api/v1/bookings/${first.body.id}/cancel`).set(a.headers).expect(200);
    await book(b.headers, body).expect(201);
  });
});

describe('idempotencia', () => {
  it('la misma Idempotency-Key devuelve el mismo turno sin duplicar', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const client = await registerClient(ctx);
    const key = uuid();
    const body = { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start };
    const [r1, r2] = await Promise.all([book(client.headers, body, key), book(client.headers, body, key)]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.id).toBe(r2.body.id);
    expect(await ctx.prisma.booking.count({ where: { clientId: client.id } })).toBe(1);
  });
});

describe('cancelación y reprogramación', () => {
  it('el cliente no puede cancelar dentro del plazo; el negocio sí', async () => {
    const biz = await createBusiness(ctx, { cancellationHours: 72 });
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const client = await registerClient(ctx);
    const res = await book(client.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
    expect(res.body.canClientCancel).toBe(false);
    await ctx.http().post(`/api/v1/bookings/${res.body.id}/cancel`).set(client.headers).expect(403);
    const owner = asUser(biz.ownerId, { memberships: [{ businessId: biz.businessId, role: 'OWNER' }] });
    await ctx.http().post(`/api/v1/bookings/${res.body.id}/cancel`).set(owner).expect(200);
  });

  it('cancela con el token del email, una sola vez', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const client = await registerClient(ctx);
    const res = await book(client.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
    const { cancelToken } = await ctx.prisma.booking.findUniqueOrThrow({ where: { id: res.body.id } });
    const cancel = (token: string) => ctx.http().post('/api/v1/bookings/cancel').set(viaGateway()).query({ token });
    await cancel(cancelToken).expect(200);
    await cancel(cancelToken).expect(409);
    await cancel('inventado').expect(404);
  });

  it('reprogramar a un horario ocupado da 409 y a uno libre mueve el turno', async () => {
    const biz = await createBusiness(ctx);
    const slots = await slotsOn(ctx, biz.slug, biz.serviceId);
    const a = await registerClient(ctx);
    const b = await registerClient(ctx);
    const mine = await book(a.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slots[0].start }).expect(201);
    await book(b.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slots[4].start }).expect(201);
    const move = (start: string) => ctx.http().post(`/api/v1/bookings/${mine.body.id}/reschedule`).set(a.headers).send({ start });
    await move(slots[4].start).expect(409);
    expect((await move(slots[1].start).expect(200)).body.start).toBe(slots[1].start);
  });

  it('un tercero no ve ni toca turnos ajenos (404)', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const a = await registerClient(ctx);
    const stranger = await registerClient(ctx);
    const res = await book(a.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
    await ctx.http().post(`/api/v1/bookings/${res.body.id}/cancel`).set(stranger.headers).expect(404);
  });
});

describe('seguridad entre servicios', () => {
  it('rechaza requests que no vienen del gateway (sin token interno)', async () => {
    await ctx.http().get('/api/v1/me/bookings').set('x-user-id', uuid()).expect(401);
  });

  it('la agenda es del negocio del header que validó el gateway', async () => {
    const a = await createBusiness(ctx);
    const b = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, a.slug, a.serviceId);
    const client = await registerClient(ctx, 'Ana Pérez');
    await book(client.headers, { businessSlug: a.slug, serviceId: a.serviceId, start: slot.start }).expect(201);
    const range = { from: new Date().toISOString(), to: new Date(Date.now() + 7 * 86_400_000).toISOString() };

    const agendaA = await ctx.http().get('/api/v1/business/agenda').set(a.owner).query(range).expect(200);
    expect(agendaA.body).toHaveLength(1);
    expect(agendaA.body[0].client.fullName).toBe('Ana Pérez'); // de la réplica de clientes
    const agendaB = await ctx.http().get('/api/v1/business/agenda').set(b.owner).query(range).expect(200);
    expect(agendaB.body).toHaveLength(0);
  });
});

describe('réplica del catálogo', () => {
  it('un cambio de horario por evento invalida el caché y cambia la disponibilidad', async () => {
    const biz = await createBusiness(ctx);
    const date = dateIn(2);
    expect((await slotsOn(ctx, biz.slug, biz.serviceId, date)).length).toBeGreaterThan(0);
    const redis = new Redis(process.env.REDIS_URL!);
    expect(await redis.exists(`avail:${biz.professionalId}:${date}`)).toBe(1);

    await biz.ev('schedule.changed', { professionalId: biz.professionalId, schedules: [], exceptions: [] });
    expect(await redis.exists(`avail:${biz.professionalId}:${date}`)).toBe(0);
    expect(await slotsOn(ctx, biz.slug, biz.serviceId, date)).toEqual([]);
    await redis.quit();
  });

  it('un servicio desactivado por evento deja de poder reservarse', async () => {
    const biz = await createBusiness(ctx);
    await biz.ev('service.changed', {
      service: { id: biz.serviceId, businessId: biz.businessId, name: 'Corte', durationMin: 30, bufferMin: 0, priceCents: 1000, depositCents: 0, active: false },
    });
    await ctx
      .http()
      .get(`/api/v1/public/businesses/${biz.slug}/availability`)
      .set(viaGateway())
      .query({ serviceId: biz.serviceId, date: dateIn(1) })
      .expect(404);
  });

  it('un evento repetido se aplica una sola vez', async () => {
    const id = uuid();
    const event = envelope('user.registered', null, { userId: id, email: 'a@test.dev', fullName: 'Primera', phone: null }) as AuthEvent;
    await feed(ctx, event);
    await ctx.prisma.client.update({ where: { id }, data: { fullName: 'Cambiado a mano' } });
    await feed(ctx, event); // Kafka lo reentrega
    expect((await ctx.prisma.client.findUniqueOrThrow({ where: { id } })).fullName).toBe('Cambiado a mano');
    expect(await ctx.prisma.processedEvent.count({ where: { eventId: event.eventId } })).toBe(1);
  });
});

describe('outbox', () => {
  it('turno y evento se guardan juntos; los eventos de un turno quedan en orden y se publican', async () => {
    const biz = await createBusiness(ctx);
    const slots = await slotsOn(ctx, biz.slug, biz.serviceId);
    const client = await registerClient(ctx);
    const res = await book(client.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slots[0].start }).expect(201);
    await ctx.http().post(`/api/v1/bookings/${res.body.id}/reschedule`).set(client.headers).send({ start: slots[3].start }).expect(200);
    await ctx.http().post(`/api/v1/bookings/${res.body.id}/cancel`).set(client.headers).expect(200);

    const events = () => ctx.prisma.outboxEvent.findMany({ where: { key: res.body.id }, orderBy: { id: 'asc' } });
    expect((await events()).map((e) => e.eventType)).toEqual(['booking.confirmed', 'booking.rescheduled', 'booking.cancelled']);
    await waitFor(async () => (await events()).every((e) => e.publishedAt));
  });

  it('una reserva rechazada por el constraint no deja eventos', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const clients = await Promise.all(Array.from({ length: 10 }, () => registerClient(ctx)));
    const before = await ctx.prisma.outboxEvent.count();
    const results = await Promise.all(
      clients.map((c) => book(c.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await ctx.prisma.outboxEvent.count()).toBe(before + 1);
  });
});

describe('API interna y jobs', () => {
  it('/internal/bookings/:id da los datos del email, solo con token interno', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
    const client = await registerClient(ctx, 'Ana Pérez');
    const res = await book(client.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);

    const detail = await ctx.http().get(`/internal/bookings/${res.body.id}`).set(viaGateway()).expect(200);
    expect(detail.body).toMatchObject({ client: { fullName: 'Ana Pérez' }, service: { name: 'Corte' }, professional: { displayName: 'Ana' } });
    expect(detail.body.cancelToken).toBeTruthy();
    await ctx.http().get(`/internal/bookings/${res.body.id}`).expect(401);
  });

  it('mark-no-shows pasa a NO_SHOW los confirmados vencidos hace más de 24 h', async () => {
    const biz = await createBusiness(ctx);
    const client = await registerClient(ctx);
    const make = (hoursAgo: number) => {
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
          status: 'CONFIRMED',
          priceCents: 1000,
          cancelToken: uuid(),
          idempotencyKey: uuid(),
        },
      });
    };
    const old = await make(48);
    const recent = await make(3);
    await ctx.app.get(BookingService).markNoShows();
    const status = async (id: string) => (await ctx.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(old.id)).toBe('NO_SHOW');
    expect(await status(recent.id)).toBe('CONFIRMED');
  });
});
