import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AuthEvent, BusinessEvent, TOPICS } from '@turnos/contracts';
import { KafkaService, processOnce } from '@turnos/kafka';
import { PrismaService } from './prisma.service';
import { AvailabilityCache } from './redis.module';

export const BOOKING_CONSUMER = 'booking-service';

/**
 * Mantiene la réplica local del catálogo (business.events) y de los clientes
 * (auth.events). Así booking-service calcula disponibilidad sin llamar a otros
 * servicios en cada consulta. Los eventos traen el estado completo: se reemplaza.
 * Como business.events usa businessId de clave, los cambios de un negocio llegan
 * en orden (el servicio antes que el profesional que lo ofrece, etc.).
 */
@Injectable()
export class ReplicaConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly cache: AvailabilityCache,
  ) {}

  async onApplicationBootstrap() {
    await this.kafka.consume({
      groupId: BOOKING_CONSUMER,
      topics: [TOPICS.business, TOPICS.auth],
      fromBeginning: true,
      handler: async ({ message }) => {
        if (message.value) await this.handle(JSON.parse(message.value.toString()) as BusinessEvent | AuthEvent);
      },
    });
  }

  async handle(event: BusinessEvent | AuthEvent) {
    await processOnce(this.prisma, BOOKING_CONSUMER, event.eventId, () => this.apply(event));
  }

  private async apply(event: BusinessEvent | AuthEvent) {
    switch (event.eventType) {
      case 'user.registered': {
        const { userId, email, fullName, phone } = event.payload;
        await this.prisma.client.upsert({
          where: { id: userId },
          create: { id: userId, email, fullName, phone },
          update: { email, fullName, phone },
        });
        return;
      }
      case 'business.created':
      case 'business.updated': {
        const { business } = event.payload;
        await this.prisma.business.upsert({ where: { id: business.id }, create: business, update: business });
        // Zona horaria, aviso mínimo o ventana de reserva afectan a todos sus profesionales
        if (event.eventType === 'business.updated') await this.invalidateBusiness(business.id);
        return;
      }
      case 'service.changed': {
        const { service } = event.payload;
        await this.prisma.service.upsert({ where: { id: service.id }, create: service, update: service });
        await this.invalidateBusiness(service.businessId);
        return;
      }
      case 'professional.changed': {
        const { serviceIds, ...p } = event.payload.professional;
        await this.prisma.$transaction([
          this.prisma.professional.upsert({ where: { id: p.id }, create: p, update: p }),
          this.prisma.professionalService.deleteMany({ where: { professionalId: p.id } }),
          this.prisma.professionalService.createMany({
            data: serviceIds.map((serviceId) => ({ professionalId: p.id, serviceId })),
          }),
        ]);
        await this.cache.invalidateProfessionals([p.id]);
        return;
      }
      case 'schedule.changed': {
        const { professionalId, schedules, exceptions } = event.payload;
        await this.prisma.$transaction([
          this.prisma.schedule.deleteMany({ where: { professionalId } }),
          this.prisma.schedule.createMany({ data: schedules.map((s) => ({ ...s, professionalId })) }),
          this.prisma.scheduleException.deleteMany({ where: { professionalId } }),
          this.prisma.scheduleException.createMany({ data: exceptions.map((e) => ({ ...e, professionalId })) }),
        ]);
        await this.cache.invalidateProfessionals([professionalId]);
        return;
      }
    }
  }

  private async invalidateBusiness(businessId: string) {
    const pros = await this.prisma.professional.findMany({ where: { businessId }, select: { id: true } });
    await this.cache.invalidateProfessionals(pros.map((p) => p.id));
  }
}
