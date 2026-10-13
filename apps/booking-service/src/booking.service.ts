import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser, isMemberOf, Tenant } from '@turnos/common';
import { canClientCancel, localDateOf } from '@turnos/availability';
import {
  BookingEvent,
  BookingEventPayload,
  BookingEventType,
  BookingView,
  CreateBookingInput,
  InternalBookingDetail,
  RescheduleBookingInput,
  TOPICS,
} from '@turnos/contracts';
import { envelope, OutboxRelay, outboxRecord } from '@turnos/kafka';
import { randomBytes } from 'crypto';
import { Booking, Business, Prisma, Professional, Service } from '../generated/prisma';
import { PrismaService } from './prisma.service';
import { AvailabilityCache } from './redis.module';
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
    private readonly cache: AvailabilityCache,
    private readonly relay: OutboxRelay,
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
      // El turno y su evento se guardan en la misma transacción (outbox).
      const booking = await this.prisma.$transaction(async (tx) => {
        const created = await tx.booking.create({
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
        await this.writeEvent(tx, 'booking.confirmed', created);
        return created;
      });
      await this.afterCommit(booking);
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
    return this.doCancel(booking, booking.clientId === user.id && !isMemberOf(user, booking.businessId));
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
    const asClient = booking.clientId === user.id && !isMemberOf(user, booking.businessId);
    if (asClient && !canClientCancel(booking.startsAt, new Date(), booking.business.cancellationHours)) {
      throw new ForbiddenException(
        `Solo se puede reprogramar hasta ${booking.business.cancellationHours} h antes. Comunicate con el negocio.`,
      );
    }
    const start = new Date(input.start);
    const professionalId = input.professionalId ?? booking.professionalId;
    await this.findSlot(booking.business, booking.service, start, professionalId, booking.id);

    try {
      const previous = { professionalId: booking.professionalId, start: booking.startsAt.toISOString() };
      const updated = await this.prisma.$transaction(async (tx) => {
        const u = await tx.booking.update({
          where: { id: booking.id },
          data: { professionalId, ...this.period(start, booking.service) },
          include: withRelations,
        });
        await this.writeEvent(tx, 'booking.rescheduled', u, { previous });
        return u;
      });
      await this.afterCommit(updated, previous);
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
    const clients = await this.prisma.client.findMany({
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
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.booking.update({
        where: { id },
        data: { status: attended ? 'ATTENDED' : 'NO_SHOW' },
        include: withRelations,
      });
      await this.writeEvent(tx, 'booking.attendance', u);
      return u;
    });
    this.relay.kick();
    return this.toView(updated);
  }

  /**
   * Job horario: los turnos confirmados que terminaron hace más de `graceHours`
   * sin asistencia marcada pasan a NO_SHOW (insumo de las métricas de ausentismo).
   */
  async markNoShows(now = new Date(), graceHours = 24): Promise<number> {
    const stale = await this.prisma.booking.findMany({
      where: { status: 'CONFIRMED', endsAt: { lt: new Date(now.getTime() - graceHours * 3_600_000) } },
      include: withRelations,
      take: 500,
    });
    let marked = 0;
    for (const b of stale) {
      const done = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.booking.updateMany({
          where: { id: b.id, status: 'CONFIRMED' },
          data: { status: 'NO_SHOW' },
        });
        if (count) await this.writeEvent(tx, 'booking.no_show', { ...b, status: 'NO_SHOW' });
        return count > 0;
      });
      if (done) marked++;
    }
    if (marked) this.relay.kick();
    return marked;
  }

  /** Para notifications-service: todo lo que necesita un email del turno. */
  async internalDetail(id: string): Promise<InternalBookingDetail> {
    const b = await this.prisma.booking.findUnique({ where: { id }, include: withRelations });
    if (!b) throw new NotFoundException('Turno no encontrado');
    const client = await this.prisma.client.findUnique({ where: { id: b.clientId } });
    if (!client) throw new NotFoundException('Cliente todavía no replicado');
    return {
      id: b.id,
      status: b.status,
      start: b.startsAt.toISOString(),
      end: b.endsAt.toISOString(),
      cancelToken: b.cancelToken,
      business: {
        id: b.business.id,
        slug: b.business.slug,
        name: b.business.name,
        address: b.business.address,
        timezone: b.business.timezone,
        cancellationHours: b.business.cancellationHours,
      },
      service: { name: b.service.name },
      professional: { displayName: b.professional.displayName },
      client: { id: client.id, email: client.email, fullName: client.fullName },
    };
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
      fresh: true,
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
    const cancelled = { ...booking, status: 'CANCELLED' as const };
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.booking.updateMany({
        where: { id: booking.id, status: { in: [...ACTIVE_STATUSES] } },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      if (!count) throw new ConflictException('El turno ya no está activo');
      await this.writeEvent(tx, 'booking.cancelled', cancelled, { cancelledBy: applyClientPolicy ? 'CLIENT' : 'BUSINESS' });
    });
    await this.afterCommit(cancelled);
    return this.toView(cancelled);
  }

  /** Escribe el evento en el outbox, dentro de la transacción del cambio. */
  private async writeEvent(
    tx: Prisma.TransactionClient,
    type: BookingEventType,
    b: Booking,
    extra: Partial<BookingEventPayload> = {},
  ) {
    const event: BookingEvent = envelope(type, b.businessId, {
      bookingId: b.id,
      professionalId: b.professionalId,
      clientId: b.clientId,
      start: b.startsAt.toISOString(),
      end: b.endsAt.toISOString(),
      status: b.status,
      ...extra,
    });
    await tx.outboxEvent.create({ data: outboxRecord(TOPICS.booking, b.id, event) as Prisma.OutboxEventCreateInput });
  }

  /**
   * Después del commit: invalida el caché de disponibilidad (de forma síncrona, para
   * que la próxima consulta ya lo vea) y despierta al relay para publicar enseguida.
   */
  private async afterCommit(b: BookingWithRelations, previous?: { professionalId: string; start: string }) {
    const tz = b.business.timezone;
    const days = (pro: string, start: Date) => {
      const day = localDateOf(start, tz);
      // El día anterior también, por los tramos que cruzan la medianoche.
      const before = localDateOf(new Date(start.getTime() - 86_400_000), tz);
      return this.cache.invalidateDay(pro, day, before);
    };
    await days(b.professionalId, b.startsAt);
    if (previous) await days(previous.professionalId, new Date(previous.start));
    this.relay.kick();
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
    if (booking.clientId !== user.id && !isMemberOf(user, booking.businessId)) {
      throw new NotFoundException('Turno no encontrado');
    }
    return booking;
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
