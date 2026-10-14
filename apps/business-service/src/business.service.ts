import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidTimeZone, workingIntervals } from '@turnos/availability';
import { AuthUser, Tenant } from '@turnos/common';
import {
  BusinessEvent,
  BusinessState,
  CreateBusinessInput,
  ExceptionInput,
  ProfessionalInput,
  ProfessionalState,
  PublicBusiness,
  ScheduleInput,
  ScheduleState,
  ServiceInput,
  ServiceState,
  TOPICS,
  UpdateBusinessInput,
} from '@turnos/contracts';
import { envelope, OutboxRelay, outboxRecord } from '@turnos/kafka';
import { Business, Prisma, Service } from '../generated/prisma';
import { PrismaService } from './prisma.service';

type Tx = Prisma.TransactionClient;

const businessState = (b: Business): BusinessState => ({
  id: b.id,
  slug: b.slug,
  name: b.name,
  timezone: b.timezone,
  address: b.address,
  cancellationHours: b.cancellationHours,
  bookingWindowDays: b.bookingWindowDays,
  minNoticeMinutes: b.minNoticeMinutes,
  requiresDeposit: b.requiresDeposit,
});

const serviceState = (s: Service): ServiceState => ({
  id: s.id,
  businessId: s.businessId,
  name: s.name,
  durationMin: s.durationMin,
  bufferMin: s.bufferMin,
  priceCents: s.priceCents,
  depositCents: s.depositCents,
  active: s.active,
});

/**
 * Catálogo del negocio. Cada cambio se guarda junto con su evento (outbox) en
 * business.events, con el estado completo: booking-service reemplaza su copia
 * sin tener que llamar a este servicio en cada consulta de disponibilidad.
 */
@Injectable()
export class BusinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: OutboxRelay,
  ) {}

  // ---------- negocio ----------

  async create(user: AuthUser, input: CreateBusinessInput) {
    this.assertTimezone(input.timezone);
    try {
      return await this.write(async (tx) => {
        const b = await tx.business.create({
          data: { name: input.name, slug: input.slug, timezone: input.timezone, address: input.address, createdBy: user.id },
        });
        // auth-service lo consume y crea la membresía OWNER
        await this.emit(tx, b.id, 'business.created', { business: businessState(b), ownerId: user.id });
        return b;
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

  update(businessId: string, input: UpdateBusinessInput) {
    if (input.timezone) this.assertTimezone(input.timezone);
    return this.write(async (tx) => {
      const b = await tx.business.update({ where: { id: businessId }, data: input });
      await this.emit(tx, b.id, 'business.updated', { business: businessState(b) });
      return b;
    });
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
      requiresDeposit: business.requiresDeposit,
      services: business.services.map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        depositCents: business.requiresDeposit ? s.depositCents : 0,
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
    return this.write(async (tx) => {
      const p = await tx.professional.create({
        data: {
          businessId,
          displayName: input.displayName,
          active: input.active,
          services: { create: input.serviceIds.map((serviceId) => ({ serviceId })) },
        },
      });
      await this.emitProfessional(tx, p.id);
      return p;
    });
  }

  async updateProfessional(businessId: string, id: string, input: ProfessionalInput) {
    await this.findProfessional(businessId, id);
    await this.assertServicesBelong(businessId, input.serviceIds);
    return this.write(async (tx) => {
      const p = await tx.professional.update({
        where: { id },
        data: {
          displayName: input.displayName,
          active: input.active,
          services: { deleteMany: {}, create: input.serviceIds.map((serviceId) => ({ serviceId })) },
        },
      });
      await this.emitProfessional(tx, p.id);
      return p;
    });
  }

  /**
   * Siempre se desactiva en vez de borrarse: los turnos (que viven en booking-service)
   * lo siguen referenciando y este servicio no sabe si tiene historial.
   */
  async deleteProfessional(businessId: string, id: string) {
    await this.findProfessional(businessId, id);
    await this.write(async (tx) => {
      await tx.professional.update({ where: { id }, data: { active: false } });
      await this.emitProfessional(tx, id);
    });
    return { deactivated: true };
  }

  // ---------- servicios ----------

  listServices(businessId: string) {
    return this.prisma.service.findMany({ where: { businessId }, orderBy: { name: 'asc' } });
  }

  createService(businessId: string, input: ServiceInput) {
    return this.write(async (tx) => {
      const s = await tx.service.create({ data: { ...input, businessId } });
      await this.emit(tx, businessId, 'service.changed', { service: serviceState(s) });
      return s;
    });
  }

  async updateService(businessId: string, id: string, input: ServiceInput) {
    await this.findService(businessId, id);
    return this.write(async (tx) => {
      const s = await tx.service.update({ where: { id }, data: input });
      await this.emit(tx, businessId, 'service.changed', { service: serviceState(s) });
      return s;
    });
  }

  /** Igual que con profesionales: se desactiva, no se borra. */
  async deleteService(businessId: string, id: string) {
    await this.findService(businessId, id);
    await this.write(async (tx) => {
      const s = await tx.service.update({ where: { id }, data: { active: false } });
      await this.emit(tx, businessId, 'service.changed', { service: serviceState(s) });
    });
    return { deactivated: true };
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
    await this.write(async (tx) => {
      await tx.schedule.deleteMany({ where: { professionalId } });
      await tx.schedule.createMany({ data: input.ranges.map((r) => ({ ...r, professionalId })) });
      await this.emitSchedule(tx, tenant.businessId, professionalId);
    });
    return this.getSchedule(tenant, user, professionalId);
  }

  async listExceptions(tenant: Tenant, user: AuthUser, professionalId: string) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    return this.prisma.scheduleException.findMany({ where: { professionalId }, orderBy: { date: 'asc' } });
  }

  async createException(tenant: Tenant, user: AuthUser, professionalId: string, input: ExceptionInput) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    return this.write(async (tx) => {
      const created = await tx.scheduleException.create({ data: { ...input, professionalId } });
      await this.emitSchedule(tx, tenant.businessId, professionalId);
      return created;
    });
  }

  async deleteException(tenant: Tenant, user: AuthUser, professionalId: string, exceptionId: string) {
    await this.assertCanEditProfessional(tenant, user, professionalId);
    await this.write(async (tx) => {
      const { count } = await tx.scheduleException.deleteMany({ where: { id: exceptionId, professionalId } });
      if (!count) throw new NotFoundException('Excepción no encontrada');
      await this.emitSchedule(tx, tenant.businessId, professionalId);
    });
  }

  // ---------- eventos ----------

  /** Ejecuta el cambio y su evento en una transacción, y despierta al relay al terminar. */
  private async write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const result = await this.prisma.$transaction(fn);
    this.relay.kick();
    return result;
  }

  private async emit<E extends BusinessEvent>(tx: Tx, businessId: string, type: E['eventType'], payload: E['payload']) {
    const event = envelope(type, businessId, payload);
    await tx.outboxEvent.create({ data: outboxRecord(TOPICS.business, businessId, event) as Prisma.OutboxEventCreateInput });
  }

  private async emitProfessional(tx: Tx, professionalId: string) {
    const p = await tx.professional.findUniqueOrThrow({ where: { id: professionalId }, include: { services: true } });
    const professional: ProfessionalState = {
      id: p.id,
      businessId: p.businessId,
      userId: p.userId,
      displayName: p.displayName,
      active: p.active,
      serviceIds: p.services.map((s) => s.serviceId),
    };
    await this.emit(tx, p.businessId, 'professional.changed', { professional });
  }

  private async emitSchedule(tx: Tx, businessId: string, professionalId: string) {
    const [schedules, exceptions] = await Promise.all([
      tx.schedule.findMany({ where: { professionalId } }),
      tx.scheduleException.findMany({ where: { professionalId } }),
    ]);
    const state: ScheduleState = {
      professionalId,
      schedules: schedules.map(({ id, weekday, startTime, endTime }) => ({ id, weekday, startTime, endTime })),
      exceptions: exceptions.map(({ id, date, type, startTime, endTime }) => ({ id, date, type, startTime, endTime })),
    };
    await this.emit(tx, businessId, 'schedule.changed', state);
  }

  // ---------- helpers ----------

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
