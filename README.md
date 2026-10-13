# Turnos

Plataforma multi-tenant de turnos online: cada negocio (peluquería, consultorio, taller) tiene su página pública (`/b/mi-negocio`), carga profesionales, servicios y horarios, y sus clientes reservan sin llamar ni escribir por WhatsApp.

**Lo interesante del backend:** reservas concurrentes sin doble booking (exclusion constraint de Postgres), fechas y zonas horarias bien resueltas, y aislamiento entre negocios.

## Estado

| Etapa | Contenido | Estado |
| --- | --- | --- |
| 1. Base | Monorepo, Docker Compose, CI, seed del negocio demo | ✅ |
| 2. Monolito modular | NestJS (auth, business, booking), disponibilidad, reserva con exclusion constraint, cancelación y reprogramación. Front: página pública, wizard de reserva, mis turnos, panel y configuración | ✅ |
| 3. Agenda y notificaciones | FullCalendar, WebSocket, emails y recordatorios con BullMQ | pendiente |
| 4. Eventos | Kafka + outbox | pendiente |
| 5. Microservicios | Separar servicios, gateway | pendiente |
| 6. Extras | Seña con Mercado Pago sandbox, drag & drop, Playwright | pendiente |

## Cómo levantarlo

Requisitos: Node 22, pnpm 10, Docker.

```bash
pnpm install
pnpm db:up          # Postgres (5544), Redis (6380), Mailpit (8026)
cp apps/api/.env.example apps/api/.env
pnpm db:migrate
pnpm db:seed        # Barbería Demo con turnos cargados
pnpm dev:api        # http://localhost:3000/api/v1 · Swagger en /docs
pnpm dev:web        # http://localhost:5180
```

Usuarios de prueba (contraseña `demo1234`): `cliente@turnos.dev` (cliente) y `demo@turnos.dev` (dueña de la Barbería Demo).

## Tests

```bash
pnpm --filter @turnos/availability test   # unitarios de la lógica de disponibilidad
pnpm --filter @turnos/api test            # integración contra Postgres real (Testcontainers, necesita Docker)
```

Lo que cubren:

- **Disponibilidad:** servicio que no entra al final del tramo, varios tramos por día, feriados, horas extra, buffer, aviso mínimo, ventana de reserva, turno que cruza la medianoche, cambio de día por UTC, DST.
- **Concurrencia:** 20 reservas en paralelo al mismo slot → una gana y 19 reciben `409`. También directo contra la base, salteando la API.
- **Idempotencia:** dos requests con la misma `Idempotency-Key` devuelven el mismo turno.
- **Multi-tenancy y roles:** un dueño no puede leer la agenda ni tocar recursos de otro negocio; el staff no puede crear servicios ni editar horarios ajenos.
- **Políticas:** cancelación dentro del plazo, link de cancelación de un solo uso, reprogramar a un horario ocupado.

## Estructura

```
apps/
  api/            NestJS + Prisma (monolito modular: auth, business, booking)
  web/            React + Vite + TanStack Query + React Hook Form + Tailwind
libs/
  availability/   lógica pura de disponibilidad y política de cancelación
  contracts/      esquemas Zod y tipos compartidos entre front y back
infra/            docker-compose
docs/adr/         decisiones de arquitectura
```

## Decisiones clave

- [ADR 0001 — Exclusion constraint en lugar de locks en código](docs/adr/0001-exclusion-constraint.md)
- [ADR 0002 — Calcular la disponibilidad en vez de guardarla](docs/adr/0002-disponibilidad-calculada.md)

Detalles:

- `bookings.period` es una columna generada `tstzrange(starts_at, blocked_until)`; `blocked_until` incluye el buffer del servicio.
- El `businessId` de las rutas de gestión llega en el header `X-Business-Id`, y solo se acepta si el usuario tiene membresía en ese negocio. Nunca se toma del body.
- Access token JWT de 15 min en memoria; refresh token rotativo en cookie `httpOnly`, con detección de reuso.
- La `Idempotency-Key` se genera al abrir el paso de confirmación: un doble click no reserva dos veces.
- Las fechas siempre se muestran en la zona horaria del negocio, no en la del navegador.

## API

Todo bajo `/api/v1`, documentado en Swagger (`/docs`).

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
