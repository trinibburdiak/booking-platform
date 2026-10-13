import 'reflect-metadata';
import 'dotenv/config';
import { bootstrapService } from '@turnos/common';
import { AppModule } from './app.module';

void bootstrapService(AppModule, { name: 'booking-service', port: Number(process.env.HTTP_PORT ?? 3003) });
