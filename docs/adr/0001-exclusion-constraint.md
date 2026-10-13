# ADR 0001 — Exclusion constraint en lugar de locks en código

**Estado:** aceptado · 2026-10-13

## Contexto

Dos clientes pueden intentar reservar el mismo horario del mismo profesional al mismo tiempo. Si la validación vive solo en el código ("¿está libre? → insertar"), las dos requests pueden pasar el chequeo antes de que cualquiera inserte, y el profesional queda con dos turnos superpuestos.

Alternativas consideradas:

- **Lock en memoria / mutex por profesional:** no funciona con más de una instancia de la API.
- **Lock distribuido (Redis):** agrega una pieza que puede fallar o expirar a destiempo, y la base sigue sin protegerse de otros caminos de escritura.
- **`SELECT … FOR UPDATE` + chequeo:** no bloquea filas que todavía no existen; requiere serializar por profesional con un lock explícito.
- **Aislamiento `SERIALIZABLE`:** funciona, pero obliga a reintentar transacciones y es más difícil de razonar.

## Decisión

La regla vive en Postgres:

```sql
ALTER TABLE bookings ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (professional_id WITH =, period WITH &&)
  WHERE (status IN ('PENDING', 'CONFIRMED'));
```

`period` es una columna generada `tstzrange(starts_at, blocked_until, '[)')`, donde `blocked_until` incluye el buffer del servicio. El rango es semiabierto: un turno que termina 10:30 no choca con otro que empieza 10:30.

La API valida antes de insertar para dar buenos mensajes, pero la garantía es el constraint: si Postgres rechaza con `23P01`, la API responde `409 SLOT_TAKEN`.

## Consecuencias

- Imposible tener doble booking, aunque haya varias instancias o alguien escriba directo en la base.
- Cancelar o expirar un turno libera el horario sin pasos extra: esos estados quedan fuera del `WHERE`.
- Requiere la extensión `btree_gist` y una migración SQL escrita a mano (Prisma no modela exclusion constraints).
- Test de integración: 20 reservas en paralelo al mismo slot → exactamente una gana.
