import { DynamicModule, Module, Type } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { LoggerModule } from 'nestjs-pino';
import { HEADERS } from './gateway-auth';

/**
 * Contexto de la request (o del evento) en curso. El gateway genera el
 * x-request-id; cada servicio lo toma, lo agrega a sus logs, lo propaga en las
 * llamadas internas y lo guarda como `correlationId` en los eventos que publica.
 * Los consumidores de Kafka lo restauran, así una reserva se puede seguir de
 * punta a punta buscando un solo id en los logs.
 */
const context = new AsyncLocalStorage<{ requestId: string }>();

export const currentRequestId = (): string | undefined => context.getStore()?.requestId;

export function runWithRequestId<T>(requestId: string | undefined, fn: () => T): T {
  return context.run({ requestId: requestId || randomUUID() }, fn);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[HEADERS.requestId];
  const requestId = (typeof incoming === 'string' && incoming) || randomUUID();
  req.headers[HEADERS.requestId] = requestId;
  res.setHeader(HEADERS.requestId, requestId);
  context.run({ requestId }, next);
}

/** Logs JSON con Pino (LOG_PRETTY=true para leerlos cómodos en desarrollo). */
export function loggerModule(service: string): DynamicModule {
  return LoggerModule.forRoot({
    pinoHttp: {
      name: service,
      level: process.env.LOG_LEVEL ?? 'info',
      genReqId: (req) => (req.headers[HEADERS.requestId] as string) || randomUUID(),
      mixin: () => {
        const requestId = currentRequestId();
        return requestId ? { requestId } : {};
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      transport: process.env.LOG_PRETTY === 'true' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  });
}

/** Envuelve el módulo raíz de un servicio para sumarle el logger. */
export function withLogging(root: Type<unknown>, service: string): Type<unknown> {
  @Module({ imports: [root, loggerModule(service)] })
  class LoggedRoot {}
  return LoggedRoot;
}
