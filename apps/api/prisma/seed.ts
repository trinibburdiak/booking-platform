/**
 * Negocio demo ("Barbería Demo") con usuarios de prueba y turnos cargados,
 * para que cualquiera pruebe la app en 30 segundos.
 *
 *   Dueño:   demo@turnos.dev    / demo1234
 *   Cliente: cliente@turnos.dev / demo1234
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { computeSlots, localDateOf } from '@turnos/availability';
import * as argon2 from 'argon2';
import { randomBytes, randomUUID } from 'crypto';

const prisma = new PrismaClient();
const TZ = 'America/Argentina/Cordoba';
const SLUG = 'barberia-demo';

async function main() {
  await prisma.business.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { email: { in: ['demo@turnos.dev', 'cliente@turnos.dev'] } } });

  const passwordHash = await argon2.hash('demo1234');
  const owner = await prisma.user.create({
    data: { email: 'demo@turnos.dev', passwordHash, fullName: 'Dueña Demo', phone: '+54 351 000-0000' },
  });
  const client = await prisma.user.create({
    data: { email: 'cliente@turnos.dev', passwordHash, fullName: 'Cliente Demo', phone: '+54 351 111-1111' },
  });

  const business = await prisma.business.create({
    data: {
      slug: SLUG,
      name: 'Barbería Demo',
      timezone: TZ,
      address: 'Bv. San Juan 123, Córdoba',
      cancellationHours: 12,
      bookingWindowDays: 30,
      minNoticeMinutes: 60,
      memberships: { create: { userId: owner.id, role: 'OWNER' } },
    },
  });

  const [corte, barba, combo] = await Promise.all([
    prisma.service.create({ data: { businessId: business.id, name: 'Corte', durationMin: 30, bufferMin: 5, priceCents: 900000 } }),
    prisma.service.create({ data: { businessId: business.id, name: 'Barba', durationMin: 20, bufferMin: 5, priceCents: 600000 } }),
    prisma.service.create({ data: { businessId: business.id, name: 'Corte + barba', durationMin: 50, bufferMin: 10, priceCents: 1350000 } }),
  ]);

  const weekdays = [1, 2, 3, 4, 5];
  const pros = await Promise.all([
    prisma.professional.create({
      data: {
        businessId: business.id,
        displayName: 'Lucía',
        services: { create: [corte, barba, combo].map((s) => ({ serviceId: s.id })) },
        schedules: {
          create: [
            ...weekdays.flatMap((weekday) => [
              { weekday, startTime: '09:00', endTime: '13:00' },
              { weekday, startTime: '16:00', endTime: '20:00' },
            ]),
            { weekday: 6, startTime: '09:00', endTime: '14:00' },
          ],
        },
      },
      include: { schedules: true },
    }),
    prisma.professional.create({
      data: {
        businessId: business.id,
        displayName: 'Mateo',
        services: { create: [corte, combo].map((s) => ({ serviceId: s.id })) },
        schedules: { create: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '11:00', endTime: '19:00' })) },
      },
      include: { schedules: true },
    }),
  ]);

  // Un feriado de ejemplo dentro de las próximas semanas
  const now = new Date();
  const holiday = localDateOf(new Date(now.getTime() + 10 * 86_400_000), TZ);
  await prisma.scheduleException.create({
    data: { professionalId: pros[0].id, date: holiday, type: 'CLOSED', reason: 'Feriado' },
  });

  // Turnos en los próximos 7 días, elegidos entre los slots realmente libres
  let created = 0;
  for (let d = 0; d < 7; d++) {
    const date = localDateOf(new Date(now.getTime() + d * 86_400_000), TZ);
    for (const [i, pro] of pros.entries()) {
      const service = i === 0 ? corte : combo;
      const busy = await prisma.booking.findMany({
        where: { professionalId: pro.id, status: 'CONFIRMED' },
        select: { startsAt: true, blockedUntil: true },
      });
      const slots = computeSlots({
        date,
        timezone: TZ,
        schedule: pro.schedules,
        exceptions: [],
        busy: busy.map((b) => ({ start: b.startsAt, end: b.blockedUntil })),
        durationMin: service.durationMin,
        bufferMin: service.bufferMin,
        now,
        minNoticeMin: 60,
        bookingWindowDays: 30,
      });
      for (const slot of slots.filter((_, idx) => idx % 5 === 1).slice(0, 3)) {
        const start = new Date(slot.start);
        await prisma.booking.create({
          data: {
            businessId: business.id,
            professionalId: pro.id,
            serviceId: service.id,
            clientId: client.id,
            startsAt: start,
            endsAt: new Date(start.getTime() + service.durationMin * 60_000),
            blockedUntil: new Date(start.getTime() + (service.durationMin + service.bufferMin) * 60_000),
            status: 'CONFIRMED',
            priceCents: service.priceCents,
            cancelToken: randomBytes(32).toString('base64url'),
            idempotencyKey: randomUUID(),
          },
        });
        created++;
      }
    }
  }

  console.log(`Seed listo: ${business.name} (/b/${SLUG}) con ${pros.length} profesionales y ${created} turnos.`);
  console.log('Dueño: demo@turnos.dev / demo1234 — Cliente: cliente@turnos.dev / demo1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
