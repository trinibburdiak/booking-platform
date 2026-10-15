#!/bin/sh
# Arranca un servicio dentro de la imagen de producción.
#   SERVICE=api-gateway | auth-service | business-service | booking-service | notifications-service | payments-service
# Los servicios con base de datos aplican sus migraciones antes de arrancar
# (prisma migrate deploy es idempotente y usa un lock de Postgres).
set -e
: "${SERVICE:?Falta la variable SERVICE}"
cd "/app/apps/$SERVICE"
if [ -f prisma/schema.prisma ]; then
  echo "[$SERVICE] aplicando migraciones…"
  /app/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
fi
exec node dist/main.js
