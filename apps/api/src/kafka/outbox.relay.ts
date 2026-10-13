import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaService } from './kafka.service';

interface OutboxRow {
  id: bigint;
  event_id: string;
  topic: string;
  key: string;
  event_type: string;
  payload: unknown;
}

/** Número arbitrario para el advisory lock: identifica "el relay del outbox". */
const RELAY_LOCK = 724_001;
const BATCH = 100;

/**
 * Relay del outbox: lee los eventos sin publicar, los manda a Kafka y los marca
 * como publicados. Corre en cada instancia de la API, pero un advisory lock de
 * Postgres asegura que publique una sola a la vez, así se respeta el orden.
 * Entrega "al menos una vez": si se cae entre publicar y marcar, el evento se
 * vuelve a mandar y los consumidores lo descartan por `eventId`.
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
    private readonly prisma: PrismaService,
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

  /** Llamado después de cada commit con eventos: publica ya, sin esperar al próximo ciclo. */
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
