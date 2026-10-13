import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureService } from '@turnos/common';
import { BusinessEvent } from '@turnos/contracts';
import { envelope } from '@turnos/kafka';
import { asUser, Infra, startInfra, uuid, viaGateway, waitFor } from '@turnos/testing';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { BusinessEventsConsumer } from '../src/business-events.consumer';
import { PrismaService } from '../src/prisma.service';

let app: INestApplication;
let prisma: PrismaService;
let infra: Infra;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  infra = await startInfra({ serviceDir: join(__dirname, '..'), postgres: true, kafka: true });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = configureService(moduleRef.createNestApplication());
  app.use(cookieParser());
  await app.listen(0);
  prisma = app.get(PrismaService);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

const register = async (email = `${uuid()}@test.dev`) => {
  const res = await http().post('/api/v1/auth/register').set(viaGateway()).send({ email, password: 'password123', fullName: 'Ana Pérez' }).expect(201);
  const cookie = res.headers['set-cookie'] as unknown as string[];
  return { id: res.body.user.id as string, email, token: res.body.accessToken as string, cookie };
};

const refreshWith = (cookie: string[]) => http().post('/api/v1/auth/refresh').set(viaGateway()).set('Cookie', cookie);

describe('sesiones', () => {
  it('registro publica user.registered en el outbox (booking lo usa para la agenda)', async () => {
    const user = await register();
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { key: user.id } });
    expect(row.eventType).toBe('user.registered');
    expect(row.payload).toMatchObject({ payload: { userId: user.id, email: user.email, fullName: 'Ana Pérez' } });
    await waitFor(async () => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).publishedAt);
  });

  it('login con contraseña incorrecta da 401 y email repetido da 409', async () => {
    const user = await register();
    await http().post('/api/v1/auth/login').set(viaGateway()).send({ email: user.email, password: 'otra-cosa' }).expect(401);
    await http().post('/api/v1/auth/register').set(viaGateway()).send({ email: user.email, password: 'password123', fullName: 'Ana' }).expect(409);
  });

  it('refresh rota el token; reusar uno viejo revoca todas las sesiones', async () => {
    const user = await register();
    const first = await refreshWith(user.cookie).expect(200);
    const second = first.headers['set-cookie'] as unknown as string[];
    await refreshWith(user.cookie).expect(401); // reuso del token ya rotado
    await refreshWith(second).expect(401); // y eso revocó también el nuevo
  });
});

describe('membresías', () => {
  it('al consumir business.created, el creador queda como OWNER y /auth/me lo muestra', async () => {
    const user = await register();
    const businessId = uuid();
    const event = envelope('business.created', businessId, {
      ownerId: user.id,
      business: {
        id: businessId,
        slug: 'mi-negocio',
        name: 'Mi Negocio',
        timezone: 'UTC',
        address: null,
        cancellationHours: 24,
        bookingWindowDays: 30,
        minNoticeMinutes: 0,
      },
    }) as BusinessEvent;
    await app.get(BusinessEventsConsumer).handle(event);
    await app.get(BusinessEventsConsumer).handle(event); // duplicado: no hace nada

    const me = await http().get('/api/v1/auth/me').set(asUser(user.id)).expect(200);
    expect(me.body.memberships).toEqual([{ businessId, role: 'OWNER', businessName: 'Mi Negocio', businessSlug: 'mi-negocio' }]);

    const internal = await http().get(`/internal/users/${user.id}/memberships`).set(viaGateway()).expect(200);
    expect(internal.body).toEqual([{ businessId, role: 'OWNER' }]);
  });

  it('el endpoint interno no se puede usar sin token interno', async () => {
    await http().get(`/internal/users/${uuid()}/memberships`).expect(401);
  });
});
