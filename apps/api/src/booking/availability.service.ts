import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Business, Service } from '@prisma/client';
import { busyLookupWindow, computeSlots } from '@turnos/availability';
import { AvailableSlot } from '@turnos/contracts';
import { PrismaService } from '../prisma/prisma.service';

export const ACTIVE_STATUSES = ['PENDING', 'CONFIRMED'] as const;

export interface SlotQuery {
  business: Business;
  service: Service;
  date: string;
  professionalId?: string;
  /** Al reprogramar, el turno propio no cuenta como ocupado. */
  excludeBookingId?: string;
  now?: Date;
}

/**
 * Lee de la base lo que necesita la función pura `computeSlots` y combina los
 * resultados de varios profesionales cuando el cliente elige "cualquiera".
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

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

    const window = busyLookupWindow(date, business.timezone);
    const busy = await this.prisma.booking.findMany({
      where: {
        professionalId: { in: professionals.map((p) => p.id) },
        status: { in: [...ACTIVE_STATUSES] },
        startsAt: { lt: window.to },
        blockedUntil: { gt: window.from },
        ...(q.excludeBookingId ? { id: { not: q.excludeBookingId } } : {}),
      },
      select: { professionalId: true, startsAt: true, blockedUntil: true },
    });

    const now = q.now ?? new Date();
    const byStart = new Map<string, AvailableSlot & { load: number }>();
    for (const pro of professionals) {
      const proBusy = busy.filter((b) => b.professionalId === pro.id);
      const slots = computeSlots({
        date,
        timezone: business.timezone,
        schedule: pro.schedules,
        exceptions: pro.exceptions,
        busy: proBusy.map((b) => ({ start: b.startsAt, end: b.blockedUntil })),
        durationMin: service.durationMin,
        bufferMin: service.bufferMin,
        now,
        minNoticeMin: business.minNoticeMinutes,
        bookingWindowDays: business.bookingWindowDays,
      });
      // Con "cualquiera", cada horario se asigna al profesional con menos turnos ese día.
      for (const slot of slots) {
        const current = byStart.get(slot.start);
        if (!current || proBusy.length < current.load) {
          byStart.set(slot.start, { ...slot, professionalId: pro.id, load: proBusy.length });
        }
      }
    }
    return [...byStart.values()]
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(({ load: _load, ...slot }) => slot);
  }
}
