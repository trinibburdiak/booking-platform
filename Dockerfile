# Imagen de producción del monorepo. Una sola imagen con todos los servicios ya
# compilados: cada contenedor elige cuál correr con SERVICE (ver infra/docker-compose.prod.yml).
# La etapa `web` es Caddy con el front compilado.

FROM node:22-bookworm-slim AS build
# OpenSSL lo necesita el motor de Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY . .
# postinstall: compila las libs y genera el cliente de Prisma de cada servicio
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "./apps/*-service" --filter @turnos/api-gateway build \
 && pnpm --filter @turnos/web build

# ---------- front: Caddy con los estáticos ----------
FROM caddy:2.8.4-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile

# ---------- servicios ----------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
COPY infra/docker/start.sh /usr/local/bin/start-service
RUN chmod +x /usr/local/bin/start-service \
 && rm -rf apps/web/node_modules apps/e2e libs/*/src apps/*/src apps/*/test
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "start-service"]
