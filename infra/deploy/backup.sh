#!/bin/sh
# Backup de todas las bases (una por servicio) con pg_dumpall, comprimido. Guarda 14 días.
# Restaurar:  gunzip -c archivo.sql.gz | docker exec -i turnos-prod-postgres-1 psql -U turnos -d postgres
set -e
DIR=/var/backups/turnos
mkdir -p "$DIR"
FILE="$DIR/turnos-$(date +%Y%m%d-%H%M).sql.gz"
docker exec turnos-prod-postgres-1 pg_dumpall -U turnos | gzip > "$FILE"
find "$DIR" -name 'turnos-*.sql.gz' -mtime +14 -delete
echo "$(date -Is) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
