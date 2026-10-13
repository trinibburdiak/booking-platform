import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Business, Service } from '@prisma/client';
import { busyLookupWindow, computeSlots, Slot } from '@turnos/availability';
import { AvailableSlot } from '@turnos/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityCache } from '../redis/redis.module';

export const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED'] as const;

export interface SlotQuery {
  business: Business;
  service: Service;
  date: string;
  professionalId?: string;
  /** Al reprogramar, el turno propio no cuenta como ocupado. */
  excludeBookingId?: string;
  now?: Date;
  /** Ignora el caché: lo usa la validación previa a reservar. */
  fresh?: boolean;
}

/** Lo que se cachea por profesional, día y servicio. `load` = turnos de ese día, para repartir "cualquiera". */
interface CachedDay {
  load: number;
  slots: Slot[];
}

/**
 * Lee de la base lo que necesita la función pura `computeSlots` y combina los
 * resultados de varios profesionales cuando el cliente elige "cualquiera".
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AvailabilityCache,
  ) {}

  async resolveBusinessAndService(slug: string, serviceId: string) {
    const business = await this.prisma.business.findUnique({ where: { slug } });
    if (!business) throw new NotFoundException('Negocio no encontrado');
    const service = await this.prisma.service.findFirst({ where: { id: serviceId, businessId: business.id, active: true } });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    return { business, service };
  }

  async slots(q: SlotQuery): Promise<AvailableSlot[]> {
    const { business, service, date } = q;
    const professionals = await this.prisma.professional.findMany({
      where: {
        businessId: business.id,
        active: true,
        services: { some: { serviceId: service.id } },
        ...(q.professionalId ? { id: q.professionalId } : {}),
      },
      include: {
        schedules: true,
        exceptions: { where: { date } },
      },
    });
    if (q.professionalId && !professionals.length) {
      throw new BadRequestException('Ese profesional no ofrece este servicio');
    }

    const now = q.now ?? new Date();
    const useCache = !q.fresh && !q.excludeBookingId && !q.now;
    const window = busyLookupWindow(date, business.timezone);
    const earliest = now.getTime() + business.minNoticeMinutes * 60_000;

    const byStart = new Map<string, AvailableSlot & { load: number }>();
    for (const pro of professionals) {
      let day = useCache ? await this.cache.get<CachedDay>(pro.id, date, service.id) : null;
      if (!day) {
        const busy = await this.prisma.booking.findMany({
          where: {
            professionalId: pro.id,
            status: { in: [...ACTIVE_STATUSES] },
            startsAt: { lt: window.to },
            blockedUntil: { gt: window.from },
            ...(q.excludeBookingId ? { id: { not: q.excludeBookingId } } : {}),
          },
          select: { startsAt: true, blockedUntil: true },
        });
        const slots = computeSlots({
          date,
          timezone: business.timezone,
          schedule: pro.schedules,
          exceptions: pro.exceptions,
          busy: busy.map((b) => ({ start: b.startsAt, end: b.blockedUntil })),
          durationMin: service.durationMin,
          bufferMin: service.bufferMin,
          now,
          minNoticeMin: business.minNoticeMinutes,
          bookingWindowDays: business.bookingWindowDays,
        });
        day = { load: busy.length, slots };
        if (useCache) await this.cache.set(pro.id, date, service.id, day);
      }
      // Con "cualquiera", cada horario se asigna al profesional con menos turnos ese día.
      // El aviso mínimo se vuelve a aplicar porque el caché pudo calcularse unos minutos antes.
      for (const slot of day.slots) {
        if (new Date(slot.start).getTime() < earliest) continue;
        const current = byStart.get(slot.start);
        if (!current || day.load < current.load) {
          byStart.set(slot.start, { ...slot, professionalId: pro.id, load: day.load });
        }
      }
    }
    return [...byStart.values()]
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(({ load: _load, ...slot }) => slot);
  }
}
