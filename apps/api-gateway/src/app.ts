import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { HEADERS, withLogging } from '@turnos/common';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import helmet from 'helmet';
import Redis from 'ioredis';
import { Logger } from 'nestjs-pino';
import pinoHttp from 'pino-http';
import { AppModule } from './app.module';
import { createGateway, createSocketProxy } from './gateway.middleware';

/**
 * API gateway: única puerta de entrada del front. Valida el JWT, resuelve el
 * negocio contra las membresías, aplica rate limiting y reenvía a cada servicio.
 * Sin body parser: los cuerpos pasan tal cual al servicio de destino.
 */
export async function createGatewayApp(): Promise<{ app: INestApplication; redis: Redis }> {
  const app = await NestFactory.create(withLogging(AppModule, 'api-gateway'), { bodyParser: false, bufferLogs: true });
  app.useLogger(app.get(Logger));
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380');
  const socketProxy = createSocketProxy();

  // Un log por request proxeada, con el x-request-id que después siguen todos los servicios
  app.use(
    pinoHttp({
      name: 'api-gateway',
      level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
      genReqId: (req, res) => {
        const id = (req.headers[HEADERS.requestId] as string) || randomUUID();
        req.headers[HEADERS.requestId] = id;
        res.setHeader(HEADERS.requestId, id);
        return id;
      },
      customProps: (req) => ({ requestId: req.id }),
      autoLogging: { ignore: (req) => req.url === '/health' },
      serializers: { req: (req) => ({ method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      transport: process.env.LOG_PRETTY === 'true' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5180', credentials: true });
  app.use(socketProxy);
  app.use(createGateway({ jwt: app.get(JwtService), redis }));
  app.enableShutdownHooks();

  await app.init();
  (app.getHttpServer() as Server).on('upgrade', socketProxy.upgrade);
  return { app, redis };
}
