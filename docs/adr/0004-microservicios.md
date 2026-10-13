# ADR 0004 — Separar en microservicios

**Estado:** aceptado · 2026-10-16

## Contexto

El monolito modular (etapas 2 a 4) ya tenía módulos con límites claros y eventos con outbox. La etapa 5 los separa en servicios desplegables por separado, cada uno dueño de sus datos.

## Decisión

| Servicio | Puerto | Base | Publica | Consume |
| --- | --- | --- | --- | --- |
| api-gateway | 3000 | — (Redis) | — | — |
| auth-service | 3001 | turnos_auth | `auth.events` (user.registered) | `business.events` |
| business-service | 3002 | turnos_business | `business.events` | — |
| booking-service | 3003 | turnos_booking | `booking.events` | `business.events`, `auth.events` |
| notifications-service | 3004 | turnos_notifications | — | `booking.events` |

**Gateway como única puerta.** Valida el JWT, pide las membresías a auth (caché de 15 s en Redis), verifica que `X-Business-Id` sea un negocio del usuario y pasa el resultado en headers (`x-user-id`, `x-user-memberships`, `x-tenant-role`). Descarta esos headers si los manda el cliente. Los servicios no validan tokens: confían en esos headers solo si llega el `x-internal-token` correcto. El rate limiting también vive en el gateway, con contadores en Redis.

**Réplicas por eventos en lugar de llamadas síncronas.** booking-service guarda una copia del catálogo (negocios, servicios, profesionales, horarios, excepciones) y de los clientes. Los eventos de `business.events` llevan el estado completo y la clave es el `businessId`, así llegan en orden y el consumidor solo reemplaza su copia. Calcular disponibilidad no depende de que business-service esté arriba.

**Pocas llamadas internas, solo donde hace falta el dato fresco o sensible:**
- gateway → auth: membresías del usuario (con caché).
- notifications → booking: datos del turno para el email, incluido el token de cancelación. Así ese token no viaja por Kafka.
- notifications → auth: membresía al abrir el WebSocket de la agenda.

Los endpoints `/internal/*` no los rutea el gateway y exigen el token interno.

**Borrado lógico.** business-service ya no sabe si un profesional o servicio tiene turnos (eso vive en booking), así que "eliminar" siempre desactiva.

## Consecuencias

- **Consistencia eventual en el alta de un negocio.** La membresía OWNER la crea auth al consumir `business.created`. El wizard del front espera a que aparezca en `/auth/me`, y el gateway vuelve a pedir las membresías si no encuentra el negocio en caché. En la práctica tarda milisegundos.
- **La réplica puede atrasarse** un instante: un cambio de horario se ve en la disponibilidad cuando booking consume el evento. La garantía contra el doble booking no cambia, porque es el exclusion constraint de la base de booking.
- **El seed pasa por el gateway** como un usuario más (`infra/seed/seed.mjs`). Así cada base y cada réplica se llenan por el camino real.
- **Más piezas para levantar.** `pnpm dev` arranca los cinco servicios y el front; los tests de cada servicio levantan su propia infraestructura con Testcontainers.
