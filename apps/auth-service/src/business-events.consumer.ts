import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { BusinessEvent, TOPICS } from '@turnos/contracts';
import { KafkaService, processOnce } from '@turnos/kafka';
import { PrismaService } from './prisma.service';

export const AUTH_CONSUMER = 'auth-service';

/**
 * Consume business.events: al crearse un negocio, quien lo creó queda como OWNER;
 * y se mantiene al día el nombre y slug que muestra /auth/me.
 */
@Injectable()
export class BusinessEventsConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async onApplicationBootstrap() {
    await this.kafka.consume({
      groupId: AUTH_CONSUMER,
      topics: [TOPICS.business],
      fromBeginning: true,
      handler: async ({ message }) => {
        if (message.value) await this.handle(JSON.parse(message.value.toString()) as BusinessEvent);
      },
    });
  }

  async handle(event: BusinessEvent) {
    await processOnce(this.prisma, AUTH_CONSUMER, event.eventId, async () => {
      if (event.eventType === 'business.created') {
        const { business, ownerId } = event.payload;
        await this.prisma.$transaction([
          this.prisma.businessRef.upsert({
            where: { id: business.id },
            create: { id: business.id, name: business.name, slug: business.slug },
            update: { name: business.name, slug: business.slug },
          }),
          this.prisma.membership.upsert({
            where: { userId_businessId: { userId: ownerId, businessId: business.id } },
            create: { userId: ownerId, businessId: business.id, role: 'OWNER' },
            update: {},
          }),
        ]);
      } else if (event.eventType === 'business.updated') {
        const { business } = event.payload;
        await this.prisma.businessRef.upsert({
          where: { id: business.id },
          create: { id: business.id, name: business.name, slug: business.slug },
          update: { name: business.name, slug: business.slug },
        });
      }
    });
  }
}
