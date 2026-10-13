import { RedisOptions } from 'ioredis';

/** Conexión de BullMQ a partir de REDIS_URL (BullMQ exige `maxRetriesPerRequest: null`). */
export function redisOptions(): RedisOptions {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  return { host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, maxRetriesPerRequest: null };
}
