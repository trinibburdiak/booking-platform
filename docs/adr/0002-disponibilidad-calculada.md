# ADR 0002 — Calcular la disponibilidad en vez de guardarla

**Estado:** aceptado · 2026-10-13

## Contexto

Los horarios libres dependen del horario semanal, las excepciones (feriados, vacaciones, horas extra), los turnos ocupados, la duración y el buffer del servicio, el aviso mínimo y la ventana de reserva. Guardar "slots" pre-generados obliga a regenerarlos cada vez que cambia cualquiera de esas cosas.

## Decisión

Los slots no se guardan: se calculan a pedido con una función pura (`libs/availability`), que recibe horario, excepciones, turnos ocupados y reglas, y devuelve slots en UTC y en hora local del negocio.

Las fechas se guardan en UTC (`timestamptz`); los horarios semanales, en hora local del negocio (`"09:00"`), junto con la zona IANA del negocio. La conversión se hace con Luxon al calcular, así los cambios de horario (DST) se resuelven solos.

## Consecuencias

- Cambiar un horario o cargar un feriado se refleja al instante, sin jobs de regeneración.
- La lógica más delicada es testeable sin base ni framework: tramos que no entran, feriados, turnos que cruzan medianoche, cambio de día por UTC, DST.
- El costo es calcular en cada consulta; en la etapa 3 se cachea en Redis (`avail:{professionalId}:{fecha}`) y se invalida al reservar, cancelar o recibir `schedule.changed`.
