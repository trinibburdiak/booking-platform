import 'reflect-metadata';
import 'dotenv/config';
import { bootstrapService } from '@turnos/common';
import { AppModule } from './app.module';
import { NotificationsService } from './notifications.service';
import { mountQueuesBoard } from './queues-board';

void bootstrapService(AppModule, {
  name: 'notifications-service',
  port: Number(process.env.HTTP_PORT ?? 3004),
  setup: (app) => mountQueuesBoard(app, [app.get(NotificationsService).reminders]),
});
