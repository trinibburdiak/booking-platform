import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';

export const REDIS = Symbol('REDIS');

/** Opciones de conexión a partir de REDIS_URL. BullMQ exige `maxRetriesPerRequest: null`. */
export function redisOptions(): RedisOptions {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

const TTL_SECONDS = 300;

/**
 * Caché de disponibilidad: un hash por profesional y día (`avail:{professionalId}:{fecha}`),
 * con un campo por servicio. Se invalida al crear, cancelar, reprogramar o expirar un turno
 * y cuando cambian horarios, excepciones o servicios.
 */
@Injectable()
export class AvailabilityCache {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(professionalId: string, date: string) {
    return `avail:${professionalId}:${date}`;
  }

  async get<T>(professionalId: string, date: string, serviceId: string): Promise<T | null> {
    const raw = await this.redis.hget(this.key(professionalId, date), serviceId);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(professionalId: string, date: string, serviceId: string, value: unknown) {
    const key = this.key(professionalId, date);
    await this.redis.multi().hset(key, serviceId, JSON.stringify(value)).expire(key, TTL_SECONDS).exec();
  }

  async invalidateDay(professionalId: string, ...dates: string[]) {
    if (dates.length) await this.redis.del(...dates.map((d) => this.key(professionalId, d)));
  }

  /** Borra todos los días cacheados de uno o más profesionales (cambio de horario o de servicio). */
  async invalidateProfessionals(professionalIds: string[]) {
    for (const id of professionalIds) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `avail:${id}:*`, 'COUNT', 200);
        if (keys.length) await this.redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
    }
  }
}

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: () => new Redis({ ...redisOptions(), lazyConnect: false }) },
    AvailabilityCache,
    RedisLifecycle,
  ],
  exports: [REDIS, AvailabilityCache],
})
export class RedisModule {}
