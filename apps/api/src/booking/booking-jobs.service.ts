import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { redisOptions } from '../redis/redis.module';
import { BookingService } from './booking.service';

export const MAINTENANCE_QUEUE = 'booking-maintenance';

/**
 * Jobs periódicos del dominio de turnos. `mark-no-shows` corre cada hora con un
 * job scheduler de BullMQ (uno solo aunque haya varias instancias de la API).
 */
@Injectable()
export class BookingJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingJobsService.name);
  private readonly queue = new Queue(MAINTENANCE_QUEUE, { connection: redisOptions() });
  private worker?: Worker;

  constructor(private readonly bookings: BookingService) {}

  async onModuleInit() {
    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      async (job) => {
        if (job.name !== 'mark-no-shows') return;
        const marked = await this.bookings.markNoShows();
        if (marked) this.logger.log(`${marked} turnos marcados como no asistidos`);
        return { marked };
      },
      { connection: redisOptions() },
    );
    await this.queue.upsertJobScheduler('mark-no-shows', { every: 3_600_000 }, { name: 'mark-no-shows' });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
  }
}
