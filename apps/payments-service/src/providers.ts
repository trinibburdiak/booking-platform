import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export interface CheckoutRequest {
  paymentId: string;
  bookingId: string;
  amountCents: number;
  description: string;
  expiresAt: Date;
}

export type ProviderStatus = 'approved' | 'rejected' | 'pending';

export interface PaymentProvider {
  readonly name: 'mercadopago' | 'sandbox';
  createCheckout(req: CheckoutRequest): Promise<{ checkoutUrl: string; providerRef: string }>;
  refund(providerPaymentId: string): Promise<void>;
}

const webUrl = () => process.env.PUBLIC_WEB_URL ?? 'http://localhost:5180';

/** Página de vuelta en el front: muestra el estado del turno y del pago. */
export const bookingPage = (bookingId: string) => `${webUrl()}/reservas/${bookingId}`;

/**
 * Checkout simulado, para desarrollo y demo sin credenciales: el link lleva a una
 * página de este servicio con dos botones (aprobar / rechazar) que producen el
 * mismo resultado que el webhook de Mercado Pago.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox' as const;

  async createCheckout(req: CheckoutRequest) {
    return { checkoutUrl: `${webUrl()}/api/v1/payments/sandbox/${req.paymentId}`, providerRef: req.paymentId };
  }

  async refund() {
    /* nada que devolver: no hubo plata real */
  }
}

/**
 * Mercado Pago (Checkout Pro). Con un access token de prueba (TEST-...) se usa el
 * sandbox de MP. Las notificaciones llegan por webhook a /webhooks/mercadopago:
 * MP_NOTIFICATION_URL tiene que ser una URL pública (en local, un túnel tipo ngrok).
 */
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago' as const;
  private readonly logger = new Logger(MercadoPagoProvider.name);
  private readonly api = 'https://api.mercadopago.com';

  constructor(private readonly accessToken: string) {}

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        ...(idempotencyKey && { 'x-idempotency-key': idempotencyKey }),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(`Mercado Pago ${method} ${path} → ${res.status}: ${data.message ?? ''}`);
    return data;
  }

  async createCheckout(req: CheckoutRequest) {
    const back = bookingPage(req.bookingId);
    const pref = await this.call<{ id: string; init_point: string; sandbox_init_point: string }>(
      'POST',
      '/checkout/preferences',
      {
        items: [{ title: req.description, quantity: 1, unit_price: req.amountCents / 100, currency_id: 'ARS' }],
        external_reference: req.paymentId,
        back_urls: { success: back, failure: back, pending: back },
        auto_return: 'approved',
        notification_url: process.env.MP_NOTIFICATION_URL || undefined,
        expires: true,
        expiration_date_to: req.expiresAt.toISOString(),
      },
      req.paymentId,
    );
    const sandbox = this.accessToken.startsWith('TEST-');
    return { checkoutUrl: sandbox ? pref.sandbox_init_point : pref.init_point, providerRef: pref.id };
  }

  /** Estado real del pago: el webhook solo trae el id, nunca se confía en el body. */
  async getPayment(mpPaymentId: string) {
    const p = await this.call<{ id: number; status: string; status_detail: string; external_reference: string }>(
      'GET',
      `/v1/payments/${encodeURIComponent(mpPaymentId)}`,
    );
    const status: ProviderStatus = p.status === 'approved' ? 'approved' : ['rejected', 'cancelled'].includes(p.status) ? 'rejected' : 'pending';
    return { status, detail: p.status_detail, paymentId: p.external_reference, mpPaymentId: String(p.id) };
  }

  async refund(providerPaymentId: string) {
    await this.call('POST', `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds`, {}, `refund-${providerPaymentId}`);
    this.logger.log(`Devolución pedida a Mercado Pago para el pago ${providerPaymentId}`);
  }
}

/**
 * Firma del webhook de Mercado Pago: header `x-signature: ts=...,v1=...`, HMAC-SHA256
 * con el secreto del panel de MP sobre `id:{data.id};request-id:{x-request-id};ts:{ts};`.
 */
export function verifyMercadoPagoSignature(opts: {
  secret: string;
  signature: string | undefined;
  requestId: string | undefined;
  dataId: string;
}): boolean {
  if (!opts.signature) return false;
  const parts = Object.fromEntries(opts.signature.split(',').map((p) => p.trim().split('=') as [string, string]));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${opts.dataId.toLowerCase()};request-id:${opts.requestId ?? ''};ts:${parts.ts};`;
  const expected = createHmac('sha256', opts.secret).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function providerFromEnv(): PaymentProvider {
  const token = process.env.MP_ACCESS_TOKEN;
  return token ? new MercadoPagoProvider(token) : new SandboxProvider();
}
