import 'reflect-metadata';
import 'dotenv/config';
import { bootstrapService } from '@turnos/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

void bootstrapService(AppModule, {
  name: 'auth-service',
  port: Number(process.env.HTTP_PORT ?? 3001),
  setup: (app) => app.use(cookieParser()),
});
