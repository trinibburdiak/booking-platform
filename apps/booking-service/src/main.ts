import 'reflect-metadata';
import 'dotenv/config';
import { bootstrapService } from '@turnos/common';
import { AppModule } from './app.module';
import { BookingJobsService } from './booking-jobs.service';
import { ExpirationQueue } from './expiration.queue';
import { mountQueuesBoard } from './queues-board';

void bootstrapService(AppModule, {
  name: 'booking-service',
  port: Number(process.env.HTTP_PORT ?? 3003),
  setup: (app) => mountQueuesBoard(app, [app.get(BookingJobsService).maintenance, app.get(ExpirationQueue).queue]),
});
