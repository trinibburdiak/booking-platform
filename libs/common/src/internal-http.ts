import { HttpException, InternalServerErrorException } from '@nestjs/common';
import { HEADERS, internalToken } from './gateway-auth';

/**
 * Llamada HTTP entre servicios (endpoints /internal/*, que el gateway no expone).
 * Propaga el token interno y traduce los errores a excepciones de Nest.
 */
export async function internalGet<T>(baseUrl: string, path: string, init: { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { [HEADERS.internalToken]: internalToken(), accept: 'application/json' },
    signal: AbortSignal.timeout(init.timeoutMs ?? 5_000),
  }).catch((e: Error) => {
    throw new InternalServerErrorException(`No se pudo llamar a ${baseUrl}${path}: ${e.message}`);
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new HttpException(body, res.status);
  }
  return (await res.json()) as T;
}

export const SERVICE_URLS = {
  auth: () => process.env.AUTH_URL ?? 'http://localhost:3001',
  business: () => process.env.BUSINESS_URL ?? 'http://localhost:3002',
  booking: () => process.env.BOOKING_URL ?? 'http://localhost:3003',
  notifications: () => process.env.NOTIFICATIONS_URL ?? 'http://localhost:3004',
};
