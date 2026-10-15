-- Se ejecuta solo la primera vez que arranca el volumen de Postgres.
-- Cada servicio es dueño de su base (ver docs/adr/0004-microservicios.md).
CREATE DATABASE turnos_auth;
CREATE DATABASE turnos_business;
CREATE DATABASE turnos_booking;
CREATE DATABASE turnos_notifications;
CREATE DATABASE turnos_payments;
