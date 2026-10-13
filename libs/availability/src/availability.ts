import { DateTime, IANAZone } from 'luxon';

/** Tramo del horario semanal, en hora local del negocio ("HH:mm"). weekday: 0 = domingo … 6 = sábado. */
export interface WeeklyRange {
  weekday: number;
  startTime: string;
  endTime: string;
}

export type ExceptionType = 'CLOSED' | 'EXTRA_HOURS';

/**
 * Excepción para una fecha local ("YYYY-MM-DD").
 * CLOSED sin horas cierra el día entero; con horas, quita ese tramo.
 * EXTRA_HOURS suma un tramo.
 */
export interface ScheduleExceptionRule {
  date: string;
  type: ExceptionType;
  startTime?: string | null;
  endTime?: string | null;
}

/** Intervalo ocupado en UTC. Debe incluir el buffer del servicio que lo ocupa. */
export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface AvailabilityInput {
  /** Fecha local del negocio, "YYYY-MM-DD". */
  date: string;
  /** Zona IANA del negocio, ej. "America/Argentina/Cordoba". */
  timezone: string;
  schedule: WeeklyRange[];
  exceptions: ScheduleExceptionRule[];
  busy: BusyInterval[];
  durationMin: number;
  bufferMin: number;
  now: Date;
  /** Aviso mínimo en minutos (ej. 120). */
  minNoticeMin: number;
  /** Cuántos días hacia adelante se puede reservar, contando desde hoy (hora local). */
  bookingWindowDays: number;
  /** Paso entre slots. Por defecto 15 minutos. */
  stepMin?: number;
}

export interface Slot {
  /** Inicio en UTC (ISO 8601), para reservar. */
  start: string;
  /** Fin del servicio en UTC (sin buffer). */
  end: string;
  /** Hora local del negocio, para mostrar. */
  localStart: string;
  localEnd: string;
}

/** Intervalo en milisegundos epoch, [start, end). */
export interface Interval {
  start: number;
  end: number;
}

const MINUTE = 60_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Convierte un tramo local de un día a un intervalo UTC.
 * Si el fin es menor o igual al inicio, el tramo cruza la medianoche y termina al día siguiente.
 * Los cambios de horario (DST) los resuelve Luxon al interpretar la hora en la zona del negocio.
 */
function localRangeToInterval(date: string, startTime: string, endTime: string, zone: string): Interval {
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    throw new Error(`Hora inválida: ${startTime}-${endTime}`);
  }
  const start = DateTime.fromISO(`${date}T${startTime}`, { zone });
  let end = DateTime.fromISO(`${date}T${endTime}`, { zone });
  if (end <= start) end = DateTime.fromISO(`${date}T${endTime}`, { zone }).plus({ days: 1 });
  return { start: start.toMillis(), end: end.toMillis() };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

function subtractInterval(ranges: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const r of ranges) {
    if (cut.end <= r.start || cut.start >= r.end) {
      out.push(r);
      continue;
    }
    if (cut.start > r.start) out.push({ start: r.start, end: cut.start });
    if (cut.end < r.end) out.push({ start: cut.end, end: r.end });
  }
  return out;
}

/** Tramos de atención de un día (pasos 1 a 3), en UTC. */
export function workingIntervals(
  date: string,
  timezone: string,
  schedule: WeeklyRange[],
  exceptions: ScheduleExceptionRule[],
): Interval[] {
  if (!DATE_RE.test(date)) throw new Error(`Fecha inválida: ${date}`);
  const day = DateTime.fromISO(date, { zone: timezone });
  if (!day.isValid) throw new Error(`Fecha o zona inválida: ${date} ${timezone}`);
  const weekday = day.weekday % 7; // Luxon: 1 = lunes … 7 = domingo

  const todays = exceptions.filter((e) => e.date === date);
  const closedAllDay = todays.some((e) => e.type === 'CLOSED' && !e.startTime && !e.endTime);

  let ranges: Interval[] = closedAllDay
    ? []
    : schedule
        .filter((s) => s.weekday === weekday)
        .map((s) => localRangeToInterval(date, s.startTime, s.endTime, timezone));

  for (const e of todays) {
    if (e.type === 'EXTRA_HOURS' && e.startTime && e.endTime) {
      ranges.push(localRangeToInterval(date, e.startTime, e.endTime, timezone));
    }
  }
  ranges = mergeIntervals(ranges);

  for (const e of todays) {
    if (e.type === 'CLOSED' && e.startTime && e.endTime) {
      ranges = subtractInterval(ranges, localRangeToInterval(date, e.startTime, e.endTime, timezone));
    }
  }
  return ranges;
}

/**
 * Calcula los slots libres de un profesional para un servicio en un día.
 * Función pura: no depende de la base ni del framework.
 */
export function computeSlots(input: AvailabilityInput): Slot[] {
  const { date, timezone, durationMin, bufferMin, now } = input;
  const step = (input.stepMin ?? 15) * MINUTE;
  const duration = durationMin * MINUTE;
  const blocked = (durationMin + bufferMin) * MINUTE;
  if (durationMin <= 0) throw new Error('La duración debe ser positiva');

  const ranges = workingIntervals(date, timezone, input.schedule, input.exceptions);
  const busy = mergeIntervals(input.busy.map((b) => ({ start: b.start.getTime(), end: b.end.getTime() })));

  const earliest = now.getTime() + input.minNoticeMin * MINUTE;
  const latest = DateTime.fromJSDate(now, { zone: timezone })
    .startOf('day')
    .plus({ days: input.bookingWindowDays + 1 })
    .toMillis();

  const slots: Slot[] = [];
  for (const range of ranges) {
    for (let s = range.start; s + duration <= range.end; s += step) {
      if (s < earliest || s >= latest) continue;
      const occupiedUntil = s + blocked;
      if (busy.some((b) => s < b.end && occupiedUntil > b.start)) continue;
      const start = DateTime.fromMillis(s, { zone: timezone });
      const end = DateTime.fromMillis(s + duration, { zone: timezone });
      slots.push({
        start: start.toUTC().toISO()!,
        end: end.toUTC().toISO()!,
        localStart: start.toFormat('HH:mm'),
        localEnd: end.toFormat('HH:mm'),
      });
    }
  }
  return slots;
}

/** Ventana UTC que hay que consultar para traer turnos ocupados de un día (incluye tramos que cruzan medianoche). */
export function busyLookupWindow(date: string, timezone: string): { from: Date; to: Date } {
  const day = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  return { from: day.toJSDate(), to: day.plus({ days: 2 }).toJSDate() };
}

export function isValidTimeZone(timezone: string): boolean {
  return IANAZone.isValidZone(timezone);
}

/** Fecha local ("YYYY-MM-DD") de un instante en la zona del negocio. */
export function localDateOf(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate()!;
}
