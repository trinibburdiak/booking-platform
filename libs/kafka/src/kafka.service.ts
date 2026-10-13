import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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

  /** Crea los tópicos que faltan (los consumidores también los aseguran) y conecta el productor. */
  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      await this.ensureTopics(this.options.produces);
      this.producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        createPartitioner: Partitioners.DefaultPartitioner,
      });
      await this.producer.connect();
    })();
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
    await this.ensureTopics(opts.topics);
    const consumer = this.kafka.consumer({ groupId: opts.groupId });
    this.consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topics: opts.topics, fromBeginning: opts.fromBeginning });
    const joined = new Promise<void>((resolve) => consumer.on(consumer.events.GROUP_JOIN, () => resolve()));
    await consumer.run({ eachMessage: opts.handler });
    await Promise.race([joined, new Promise((r) => setTimeout(r, 30_000))]);
    this.logger.log(`Consumidor ${opts.groupId} escuchando ${opts.topics.join(', ')}`);
  }

  async onModuleDestroy() {
    await Promise.all(this.consumers.map((c) => c.disconnect()));
    await this.producer?.disconnect();
  }
}
