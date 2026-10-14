/**
 * Catálogo de eventos entre servicios. Todos viajan con el mismo sobre
 * (eventId, eventType, occurredAt, businessId, payload) y se publican con outbox.
 *
 * Tópicos y claves:
 * - auth.events     (clave: userId)     — los publica auth-service
 * - business.events (clave: businessId) — los publica business-service; misma clave = orden por negocio
 * - booking.events  (clave: bookingId)  — los publica booking-service; misma clave = orden por turno
 * - payments.events (clave: bookingId)  — los publica payments-service
 */
export const TOPICS = {
  auth: 'auth.events',
  business: 'business.events',
  booking: 'booking.events',
  payments: 'payments.events',
} as const;

export interface EventEnvelope<T extends string = string, P = unknown> {
  eventId: string;
  eventType: T;
  occurredAt: string;
  /** x-request-id de la request que originó el evento: permite seguirla por todos los servicios */
  correlationId?: string;
  /** null en eventos que no son de un negocio (user.registered) */
  businessId: string | null;
  payload: P;
}

// ---------- auth.events ----------

export interface UserRegisteredPayload {
  userId: string;
  email: string;
  fullName: string;
  phone: string | null;
}

export type AuthEvent = EventEnvelope<'user.registered', UserRegisteredPayload>;

// ---------- business.events (estado completo: el consumidor reemplaza su copia) ----------

export interface BusinessState {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  address: string | null;
  cancellationHours: number;
  bookingWindowDays: number;
  minNoticeMinutes: number;
  requiresDeposit: boolean;
}

export interface ServiceState {
  id: string;
  businessId: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  priceCents: number;
  depositCents: number;
  active: boolean;
}

export interface ProfessionalState {
  id: string;
  businessId: string;
  userId: string | null;
  displayName: string;
  active: boolean;
  serviceIds: string[];
}

export interface ScheduleState {
  professionalId: string;
  schedules: { id: string; weekday: number; startTime: string; endTime: string }[];
  exceptions: {
    id: string;
    date: string;
    type: 'CLOSED' | 'EXTRA_HOURS';
    startTime: string | null;
    endTime: string | null;
  }[];
}

export type BusinessEvent =
  | EventEnvelope<'business.created', { business: BusinessState; ownerId: string }>
  | EventEnvelope<'business.updated', { business: BusinessState }>
  | EventEnvelope<'service.changed', { service: ServiceState }>
  | EventEnvelope<'professional.changed', { professional: ProfessionalState }>
  | EventEnvelope<'schedule.changed', ScheduleState>;

// ---------- booking.events ----------

export type BookingEventType =
  | 'booking.created'
  | 'booking.expired'
  | 'booking.refund_required'
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'booking.rescheduled'
  | 'booking.attendance'
  | 'booking.no_show';

export interface BookingEventPayload {
  bookingId: string;
  professionalId: string;
  clientId: string;
  start: string;
  end: string;
  status: string;
  /** Solo en booking.rescheduled */
  previous?: { professionalId: string; start: string };
  /** Solo en booking.cancelled */
  cancelledBy?: 'CLIENT' | 'BUSINESS';
  /** booking.created (con seña): monto y vencimiento del pago */
  depositCents?: number;
  expiresAt?: string;
  /** booking.expired: por qué venció */
  reason?: 'NOT_PAID' | 'PAYMENT_REJECTED';
}

export type BookingEvent = EventEnvelope<BookingEventType, BookingEventPayload>;

// ---------- payments.events ----------

export interface PaymentPayload {
  paymentId: string;
  bookingId: string;
  amountCents: number;
  provider: 'mercadopago' | 'sandbox';
}

export type PaymentEvent =
  | EventEnvelope<'payment.approved', PaymentPayload>
  | EventEnvelope<'payment.failed', PaymentPayload & { reason: string }>
  | EventEnvelope<'payment.refunded', PaymentPayload>;

// ---------- APIs internas (servicio a servicio, no pasan por el gateway) ----------

export interface InternalMembership {
  businessId: string;
  role: 'OWNER' | 'STAFF';
}

/** GET booking-service /internal/bookings/:id — lo usa notifications para armar los emails. */
export interface InternalBookingDetail {
  id: string;
  status: string;
  start: string;
  end: string;
  cancelToken: string;
  business: { id: string; slug: string; name: string; address: string | null; timezone: string; cancellationHours: number };
  service: { name: string; depositCents: number };
  professional: { displayName: string };
  client: { id: string; email: string; fullName: string };
  expiresAt: string | null;
}
