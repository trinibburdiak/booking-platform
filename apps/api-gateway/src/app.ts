import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Server } from 'http';
import helmet from 'helmet';
import Redis from 'ioredis';
import { AppModule } from './app.module';
import { createGateway, createSocketProxy } from './gateway.middleware';

/**
 * API gateway: única puerta de entrada del front. Valida el JWT, resuelve el
 * negocio contra las membresías, aplica rate limiting y reenvía a cada servicio.
 * Sin body parser: los cuerpos pasan tal cual al servicio de destino.
 */
export async function createGatewayApp(): Promise<{ app: INestApplication; redis: Redis }> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  const socketProxy = createSocketProxy();

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5180', credentials: true });
  app.use(socketProxy);
  app.use(createGateway({ jwt: app.get(JwtService), redis }));
  app.enableShutdownHooks();

  await app.init();
  (app.getHttpServer() as Server).on('upgrade', socketProxy.upgrade);
  return { app, redis };
}
