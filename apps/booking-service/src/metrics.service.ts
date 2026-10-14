import { BadRequestException, Injectable } from '@nestjs/common';
import { Tenant } from '@turnos/common';
import { PrismaService } from './prisma.service';

interface Counts {
  attended: number;
  noShow: number;
  cancelled: number;
  expired: number;
}

export interface MetricsView {
  from: string;
  to: string;
  totals: Counts & { booked: number; upcoming: number; noShowRate: number | null; revenueCents: number };
  byProfessional: (Counts & { professionalId: string; displayName: string; noShowRate: number | null })[];
  byWeekday: { weekday: number; attended: number; noShow: number; noShowRate: number | null }[];
  repeatNoShows: { clientId: string; fullName: string; email: string; noShows: number }[];
}

const rate = (c: { attended: number; noShow: number }) => (c.attended + c.noShow ? c.noShow / (c.attended + c.noShow) : null);

/**
 * Métricas de ausentismo: de los turnos que ya pasaron, cuántos asistieron y
 * cuántos no. La tasa es no asistidos / (asistidos + no asistidos): los
 * cancelados a tiempo no cuentan como ausentismo.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenant: Tenant, from: Date, to: Date): Promise<MetricsView> {
    if (to <= from) throw new BadRequestException('Rango inválido');
    if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new BadRequestException('Rango máximo: 400 días');
    const businessId = tenant.businessId;
    const { timezone } = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } });

    const n = (v: bigint | number | null) => Number(v ?? 0);

    const [pros, weekdays, repeat, totals] = await Promise.all([
      this.prisma.$queryRaw<{ id: string; display_name: string; attended: bigint; no_show: bigint; cancelled: bigint; expired: bigint }[]>`
        SELECT p.id, p.display_name,
          count(*) FILTER (WHERE b.status = 'ATTENDED') AS attended,
          count(*) FILTER (WHERE b.status = 'NO_SHOW') AS no_show,
          count(*) FILTER (WHERE b.status = 'CANCELLED') AS cancelled,
          count(*) FILTER (WHERE b.status = 'EXPIRED') AS expired
        FROM bookings b JOIN professional_replica p ON p.id = b.professional_id
        WHERE b.business_id = ${businessId}::uuid AND b.starts_at >= ${from} AND b.starts_at < ${to}
        GROUP BY p.id, p.display_name ORDER BY p.display_name`,
      this.prisma.$queryRaw<{ weekday: number; attended: bigint; no_show: bigint }[]>`
        SELECT extract(dow FROM b.starts_at AT TIME ZONE ${timezone})::int AS weekday,
          count(*) FILTER (WHERE b.status = 'ATTENDED') AS attended,
          count(*) FILTER (WHERE b.status = 'NO_SHOW') AS no_show
        FROM bookings b
        WHERE b.business_id = ${businessId}::uuid AND b.starts_at >= ${from} AND b.starts_at < ${to}
          AND b.status IN ('ATTENDED', 'NO_SHOW')
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ client_id: string; full_name: string | null; email: string | null; no_shows: bigint }[]>`
        SELECT b.client_id, c.full_name, c.email, count(*) AS no_shows
        FROM bookings b LEFT JOIN client_replica c ON c.id = b.client_id
        WHERE b.business_id = ${businessId}::uuid AND b.starts_at >= ${from} AND b.starts_at < ${to} AND b.status = 'NO_SHOW'
        GROUP BY b.client_id, c.full_name, c.email HAVING count(*) >= 2
        ORDER BY no_shows DESC LIMIT 5`,
      this.prisma.$queryRaw<{ booked: bigint; upcoming: bigint; revenue: bigint | null }[]>`
        SELECT count(*) FILTER (WHERE b.status NOT IN ('EXPIRED')) AS booked,
          count(*) FILTER (WHERE b.status IN ('CONFIRMED', 'PENDING') AND b.starts_at > now()) AS upcoming,
          sum(b.price_cents) FILTER (WHERE b.status = 'ATTENDED') AS revenue
        FROM bookings b
        WHERE b.business_id = ${businessId}::uuid AND b.starts_at >= ${from} AND b.starts_at < ${to}`,
    ]);

    const byProfessional = pros.map((p) => {
      const c = { attended: n(p.attended), noShow: n(p.no_show), cancelled: n(p.cancelled), expired: n(p.expired) };
      return { professionalId: p.id, displayName: p.display_name, ...c, noShowRate: rate(c) };
    });
    const sum = byProfessional.reduce(
      (a, p) => ({ attended: a.attended + p.attended, noShow: a.noShow + p.noShow, cancelled: a.cancelled + p.cancelled, expired: a.expired + p.expired }),
      { attended: 0, noShow: 0, cancelled: 0, expired: 0 },
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        ...sum,
        booked: n(totals[0]?.booked),
        upcoming: n(totals[0]?.upcoming),
        revenueCents: n(totals[0]?.revenue),
        noShowRate: rate(sum),
      },
      byProfessional,
      byWeekday: weekdays.map((w) => {
        const c = { attended: n(w.attended), noShow: n(w.no_show) };
        return { weekday: w.weekday, ...c, noShowRate: rate(c) };
      }),
      repeatNoShows: repeat.map((r) => ({
        clientId: r.client_id,
        fullName: r.full_name ?? 'Cliente',
        email: r.email ?? '',
        noShows: n(r.no_shows),
      })),
    };
  }
}
