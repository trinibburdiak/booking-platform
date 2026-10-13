import { DynamicModule, Global, Module, Type } from '@nestjs/common';
import { KAFKA_OPTIONS, KafkaOptions, KafkaService } from './kafka.service';
import { OUTBOX_PRISMA, OutboxRelay } from './outbox';

export * from './kafka.service';
export * from './outbox';

/**
 * Kafka + outbox para un servicio. `prisma` es el provider del PrismaClient del
 * servicio (debe venir de un módulo global), así el relay escribe en la base correcta.
 */
@Global()
@Module({})
export class EventsModule {
  static forRoot(options: KafkaOptions & { prisma: Type<unknown> }): DynamicModule {
    return {
      module: EventsModule,
      providers: [
        { provide: KAFKA_OPTIONS, useValue: { clientId: options.clientId, produces: options.produces } },
        { provide: OUTBOX_PRISMA, useExisting: options.prisma },
        KafkaService,
        OutboxRelay,
      ],
      exports: [KafkaService, OutboxRelay, OUTBOX_PRISMA],
    };
  }
}
