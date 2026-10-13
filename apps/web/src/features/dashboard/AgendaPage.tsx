import type { BookingView } from '@turnos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { api, errorMessage } from '../../shared/lib/api';
import { capitalize, formatPrice, formatTime } from '../../shared/lib/format';
import { Alert, EmptyState, Modal, Spinner, StatusBadge } from '../../shared/ui';
import { useBusiness, useBusinessKey, useProfessionals } from './hooks';

const HOUR_PX = 64;
const BLOCK_STYLE: Record<string, string> = {
  CONFIRMED: 'border-brand-500 bg-brand-50 text-brand-700',
  PENDING: 'border-amber-400 bg-amber-50 text-amber-800',
  ATTENDED: 'border-sky-400 bg-sky-50 text-sky-800',
  NO_SHOW: 'border-red-300 bg-red-50 text-red-700',
  CANCELLED: 'border-stone-300 bg-stone-50 text-stone-400 line-through',
  EXPIRED: 'border-stone-300 bg-stone-50 text-stone-400 line-through',
};

/** Vista día por profesional. En la etapa 3 se reemplaza por FullCalendar con drag & drop y tiempo real. */
export function AgendaPage() {
  const business = useBusiness();
  const pros = useProfessionals();
  const key = useBusinessKey();
  const zone = business.data?.timezone ?? 'UTC';
  const [day, setDay] = useState(() => DateTime.now().setZone(zone).toISODate()!);
  const [showCancelled, setShowCancelled] = useState(false);
  const [open, setOpen] = useState<BookingView | null>(null);

  const start = DateTime.fromISO(day, { zone }).startOf('day');
  const agenda = useQuery({
    enabled: !!business.data,
    queryKey: key('agenda', day),
    queryFn: async () =>
      (
        await api.get<BookingView[]>('/business/agenda', {
          params: { from: start.toUTC().toISO(), to: start.plus({ days: 1 }).toUTC().toISO() },
        })
      ).data,
    refetchInterval: 30_000,
  });

  if (business.isLoading || pros.isLoading) return <Spinner />;
  if (business.isError) return <Alert>{errorMessage(business.error)}</Alert>;

  const activePros = (pros.data ?? []).filter((p) => p.active);
  const bookings = (agenda.data ?? []).filter((b) => showCancelled || !['CANCELLED', 'EXPIRED'].includes(b.status));

  // Rango horario visible: de la primera a la última hora con horario o turnos (mínimo 8 a 20)
  const weekday = start.weekday % 7;
  const hours = activePros.flatMap((p) =>
    p.schedules.filter((s) => s.weekday === weekday).flatMap((s) => [Number(s.startTime.slice(0, 2)), Number(s.endTime.slice(0, 2)) + 1]),
  );
  for (const b of bookings) {
    hours.push(DateTime.fromISO(b.start, { zone }).hour, DateTime.fromISO(b.end, { zone }).hour + 1);
  }
  const firstHour = Math.max(0, Math.min(8, ...hours));
  const lastHour = Math.min(24, Math.max(20, ...hours));
  const totalRevenue = bookings.filter((b) => ['CONFIRMED', 'ATTENDED'].includes(b.status)).reduce((a, b) => a + b.priceCents, 0);

  const shift = (days: number) => setDay(DateTime.fromISO(day).plus({ days }).toISODate()!);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{capitalize(start.setLocale('es-AR').toFormat("cccc d 'de' LLLL"))}</h1>
          <p className="text-sm text-stone-500">
            {bookings.filter((b) => b.status !== 'CANCELLED').length} turnos · {formatPrice(totalRevenue)} · hora de{' '}
            {zone.split('/').pop()?.replace(/_/g, ' ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={() => shift(-1)} aria-label="Día anterior">
            ←
          </button>
          <button className="btn-secondary" onClick={() => setDay(DateTime.now().setZone(zone).toISODate()!)}>
            Hoy
          </button>
          <button className="btn-secondary" onClick={() => shift(1)} aria-label="Día siguiente">
            →
          </button>
          <input type="date" className="input w-auto" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
        Mostrar cancelados
      </label>

      {agenda.isError && <Alert>{errorMessage(agenda.error)}</Alert>}
      {!activePros.length ? (
        <EmptyState>Todavía no hay profesionales activos. Agregalos en "Profesionales y horarios".</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <div className="grid min-w-[560px]" style={{ gridTemplateColumns: `56px repeat(${activePros.length}, minmax(160px, 1fr))` }}>
            <div className="border-b border-stone-200" />
            {activePros.map((p) => (
              <div key={p.id} className="border-b border-l border-stone-200 px-3 py-2 text-sm font-semibold">
                {p.displayName}
              </div>
            ))}

            <div className="relative" style={{ height: (lastHour - firstHour) * HOUR_PX }}>
              {Array.from({ length: lastHour - firstHour }, (_, i) => (
                <div key={i} className="absolute right-2 -translate-y-2 text-xs text-stone-400" style={{ top: i * HOUR_PX }}>
                  {String(firstHour + i).padStart(2, '0')}:00
                </div>
              ))}
            </div>

            {activePros.map((p) => (
              <div key={p.id} className="relative border-l border-stone-200" style={{ height: (lastHour - firstHour) * HOUR_PX }}>
                {/* Horario de atención */}
                {p.schedules
                  .filter((s) => s.weekday === weekday)
                  .map((s) => {
                    const top = toMinutes(s.startTime) - firstHour * 60;
                    let len = toMinutes(s.endTime) - toMinutes(s.startTime);
                    if (len <= 0) len += 1440;
                    return (
                      <div
                        key={s.id}
                        className="absolute inset-x-0 bg-brand-50/40"
                        style={{ top: (top / 60) * HOUR_PX, height: (len / 60) * HOUR_PX }}
                      />
                    );
                  })}
                {Array.from({ length: lastHour - firstHour }, (_, i) => (
                  <div key={i} className="absolute inset-x-0 border-t border-stone-100" style={{ top: i * HOUR_PX }} />
                ))}
                {bookings
                  .filter((b) => b.professional.id === p.id)
                  .map((b) => {
                    const s = DateTime.fromISO(b.start, { zone });
                    const e = DateTime.fromISO(b.end, { zone });
                    const top = ((s.hour - firstHour) * 60 + s.minute) / 60;
                    const height = e.diff(s, 'minutes').minutes / 60;
                    return (
                      <button
                        key={b.id}
                        onClick={() => setOpen(b)}
                        className={`absolute inset-x-1 overflow-hidden rounded-md border-l-4 px-2 py-1 text-left text-xs shadow-sm transition hover:shadow ${BLOCK_STYLE[b.status]}`}
                        style={{ top: top * HOUR_PX + 1, height: Math.max(height * HOUR_PX - 2, 20) }}
                      >
                        <span className="font-semibold">
                          {formatTime(b.start, zone)} {b.client?.fullName}
                        </span>
                        <span className="block truncate opacity-80">{b.service.name}</span>
                      </button>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      )}

      {open && <BookingDrawer booking={open} zone={zone} onClose={() => setOpen(null)} />}
    </div>
  );
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function BookingDrawer({ booking, zone, onClose }: { booking: BookingView; zone: string; onClose: () => void }) {
  const qc = useQueryClient();
  const key = useBusinessKey();
  const done = () => {
    qc.invalidateQueries({ queryKey: key('agenda') });
    onClose();
  };
  const attendance = useMutation({
    mutationFn: (attended: boolean) => api.patch(`/business/bookings/${booking.id}/attendance`, { attended }),
    onSuccess: done,
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/bookings/${booking.id}/cancel`), onSuccess: done });
  const started = new Date(booking.start) <= new Date();
  const active = ['PENDING', 'CONFIRMED'].includes(booking.status);
  const error = attendance.error ?? cancel.error;

  return (
    <Modal title={`${formatTime(booking.start, zone)}–${formatTime(booking.end, zone)} · ${booking.service.name}`} onClose={onClose}>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-stone-500">Estado</dt>
        <dd>
          <StatusBadge status={booking.status} />
        </dd>
        <dt className="text-stone-500">Cliente</dt>
        <dd>{booking.client?.fullName}</dd>
        <dt className="text-stone-500">Contacto</dt>
        <dd>
          <a className="text-brand-600" href={`mailto:${booking.client?.email}`}>
            {booking.client?.email}
          </a>
          {booking.client?.phone && <span className="block">{booking.client.phone}</span>}
        </dd>
        <dt className="text-stone-500">Profesional</dt>
        <dd>{booking.professional.displayName}</dd>
        <dt className="text-stone-500">Precio</dt>
        <dd>{formatPrice(booking.priceCents)}</dd>
      </dl>
      {error && (
        <div className="mt-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {active && (
          <button className="btn-danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancelar turno
          </button>
        )}
        {started && ['CONFIRMED', 'ATTENDED', 'NO_SHOW'].includes(booking.status) && (
          <>
            <button className="btn-secondary" onClick={() => attendance.mutate(false)} disabled={attendance.isPending}>
              No asistió
            </button>
            <button className="btn-primary" onClick={() => attendance.mutate(true)} disabled={attendance.isPending}>
              Asistió
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
