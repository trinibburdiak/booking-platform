import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true });
  return app;
}

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule));
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Turnos API').setVersion('0.1').addBearerAuth().build(),
  );
  SwaggerModule.setup('docs', app, doc);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API en http://localhost:${port}/api/v1 — Swagger en http://localhost:${port}/docs`);
}

if (require.main === module) {
  require('dotenv/config');
  void bootstrap();
}
