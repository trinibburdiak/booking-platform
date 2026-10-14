import { expect, Page, test } from '@playwright/test';

/**
 * Recorridos completos por el front, contra los seis servicios reales.
 * Necesita la Barbería Demo cargada (`pnpm db:seed`).
 */
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const OWNER = { email: 'demo@turnos.dev', password: 'demo1234' };
const CLIENT = { email: 'cliente@turnos.dev', password: 'demo1234' };

async function login(page: Page, who: { email: string; password: string }, next: string) {
  await page.goto(`/ingresar?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Contraseña').fill(who.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await page.waitForURL((url) => url.pathname === next.split('?')[0]);
}

/** Elige servicio, "cualquiera", un día al azar de las próximas dos semanas y el último horario libre. */
async function pickSlot(page: Page, service: RegExp) {
  await page.goto('/b/barberia-demo');
  await page.getByRole('button', { name: service }).click();
  const anyone = page.getByRole('button', { name: 'Cualquiera' });
  if (await anyone.isVisible()) await anyone.click();

  const days = page.locator('button[aria-pressed]').filter({ hasText: /oct|nov|dic|ene|feb|mar|abr|may|jun|jul|ago|sep/i });
  const slots = page.getByRole('button', { name: /^\d{2}:\d{2}$/ });
  for (const offset of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    await days.nth(offset).click();
    await page.waitForResponse((r) => r.url().includes('/availability'));
    if (await slots.count()) break;
  }
  const slot = slots.last();
  const label = await slot.textContent();
  await slot.click();
  return label!;
}

test('el cliente reserva y la dueña lo ve aparecer en vivo en su agenda', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await login(owner, OWNER, '/panel');
  await expect(owner.getByText(/^En vivo/)).toBeVisible();

  const clientCtx = await browser.newContext();
  const client = await clientCtx.newPage();
  await login(client, CLIENT, '/mis-turnos');
  const time = await pickSlot(client, /^Corte 30 min/);
  await client.getByRole('button', { name: 'Confirmar reserva' }).click();
  await expect(client.getByText('¡Turno confirmado!')).toBeVisible();

  // WebSocket: booking → Kafka → notifications → gateway → navegador de la dueña
  await expect(owner.getByRole("status").filter({ hasText: "Nuevo turno" })).toContainText(`${time} h`, { timeout: 30_000 });

  await ownerCtx.close();
  await clientCtx.close();
});

test.describe('con seña', () => {
  test.beforeAll(async ({ request }) => {
    // La dueña exige seña y la configura en "Corte + barba"
    const session = await (await request.post(`${API}/auth/login`, { data: OWNER })).json();
    const headers = { authorization: `Bearer ${session.accessToken}`, 'x-business-id': session.user.memberships[0].businessId };
    await request.patch(`${API}/business`, { headers, data: { requiresDeposit: true } });
    const services = await (await request.get(`${API}/business/services`, { headers })).json();
    const combo = services.find((s: { name: string }) => s.name === 'Corte + barba');
    await request.put(`${API}/business/services/${combo.id}`, {
      headers,
      data: { name: combo.name, durationMin: combo.durationMin, bufferMin: combo.bufferMin, priceCents: combo.priceCents, depositCents: 400000, active: true },
    });
  });

  test('reserva, paga la seña en el checkout y el turno queda confirmado', async ({ page }) => {
    await login(page, CLIENT, '/mis-turnos');
    // La réplica de booking recibe el cambio de seña por evento: reintentar hasta verlo
    await expect(async () => {
      await page.goto('/b/barberia-demo');
      await expect(page.getByText('Seña de $ 4.000')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    await pickSlot(page, /^Corte \+ barba/);
    await expect(page.getByText('se paga ahora para confirmar')).toBeVisible();
    await page.getByRole('button', { name: 'Reservar y pagar la seña' }).click();

    await page.waitForURL(/\/reservas\//);
    await expect(page.getByText('Pendiente')).toBeVisible();
    await page.getByRole('link', { name: /Pagar \$ 4\.000/ }).click();

    await expect(page.getByText('Checkout simulado')).toBeVisible();
    await page.getByRole('button', { name: 'Pagar (aprobar)' }).click();

    await page.waitForURL(/pago=aprobado/);
    await expect(page.getByText('¡Turno confirmado!')).toBeVisible();
  });

  test('si el pago se rechaza, la reserva vence y el horario se libera', async ({ page }) => {
    await login(page, CLIENT, '/mis-turnos');
    await expect(async () => {
      await page.goto('/b/barberia-demo');
      await expect(page.getByText('Seña de $ 4.000')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    await pickSlot(page, /^Corte \+ barba/);
    await page.getByRole('button', { name: 'Reservar y pagar la seña' }).click();
    await page.waitForURL(/\/reservas\//);
    await page.getByRole('link', { name: /Pagar \$ 4\.000/ }).click();
    await page.getByRole('button', { name: 'Rechazar el pago' }).click();

    await page.waitForURL(/pago=rechazado/);
    await expect(page.getByText(/La reserva se venció porque el pago fue rechazado/)).toBeVisible();
  });
});
