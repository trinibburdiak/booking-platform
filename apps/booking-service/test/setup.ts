import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureService } from '@turnos/common';
import { BusinessEvent, AuthEvent } from '@turnos/contracts';
import { envelope } from '@turnos/kafka';
import { asUser, Infra, startInfra, uuid, viaGateway } from '@turnos/testing';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { ReplicaConsumer } from '../src/replica.consumer';

export interface Ctx {
  app: INestApplication;
  prisma: PrismaService;
  infra: Infra;
  http: () => ReturnType<typeof request>;
}

export async function startService(): Promise<Ctx> {
  const infra = await startInfra({ serviceDir: join(__dirname, '..'), postgres: true, redis: true, kafka: true });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureService(moduleRef.createNestApplication());
  await app.listen(0);
  return { app, prisma: app.get(PrismaService), infra, http: () => request(app.getHttpServer()) };
}

export async function stopService(ctx: Ctx | undefined) {
  await ctx?.app.close();
  await ctx?.infra.stop();
}

/** Alimenta la réplica como lo haría Kafka, llamando directo al consumidor. */
export async function feed(ctx: Ctx, event: BusinessEvent | AuthEvent) {
  await ctx.app.get(ReplicaConsumer).handle(event);
}

export async function registerClient(ctx: Ctx, fullName = 'Cliente') {
  const id = uuid();
  await feed(ctx, envelope('user.registered', null, { userId: id, email: `${id}@test.dev`, fullName, phone: null }) as AuthEvent);
  return { id, headers: asUser(id) };
}

/**
 * Un negocio con un profesional que atiende todos los días de 08:00 a 20:00,
 * sin aviso mínimo y un servicio de 30 min, cargado en la réplica por eventos.
 */
export async function createBusiness(ctx: Ctx, opts: { cancellationHours?: number } = {}) {
  const businessId = uuid();
  const serviceId = uuid();
  const professionalId = uuid();
  const ownerId = uuid();
  const slug = `test-${businessId.slice(0, 8)}`;
  const business = {
    id: businessId,
    slug,
    name: 'Negocio Test',
    timezone: 'America/Argentina/Cordoba',
    address: null,
    cancellationHours: opts.cancellationHours ?? 0,
    bookingWindowDays: 30,
    minNoticeMinutes: 0,
  };
  const ev = <E extends BusinessEvent>(type: E['eventType'], payload: E['payload']) =>
    feed(ctx, envelope(type, businessId, payload) as BusinessEvent);

  await ev('business.created', { business, ownerId });
  await ev('service.changed', {
    service: { id: serviceId, businessId, name: 'Corte', durationMin: 30, bufferMin: 0, priceCents: 1000, depositCents: 0, active: true },
  });
  await ev('professional.changed', {
    professional: { id: professionalId, businessId, userId: null, displayName: 'Ana', active: true, serviceIds: [serviceId] },
  });
  await ev('schedule.changed', {
    professionalId,
    schedules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ id: uuid(), weekday, startTime: '08:00', endTime: '20:00' })),
    exceptions: [],
  });

  const owner = asUser(ownerId, { tenant: { businessId, role: 'OWNER' } });
  return { businessId, slug, serviceId, professionalId, ownerId, owner, business, ev };
}

export const dateIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });

export async function slotsOn(ctx: Ctx, slug: string, serviceId: string, date = dateIn(1)) {
  const res = await ctx
    .http()
    .get(`/api/v1/public/businesses/${slug}/availability`)
    .set(viaGateway())
    .query({ serviceId, date })
    .expect(200);
  return res.body.slots as { start: string; professionalId: string; localStart: string }[];
}
