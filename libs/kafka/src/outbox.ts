import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@turnos/contracts';
import { randomUUID } from 'crypto';
import { KafkaService } from './kafka.service';

/**
 * Lo mínimo que el relay necesita de un PrismaClient. Cada servicio tiene su propio
 * cliente generado, pero todos tienen las tablas `outbox` y `processed_events`
 * con el mismo esquema (ver prisma/schema.prisma de cada servicio).
 */
export interface OutboxPrisma {
  $transaction<R>(fn: (tx: OutboxPrismaTx) => Promise<R>, options?: { timeout?: number }): Promise<R>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
export interface OutboxPrismaTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export const OUTBOX_PRISMA = Symbol('OUTBOX_PRISMA');

export function envelope<T extends string, P>(eventType: T, businessId: string | null, payload: P): EventEnvelope<T, P> {
  return { eventId: randomUUID(), eventType, occurredAt: new Date().toISOString(), businessId, payload };
}

/** Datos para `tx.outboxEvent.create({ data })`, dentro de la transacción del cambio. */
export function outboxRecord(topic: string, key: string, event: EventEnvelope) {
  return {
    eventId: event.eventId,
    topic,
    key,
    eventType: event.eventType,
    payload: event as unknown as object,
  };
}

interface OutboxRow {
  id: bigint;
  event_id: string;
  topic: string;
  key: string;
  event_type: string;
  payload: unknown;
}

/** Número arbitrario para el advisory lock: identifica "el relay del outbox" (uno por base). */
const RELAY_LOCK = 724_001;
const BATCH = 100;

/**
 * Relay del outbox: lee los eventos sin publicar, los manda a Kafka y los marca
 * como publicados. Un advisory lock de Postgres asegura que publique una sola
 * instancia a la vez, así se respeta el orden. Entrega "al menos una vez".
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollMs = Number(process.env.OUTBOX_POLL_MS ?? 1000);
  private timer?: NodeJS.Timeout;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(
    @Inject(OUTBOX_PRISMA) private readonly prisma: OutboxPrisma,
    private readonly kafka: KafkaService,
  ) {}

  async onApplicationBootstrap() {
    await this.kafka.ready();
    this.schedule();
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Llamar después de cada commit con eventos: publica ya, sin esperar al próximo ciclo. */
  kick() {
    if (this.running) this.again = true;
    else void this.tick();
  }

  private schedule() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      let published: number;
      do {
        this.again = false;
        published = await this.publishBatch();
      } while ((published === BATCH || this.again) && !this.stopped);
    } catch (e) {
      this.logger.error(`Relay: ${(e as Error).message}`);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  /** Devuelve cuántos eventos publicó. */
  async publishBatch(): Promise<number> {
    let failed: { ids: bigint[]; error: string } | null = null;
    const count = await this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${RELAY_LOCK}) AS locked`;
        if (!locked) return 0;
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, event_id, topic, key, event_type, payload FROM outbox
          WHERE published_at IS NULL ORDER BY id LIMIT ${BATCH}`;
        if (!rows.length) return 0;

        const byTopic = new Map<string, OutboxRow[]>();
        for (const r of rows) byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r]);
        try {
          for (const [topic, list] of byTopic) {
            await this.kafka.send(
              topic,
              list.map((r) => ({
                key: r.key,
                value: JSON.stringify(r.payload),
                headers: { eventType: r.event_type, eventId: r.event_id },
              })),
            );
          }
        } catch (e) {
          failed = { ids: rows.map((r) => r.id), error: (e as Error).message.slice(0, 500) };
          return 0;
        }
        const ids = rows.map((r) => r.id);
        await tx.$executeRaw`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY(${ids}::bigint[])`;
        return rows.length;
      },
      { timeout: 30_000 },
    );
    if (failed) {
      const { ids, error } = failed;
      await this.prisma.$executeRaw`UPDATE outbox SET attempts = attempts + 1, last_error = ${error} WHERE id = ANY(${ids}::bigint[])`;
      throw new Error(`No se pudo publicar en Kafka: ${error}`);
    }
    return count;
  }
}

/**
 * Procesa un evento una sola vez por consumidor. Kafka entrega "al menos una vez":
 * se reclama el eventId en `processed_events` y, si el handler falla, se libera
 * para que el reintento lo vuelva a tomar. Devuelve false si era un duplicado.
 */
export async function processOnce(
  prisma: OutboxPrisma,
  consumer: string,
  eventId: string,
  handler: () => Promise<void>,
): Promise<boolean> {
  const claimed = await prisma.$executeRaw`
    INSERT INTO processed_events (consumer, event_id) VALUES (${consumer}, ${eventId}::uuid)
    ON CONFLICT DO NOTHING`;
  if (!claimed) return false;
  try {
    await handler();
    return true;
  } catch (e) {
    await prisma.$executeRaw`DELETE FROM processed_events WHERE consumer = ${consumer} AND event_id = ${eventId}::uuid`;
    throw e;
  }
}
