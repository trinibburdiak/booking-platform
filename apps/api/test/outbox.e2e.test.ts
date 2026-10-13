import { randomUUID } from 'crypto';
import { BOOKING_EVENTS_TOPIC, BookingEvent } from '../src/events/booking-events';
import { KafkaService } from '../src/kafka/kafka.service';
import { createBusiness, registerUser, startApp, stopApp, TestContext, tomorrowSlots } from './setup';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startApp();
}, 240_000);

afterAll(() => stopApp(ctx));

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const book = (token: string, body: object) =>
  ctx.http().post('/api/v1/bookings').auth(token, { type: 'bearer' }).set('Idempotency-Key', randomUUID()).send(body);

const eventsOf = (bookingId: string) =>
  ctx.prisma.outboxEvent.findMany({ where: { key: bookingId }, orderBy: { id: 'asc' } });

describe('outbox', () => {
  it('el turno y su evento se guardan juntos, y el relay lo publica', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    const res = await book(client.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);

    const [row] = await eventsOf(res.body.id);
    expect(row).toMatchObject({ topic: BOOKING_EVENTS_TOPIC, key: res.body.id, eventType: 'booking.confirmed' });
    expect((row.payload as unknown as BookingEvent).payload).toMatchObject({ bookingId: res.body.id, status: 'CONFIRMED' });

    await waitFor(async () => (await eventsOf(res.body.id))[0].publishedAt);
  });

  it('una reserva rechazada por el constraint no deja eventos', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const clients = await Promise.all(Array.from({ length: 10 }, () => registerUser(ctx)));
    const before = await ctx.prisma.outboxEvent.count();

    const results = await Promise.all(
      clients.map((c) => book(c.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await ctx.prisma.outboxEvent.count()).toBe(before + 1);
  });

  it('los eventos de un turno quedan en orden: confirmado → reprogramado → cancelado', async () => {
    const biz = await createBusiness(ctx);
    const slots = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    const res = await book(client.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slots[0].start }).expect(201);
    const auth = (r: ReturnType<ReturnType<TestContext['http']>['post']>) => r.auth(client.token, { type: 'bearer' });
    await auth(ctx.http().post(`/api/v1/bookings/${res.body.id}/reschedule`)).send({ start: slots[3].start }).expect(200);
    await auth(ctx.http().post(`/api/v1/bookings/${res.body.id}/cancel`)).expect(200);

    const types = (await eventsOf(res.body.id)).map((e) => e.eventType);
    expect(types).toEqual(['booking.confirmed', 'booking.rescheduled', 'booking.cancelled']);
    await waitFor(async () => (await eventsOf(res.body.id)).every((e) => e.publishedAt));
  });
});

describe('consumidor de notificaciones', () => {
  it('reacciona al evento de Kafka y descarta duplicados (entrega "al menos una vez")', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    const res = await book(client.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
    const sent = () => ctx.prisma.notification.count({ where: { bookingId: res.body.id, type: 'BOOKING_CONFIRMED' } });
    await waitFor(async () => (await sent()) === 1);

    // Reenvío manual del mismo evento, como si el relay se hubiera caído antes de marcarlo
    const [row] = await eventsOf(res.body.id);
    await ctx.app.get(KafkaService).send(BOOKING_EVENTS_TOPIC, [
      { key: row.key, value: JSON.stringify(row.payload), headers: { eventType: row.eventType, eventId: row.eventId } },
    ]);
    await new Promise((r) => setTimeout(r, 2_000));

    expect(await sent()).toBe(1);
    expect(await ctx.prisma.processedEvent.count({ where: { eventId: row.eventId } })).toBe(1);
  });
});
