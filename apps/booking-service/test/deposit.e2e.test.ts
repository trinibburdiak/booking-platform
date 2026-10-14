import { PaymentEvent } from '@turnos/contracts';
import { envelope } from '@turnos/kafka';
import { uuid, waitFor } from '@turnos/testing';
import { PaymentsConsumer } from '../src/payments.consumer';
import { Ctx, createBusiness, registerClient, slotsOn, startService, stopService } from './setup';

let ctx: Ctx;

beforeAll(async () => {
  process.env.DEPOSIT_MINUTES = '0.05'; // 3 segundos para pagar, así se puede probar el vencimiento
  ctx = await startService();
}, 240_000);

afterAll(() => stopService(ctx));

const book = (headers: Record<string, string>, body: object) =>
  ctx.http().post('/api/v1/bookings').set(headers).set('Idempotency-Key', uuid()).send(body);

const paymentEvent = (type: 'payment.approved' | 'payment.failed', bookingId: string) =>
  envelope(type, null, { paymentId: uuid(), bookingId, amountCents: 500, provider: 'sandbox', reason: 'rejected' }) as PaymentEvent;

const pay = (type: 'payment.approved' | 'payment.failed', bookingId: string) =>
  ctx.app.get(PaymentsConsumer).handle(paymentEvent(type, bookingId));

const status = async (id: string) => (await ctx.prisma.booking.findUniqueOrThrow({ where: { id } })).status;

async function pendingBooking() {
  const biz = await createBusiness(ctx, { depositCents: 500 });
  const [slot] = await slotsOn(ctx, biz.slug, biz.serviceId);
  const client = await registerClient(ctx);
  const res = await book(client.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
  return { biz, slot, client, booking: res.body as { id: string; status: string; depositCents: number; expiresAt: string } };
}

describe('turnos con seña', () => {
  it('queda PENDING, ocupa el horario y publica booking.created con monto y vencimiento', async () => {
    const { biz, slot, booking } = await pendingBooking();
    expect(booking).toMatchObject({ status: 'PENDING', depositCents: 500 });
    expect(new Date(booking.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const other = await registerClient(ctx);
    await book(other.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(409);

    const [event] = await ctx.prisma.outboxEvent.findMany({ where: { key: booking.id } });
    expect(event.eventType).toBe('booking.created');
    expect(event.payload).toMatchObject({ payload: { depositCents: 500, expiresAt: booking.expiresAt } });
  });

  it('pago aprobado → CONFIRMED y booking.confirmed (el email de confirmación sale recién ahí)', async () => {
    const { booking } = await pendingBooking();
    await pay('payment.approved', booking.id);
    expect(await status(booking.id)).toBe('CONFIRMED');
    const types = (await ctx.prisma.outboxEvent.findMany({ where: { key: booking.id }, orderBy: { id: 'asc' } })).map((e) => e.eventType);
    expect(types).toEqual(['booking.created', 'booking.confirmed']);
  });

  it('pago rechazado → EXPIRED y el horario se libera', async () => {
    const { biz, slot, booking } = await pendingBooking();
    await pay('payment.failed', booking.id);
    expect(await status(booking.id)).toBe('EXPIRED');
    const other = await registerClient(ctx);
    await book(other.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
  });

  it('si no paga a tiempo, el job expire-pending lo vence', async () => {
    const { booking } = await pendingBooking();
    await waitFor(async () => (await status(booking.id)) === 'EXPIRED', 15_000);
    const last = await ctx.prisma.outboxEvent.findFirstOrThrow({ where: { key: booking.id }, orderBy: { id: 'desc' } });
    expect(last).toMatchObject({ eventType: 'booking.expired', payload: { payload: { reason: 'NOT_PAID' } } });
  });

  it('pago que llega tarde: si el horario sigue libre, se confirma igual', async () => {
    const { booking } = await pendingBooking();
    await waitFor(async () => (await status(booking.id)) === 'EXPIRED', 15_000);
    await pay('payment.approved', booking.id);
    expect(await status(booking.id)).toBe('CONFIRMED');
  });

  it('pago que llega tarde con el horario ya tomado: el constraint lo impide y se pide devolución', async () => {
    const { biz, slot, booking } = await pendingBooking();
    await waitFor(async () => (await status(booking.id)) === 'EXPIRED', 15_000);
    const other = await registerClient(ctx);
    await book(other.headers, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);

    await pay('payment.approved', booking.id);
    expect(await status(booking.id)).toBe('EXPIRED');
    const last = await ctx.prisma.outboxEvent.findFirstOrThrow({ where: { key: booking.id }, orderBy: { id: 'desc' } });
    expect(last.eventType).toBe('booking.refund_required');
  });

  it('el mismo evento de pago dos veces se aplica una sola vez', async () => {
    const { booking } = await pendingBooking();
    const event = paymentEvent('payment.approved', booking.id);
    await ctx.app.get(PaymentsConsumer).handle(event);
    await ctx.app.get(PaymentsConsumer).handle(event);
    expect(await ctx.prisma.outboxEvent.count({ where: { key: booking.id, eventType: 'booking.confirmed' } })).toBe(1);
  });
});

describe('métricas de ausentismo', () => {
  it('cuenta asistencias y faltas por profesional y día, sin contar cancelados', async () => {
    const biz = await createBusiness(ctx);
    const client = await registerClient(ctx, 'Juan Faltón');
    const mk = (daysAgo: number, st: 'ATTENDED' | 'NO_SHOW' | 'CANCELLED') => {
      const start = new Date(Date.now() - daysAgo * 86_400_000);
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
          status: st,
          priceCents: 1000,
          cancelToken: uuid(),
          idempotencyKey: uuid(),
        },
      });
    };
    await Promise.all([mk(2, 'ATTENDED'), mk(3, 'ATTENDED'), mk(4, 'NO_SHOW'), mk(5, 'NO_SHOW'), mk(6, 'CANCELLED')]);

    const res = await ctx
      .http()
      .get('/api/v1/business/metrics')
      .set(biz.owner)
      .query({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() })
      .expect(200);

    expect(res.body.totals).toMatchObject({ attended: 2, noShow: 2, cancelled: 1, noShowRate: 0.5, revenueCents: 2000 });
    expect(res.body.byProfessional[0]).toMatchObject({ displayName: 'Ana', attended: 2, noShow: 2, noShowRate: 0.5 });
    expect(res.body.byWeekday.reduce((a: number, w: { noShow: number }) => a + w.noShow, 0)).toBe(2);
    expect(res.body.repeatNoShows).toEqual([expect.objectContaining({ fullName: 'Juan Faltón', noShows: 2 })]);
  });
});
