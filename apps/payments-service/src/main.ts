import 'reflect-metadata';
import 'dotenv/config';
import { bootstrapService } from '@turnos/common';
import { AppModule } from './app.module';

void bootstrapService(AppModule, { name: 'payments-service', port: Number(process.env.HTTP_PORT ?? 3005) });
