import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureService } from '@turnos/common';
import { BusinessEvent } from '@turnos/contracts';
import { asUser, Infra, startInfra, uuid, viaGateway, waitFor } from '@turnos/testing';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

let app: INestApplication;
let prisma: PrismaService;
let infra: Infra;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  infra = await startInfra({ serviceDir: join(__dirname, '..'), postgres: true, kafka: true });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureService(moduleRef.createNestApplication());
  await app.listen(0);
  prisma = app.get(PrismaService);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

async function createBusiness() {
  const ownerId = uuid();
  const slug = `test-${ownerId.slice(0, 8)}`;
  const res = await http()
    .post('/api/v1/businesses')
    .set(asUser(ownerId))
    .send({ name: 'Negocio', slug, timezone: 'America/Argentina/Cordoba' })
    .expect(201);
  const businessId = res.body.id as string;
  return { ownerId, slug, businessId, owner: asUser(ownerId, { tenant: { businessId, role: 'OWNER' } }) };
}

const events = async (businessId: string) =>
  (await prisma.outboxEvent.findMany({ where: { key: businessId }, orderBy: { id: 'asc' } })).map(
    (e) => e.payload as unknown as BusinessEvent,
  );

describe('catálogo y eventos', () => {
  it('crear un negocio publica business.created con el dueño (auth crea la membresía)', async () => {
    const { businessId, ownerId } = await createBusiness();
    const [created] = await events(businessId);
    expect(created).toMatchObject({ eventType: 'business.created', businessId, payload: { ownerId, business: { id: businessId } } });
    await waitFor(async () => (await prisma.outboxEvent.findFirst({ where: { key: businessId } }))?.publishedAt);
  });

  it('servicios, profesionales y horarios publican su estado completo, en orden', async () => {
    const { businessId, owner } = await createBusiness();
    const svc = await http().post('/api/v1/business/services').set(owner).send({ name: 'Corte', durationMin: 30, priceCents: 1000 }).expect(201);
    const pro = await http().post('/api/v1/business/professionals').set(owner).send({ displayName: 'Ana', serviceIds: [svc.body.id] }).expect(201);
    await http()
      .put(`/api/v1/business/professionals/${pro.body.id}/schedule`)
      .set(owner)
      .send({ ranges: [{ weekday: 1, startTime: '09:00', endTime: '13:00' }] })
      .expect(200);
    await http()
      .post(`/api/v1/business/professionals/${pro.body.id}/exceptions`)
      .set(owner)
      .send({ date: '2030-01-01', type: 'CLOSED', reason: 'Feriado' })
      .expect(201);

    const list = await events(businessId);
    expect(list.map((e) => e.eventType)).toEqual([
      'business.created',
      'service.changed',
      'professional.changed',
      'schedule.changed',
      'schedule.changed',
    ]);
    expect(list[2].payload).toMatchObject({ professional: { id: pro.body.id, serviceIds: [svc.body.id], active: true } });
    expect(list[4].payload).toMatchObject({
      professionalId: pro.body.id,
      schedules: [{ weekday: 1, startTime: '09:00', endTime: '13:00' }],
      exceptions: [{ date: '2030-01-01', type: 'CLOSED' }],
    });
  });

  it('borrar un profesional o servicio lo desactiva (los turnos viven en otro servicio)', async () => {
    const { businessId, owner } = await createBusiness();
    const svc = await http().post('/api/v1/business/services').set(owner).send({ name: 'Corte', durationMin: 30, priceCents: 1000 }).expect(201);
    await http().delete(`/api/v1/business/services/${svc.body.id}`).set(owner).expect(200);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.body.id } })).active).toBe(false);
    const last = (await events(businessId)).at(-1)!;
    expect(last).toMatchObject({ eventType: 'service.changed', payload: { service: { active: false } } });
  });

  it('slug repetido da 409 y la página pública no muestra lo inactivo', async () => {
    const { slug, owner } = await createBusiness();
    await http().post('/api/v1/businesses').set(asUser(uuid())).send({ name: 'Otro', slug, timezone: 'UTC' }).expect(409);
    await http().post('/api/v1/business/services').set(owner).send({ name: 'Inactivo', durationMin: 30, priceCents: 1, active: false }).expect(201);
    const pub = await http().get(`/api/v1/public/businesses/${slug}`).set(viaGateway()).expect(200);
    expect(pub.body.services).toEqual([]);
  });
});

describe('multi-tenancy y roles', () => {
  it('con su propio negocio en el header, un dueño no toca recursos de otro', async () => {
    const a = await createBusiness();
    const b = await createBusiness();
    const pro = await http().post('/api/v1/business/professionals').set(a.owner).send({ displayName: 'Ana' }).expect(201);
    await http().put(`/api/v1/business/professionals/${pro.body.id}/schedule`).set(b.owner).send({ ranges: [] }).expect(404);
    await http().put(`/api/v1/business/professionals/${pro.body.id}`).set(b.owner).send({ displayName: 'Otra' }).expect(404);
  });

  it('el staff no puede crear servicios ni editar el horario de otro profesional', async () => {
    const biz = await createBusiness();
    const pro = await http().post('/api/v1/business/professionals').set(biz.owner).send({ displayName: 'Ana' }).expect(201);
    const staff = asUser(uuid(), { tenant: { businessId: biz.businessId, role: 'STAFF' } });
    await http().post('/api/v1/business/services').set(staff).send({ name: 'X', durationMin: 30, priceCents: 1 }).expect(403);
    await http().put(`/api/v1/business/professionals/${pro.body.id}/schedule`).set(staff).send({ ranges: [] }).expect(403);
    await http().get('/api/v1/business/professionals').set(staff).expect(200);
  });

  it('rechaza requests sin token interno', async () => {
    await http().get('/api/v1/business/professionals').set('x-business-id', uuid()).set('x-tenant-role', 'OWNER').expect(401);
  });

  it('valida tramos superpuestos y zonas horarias', async () => {
    const biz = await createBusiness();
    const pro = await http().post('/api/v1/business/professionals').set(biz.owner).send({ displayName: 'Ana' }).expect(201);
    await http()
      .put(`/api/v1/business/professionals/${pro.body.id}/schedule`)
      .set(biz.owner)
      .send({ ranges: [{ weekday: 1, startTime: '09:00', endTime: '13:00' }, { weekday: 1, startTime: '12:00', endTime: '14:00' }] })
      .expect(400);
    await http().patch('/api/v1/business').set(biz.owner).send({ timezone: 'Marte/Olympus' }).expect(400);
  });
});
