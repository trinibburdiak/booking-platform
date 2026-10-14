import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureService } from '@turnos/common';
import { BookingEvent } from '@turnos/contracts';
import { envelope } from '@turnos/kafka';
import { asUser, Infra, startInfra, uuid, viaGateway, waitFor } from '@turnos/testing';
import { createHmac } from 'crypto';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PaymentsService } from '../src/payments.service';
import { PrismaService } from '../src/prisma.service';
import { verifyMercadoPagoSignature } from '../src/providers';

let app: INestApplication;
let infra: Infra;
let prisma: PrismaService;
let payments: PaymentsService;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  process.env.MP_ACCESS_TOKEN = ''; // checkout simulado
  infra = await startInfra({ serviceDir: join(__dirname, '..'), postgres: true, kafka: true });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureService(moduleRef.createNestApplication());
  await app.listen(0);
  prisma = app.get(PrismaService);
  payments = app.get(PaymentsService);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

async function bookingCreated() {
  const bookingId = uuid();
  const clientId = uuid();
  const businessId = uuid();
  const event = envelope('booking.created', businessId, {
    bookingId,
    clientId,
    professionalId: uuid(),
    start: new Date(Date.now() + 86_400_000).toISOString(),
    end: new Date(Date.now() + 86_400_000 + 1_800_000).toISOString(),
    status: 'PENDING',
    depositCents: 400000,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  }) as BookingEvent;
  await payments.handle(event);
  const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId } });
  return { bookingId, clientId, businessId, payment, event };
}

const outbox = (bookingId: string) => prisma.outboxEvent.findMany({ where: { key: bookingId }, orderBy: { id: 'asc' } });

describe('seña', () => {
  it('booking.created crea el cobro con link de checkout; el cliente lo consulta', async () => {
    const { bookingId, clientId, payment, event } = await bookingCreated();
    expect(payment).toMatchObject({ status: 'CREATED', amountCents: 400000, provider: 'sandbox' });
    expect(payment.checkoutUrl).toContain(`/api/v1/payments/sandbox/${payment.id}`);

    await payments.handle(event); // duplicado: no crea otro
    expect(await prisma.payment.count({ where: { bookingId } })).toBe(1);

    const view = await http().get(`/api/v1/payments/booking/${bookingId}`).set(asUser(clientId)).expect(200);
    expect(view.body).toMatchObject({ status: 'CREATED', checkoutUrl: payment.checkoutUrl });
    await http().get(`/api/v1/payments/booking/${bookingId}`).set(asUser(uuid())).expect(404); // otro usuario
  });

  it('checkout simulado: aprobar publica payment.approved una sola vez y vuelve al turno', async () => {
    const { bookingId, payment } = await bookingCreated();
    const page = await http().get(`/api/v1/payments/sandbox/${payment.id}`).set(viaGateway()).expect(200);
    expect(page.text).toContain('Checkout simulado');

    const res = await http().post(`/api/v1/payments/sandbox/${payment.id}/approve`).set(viaGateway()).expect(303);
    expect(res.headers.location).toBe(`http://localhost:5180/reservas/${bookingId}?pago=aprobado`);
    await http().post(`/api/v1/payments/sandbox/${payment.id}/approve`).set(viaGateway()).expect(303);

    const events = await outbox(bookingId);
    expect(events.map((e) => e.eventType)).toEqual(['payment.approved']);
    await waitFor(async () => (await outbox(bookingId))[0].publishedAt);
  });

  it('rechazar publica payment.failed', async () => {
    const { bookingId, payment } = await bookingCreated();
    const res = await http().post(`/api/v1/payments/sandbox/${payment.id}/reject`).set(viaGateway()).expect(303);
    expect(res.headers.location).toContain('pago=rechazado');
    expect((await outbox(bookingId)).map((e) => e.eventType)).toEqual(['payment.failed']);
  });

  it('booking.refund_required devuelve una seña aprobada', async () => {
    const { bookingId, businessId, payment } = await bookingCreated();
    await http().post(`/api/v1/payments/sandbox/${payment.id}/approve`).set(viaGateway()).expect(303);
    await payments.handle(
      envelope('booking.refund_required', businessId, {
        bookingId,
        clientId: uuid(),
        professionalId: uuid(),
        start: new Date().toISOString(),
        end: new Date().toISOString(),
        status: 'EXPIRED',
      }) as BookingEvent,
    );
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('REFUNDED');
    expect((await outbox(bookingId)).map((e) => e.eventType)).toEqual(['payment.approved', 'payment.refunded']);
  });
});

describe('webhook de Mercado Pago', () => {
  it('valida la firma x-signature (HMAC-SHA256 sobre id, request-id y ts)', () => {
    const secret = 'secreto';
    const ts = '1700000000';
    const v1 = createHmac('sha256', secret).update(`id:12345;request-id:req-1;ts:${ts};`).digest('hex');
    expect(verifyMercadoPagoSignature({ secret, signature: `ts=${ts},v1=${v1}`, requestId: 'req-1', dataId: '12345' })).toBe(true);
    expect(verifyMercadoPagoSignature({ secret, signature: `ts=${ts},v1=${v1}`, requestId: 'otro', dataId: '12345' })).toBe(false);
    expect(verifyMercadoPagoSignature({ secret, signature: undefined, requestId: 'req-1', dataId: '12345' })).toBe(false);
  });

  it('con firma inválida responde 401; sin Mercado Pago configurado, 403', async () => {
    process.env.MP_WEBHOOK_SECRET = 'secreto';
    try {
      await http().post('/api/v1/webhooks/mercadopago').set(viaGateway()).send({ type: 'payment', data: { id: '1' } }).expect(401);
    } finally {
      delete process.env.MP_WEBHOOK_SECRET;
    }
    await http().post('/api/v1/webhooks/mercadopago').set(viaGateway()).send({ type: 'payment', data: { id: '1' } }).expect(403);
    await http().post('/api/v1/webhooks/mercadopago').set(viaGateway()).send({ type: 'merchant_order' }).expect(200);
  });
});
