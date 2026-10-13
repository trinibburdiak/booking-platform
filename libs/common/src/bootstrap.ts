import { Controller, Get, INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { NoInternalToken } from './gateway-auth';

/** /health sin token interno, para Docker, Kubernetes o un balanceador. */
export function healthController(name: string, check: () => Promise<unknown> = async () => undefined) {
  @Controller('health')
  class HealthController {
    @Get()
    @NoInternalToken()
    async health() {
      await check();
      return { status: 'ok', service: name };
    }
  }
  return HealthController;
}

/** Configuración común: prefijo /api/v1 (salvo /health e /internal) y Helmet. */
export function configureService(app: INestApplication) {
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'internal/*path'] });
  app.use(helmet());
  return app;
}

export async function bootstrapService(module: Type<unknown>, opts: { name: string; port: number; setup?: (app: INestApplication) => void }) {
  const app = configureService(await NestFactory.create(module));
  opts.setup?.(app);
  app.enableShutdownHooks();
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle(opts.name).setVersion('0.1').build());
  SwaggerModule.setup('docs', app, doc);
  await app.listen(opts.port);
  console.log(`${opts.name} en http://localhost:${opts.port} — Swagger en /docs`);
  return app;
}
