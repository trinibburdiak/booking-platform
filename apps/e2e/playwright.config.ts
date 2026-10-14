import { defineConfig, devices } from '@playwright/test';

/**
 * Pruebas de punta a punta contra el sistema corriendo (`pnpm dev` + `pnpm db:seed`).
 * Localmente usa el Chrome instalado; en CI, el Chromium de Playwright.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // Todas las pruebas usan la misma Barbería Demo: en paralelo competirían por los mismos horarios
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:5180',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Cordoba',
    trace: 'retain-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    channel: process.env.CI ? undefined : 'chrome',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } }],
});
