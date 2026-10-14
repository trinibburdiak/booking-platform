import { ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { AuthUser, isMemberOf } from '@turnos/common';
import { BookingEvent, PaymentEvent, PaymentView, TOPICS } from '@turnos/contracts';
import { envelope, KafkaService, OutboxRelay, outboxRecord, processOnce } from '@turnos/kafka';
import { Payment, Prisma } from '../generated/prisma';
import { PrismaService } from './prisma.service';
import { MercadoPagoProvider, PaymentProvider, providerFromEnv, ProviderStatus } from './providers';

export const PAYMENTS_CONSUMER = 'payments-service';

/**
 * Señas. Escucha booking.events:
 * - booking.created con seña → crea el cobro en el proveedor (link de pago).
 * - booking.refund_required → devuelve la seña (pagó tarde y el horario ya no estaba).
 * Publica payment.approved / payment.failed / payment.refunded en payments.events.
 */
@Injectable()
export class PaymentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentsService.name);
  readonly provider: PaymentProvider = providerFromEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly relay: OutboxRelay,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log(`Proveedor de pagos: ${this.provider.name}`);
    await this.kafka.consume({
      groupId: PAYMENTS_CONSUMER,
      topics: [TOPICS.booking],
      fromBeginning: true,
      handler: async ({ message }) => {
        if (message.value) await this.handle(JSON.parse(message.value.toString()) as BookingEvent);
      },
    });
  }

  async handle(event: BookingEvent) {
    if (event.eventType !== 'booking.created' && event.eventType !== 'booking.refund_required') return;
    await processOnce(this.prisma, PAYMENTS_CONSUMER, event.eventId, async () => {
      if (event.eventType === 'booking.created') await this.createForBooking(event);
      else await this.refund(event.payload.bookingId);
    });
  }

  private async createForBooking(event: BookingEvent) {
    const { bookingId, clientId, depositCents, expiresAt } = event.payload;
    if (!depositCents || !expiresAt || !event.businessId) return;
    const payment = await this.prisma.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        businessId: event.businessId,
        clientId,
        amountCents: depositCents,
        status: 'CREATED',
        provider: this.provider.name,
        expiresAt: new Date(expiresAt),
      },
      update: {},
    });
    if (payment.checkoutUrl) return;
    try {
      const { checkoutUrl, providerRef } = await this.provider.createCheckout({
        paymentId: payment.id,
        bookingId,
        amountCents: depositCents,
        description: 'Seña de turno',
        expiresAt: new Date(expiresAt),
      });
      await this.prisma.payment.update({ where: { id: payment.id }, data: { checkoutUrl, providerRef, lastError: null } });
    } catch (e) {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { lastError: (e as Error).message.slice(0, 500) } });
      throw e; // Kafka reintenta
    }
  }

  /**
   * Aplica el resultado del proveedor (webhook o checkout simulado). Idempotente:
   * solo un pago CREATED cambia de estado, y el evento sale en la misma transacción.
   */
  async applyResult(paymentId: string, status: ProviderStatus, providerPaymentId?: string, detail = ''): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Pago no encontrado');
    if (status === 'pending' || payment.status !== 'CREATED') return payment;

    const next = status === 'approved' ? 'APPROVED' : 'REJECTED';
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, status: 'CREATED' },
        data: { status: next, providerPaymentId: providerPaymentId ?? payment.providerPaymentId },
      });
      if (count) {
        const base = { paymentId, bookingId: payment.bookingId, amountCents: payment.amountCents, provider: this.provider.name };
        const event: PaymentEvent =
          next === 'APPROVED'
            ? envelope('payment.approved', payment.businessId, base)
            : envelope('payment.failed', payment.businessId, { ...base, reason: detail || 'rejected' });
        await tx.outboxEvent.create({ data: outboxRecord(TOPICS.payments, payment.bookingId, event) as Prisma.OutboxEventCreateInput });
      }
      return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    });
    this.relay.kick();
    return updated;
  }

  /** Webhook de Mercado Pago: se consulta el pago real y se mapea por external_reference. */
  async handleMercadoPagoNotification(mpPaymentId: string) {
    if (!(this.provider instanceof MercadoPagoProvider)) throw new ForbiddenException('Mercado Pago no está configurado');
    const p = await this.provider.getPayment(mpPaymentId);
    return this.applyResult(p.paymentId, p.status, p.mpPaymentId, p.detail);
  }

  private async refund(bookingId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { bookingId } });
    if (!payment || payment.status !== 'APPROVED') return;
    await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'REFUND_PENDING' } });
    if (payment.providerPaymentId || this.provider.name === 'sandbox') {
      await this.provider.refund(payment.providerPaymentId ?? payment.id);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
      const event = envelope('payment.refunded', payment.businessId, {
        paymentId: payment.id,
        bookingId,
        amountCents: payment.amountCents,
        provider: this.provider.name,
      });
      await tx.outboxEvent.create({ data: outboxRecord(TOPICS.payments, bookingId, event) as Prisma.OutboxEventCreateInput });
    });
    this.relay.kick();
  }

  /** El cliente del turno (o alguien del negocio) consulta su seña. */
  async forBooking(user: AuthUser, bookingId: string): Promise<PaymentView> {
    const p = await this.prisma.payment.findUnique({ where: { bookingId } });
    if (!p || (p.clientId !== user.id && !isMemberOf(user, p.businessId))) throw new NotFoundException('Todavía no hay un pago para este turno');
    return this.view(p);
  }

  async getById(id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pago no encontrado');
    return p;
  }

  view(p: Payment): PaymentView {
    return {
      id: p.id,
      bookingId: p.bookingId,
      status: p.status,
      amountCents: p.amountCents,
      checkoutUrl: p.status === 'CREATED' ? p.checkoutUrl : null,
      provider: p.provider as PaymentView['provider'],
    };
  }
}
