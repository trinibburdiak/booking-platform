import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Consumer, EachMessagePayload, Kafka, logLevel, Partitioners, Producer } from 'kafkajs';
import { BOOKING_EVENTS_TOPIC } from '../events/booking-events';

const TOPICS = [{ topic: BOOKING_EVENTS_TOPIC, numPartitions: 3 }];

/**
 * Cliente de Kafka compartido: crea los tópicos al arrancar, expone un productor
 * (lo usa solo el relay del outbox) y arma consumidores con un grupo dado.
 */
@Injectable()
export class KafkaService implements OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private readonly kafka = new Kafka({
    clientId: 'turnos-api',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9094').split(','),
    logLevel: logLevel.WARN,
  });
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private readyPromise?: Promise<void>;

  /** Crea los tópicos (si no existen) y conecta el productor. Idempotente. */
  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      const admin = this.kafka.admin();
      await admin.connect();
      const existing = await admin.listTopics();
      const missing = TOPICS.filter((t) => !existing.includes(t.topic));
      if (missing.length) await admin.createTopics({ topics: missing, waitForLeaders: true });
      await admin.disconnect();
      this.producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        createPartitioner: Partitioners.DefaultPartitioner,
      });
      await this.producer.connect();
    })();
    return this.readyPromise;
  }

  async send(topic: string, messages: { key: string; value: string; headers?: Record<string, string> }[]) {
    await this.ready();
    await this.producer!.send({ topic, messages });
  }

  /**
   * Arranca un consumidor y espera a que se una al grupo, así no se pierden
   * mensajes publicados justo después de iniciar la app.
   */
  async consume(opts: {
    groupId: string;
    topic: string;
    fromBeginning: boolean;
    handler: (payload: EachMessagePayload) => Promise<void>;
  }) {
    await this.ready();
    const consumer = this.kafka.consumer({ groupId: opts.groupId });
    this.consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic: opts.topic, fromBeginning: opts.fromBeginning });
    const joined = new Promise<void>((resolve) => consumer.on(consumer.events.GROUP_JOIN, () => resolve()));
    await consumer.run({ eachMessage: opts.handler });
    await Promise.race([joined, new Promise((r) => setTimeout(r, 30_000))]);
    this.logger.log(`Consumidor ${opts.groupId} escuchando ${opts.topic}`);
  }

  async onModuleDestroy() {
    await Promise.all(this.consumers.map((c) => c.disconnect()));
    await this.producer?.disconnect();
  }
}
