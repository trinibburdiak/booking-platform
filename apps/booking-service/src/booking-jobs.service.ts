import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { BookingService } from './booking.service';
import { EXPIRATIONS_QUEUE } from './expiration.queue';
import { redisOptions } from './redis.module';

export const MAINTENANCE_QUEUE = 'booking-maintenance';

/**
 * Jobs del dominio de turnos:
 * - `mark-no-shows`: cada hora, con un job scheduler de BullMQ (uno solo aunque haya varias instancias).
 * - `expire-pending`: diferido, uno por turno con seña (ver ExpirationQueue).
 */
@Injectable()
export class BookingJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingJobsService.name);
  readonly maintenance = new Queue(MAINTENANCE_QUEUE, { connection: redisOptions() });
  private workers: Worker[] = [];

  constructor(private readonly bookings: BookingService) {}

  async onModuleInit() {
    this.workers.push(
      new Worker(
        MAINTENANCE_QUEUE,
        async (job) => {
          if (job.name !== 'mark-no-shows') return;
          const marked = await this.bookings.markNoShows();
          if (marked) this.logger.log(`${marked} turnos marcados como no asistidos`);
          return { marked };
        },
        { connection: redisOptions() },
      ),
      new Worker<{ bookingId: string }>(
        EXPIRATIONS_QUEUE,
        async (job) => {
          const expired = await this.bookings.expirePending(job.data.bookingId, 'NOT_PAID');
          if (expired) this.logger.log(`Turno ${job.data.bookingId} vencido sin pagar la seña`);
          return { expired };
        },
        { connection: redisOptions() },
      ),
    );
    await this.maintenance.upsertJobScheduler('mark-no-shows', { every: 3_600_000 }, { name: 'mark-no-shows' });
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()));
    await this.maintenance.close();
  }
}
