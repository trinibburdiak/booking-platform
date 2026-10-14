import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { runWithRequestId } from '@turnos/common';
import { Consumer, EachMessagePayload, Kafka, logLevel, Partitioners, Producer } from 'kafkajs';

export const KAFKA_OPTIONS = Symbol('KAFKA_OPTIONS');

export interface KafkaOptions {
  /** Nombre del servicio, para identificar al cliente en Kafka */
  clientId: string;
  /** Tópicos que este servicio publica (los crea si no existen) */
  produces: string[];
}

/**
 * Cliente de Kafka de un servicio: crea sus tópicos, expone el productor (lo usa
 * solo el relay del outbox) y arma consumidores que esperan a unirse al grupo.
 */
@Injectable()
export class KafkaService implements OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private readyPromise?: Promise<void>;

  constructor(@Inject(KAFKA_OPTIONS) private readonly options: KafkaOptions) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
      logLevel: logLevel.WARN,
    });
  }

  /**
   * Reintenta con espera creciente. Al arrancar todo junto (o con Kafka recién
   * levantado), el broker puede tardar en tener listos coordinador y particiones.
   */
  private async retry<T>(what: string, fn: () => Promise<T>, attempts = 12): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= attempts) throw e;
        this.logger.warn(`${what}: ${(e as Error).message} (reintento ${i}/${attempts - 1})`);
        await new Promise((r) => setTimeout(r, Math.min(500 * i, 5_000)));
      }
    }
  }

  /** Crea los tópicos que faltan (los consumidores también los aseguran) y conecta el productor. */
  ready(): Promise<void> {
    this.readyPromise ??= this.retry('Conectando el productor', async () => {
      await this.ensureTopics(this.options.produces);
      const producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        createPartitioner: Partitioners.DefaultPartitioner,
      });
      await producer.connect();
      this.producer = producer;
    }).catch((e) => {
      this.readyPromise = undefined; // que el próximo intento vuelva a probar
      throw e;
    });
    return this.readyPromise;
  }

  private async ensureTopics(topics: string[]) {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = await admin.listTopics();
      const missing = topics.filter((t) => !existing.includes(t));
      if (missing.length) {
        await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions: 3 })), waitForLeaders: true });
      }
    } finally {
      await admin.disconnect();
    }
  }

  async send(topic: string, messages: { key: string; value: string; headers?: Record<string, string> }[]) {
    await this.ready();
    await this.producer!.send({ topic, messages });
  }

  async consume(opts: {
    groupId: string;
    topics: string[];
    fromBeginning: boolean;
    handler: (payload: EachMessagePayload) => Promise<void>;
  }) {
    const { consumer, joined } = await this.retry(`Iniciando el consumidor ${opts.groupId}`, async () => {
      await this.ensureTopics(opts.topics);
      const c = this.kafka.consumer({ groupId: opts.groupId });
      try {
        await c.connect();
        await c.subscribe({ topics: opts.topics, fromBeginning: opts.fromBeginning });
      } catch (e) {
        await c.disconnect().catch(() => undefined);
        throw e;
      }
      const j = new Promise<void>((resolve) => c.on(c.events.GROUP_JOIN, () => resolve()));
      return { consumer: c, joined: j };
    });
    this.consumers.push(consumer);
    // Cada mensaje se procesa con el correlationId del evento: los logs quedan unidos a la request original
    await consumer.run({
      eachMessage: (payload) => {
        let correlationId: string | undefined;
        try {
          correlationId = JSON.parse(payload.message.value?.toString() ?? '{}').correlationId;
        } catch {
          /* mensaje que no es JSON: se procesa igual */
        }
        return runWithRequestId(correlationId, () => opts.handler(payload));
      },
    });
    await Promise.race([joined, new Promise((r) => setTimeout(r, 30_000))]);
    this.logger.log(`Consumidor ${opts.groupId} escuchando ${opts.topics.join(', ')}`);
  }

  async onModuleDestroy() {
    await Promise.all(this.consumers.map((c) => c.disconnect()));
    await this.producer?.disconnect();
  }
}
