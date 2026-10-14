# ADR 0005 — Seña con Mercado Pago y vencimiento de reservas

**Estado:** aceptado · 2026-10-17

## Contexto

Algunos negocios quieren cobrar una seña para reducir el ausentismo. Mientras el cliente paga, el horario tiene que quedar reservado; si no paga, se tiene que liberar solo. El pago lo confirma un tercero (Mercado Pago), de forma asíncrona y a veces tarde.

## Decisión

**Estados.** Con seña, el turno se crea `PENDING` con `expires_at` (15 minutos, `DEPOSIT_MINUTES`). `PENDING` cuenta para el exclusion constraint igual que `CONFIRMED`, así nadie más puede tomar el horario mientras tanto.

**Flujo por eventos:**

1. booking-service crea el turno `PENDING` y publica `booking.created` (con monto y vencimiento). También programa el job diferido `expire-pending` en BullMQ, con `jobId = bookingId`.
2. payments-service consume `booking.created` y crea el cobro en el proveedor (preferencia de Checkout Pro). notifications manda el email con el link de pago.
3. Mercado Pago avisa por webhook. payments-service verifica la firma `x-signature`, consulta el pago real a la API de MP (nunca confía en el body) y publica `payment.approved` o `payment.failed`.
4. booking-service consume `payments.events`:
   - aprobado → `CONFIRMED`, y `booking.confirmed` dispara el email de confirmación y el recordatorio;
   - rechazado → `EXPIRED`, que libera el horario.
5. Si nadie paga, `expire-pending` pasa el turno a `EXPIRED` y publica `booking.expired`.

**Pago tardío.** Si llega `payment.approved` para un turno ya vencido, booking intenta volver a confirmarlo. Si otro cliente tomó el horario, el exclusion constraint lo impide, y booking publica `booking.refund_required`; payments devuelve la seña y publica `payment.refunded`.

**Proveedor intercambiable.** Con `MP_ACCESS_TOKEN` se usa Mercado Pago; un token de prueba `TEST-…` usa su sandbox. Sin token, se usa un checkout simulado servido por payments-service, con botones de aprobar y rechazar que siguen el mismo camino que el webhook. Así el flujo completo se puede probar en local, en CI y en la demo sin credenciales.

## Consecuencias

- El cobro nunca bloquea la reserva: si payments o Mercado Pago están caídos, el turno queda `PENDING` y vence solo.
- Todo es idempotente: un pago se aplica una sola vez (`status = CREATED` en el `WHERE`), los eventos repetidos se descartan por `eventId`, y los jobs usan el `bookingId` como id.
- Para recibir webhooks reales en local hace falta una URL pública (`MP_NOTIFICATION_URL`, por ejemplo con ngrok).
- La seña no se devuelve si el cliente cancela un turno confirmado; esa política queda para más adelante.
