# Turnos

Plataforma multi-tenant de turnos online: cada negocio (peluquería, consultorio, taller) tiene su página pública (`/b/mi-negocio`), carga profesionales, servicios y horarios, y sus clientes reservan sin llamar ni escribir por WhatsApp.

**Lo interesante del backend:** reservas concurrentes sin doble booking (exclusion constraint de Postgres), fechas y zonas horarias bien resueltas, y aislamiento entre negocios.

## Estado

| Etapa | Contenido | Estado |
| --- | --- | --- |
| 1. Base | Monorepo, Docker Compose, CI, seed del negocio demo | ✅ |
| 2. Monolito modular | NestJS (auth, business, booking), disponibilidad, reserva con exclusion constraint, cancelación y reprogramación. Front: página pública, wizard de reserva, mis turnos, panel y configuración | ✅ |
| 3. Agenda y notificaciones | Agenda con FullCalendar (día/semana, drag & drop), tiempo real con Socket.IO, emails de confirmación/reprogramación/cancelación, recordatorio 24 h antes y `mark-no-shows` con BullMQ, caché de disponibilidad en Redis | ✅ |
| 4. Eventos | Outbox en Postgres + relay a Kafka (`booking.events`, clave = bookingId); notificaciones y agenda en vivo consumen de Kafka con idempotencia | ✅ |
| 5. Microservicios | api-gateway + auth, business, booking y notifications, cada uno con su base; booking con réplica del catálogo y de clientes por eventos | ✅ |
| 6. Extras | Seña con Mercado Pago sandbox, drag & drop, Playwright | pendiente |

## Arquitectura

```
                 ┌───────────── web (React, :5180) ─────────────┐
                 │                                              │
                 ▼                                              │ WebSocket
          api-gateway :3000  ── JWT, membresías, rate limiting ─┤
     ┌──────────┬──────────┼───────────────┬──────────────┐     │
     ▼          ▼          ▼               ▼              ▼     │
  auth :3001  business :3002  booking :3003  notifications :3004 ◄┘
     │          │              │   ▲  réplica     │  emails, recordatorios
     │          │              │   │  catálogo    │  (BullMQ), agenda en vivo
     ▼          ▼              ▼   │  y clientes  ▼
  turnos_auth  turnos_business  turnos_booking   turnos_notifications
     │          │              │                  ▲
     └── auth.events ── business.events ── booking.events ──┘   Kafka (outbox en cada servicio)
```

Cada servicio es dueño de su base y publica sus cambios con outbox. El front solo habla con el gateway. Detalle en [ADR 0004](docs/adr/0004-microservicios.md).

## Cómo levantarlo

Requisitos: Node 22, pnpm 10, Docker.

```bash
pnpm install
pnpm db:up          # Postgres (5544), Redis (6380), Mailpit (8026), Kafka (9094), Kafka UI (8090)
pnpm db:migrate     # migra la base de cada servicio
pnpm dev            # gateway (3000), auth (3001), business (3002), booking (3003), notifications (3004) y web (5180)
pnpm db:seed        # en otra terminal, con todo corriendo: carga la Barbería Demo pasando por el gateway
```

Los `.env` de cada servicio salen de su `.env.example` (`apps/*/.env.example`).

Usuarios de prueba (contraseña `demo1234`): `cliente@turnos.dev` (cliente) y `demo@turnos.dev` (dueña de la Barbería Demo).

Los emails no salen a internet: se ven en Mailpit, http://localhost:8026. Los eventos se ven en Kafka UI, http://localhost:8090. Cada servicio tiene Swagger en `/docs` de su puerto.

## Tests

```bash
pnpm --filter @turnos/availability test   # unitarios de la lógica de disponibilidad
pnpm test                                 # todo: cada servicio levanta su Postgres, Redis y Kafka con Testcontainers (necesita Docker)
```

Lo que cubren:

- **Disponibilidad:** servicio que no entra al final del tramo, varios tramos por día, feriados, horas extra, buffer, aviso mínimo, ventana de reserva, turno que cruza la medianoche, cambio de día por UTC, DST.
- **Concurrencia:** 20 reservas en paralelo al mismo slot → una gana y 19 reciben `409`. También directo contra la base, salteando la API.
- **Idempotencia:** dos requests con la misma `Idempotency-Key` devuelven el mismo turno.
- **Multi-tenancy y roles:** un dueño no puede leer la agenda ni tocar recursos de otro negocio; el staff no puede crear servicios ni editar horarios ajenos.
- **Políticas:** cancelación dentro del plazo, link de cancelación de un solo uso, reprogramar a un horario ocupado.
- **Notificaciones:** email de confirmación con link de cancelación; recordatorio programado 24 h antes con `jobId = bookingId`, que se borra al cancelar y se reemplaza al reprogramar; el worker no manda recordatorios de turnos movidos.
- **Tiempo real:** el panel recibe el turno nuevo por WebSocket; quien no es del negocio no puede suscribirse.
- **Outbox y Kafka:** el turno y su evento se guardan juntos; una reserva rechazada no deja eventos; los eventos de un turno quedan en orden; un evento entregado dos veces manda un solo email.
- **Caché y jobs:** la disponibilidad se cachea en Redis y se invalida al cambiar el horario; `mark-no-shows` solo toca confirmados vencidos hace más de 24 h.

## Estructura

```
apps/
  api-gateway/            entrada única: JWT, tenant, rate limiting, proxy HTTP y WebSocket
  auth-service/           usuarios, sesiones, membresías
  business-service/       negocios, profesionales, servicios, horarios, excepciones
  booking-service/        disponibilidad, turnos (exclusion constraint), réplica del catálogo, mark-no-shows
  notifications-service/  emails, recordatorios con BullMQ, WebSocket de la agenda
  web/                    React + Vite + TanStack Query + FullCalendar + Tailwind
libs/
  availability/           lógica pura de disponibilidad y política de cancelación
  contracts/              esquemas Zod, DTOs y catálogo de eventos
  common/                 guards de headers del gateway, token interno, cliente HTTP interno, bootstrap
  kafka/                  cliente de Kafka, outbox relay y consumidor idempotente
  testing/                contenedores y helpers para los tests de integración
infra/                    docker-compose y seed
docs/adr/                 decisiones de arquitectura
```

## Decisiones clave

- [ADR 0001 — Exclusion constraint en lugar de locks en código](docs/adr/0001-exclusion-constraint.md)
- [ADR 0002 — Calcular la disponibilidad en vez de guardarla](docs/adr/0002-disponibilidad-calculada.md)
- [ADR 0003 — Eventos con outbox y Kafka](docs/adr/0003-outbox-y-kafka.md)
- [ADR 0004 — Separar en microservicios](docs/adr/0004-microservicios.md)

Detalles:

- `bookings.period` es una columna generada `tstzrange(starts_at, blocked_until)`; `blocked_until` incluye el buffer del servicio.
- El `businessId` de las rutas de gestión llega en el header `X-Business-Id`: el gateway lo acepta solo si el usuario tiene membresía en ese negocio, y los servicios confían en el resultado solo si viene con el token interno. Nunca se toma del body.
- Access token JWT de 15 min en memoria; refresh token rotativo en cookie `httpOnly`, con detección de reuso.
- La `Idempotency-Key` se genera al abrir el paso de confirmación: un doble click no reserva dos veces.
- Las fechas siempre se muestran en la zona horaria del negocio, no en la del navegador.
- Los turnos publican eventos de dominio (`booking.confirmed`, `booking.cancelled`, `booking.rescheduled`…) con el patrón outbox: se guardan en la misma transacción que el cambio y un relay los manda a Kafka. Notificaciones reacciona a ellos sin que booking la conozca.
- Recordatorios con jobs diferidos de BullMQ (no un cron que recorra la tabla): reprogramar es borrar el job y crear otro.
- Al generar migraciones con Prisma, revisar que no agregue `ALTER COLUMN "period" DROP DEFAULT`: confunde la columna generada con un default y la migración falla.

## API

Todo bajo `/api/v1` en el gateway (puerto 3000). Cada servicio documenta su parte en Swagger (`/docs` de su puerto).

| Método | Ruta | Acceso |
| --- | --- | --- |
| POST | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` · GET `/auth/me` | Pública / usuario |
| GET | `/public/businesses/:slug` | Pública |
| GET | `/public/businesses/:slug/availability?serviceId=&professionalId=&date=` | Pública |
| POST | `/bookings` (header `Idempotency-Key`) | Cliente |
| GET | `/me/bookings` | Cliente |
| POST | `/bookings/:id/cancel`, `/bookings/:id/reschedule` | Cliente o negocio |
| POST | `/bookings/cancel?token=` | Link del email |
| POST | `/businesses` | Usuario (queda como OWNER) |
| GET/PATCH | `/business` | Owner (lectura: staff) |
| CRUD | `/business/professionals`, `/business/services` | Owner |
| GET/PUT | `/business/professionals/:id/schedule` | Owner o el propio staff |
| GET/POST/DELETE | `/business/professionals/:id/exceptions` | Owner o el propio staff |
| GET | `/business/agenda?from=&to=&professionalId=` | Owner o staff |
| PATCH | `/business/bookings/:id/attendance` | Owner o staff |
