import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

/**
 * Eventos de dominio de un turno. Se escriben en el outbox dentro de la misma
 * transacción que el cambio y un relay los publica en Kafka.
 *
 * Todos van al tópico `booking.events` con clave = bookingId: así los eventos de
 * un mismo turno caen en la misma partición y llegan en orden (confirmado →
 * reprogramado → cancelado), cosa que no pasaría con un tópico por tipo.
 */
export const BOOKING_EVENTS_TOPIC = 'booking.events';

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
  status: string;
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

/** Fila del outbox para un evento de turno. */
export function outboxRow(event: BookingEvent): Prisma.OutboxEventCreateInput {
  return {
    eventId: event.eventId,
    topic: BOOKING_EVENTS_TOPIC,
    key: event.payload.bookingId,
    eventType: event.eventType,
    payload: event as unknown as Prisma.InputJsonValue,
  };
}
