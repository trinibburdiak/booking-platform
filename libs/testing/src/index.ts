import { KafkaContainer, StartedKafkaContainer } from '@testcontainers/kafka';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { HEADERS, internalToken } from '@turnos/common';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { GenericContainer, StartedTestContainer } from 'testcontainers';

export interface Infra {
  postgres?: StartedPostgreSqlContainer;
  redis?: StartedTestContainer;
  kafka?: StartedKafkaContainer;
  stop: () => Promise<void>;
}

/**
 * Levanta en contenedores lo que pida el servicio, aplica sus migraciones y deja
 * las variables de entorno listas. Los emails van a un transporte en memoria.
 */
export async function startInfra(opts: { serviceDir: string; postgres?: boolean; redis?: boolean; kafka?: boolean }): Promise<Infra> {
  const [postgres, redis, kafka] = await Promise.all([
    opts.postgres ? new PostgreSqlContainer('postgres:16-alpine').start() : undefined,
    opts.redis ? new GenericContainer('redis:7-alpine').withExposedPorts(6379).start() : undefined,
    opts.kafka ? new KafkaContainer('confluentinc/cp-kafka:7.7.1').withKraft().start() : undefined,
  ]);
  if (postgres) {
    process.env.DATABASE_URL = postgres.getConnectionUri();
    execSync('npx prisma migrate deploy', { cwd: opts.serviceDir, env: process.env, stdio: 'pipe' });
  }
  if (redis) process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  if (kafka) process.env.KAFKA_BROKERS = `${kafka.getHost()}:${kafka.getMappedPort(9093)}`;
  process.env.OUTBOX_POLL_MS = '200';
  // Vacío (no borrado): Prisma recarga el .env y volvería a ponerlo.
  process.env.SMTP_HOST = '';
  return {
    postgres,
    redis,
    kafka,
    stop: async () => {
      await Promise.all([postgres?.stop(), redis?.stop(), kafka?.stop()]);
    },
  };
}

/** Headers que pondría el gateway para un usuario (y opcionalmente un negocio con rol). */
export function asUser(
  userId: string,
  opts: { memberships?: { businessId: string; role: 'OWNER' | 'STAFF' }[]; tenant?: { businessId: string; role: 'OWNER' | 'STAFF' } } = {},
): Record<string, string> {
  const memberships = opts.memberships ?? (opts.tenant ? [opts.tenant] : []);
  return {
    [HEADERS.internalToken]: internalToken(),
    [HEADERS.userId]: userId,
    [HEADERS.userEmail]: `${userId}@test.dev`,
    [HEADERS.memberships]: JSON.stringify(memberships),
    ...(opts.tenant && { [HEADERS.businessId]: opts.tenant.businessId, [HEADERS.tenantRole]: opts.tenant.role }),
  };
}

/** Solo el token interno: una request pública que pasó por el gateway. */
export const viaGateway = (): Record<string, string> => ({ [HEADERS.internalToken]: internalToken() });

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor: tiempo agotado');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const uuid = () => randomUUID();
