import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { redisOptions } from './redis.module';

export const EXPIRATIONS_QUEUE = 'booking-expirations';

/** Minutos para pagar la seña antes de que el turno PENDING venza y libere el horario. */
export const depositMinutes = () => Number(process.env.DEPOSIT_MINUTES ?? 15);

/**
 * Job diferido `expire-pending` con jobId = bookingId: al vencer el plazo de pago,
 * si el turno sigue PENDING pasa a EXPIRED. Si se paga antes, el job se borra.
 */
@Injectable()
export class ExpirationQueue implements OnModuleDestroy {
  readonly queue = new Queue<{ bookingId: string }>(EXPIRATIONS_QUEUE, {
    connection: redisOptions(),
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 100, attempts: 5, backoff: { type: 'exponential', delay: 5_000 } },
  });

  async schedule(bookingId: string, expiresAt: Date) {
    await this.queue.remove(bookingId);
    await this.queue.add('expire-pending', { bookingId }, { jobId: bookingId, delay: Math.max(0, expiresAt.getTime() - Date.now()) });
  }

  async cancel(bookingId: string) {
    await this.queue.remove(bookingId);
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
