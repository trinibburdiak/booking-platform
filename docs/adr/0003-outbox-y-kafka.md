# ADR 0003 — Eventos con outbox y Kafka

**Estado:** aceptado · 2026-10-15

## Contexto

Cuando cambia un turno hay que avisar a otras partes: emails, recordatorios, la agenda en vivo y, en la etapa 5, otros servicios. Publicar directo a Kafka después de guardar en la base tiene dos fallas:

- Si la base commitea y Kafka falla (o la API se cae entre las dos cosas), el evento se pierde: el cliente no recibe el email.
- Si se publica antes del commit y la transacción hace rollback (por ejemplo, el exclusion constraint rechaza el turno), se avisa de algo que nunca pasó.

## Decisión

**Patrón outbox.** El evento se inserta en la tabla `outbox` dentro de la misma transacción que el cambio del turno. Un relay lee las filas sin publicar, las manda a Kafka y las marca con `published_at`.

- **Orden:** el relay toma un advisory lock de Postgres (`pg_try_advisory_xact_lock`), así publica una sola instancia a la vez y en orden de `id`.
- **Latencia:** después de cada commit, la API despierta al relay (`kick()`); el polling (1 s) queda como respaldo.
- **Un tópico, clave = bookingId:** todos los eventos de turnos van a `booking.events`. Con un tópico por tipo, `booking.cancelled` podría procesarse antes que `booking.confirmed` del mismo turno. Con un solo tópico y la misma clave, caen en la misma partición y llegan en orden.
- **Al menos una vez:** si el relay publica y se cae antes de marcar, el evento se vuelve a mandar. Cada consumidor registra los `eventId` procesados en `processed_events` y descarta duplicados. Si el procesamiento falla, libera el registro para que el reintento de Kafka lo tome.
- **Dos tipos de consumidor:**
  - `notifications` (un grupo compartido): emails y recordatorios, una sola vez aunque haya varias instancias.
  - `agenda-realtime-{host}-{pid}` (un grupo por instancia): cada instancia recibe todo y avisa a sus propios sockets.

## Consecuencias

- Ningún evento se pierde ni se inventa: el evento existe si y solo si el cambio se commiteó.
- La reserva no depende de que Kafka esté arriba: si cae, los eventos esperan en `outbox` y salen cuando vuelve.
- Hay una pequeña demora (milisegundos) entre el commit y el aviso.
- Los grupos `agenda-realtime-*` de instancias viejas quedan en Kafka hasta que expiran sus offsets (7 días por defecto).
- El caché de disponibilidad se sigue invalidando de forma síncrona en la API, no por evento, para que la siguiente consulta ya vea el cambio.
