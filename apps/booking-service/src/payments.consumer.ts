import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PaymentEvent, TOPICS } from '@turnos/contracts';
import { KafkaService, processOnce } from '@turnos/kafka';
import { BookingService } from './booking.service';
import { PrismaService } from './prisma.service';

export const BOOKING_PAYMENTS_CONSUMER = 'booking-service.payments';

/**
 * Consume payments.events: pago aprobado → confirma el turno; pago rechazado →
 * vence el turno y libera el horario. Grupo propio (no el de la réplica), porque
 * un grupo de Kafka debe tener la misma suscripción en todos sus miembros.
 */
@Injectable()
export class PaymentsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentsConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly bookings: BookingService,
  ) {}

  async onApplicationBootstrap() {
    await this.kafka.consume({
      groupId: BOOKING_PAYMENTS_CONSUMER,
      topics: [TOPICS.payments],
      fromBeginning: true,
      handler: async ({ message }) => {
        if (message.value) await this.handle(JSON.parse(message.value.toString()) as PaymentEvent);
      },
    });
  }

  async handle(event: PaymentEvent) {
    await processOnce(this.prisma, BOOKING_PAYMENTS_CONSUMER, event.eventId, async () => {
      const { bookingId } = event.payload;
      if (event.eventType === 'payment.approved') {
        const result = await this.bookings.confirmPayment(bookingId);
        if (result === 'refund') this.logger.warn(`Seña de ${bookingId} pagada tarde y el horario ya no está: se pide devolución`);
      } else if (event.eventType === 'payment.failed') {
        await this.bookings.expirePending(bookingId, 'PAYMENT_REJECTED');
      }
    });
  }
}
