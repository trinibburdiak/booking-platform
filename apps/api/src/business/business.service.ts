import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isValidTimeZone, workingIntervals } from '@turnos/availability';
import {
  CreateBusinessInput,
  ExceptionInput,
  ProfessionalInput,
  PublicBusiness,
  ScheduleInput,
  ServiceInput,
  UpdateBusinessInput,
} from '@turnos/contracts';
import { AuthUser, Tenant } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityCache } from '../redis/redis.module';

@Injectable()
export class BusinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AvailabilityCache,
  ) {}

  // ---------- negocio ----------

  async create(user: AuthUser, input: CreateBusinessInput) {
    this.assertTimezone(input.timezone);
    try {
      return await this.prisma.business.create({
        data: {
          name: input.name,
          slug: input.slug,
          timezone: input.timezone,
          address: input.address,
          memberships: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ese slug ya está en uso');
      }
      throw e;
    }
  }

  get(businessId: string) {
    return this.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
  }

  async update(businessId: string, input: UpdateBusinessInput) {
    if (input.timezone) this.assertTimezone(input.timezone);
    const updated = await this.prisma.business.update({ where: { id: businessId }, data: input });
    await this.invalidateBusiness(businessId);
    return updated;
  }

  async getPublic(slug: string): Promise<PublicBusiness> {
    const business = await this.prisma.business.findUnique({
      where: { slug },
      include: {
        services: { where: { active: true }, include: { professionals: true }, orderBy: { name: 'asc' } },
        professionals: { where: { active: true }, orderBy: { displayName: 'asc' } },
      },
    });
    if (!business) throw new NotFoundException('Negocio no encontrado');
    const activePros = new Set(business.professionals.map((p) => p.id));
    return {
      id: business.id,
      slug: business.slug,
      name: business.name,
      timezone: business.timezone,
      address: business.address,
      cancellationHours: business.cancellationHours,
      services: business.services.map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        professionalIds: s.professionals.map((p) => p.professionalId).filter((id) => activePros.has(id)),
      })),
      professionals: business.professionals.map((p) => ({ id: p.id, displayName: p.displayName })),
    };
  }

  // ---------- profesionales ----------

  async listProfessionals(businessId: string) {
    const pros = await this.prisma.professional.findMany({
      where: { businessId },
      include: { services: true, schedules: { orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] } },
      orderBy: { displayName: 'asc' },
    });
    return pros.map(({ services, ...p }) => ({ ...p, serviceIds: services.map((s) => s.serviceId) }));
  }

  async createProfessional(businessId: string, input: ProfessionalInput) {
    await this.assertServicesBelong(businessId, input.serviceIds);
    return this.prisma.professional.create({
      data: {
        businessId,
        displayName: input.displayName,
        active: input.active,
        services: { create: input.serviceIds.map((serviceId) => ({ serviceId })) },
      },
    });
  }

  async updateProfessional(businessId: string, id: string, input: ProfessionalInput) {
    await this.findProfessional(businessId, id);
    await this.assertServicesBelong(businessId, input.serviceIds);
    await this.cache.invalidateProfessionals([id]);
    return this.prisma.professional.update({
      where: { id },
      data: {
        displayName: input.displayName,
        active: input.active,
        services: { deleteMany: {}, create: input.serviceIds.map((serviceId) => ({ serviceId })) },
      },
    });
  }

  /** Si tiene turnos, se desactiva en vez de borrarse para no perder el historial. */
  async deleteProfessional(businessId: string, id: string) {
    await this.findProfessional(businessId, id);
    const hasBookings = await this.prisma.booking.count({ where: { professionalId: id } });
    if (hasBookings) {
      await this.prisma.professional.update({ where: { id }, data: { active: false } });
      return { deactivated: true };
    }
    await this.prisma.professional.delete({ where: { id } });
    return { deleted: true };
  }

  // ---------- servicios ----------

  listServices(businessId: string) {
    return this.prisma.service.findMany({ where: { businessId }, orderBy: { name: 'asc' } });
  }

  createService(businessId: string, input: ServiceInput) {
    return this.prisma.service.create({ data: { ...input, businessId } });
  }

  async updateService(businessId: string, id: string, input: ServiceInput) {
    await this.findService(businessId, id);
    const updated = await this.prisma.service.update({ where: { id }, data: input });
    await this.invalidateBusiness(businessId);
    return updated;
  }

  async deleteService(businessId: string, id: string) {
    await this.findService(businessId, id);
    const hasBookings = await this.prisma.booking.count({ where: { serviceId: id } });
    if (hasBookings) {
      await this.prisma.service.update({ where: { id }, data: { active: false } });
      return { deactivated: true };
    }
    await this.prisma.service.delete({ where: { id } });
    return { deleted: true };
  }

  // ---------- horarios y excepciones ----------

  async getSchedule(tenant: Tenant, user: AuthUser, professionalId: string) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    return this.prisma.schedule.findMany({
      where: { professionalId },
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
    });
  }

  /** Reemplaza el horario semanal completo en una transacción. */
  async setSchedule(tenant: Tenant, user: AuthUser, professionalId: string, input: ScheduleInput) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    for (const r of input.ranges) {
      if (r.startTime === r.endTime) throw new BadRequestException('Un tramo no puede empezar y terminar a la misma hora');
    }
    this.assertNoOverlaps(input);
    await this.prisma.$transaction([
      this.prisma.schedule.deleteMany({ where: { professionalId } }),
      this.prisma.schedule.createMany({ data: input.ranges.map((r) => ({ ...r, professionalId })) }),
    ]);
    await this.cache.invalidateProfessionals([professionalId]);
    return this.getSchedule(tenant, user, professionalId);
  }

  async listExceptions(tenant: Tenant, user: AuthUser, professionalId: string) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    return this.prisma.scheduleException.findMany({ where: { professionalId }, orderBy: { date: 'asc' } });
  }

  async createException(tenant: Tenant, user: AuthUser, professionalId: string, input: ExceptionInput) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    const created = await this.prisma.scheduleException.create({ data: { ...input, professionalId } });
    await this.cache.invalidateProfessionals([professionalId]);
    return created;
  }

  async deleteException(tenant: Tenant, user: AuthUser, professionalId: string, exceptionId: string) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    const { count } = await this.prisma.scheduleException.deleteMany({ where: { id: exceptionId, professionalId } });
    if (!count) throw new NotFoundException('Excepción no encontrada');
    await this.cache.invalidateProfessionals([professionalId]);
  }

  // ---------- helpers ----------

  /** Cambios que afectan a todo el negocio (zona horaria, políticas, servicios). */
  private async invalidateBusiness(businessId: string) {
    const pros = await this.prisma.professional.findMany({ where: { businessId }, select: { id: true } });
    await this.cache.invalidateProfessionals(pros.map((p) => p.id));
  }

  private async findProfessional(businessId: string, id: string) {
    const pro = await this.prisma.professional.findFirst({ where: { id, businessId } });
    if (!pro) throw new NotFoundException('Profesional no encontrado');
    return pro;
  }

  private async findService(businessId: string, id: string) {
    const service = await this.prisma.service.findFirst({ where: { id, businessId } });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    return service;
  }

  /** El dueño edita a cualquiera; el staff, solo su propio horario. */
  private async assertCanEditProfessional(tenant: Tenant, user: AuthUser, professionalId: string) {
    const pro = await this.findProfessional(tenant.businessId, professionalId);
    if (tenant.role === 'STAFF' && pro.userId !== user.id) {
      throw new ForbiddenException('Solo podés editar tu propio horario');
    }
  }

  private async assertServicesBelong(businessId: string, serviceIds: string[]) {
    if (!serviceIds.length) return;
    const count = await this.prisma.service.count({ where: { businessId, id: { in: serviceIds } } });
    if (count !== new Set(serviceIds).size) throw new BadRequestException('Algún servicio no pertenece al negocio');
  }

  private assertTimezone(timezone: string) {
    if (!isValidTimeZone(timezone)) throw new BadRequestException(`Zona horaria inválida: ${timezone}`);
  }

  private assertNoOverlaps(input: ScheduleInput) {
    // Se usa una fecha cualquiera en UTC: alcanza para comparar tramos del mismo día.
    for (let weekday = 0; weekday < 7; weekday++) {
      const ranges = input.ranges.filter((r) => r.weekday === weekday);
      const merged = workingIntervals('2026-01-04', 'UTC', ranges.map((r) => ({ ...r, weekday: 0 })), []);
      const total = ranges.reduce((acc, r) => {
        const [sh, sm] = r.startTime.split(':').map(Number);
        const [eh, em] = r.endTime.split(':').map(Number);
        let mins = eh * 60 + em - (sh * 60 + sm);
        if (mins <= 0) mins += 24 * 60;
        return acc + mins;
      }, 0);
      const mergedTotal = merged.reduce((acc, i) => acc + (i.end - i.start) / 60_000, 0);
      if (mergedTotal !== total) throw new BadRequestException('Hay tramos superpuestos en el mismo día');
    }
  }
}
