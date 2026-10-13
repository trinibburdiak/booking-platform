import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Infra, startInfra, uuid } from '@turnos/testing';
import { createServer, IncomingMessage, Server } from 'http';
import type Redis from 'ioredis';
import { AddressInfo } from 'net';
import { join } from 'path';
import request from 'supertest';
import { createGatewayApp } from '../src/app';

/** Un servicio falso por destino: responde quién es y qué le llegó. */
const memberships = new Map<string, { businessId: string; role: string }[]>();
const stubs: Server[] = [];

async function stub(name: string) {
  const server = createServer((req: IncomingMessage, res) => {
    const m = req.url?.match(/^\/internal\/users\/(.+)\/memberships$/);
    if (name === 'auth' && m) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(memberships.get(m[1]) ?? []));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: name, url: req.url, headers: req.headers, body })),
    );
  });
  await new Promise<void>((r) => server.listen(0, r));
  stubs.push(server);
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

let app: INestApplication;
let redis: Redis;
let infra: Infra;
let jwt: JwtService;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  process.env.AUTH_URL = await stub('auth');
  process.env.BUSINESS_URL = await stub('business');
  process.env.BOOKING_URL = await stub('booking');
  process.env.NOTIFICATIONS_URL = await stub('notifications');
  infra = await startInfra({ serviceDir: join(__dirname, '..'), redis: true });
  ({ app, redis } = await createGatewayApp());
  jwt = app.get(JwtService);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await redis?.quit();
  await infra?.stop();
  stubs.forEach((s) => s.close());
});

const tokenFor = (userId: string) => jwt.signAsync({ sub: userId, email: `${userId}@test.dev` });

describe('ruteo', () => {
  it.each([
    ['GET', '/api/v1/public/businesses/demo/availability?date=2030-01-01', 'booking'],
    ['GET', '/api/v1/public/businesses/demo', 'business'],
    ['POST', '/api/v1/auth/login', 'auth'],
    ['POST', '/api/v1/bookings/cancel?token=abc', 'booking'],
  ])('%s %s → %s', async (method, path, service) => {
    const res = await (method === 'GET' ? http().get(path) : http().post(path).send({ a: 1 })).expect(200);
    expect(res.body.service).toBe(service);
    expect(res.body.url).toBe(path); // el prefijo /api/v1 se conserva
    expect(res.body.headers['x-internal-token']).toBe(process.env.INTERNAL_TOKEN ?? 'dev-internal-token');
  });

  it('los endpoints /internal no se exponen', async () => {
    await http().get(`/api/v1/internal/users/${uuid()}/memberships`).expect(404);
    await http().get(`/internal/users/${uuid()}/memberships`).expect(404);
  });

  it('el body llega intacto al servicio', async () => {
    const res = await http().post('/api/v1/auth/register').send({ email: 'a@b.c', fullName: 'Ana' }).expect(200);
    expect(JSON.parse(res.body.body)).toEqual({ email: 'a@b.c', fullName: 'Ana' });
  });
});

describe('autenticación y negocio', () => {
  it('descarta los headers de confianza que manda el cliente', async () => {
    const res = await http()
      .get('/api/v1/public/businesses/demo')
      .set('x-user-id', 'hacker')
      .set('x-tenant-role', 'OWNER')
      .set('x-internal-token', 'falso')
      .expect(200);
    expect(res.body.headers['x-user-id']).toBeUndefined();
    expect(res.body.headers['x-tenant-role']).toBeUndefined();
    expect(res.body.headers['x-internal-token']).not.toBe('falso');
  });

  it('rutas privadas: 401 sin token o con token inválido', async () => {
    await http().get('/api/v1/me/bookings').expect(401);
    await http().get('/api/v1/me/bookings').set('Authorization', 'Bearer basura').expect(401);
  });

  it('con token, pasa el usuario y sus membresías', async () => {
    const userId = uuid();
    const businessId = uuid();
    memberships.set(userId, [{ businessId, role: 'STAFF' }]);
    const res = await http().get('/api/v1/me/bookings').set('Authorization', `Bearer ${await tokenFor(userId)}`).expect(200);
    expect(res.body.headers['x-user-id']).toBe(userId);
    expect(JSON.parse(res.body.headers['x-user-memberships'])).toEqual([{ businessId, role: 'STAFF' }]);
  });

  it('rutas de gestión: exige X-Business-Id de un negocio propio y pasa el rol', async () => {
    const userId = uuid();
    const mine = uuid();
    memberships.set(userId, [{ businessId: mine, role: 'OWNER' }]);
    const auth = `Bearer ${await tokenFor(userId)}`;

    await http().get('/api/v1/business/services').set('Authorization', auth).expect(403);
    await http().get('/api/v1/business/services').set('Authorization', auth).set('X-Business-Id', uuid()).expect(403);

    const ok = await http().get('/api/v1/business/services').set('Authorization', auth).set('X-Business-Id', mine).expect(200);
    expect(ok.body.service).toBe('business');
    expect(ok.body.headers['x-tenant-role']).toBe('OWNER');

    const agenda = await http().get('/api/v1/business/agenda').set('Authorization', auth).set('X-Business-Id', mine).expect(200);
    expect(agenda.body.service).toBe('booking');
  });

  it('si la membresía es nueva (no está en caché), la vuelve a pedir', async () => {
    const userId = uuid();
    const auth = `Bearer ${await tokenFor(userId)}`;
    memberships.set(userId, []);
    await http().get('/api/v1/me/bookings').set('Authorization', auth).expect(200); // cachea la lista vacía
    const created = uuid();
    memberships.set(userId, [{ businessId: created, role: 'OWNER' }]); // auth la creó por evento
    await http().get('/api/v1/business').set('Authorization', auth).set('X-Business-Id', created).expect(200);
  });

  it('cada respuesta lleva un x-request-id para seguir la request entre servicios', async () => {
    const res = await http().get('/api/v1/public/businesses/demo').expect(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.headers['x-request-id']).toBe(res.headers['x-request-id']);
  });
});

describe('rate limiting', () => {
  it('limita login a 20 por minuto por IP', async () => {
    process.env.RATE_LIMIT_IN_TESTS = '1';
    try {
      const results = [];
      for (let i = 0; i < 21; i++) results.push((await http().post('/api/v1/auth/login').send({})).status);
      expect(results.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(results[20]).toBe(429);
    } finally {
      delete process.env.RATE_LIMIT_IN_TESTS;
    }
  });
});
