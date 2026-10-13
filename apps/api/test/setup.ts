import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { randomUUID } from 'crypto';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  container: StartedPostgreSqlContainer;
  redis: StartedTestContainer;
  kafka: StartedKafkaContainer;
  url: string;
  http: () => ReturnType<typeof request>;
}

/** Postgres, Redis y Kafka reales en contenedores descartables, con las migraciones aplicadas. */
export async function startApp(): Promise<TestContext> {
  const [container, redis, kafka] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new KafkaContainer('confluentinc/cp-kafka:7.7.1').withKraft().start(),
  ]);
  process.env.KAFKA_BROKERS = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
  process.env.OUTBOX_POLL_MS = '200';
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  // Vacío (no borrado): Prisma recarga el .env y volvería a ponerlo. Emails a un transporte en memoria.
  process.env.SMTP_HOST = '';
  execSync('npx prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: process.env,
    stdio: 'pipe',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.listen(0);
  return {
    app,
    prisma: app.get(PrismaService),
    container,
    redis,
    kafka,
    url: await app.getUrl(),
    http: () => request(app.getHttpServer()),
  };
}

export async function stopApp(ctx: TestContext | undefined) {
  await ctx?.app.close();
  await Promise.all([ctx?.container.stop(), ctx?.redis.stop(), ctx?.kafka.stop()]);
}

export async function registerUser(ctx: TestContext, name = 'Usuario') {
  const res = await ctx
    .http()
    .post('/api/v1/auth/register')
    .send({ email: `${randomUUID()}@test.dev`, password: 'password123', fullName: name })
    .expect(201);
  return { token: res.body.accessToken as string, id: res.body.user.id as string };
}

/**
 * Crea un negocio con un profesional que atiende todos los días de 08:00 a 20:00,
 * sin aviso mínimo, y un servicio de 30 min. Devuelve todo lo necesario para reservar.
 */
export async function createBusiness(ctx: TestContext, opts: { cancellationHours?: number } = {}) {
  const owner = await registerUser(ctx, 'Dueño');
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const biz = await ctx
    .http()
    .post('/api/v1/businesses')
    .auth(owner.token, { type: 'bearer' })
    .send({ name: 'Negocio Test', slug, timezone: 'America/Argentina/Cordoba' })
    .expect(201);
  const businessId = biz.body.id as string;
  const asOwner = <T extends request.Test>(r: T) =>
    r.auth(owner.token, { type: 'bearer' }).set('X-Business-Id', businessId);

  await asOwner(ctx.http().patch('/api/v1/business'))
    .send({ minNoticeMinutes: 0, cancellationHours: opts.cancellationHours ?? 0 })
    .expect(200);
  const service = await asOwner(ctx.http().post('/api/v1/business/services'))
    .send({ name: 'Corte', durationMin: 30, bufferMin: 0, priceCents: 1000 })
    .expect(201);
  const pro = await asOwner(ctx.http().post('/api/v1/business/professionals'))
    .send({ displayName: 'Ana', serviceIds: [service.body.id] })
    .expect(201);
  await asOwner(ctx.http().put(`/api/v1/business/professionals/${pro.body.id}/schedule`))
    .send({ ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '08:00', endTime: '20:00' })) })
    .expect(200);

  return { owner, slug, businessId, serviceId: service.body.id as string, professionalId: pro.body.id as string, asOwner };
}

/** Slots del día siguiente (hora de Córdoba). */
export async function tomorrowSlots(ctx: TestContext, slug: string, serviceId: string) {
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
  const res = await ctx
    .http()
    .get(`/api/v1/public/businesses/${slug}/availability`)
    .query({ serviceId, date: tomorrow })
    .expect(200);
  return res.body.slots as { start: string; professionalId: string; localStart: string }[];
}
