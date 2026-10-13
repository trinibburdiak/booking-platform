/**
 * Carga la "Barbería Demo" a través del gateway, como lo haría un usuario real.
 * Así cada servicio llena su propia base y las réplicas se arman por eventos.
 * Requiere el sistema corriendo (`pnpm dev:services`). Se puede correr varias veces.
 *
 *   Dueña:   demo@turnos.dev    / demo1234
 *   Cliente: cliente@turnos.dev / demo1234
 */
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const SLUG = 'barberia-demo';
const TZ = 'America/Argentina/Cordoba';
const PASSWORD = 'demo1234';

async function call(method, path, { token, businessId, body, idempotencyKey, ok = [200, 201, 204] } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
      ...(businessId && { 'x-business-id': businessId }),
      ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!ok.includes(res.status)) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return { status: res.status, data };
}

/** Registra al usuario o, si ya existe, inicia sesión. */
async function session(email, fullName, phone) {
  const reg = await call('POST', '/auth/register', { body: { email, password: PASSWORD, fullName, phone }, ok: [201, 409] });
  if (reg.status === 201) return reg.data;
  return (await call('POST', '/auth/login', { body: { email, password: PASSWORD } })).data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Tiempo agotado esperando ${what}`);
    await sleep(300);
  }
}

const localDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });

async function main() {
  const owner = await session('demo@turnos.dev', 'Dueña Demo', '+54 351 000-0000');
  const client = await session('cliente@turnos.dev', 'Cliente Demo', '+54 351 111-1111');

  const existing = await call('GET', `/public/businesses/${SLUG}`, { ok: [200, 404] });
  if (existing.status === 200) {
    console.log('La Barbería Demo ya existe: solo se agregan turnos si faltan.');
  } else {
    const { data: biz } = await call('POST', '/businesses', {
      token: owner.accessToken,
      body: { name: 'Barbería Demo', slug: SLUG, timezone: TZ, address: 'Bv. San Juan 123, Córdoba' },
    });
    // auth-service crea la membresía OWNER al consumir business.created
    await waitFor(
      async () => (await call('GET', '/auth/me', { token: owner.accessToken })).data.memberships.some((m) => m.businessId === biz.id),
      'la membresía OWNER',
    );
    const asOwner = (method, path, body) => call(method, path, { token: owner.accessToken, businessId: biz.id, body });

    await asOwner('PATCH', '/business', { cancellationHours: 12, bookingWindowDays: 30, minNoticeMinutes: 60 });
    const corte = (await asOwner('POST', '/business/services', { name: 'Corte', durationMin: 30, bufferMin: 5, priceCents: 900000 })).data;
    const barba = (await asOwner('POST', '/business/services', { name: 'Barba', durationMin: 20, bufferMin: 5, priceCents: 600000 })).data;
    const combo = (await asOwner('POST', '/business/services', { name: 'Corte + barba', durationMin: 50, bufferMin: 10, priceCents: 1350000 })).data;

    const lucia = (await asOwner('POST', '/business/professionals', { displayName: 'Lucía', serviceIds: [corte.id, barba.id, combo.id] })).data;
    const mateo = (await asOwner('POST', '/business/professionals', { displayName: 'Mateo', serviceIds: [corte.id, combo.id] })).data;

    await asOwner('PUT', `/business/professionals/${lucia.id}/schedule`, {
      ranges: [
        ...[1, 2, 3, 4, 5].flatMap((weekday) => [
          { weekday, startTime: '09:00', endTime: '13:00' },
          { weekday, startTime: '16:00', endTime: '20:00' },
        ]),
        { weekday: 6, startTime: '09:00', endTime: '14:00' },
      ],
    });
    await asOwner('PUT', `/business/professionals/${mateo.id}/schedule`, {
      ranges: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '11:00', endTime: '19:00' })),
    });
    await asOwner('POST', `/business/professionals/${lucia.id}/exceptions`, { date: localDate(10), type: 'CLOSED', reason: 'Feriado' });
    console.log('Negocio, servicios, profesionales y horarios creados.');
  }

  // booking-service arma su réplica por eventos: esperar a que vea el negocio
  const pub = (await call('GET', `/public/businesses/${SLUG}`)).data;
  await waitFor(async () => {
    const r = await call('GET', `/public/businesses/${SLUG}/availability?serviceId=${pub.services[0].id}&date=${localDate(1)}`, { ok: [200, 404] });
    return r.status === 200;
  }, 'la réplica en booking-service');

  const mine = (await call('GET', '/me/bookings', { token: client.accessToken })).data;
  const upcoming = mine.filter((b) => b.status === 'CONFIRMED' && new Date(b.start) > new Date());
  if (upcoming.length >= 10) {
    console.log(`El cliente ya tiene ${upcoming.length} turnos próximos.`);
  } else {
    let created = 0;
    for (let d = 1; d <= 7; d++) {
      for (const service of pub.services.filter((s) => s.name !== 'Barba')) {
        const { data } = await call('GET', `/public/businesses/${SLUG}/availability?serviceId=${service.id}&date=${localDate(d)}`);
        // Un par de turnos por día, separados, para que la agenda se vea con vida
        for (const slot of data.slots.filter((_, i) => i % 9 === 3).slice(0, 2)) {
          const r = await call('POST', '/bookings', {
            token: client.accessToken,
            idempotencyKey: crypto.randomUUID(),
            body: { businessSlug: SLUG, serviceId: service.id, start: slot.start },
            ok: [201, 409],
          });
          if (r.status === 201) created++;
        }
      }
    }
    console.log(`${created} turnos creados.`);
  }
  console.log(`Listo: http://localhost:5180/b/${SLUG}`);
  console.log('Dueña: demo@turnos.dev / demo1234 — Cliente: cliente@turnos.dev / demo1234');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
