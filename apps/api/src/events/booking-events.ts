import { randomUUID } from 'crypto';

/**
 * Eventos de dominio de un turno. En el monolito viajan por un EventEmitter en
 * memoria; en la etapa 4 se publican en Kafka con el patrón outbox, con la
 * misma forma (eventId, eventType, occurredAt, businessId, payload).
 */
export type BookingEventType =
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
  /** Solo en booking.rescheduled */
  previous?: { professionalId: string; start: string };
  /** Solo en booking.cancelled */
  cancelledBy?: 'CLIENT' | 'BUSINESS';
}

export interface BookingEvent {
  eventId: string;
  eventType: BookingEventType;
  occurredAt: string;
  businessId: string;
  payload: BookingEventPayload;
}

export function bookingEvent(eventType: BookingEventType, businessId: string, payload: BookingEventPayload): BookingEvent {
  return { eventId: randomUUID(), eventType, occurredAt: new Date().toISOString(), businessId, payload };
}
