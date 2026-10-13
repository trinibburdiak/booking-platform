import { AvailabilityInput, computeSlots, workingIntervals } from './availability';
import { canClientCancel } from './cancellation';

const TZ = 'America/Argentina/Cordoba'; // UTC-3, sin horario de verano

// Lunes 2026-10-19
const MONDAY = '2026-10-19';

function input(overrides: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    date: MONDAY,
    timezone: TZ,
    schedule: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }],
    exceptions: [],
    busy: [],
    durationMin: 30,
    bufferMin: 0,
    now: new Date('2026-10-13T12:00:00Z'),
    minNoticeMin: 120,
    bookingWindowDays: 30,
    stepMin: 15,
    ...overrides,
  };
}

const locals = (i: AvailabilityInput) => computeSlots(i).map((s) => s.localStart);

describe('computeSlots', () => {
  it('corta el tramo en slots con paso fijo y devuelve UTC y hora local', () => {
    const slots = computeSlots(input());
    expect(slots[0]).toEqual({
      start: '2026-10-19T12:00:00.000Z',
      end: '2026-10-19T12:30:00.000Z',
      localStart: '09:00',
      localEnd: '09:30',
    });
    expect(slots.map((s) => s.localStart)).toEqual([
      '09:00', '09:15', '09:30', '09:45', '10:00', '10:15',
      '10:30', '10:45', '11:00', '11:15', '11:30',
    ]);
  });

  it('no ofrece un servicio que no entra al final del tramo', () => {
    const out = locals(input({ durationMin: 50 }));
    expect(out[out.length - 1]).toBe('11:00'); // 11:15 + 50 = 12:05 > 12:00
  });

  it('respeta varios tramos por día (9–13 y 16–20)', () => {
    const out = locals(
      input({
        schedule: [
          { weekday: 1, startTime: '09:00', endTime: '10:00' },
          { weekday: 1, startTime: '16:00', endTime: '17:00' },
        ],
        durationMin: 60,
      }),
    );
    expect(out).toEqual(['09:00', '16:00']);
  });

  it('no devuelve nada en un día sin horario', () => {
    expect(computeSlots(input({ date: '2026-10-20' }))).toEqual([]); // martes
  });

  it('feriado: CLOSED sin horas cierra el día', () => {
    expect(computeSlots(input({ exceptions: [{ date: MONDAY, type: 'CLOSED' }] }))).toEqual([]);
  });

  it('CLOSED con horas quita solo ese tramo', () => {
    const out = locals(
      input({ durationMin: 60, exceptions: [{ date: MONDAY, type: 'CLOSED', startTime: '10:00', endTime: '11:00' }] }),
    );
    expect(out).toEqual(['09:00', '11:00']);
  });

  it('EXTRA_HOURS suma un tramo, incluso en un día cerrado', () => {
    const out = locals(
      input({
        date: '2026-10-20',
        durationMin: 60,
        exceptions: [{ date: '2026-10-20', type: 'EXTRA_HOURS', startTime: '18:00', endTime: '19:00' }],
      }),
    );
    expect(out).toEqual(['18:00']);
  });

  it('resta turnos ocupados, considerando el buffer del servicio nuevo', () => {
    // Ocupado 10:00–10:30 local (13:00–13:30Z)
    const busy = [{ start: new Date('2026-10-19T13:00:00Z'), end: new Date('2026-10-19T13:30:00Z') }];
    const sinBuffer = locals(input({ busy }));
    expect(sinBuffer).toContain('09:30');
    expect(sinBuffer).not.toContain('09:45');
    expect(sinBuffer).not.toContain('10:15');
    expect(sinBuffer).toContain('10:30');

    const conBuffer = locals(input({ busy, bufferMin: 10 }));
    expect(conBuffer).not.toContain('09:30'); // 09:30 + 30 + 10 pisa las 10:00
    expect(conBuffer).toContain('09:15');
  });

  it('descarta slots en el pasado y dentro del aviso mínimo', () => {
    // Ahora: lunes 09:40 local. Aviso mínimo 60 min → primer slot 10:45
    const out = locals(input({ now: new Date('2026-10-19T12:40:00Z'), minNoticeMin: 60 }));
    expect(out[0]).toBe('10:45');
  });

  it('descarta días más allá de booking_window_days', () => {
    expect(computeSlots(input({ bookingWindowDays: 5 }))).toEqual([]); // hoy 13/10 + 5 = 18/10
    expect(computeSlots(input({ bookingWindowDays: 6 }))).not.toEqual([]);
  });

  it('turno que cruza la medianoche pertenece al día en que empieza', () => {
    const out = computeSlots(
      input({ schedule: [{ weekday: 1, startTime: '23:00', endTime: '01:00' }], durationMin: 60, stepMin: 60 }),
    );
    expect(out.map((s) => [s.localStart, s.start])).toEqual([
      ['23:00', '2026-10-20T02:00:00.000Z'],
      ['00:00', '2026-10-20T03:00:00.000Z'],
    ]);
  });

  it('cambio de día por UTC: un turno 22:00 local cae al día siguiente en UTC', () => {
    const [slot] = computeSlots(
      input({ schedule: [{ weekday: 1, startTime: '22:00', endTime: '23:00' }], durationMin: 60 }),
    );
    expect(slot.start).toBe('2026-10-20T01:00:00.000Z');
    expect(slot.localStart).toBe('22:00');
  });

  it('cambio de horario (DST): el tramo 01:00–04:00 dura 2 h el día que se adelanta el reloj', () => {
    // Europa/Madrid adelanta el reloj el domingo 2026-03-29 a las 02:00
    const [range] = workingIntervals(
      '2026-03-29',
      'Europe/Madrid',
      [{ weekday: 0, startTime: '01:00', endTime: '04:00' }],
      [],
    );
    expect((range.end - range.start) / 3_600_000).toBe(2);
  });
});

describe('canClientCancel', () => {
  const start = new Date('2026-10-20T15:00:00Z');
  it('permite cancelar con anticipación suficiente', () => {
    expect(canClientCancel(start, new Date('2026-10-19T15:00:00Z'), 24)).toBe(true);
  });
  it('no permite cancelar dentro del plazo', () => {
    expect(canClientCancel(start, new Date('2026-10-19T15:00:01Z'), 24)).toBe(false);
  });
});
