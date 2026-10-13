import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Booking, Business, Prisma, Professional, Service } from '@prisma/client';
import { canClientCancel, localDateOf } from '@turnos/availability';
import { BookingView, CreateBookingInput, RescheduleBookingInput } from '@turnos/contracts';
import { randomBytes } from 'crypto';
import { AuthUser, Tenant } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_STATUSES, AvailabilityService } from './availability.service';

type BookingWithRelations = Booking & { business: Business; service: Service; professional: Professional };
const withRelations = { business: true, service: true, professional: true } as const;

const MINUTE = 60_000;

/** Postgres SQLSTATE 23P01: el exclusion constraint `no_overlap` rechazó el turno. */
export function isOverlapViolation(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const meta = (e as Prisma.PrismaClientKnownRequestError).meta;
  return /23P01|no_overlap|exclusion constraint/i.test(`${e.message} ${JSON.stringify(meta ?? {})}`);
}

const slotTaken = () =>
  new ConflictException({ statusCode: 409, code: 'SLOT_TAKEN', message: 'Ese horario se acaba de ocupar' });

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
  ) {}

  /**
   * Reserva un slot. La validación previa da buenos mensajes de error, pero la
   * garantía contra el doble booking es el exclusion constraint de la base:
   * si dos reservas llegan a la vez, una sola pasa y la otra recibe 409.
   */
  async create(user: AuthUser, input: CreateBookingInput, idempotencyKey: string | undefined): Promise<BookingView> {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 100) {
      throw new BadRequestException('Falta el header Idempotency-Key');
    }
    const previous = await this.findByIdempotencyKey(user.id, idempotencyKey);
    if (previous) return previous;

    const { business, service } = await this.availability.resolveBusinessAndService(input.businessSlug, input.serviceId);
    const start = new Date(input.start);
    const slot = await this.findSlot(business, service, start, input.professionalId);

    try {
      const booking = await this.prisma.booking.create({
        data: {
          businessId: business.id,
          professionalId: slot.professionalId,
          serviceId: service.id,
          clientId: user.id,
          ...this.period(start, service),
          status: 'CONFIRMED',
          priceCents: service.priceCents,
          cancelToken: randomBytes(32).toString('base64url'),
          idempotencyKey,
        },
        include: withRelations,
      });
      return this.toView(booking);
    } catch (e) {
      const overlap = isOverlapViolation(e);
      const duplicateKey = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
      // Doble click: la misma Idempotency-Key llegó dos veces en paralelo. Según qué
      // índice chequee Postgres primero, falla por la key única o por el constraint.
      if (overlap || duplicateKey) {
        const existing = await this.findByIdempotencyKey(user.id, idempotencyKey);
        if (existing) return existing;
      }
      if (overlap) throw slotTaken();
      throw e;
    }
  }

  async myBookings(user: AuthUser): Promise<BookingView[]> {
    const bookings = await this.prisma.booking.findMany({
      where: { clientId: user.id },
      include: withRelations,
      orderBy: { startsAt: 'desc' },
      take: 100,
    });
    return bookings.map((b) => this.toView(b));
  }

  /** El cliente cancela respetando la política; el negocio puede cancelar siempre. */
  async cancel(user: AuthUser, id: string): Promise<BookingView> {
    const booking = await this.loadForActor(user, id);
    return this.doCancel(booking, booking.clientId === user.id && !(await this.isMember(user, booking.businessId)));
  }

  /** Cancelación sin login desde el link del email (token aleatorio, no el id). */
  async cancelByToken(token: string): Promise<BookingView> {
    if (!token) throw new BadRequestException('Falta el token');
    const booking = await this.prisma.booking.findUnique({ where: { cancelToken: token }, include: withRelations });
    if (!booking) throw new NotFoundException('Link inválido');
    return this.doCancel(booking, true);
  }

  /** Mueve el turno a otro slot en una sola operación; el constraint vuelve a validar. */
  async reschedule(user: AuthUser, id: string, input: RescheduleBookingInput): Promise<BookingView> {
    const booking = await this.loadForActor(user, id);
    this.assertActive(booking);
    const asClient = booking.clientId === user.id && !(await this.isMember(user, booking.businessId));
    if (asClient && !canClientCancel(booking.startsAt, new Date(), booking.business.cancellationHours)) {
      throw new ForbiddenException(
        `Solo se puede reprogramar hasta ${booking.business.cancellationHours} h antes. Comunicate con el negocio.`,
      );
    }
    const start = new Date(input.start);
    const professionalId = input.professionalId ?? booking.professionalId;
    await this.findSlot(booking.business, booking.service, start, professionalId, booking.id);

    try {
      const updated = await this.prisma.booking.update({
        where: { id: booking.id },
        data: { professionalId, ...this.period(start, booking.service) },
        include: withRelations,
      });
      return this.toView(updated);
    } catch (e) {
      if (isOverlapViolation(e)) throw slotTaken();
      throw e;
    }
  }

  async agenda(tenant: Tenant, from: Date, to: Date, professionalId?: string): Promise<BookingView[]> {
    if (to.getTime() - from.getTime() > 62 * 86_400_000) throw new BadRequestException('Rango máximo: 62 días');
    const bookings = await this.prisma.booking.findMany({
      where: {
        businessId: tenant.businessId,
        startsAt: { lt: to },
        endsAt: { gt: from },
        ...(professionalId ? { professionalId } : {}),
      },
      include: withRelations,
      orderBy: { startsAt: 'asc' },
    });
    const clients = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(bookings.map((b) => b.clientId))] } },
      select: { id: true, fullName: true, email: true, phone: true },
    });
    const byId = new Map(clients.map((c) => [c.id, c]));
    return bookings.map((b) => ({ ...this.toView(b), client: byId.get(b.clientId) }));
  }

  async markAttendance(tenant: Tenant, id: string, attended: boolean): Promise<BookingView> {
    const booking = await this.prisma.booking.findFirst({
      where: { id, businessId: tenant.businessId },
      include: withRelations,
    });
    if (!booking) throw new NotFoundException('Turno no encontrado');
    if (!['CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(booking.status)) {
      throw new ConflictException(`No se puede marcar asistencia de un turno ${booking.status}`);
    }
    if (booking.startsAt > new Date()) throw new BadRequestException('El turno todavía no empezó');
    const updated = await this.prisma.booking.update({
      where: { id },
      data: { status: attended ? 'ATTENDED' : 'NO_SHOW' },
      include: withRelations,
    });
    return this.toView(updated);
  }

  // ---------- helpers ----------

  private async findSlot(business: Business, service: Service, start: Date, professionalId?: string, excludeBookingId?: string) {
    if (Number.isNaN(start.getTime())) throw new BadRequestException('Fecha inválida');
    const slots = await this.availability.slots({
      business,
      service,
      date: localDateOf(start, business.timezone),
      professionalId,
      excludeBookingId,
    });
    const slot = slots.find((s) => new Date(s.start).getTime() === start.getTime());
    if (!slot) throw slotTaken();
    return slot;
  }

  private period(start: Date, service: Service) {
    return {
      startsAt: start,
      endsAt: new Date(start.getTime() + service.durationMin * MINUTE),
      blockedUntil: new Date(start.getTime() + (service.durationMin + service.bufferMin) * MINUTE),
    };
  }

  private async doCancel(booking: BookingWithRelations, applyClientPolicy: boolean): Promise<BookingView> {
    this.assertActive(booking);
    if (applyClientPolicy && !canClientCancel(booking.startsAt, new Date(), booking.business.cancellationHours)) {
      throw new ForbiddenException(
        `Solo se puede cancelar hasta ${booking.business.cancellationHours} h antes. Comunicate con el negocio.`,
      );
    }
    // Condición en el WHERE para que dos cancelaciones simultáneas no pisen otro estado.
    const { count } = await this.prisma.booking.updateMany({
      where: { id: booking.id, status: { in: [...ACTIVE_STATUSES] } },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (!count) throw new ConflictException('El turno ya no está activo');
    return this.toView({ ...booking, status: 'CANCELLED' });
  }

  private assertActive(booking: Booking) {
    if (!(ACTIVE_STATUSES as readonly string[]).includes(booking.status)) {
      throw new ConflictException('El turno ya no está activo');
    }
  }

  /** Devuelve el turno si quien pide es el cliente o alguien del negocio; si no, 404 (no revela que existe). */
  private async loadForActor(user: AuthUser, id: string): Promise<BookingWithRelations> {
    const booking = await this.prisma.booking.findUnique({ where: { id }, include: withRelations });
    if (!booking) throw new NotFoundException('Turno no encontrado');
    if (booking.clientId !== user.id && !(await this.isMember(user, booking.businessId))) {
      throw new NotFoundException('Turno no encontrado');
    }
    return booking;
  }

  private async isMember(user: AuthUser, businessId: string) {
    const m = await this.prisma.membership.findUnique({ where: { userId_businessId: { userId: user.id, businessId } } });
    return !!m;
  }

  private async findByIdempotencyKey(clientId: string, idempotencyKey: string) {
    const b = await this.prisma.booking.findUnique({
      where: { clientId_idempotencyKey: { clientId, idempotencyKey } },
      include: withRelations,
    });
    return b ? this.toView(b) : null;
  }

  private toView(b: BookingWithRelations): BookingView {
    return {
      id: b.id,
      status: b.status,
      start: b.startsAt.toISOString(),
      end: b.endsAt.toISOString(),
      priceCents: b.priceCents,
      business: {
        id: b.business.id,
        slug: b.business.slug,
        name: b.business.name,
        timezone: b.business.timezone,
        cancellationHours: b.business.cancellationHours,
      },
      service: { id: b.service.id, name: b.service.name, durationMin: b.service.durationMin },
      professional: { id: b.professional.id, displayName: b.professional.displayName },
      canClientCancel:
        (ACTIVE_STATUSES as readonly string[]).includes(b.status) &&
        canClientCancel(b.startsAt, new Date(), b.business.cancellationHours),
    };
  }
}
