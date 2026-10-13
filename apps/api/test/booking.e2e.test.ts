import { randomUUID } from 'crypto';
import { createBusiness, registerUser, startApp, stopApp, TestContext, tomorrowSlots } from './setup';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startApp();
}, 180_000);

afterAll(() => stopApp(ctx));

const book = (token: string, body: object, key = randomUUID()) =>
  ctx.http().post('/api/v1/bookings').auth(token, { type: 'bearer' }).set('Idempotency-Key', key).send(body);

describe('doble booking', () => {
  it('20 reservas en paralelo al mismo slot: solo una gana, el resto recibe 409', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const clients = await Promise.all(Array.from({ length: 20 }, (_, i) => registerUser(ctx, `Cliente ${i}`)));

    const responses = await Promise.all(
      clients.map((c) => book(c.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start })),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    expect(responses.find((r) => r.status === 409)!.body.code).toBe('SLOT_TAKEN');

    const rows = await ctx.prisma.booking.count({ where: { professionalId: biz.professionalId } });
    expect(rows).toBe(1);
  });

  it('el constraint de la base rechaza superposiciones aunque se saltee la API', async () => {
    const biz = await createBusiness(ctx);
    const client = await registerUser(ctx);
    const start = new Date('2030-01-07T12:00:00Z');
    const base = {
      businessId: biz.businessId,
      professionalId: biz.professionalId,
      serviceId: biz.serviceId,
      clientId: client.id,
      status: 'CONFIRMED' as const,
      priceCents: 1000,
    };
    const insert = (offsetMin: number) => {
      const s = new Date(start.getTime() + offsetMin * 60_000);
      const e = new Date(s.getTime() + 30 * 60_000);
      return ctx.prisma.booking.create({
        data: { ...base, startsAt: s, endsAt: e, blockedUntil: e, cancelToken: randomUUID(), idempotencyKey: randomUUID() },
      });
    };

    const results = await Promise.allSettled(Array.from({ length: 20 }, () => insert(0)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    await expect(insert(15)).rejects.toThrow(); // se superpone parcialmente
    await expect(insert(30)).resolves.toBeDefined(); // [) : termina justo donde empieza el otro
  });

  it('un turno cancelado libera el horario', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const a = await registerUser(ctx);
    const b = await registerUser(ctx);
    const body = { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start };

    const first = await book(a.token, body).expect(201);
    await book(b.token, body).expect(409);
    await ctx.http().post(`/api/v1/bookings/${first.body.id}/cancel`).auth(a.token, { type: 'bearer' }).expect(200);
    await book(b.token, body).expect(201);
  });
});

describe('idempotencia', () => {
  it('la misma Idempotency-Key devuelve el mismo turno sin duplicar', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    const key = randomUUID();
    const body = { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start };

    const [r1, r2] = await Promise.all([book(client.token, body, key), book(client.token, body, key)]);
    expect([r1.status, r2.status].every((s) => s === 201)).toBe(true);
    expect(r1.body.id).toBe(r2.body.id);
    expect(await ctx.prisma.booking.count({ where: { clientId: client.id } })).toBe(1);
  });

  it('exige el header Idempotency-Key', async () => {
    const client = await registerUser(ctx);
    await ctx
      .http()
      .post('/api/v1/bookings')
      .auth(client.token, { type: 'bearer' })
      .send({ businessSlug: 'x-y-z', serviceId: randomUUID(), start: new Date().toISOString() })
      .expect(400);
  });
});

describe('disponibilidad', () => {
  it('un slot reservado deja de aparecer', async () => {
    const biz = await createBusiness(ctx);
    const slots = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    await book(client.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slots[2].start }).expect(201);
    const after = (await tomorrowSlots(ctx, biz.slug, biz.serviceId)).map((s) => s.start);
    expect(after).not.toContain(slots[2].start);
    expect(after).toContain(slots[0].start);
  });

  it('rechaza un horario fuera de la grilla', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    const odd = new Date(new Date(slot.start).getTime() + 7 * 60_000).toISOString();
    await book(client.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: odd }).expect(409);
  });
});

describe('cancelación y reprogramación', () => {
  it('el cliente no puede cancelar dentro del plazo; el negocio sí', async () => {
    const biz = await createBusiness(ctx, { cancellationHours: 72 });
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    const res = await book(client.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
    expect(res.body.canClientCancel).toBe(false);

    await ctx.http().post(`/api/v1/bookings/${res.body.id}/cancel`).auth(client.token, { type: 'bearer' }).expect(403);
    await ctx
      .http()
      .post(`/api/v1/bookings/${res.body.id}/cancel`)
      .auth(biz.owner.token, { type: 'bearer' })
      .expect(200);
  });

  it('cancela con el token del email, una sola vez', async () => {
    const biz = await createBusiness(ctx);
    const [slot] = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const client = await registerUser(ctx);
    const res = await book(client.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slot.start }).expect(201);
    const { cancelToken } = await ctx.prisma.booking.findUniqueOrThrow({ where: { id: res.body.id } });

    await ctx.http().post('/api/v1/bookings/cancel').query({ token: cancelToken }).expect(200);
    await ctx.http().post('/api/v1/bookings/cancel').query({ token: cancelToken }).expect(409);
    await ctx.http().post('/api/v1/bookings/cancel').query({ token: 'inventado' }).expect(404);
  });

  it('reprogramar a un horario ocupado da 409 y a uno libre mueve el turno', async () => {
    const biz = await createBusiness(ctx);
    const slots = await tomorrowSlots(ctx, biz.slug, biz.serviceId);
    const a = await registerUser(ctx);
    const b = await registerUser(ctx);
    const mine = await book(a.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slots[0].start }).expect(201);
    await book(b.token, { businessSlug: biz.slug, serviceId: biz.serviceId, start: slots[4].start }).expect(201);

    const move = (start: string) =>
      ctx.http().post(`/api/v1/bookings/${mine.body.id}/reschedule`).auth(a.token, { type: 'bearer' }).send({ start });

    await move(slots[4].start).expect(409);
    const moved = await move(slots[1].start).expect(200); // se superpone con su propio horario anterior: está permitido
    expect(moved.body.start).toBe(slots[1].start);
  });
});

describe('multi-tenancy y roles', () => {
  it('un dueño no puede ver la agenda de otro negocio', async () => {
    const a = await createBusiness(ctx);
    const b = await createBusiness(ctx);
    const range = { from: new Date().toISOString(), to: new Date(Date.now() + 7 * 86_400_000).toISOString() };

    await ctx
      .http()
      .get('/api/v1/business/agenda')
      .query(range)
      .auth(b.owner.token, { type: 'bearer' })
      .set('X-Business-Id', a.businessId)
      .expect(403);

    // Con su propio negocio en el header, tampoco puede tocar recursos del otro
    await b.asOwner(ctx.http().put(`/api/v1/business/professionals/${a.professionalId}/schedule`)).send({ ranges: [] }).expect(404);
    await b.asOwner(ctx.http().get('/api/v1/business/agenda')).query(range).expect(200);
  });

  it('el staff no puede crear servicios ni editar el horario de otro profesional', async () => {
    const biz = await createBusiness(ctx);
    const staff = await registerUser(ctx, 'Staff');
    await ctx.prisma.membership.create({ data: { userId: staff.id, businessId: biz.businessId, role: 'STAFF' } });
    const asStaff = (r: ReturnType<ReturnType<TestContext['http']>['get']>) =>
      r.auth(staff.token, { type: 'bearer' }).set('X-Business-Id', biz.businessId);

    await asStaff(ctx.http().post('/api/v1/business/services'))
      .send({ name: 'X', durationMin: 30, priceCents: 1 })
      .expect(403);
    await asStaff(ctx.http().put(`/api/v1/business/professionals/${biz.professionalId}/schedule`))
      .send({ ranges: [] })
      .expect(403);
    await asStaff(ctx.http().get('/api/v1/business/professionals')).expect(200);
  });

  it('rechaza requests sin token', async () => {
    await ctx.http().get('/api/v1/me/bookings').expect(401);
  });
});
