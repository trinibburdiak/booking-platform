import { SERVICE_URLS } from '@turnos/common';

/**
 * - none:   pública (el servicio igual puede leer el usuario si viene token)
 * - user:   exige un access token válido
 * - tenant: además exige X-Business-Id de un negocio al que el usuario pertenece
 */
export type Access = 'none' | 'user' | 'tenant';
export type Bucket = 'auth' | 'availability' | 'booking-write' | 'default';

export interface Route {
  method?: string;
  pattern: RegExp;
  target: () => string;
  access: Access;
  bucket?: Bucket;
}

const UUID = '[0-9a-fA-F-]{36}';

/** Rutas bajo /api/v1, en orden: gana la primera que coincide. /internal nunca se expone. */
export const ROUTES: Route[] = [
  { pattern: /^\/auth\/me$/, target: SERVICE_URLS.auth, access: 'user' },
  { pattern: /^\/auth\/(register|login)$/, target: SERVICE_URLS.auth, access: 'none', bucket: 'auth' },
  { pattern: /^\/auth\/(refresh|logout)$/, target: SERVICE_URLS.auth, access: 'none' },

  { pattern: /^\/public\/businesses\/[^/]+\/availability$/, target: SERVICE_URLS.booking, access: 'none', bucket: 'availability' },
  { pattern: /^\/public\/businesses\/[^/]+$/, target: SERVICE_URLS.business, access: 'none' },

  { method: 'POST', pattern: /^\/businesses$/, target: SERVICE_URLS.business, access: 'user' },

  { pattern: /^\/business\/(agenda|metrics)$/, target: SERVICE_URLS.booking, access: 'tenant' },
  { pattern: new RegExp(`^/business/bookings/${UUID}/attendance$`), target: SERVICE_URLS.booking, access: 'tenant' },
  { pattern: /^\/business(\/.*)?$/, target: SERVICE_URLS.business, access: 'tenant' },

  { method: 'POST', pattern: /^\/bookings\/cancel$/, target: SERVICE_URLS.booking, access: 'none', bucket: 'booking-write' },
  { method: 'POST', pattern: /^\/bookings$/, target: SERVICE_URLS.booking, access: 'user', bucket: 'booking-write' },
  { pattern: /^\/bookings\/.+$/, target: SERVICE_URLS.booking, access: 'user', bucket: 'booking-write' },
  { pattern: /^\/me\/bookings$/, target: SERVICE_URLS.booking, access: 'user' },

  { method: 'GET', pattern: /^\/payments\/booking\/[^/]+$/, target: SERVICE_URLS.payments, access: 'user' },
  // Checkout simulado: lo abre el navegador sin token (el id del pago es un UUID imposible de adivinar)
  { pattern: /^\/payments\/sandbox\/[^/]+(\/(approve|reject))?$/, target: SERVICE_URLS.payments, access: 'none', bucket: 'booking-write' },
  // Mercado Pago llama acá; payments-service verifica la firma
  { method: 'POST', pattern: /^\/webhooks\/mercadopago$/, target: SERVICE_URLS.payments, access: 'none' },
];

export function matchRoute(method: string, path: string): Route | undefined {
  return ROUTES.find((r) => (!r.method || r.method === method) && r.pattern.test(path));
}

/** Requests por minuto por IP. Más estricto en login, disponibilidad pública y reservas, para frenar bots. */
export const LIMITS: Record<Bucket, number> = {
  auth: 20,
  availability: 120,
  'booking-write': 30,
  default: 600,
};
