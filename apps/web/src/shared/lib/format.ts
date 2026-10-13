import { DateTime } from 'luxon';

/** Las fechas siempre se muestran en la zona horaria del negocio, no la del navegador. */
export function inZone(iso: string, zone: string) {
  return DateTime.fromISO(iso, { zone }).setLocale('es-AR');
}

export const formatTime = (iso: string, zone: string) => inZone(iso, zone).toFormat('HH:mm');

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const formatDateLong = (iso: string, zone: string) => capitalize(inZone(iso, zone).toFormat("cccc d 'de' LLLL"));

export const formatDateTime = (iso: string, zone: string) =>
  capitalize(inZone(iso, zone).toFormat("ccc d 'de' LLL, HH:mm"));

export function formatPrice(cents: number) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(
    cents / 100,
  );
}

/** Próximos `n` días (fecha local del negocio), a partir de hoy. */
export function nextDays(zone: string, n: number) {
  const today = DateTime.now().setZone(zone).startOf('day').setLocale('es-AR');
  return Array.from({ length: n }, (_, i) => {
    const d = today.plus({ days: i });
    return {
      date: d.toISODate()!,
      weekday: i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : d.toFormat('ccc'),
      day: d.toFormat('d'),
      month: d.toFormat('LLL'),
    };
  });
}

export const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmado',
  CANCELLED: 'Cancelado',
  EXPIRED: 'Vencido',
  ATTENDED: 'Asistió',
  NO_SHOW: 'No asistió',
};

export const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-800 ring-amber-200',
  CONFIRMED: 'bg-brand-50 text-brand-700 ring-brand-100',
  CANCELLED: 'bg-stone-100 text-stone-500 ring-stone-200',
  EXPIRED: 'bg-stone-100 text-stone-500 ring-stone-200',
  ATTENDED: 'bg-sky-50 text-sky-700 ring-sky-200',
  NO_SHOW: 'bg-red-50 text-red-700 ring-red-200',
};
