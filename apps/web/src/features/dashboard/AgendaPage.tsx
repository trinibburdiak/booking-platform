import type { BookingView } from '@turnos/contracts';
import { DatesSetArg, EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import esLocale from '@fullcalendar/core/locales/es';
import interactionPlugin from '@fullcalendar/interaction';
import luxon3Plugin from '@fullcalendar/luxon3';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { api, errorMessage } from '../../shared/lib/api';
import { formatDateTime, formatPrice, formatTime } from '../../shared/lib/format';
import { Alert, EmptyState, Modal, Spinner, StatusBadge } from '../../shared/ui';
import { useAuth } from '../auth/useAuth';
import { ProfessionalRow, useBusiness, useBusinessKey, useProfessionals } from './hooks';
import { AgendaPush, useAgendaSocket } from './useAgendaSocket';

/** Un color por profesional, estable según el orden. */
const PALETTE = ['#256449', '#2563eb', '#b45309', '#9333ea', '#be123c', '#0e7490'];

const INACTIVE = ['CANCELLED', 'EXPIRED'];
const ACTIVE = ['PENDING', 'CONFIRMED'];

const PUSH_LABEL: Record<string, string> = {
  'booking.confirmed': 'Nuevo turno',
  'booking.cancelled': 'Turno cancelado',
  'booking.rescheduled': 'Turno reprogramado',
};

/**
 * Agenda del negocio: vista día/semana con FullCalendar, en la zona horaria del negocio.
 * Los turnos se arrastran para reprogramarlos y la agenda se actualiza sola por WebSocket.
 */
export function AgendaPage() {
  const business = useBusiness();
  const pros = useProfessionals();
  const key = useBusinessKey();
  const qc = useQueryClient();
  const { businessId } = useAuth();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [proFilter, setProFilter] = useState('all');
  const [showCancelled, setShowCancelled] = useState(false);
  const [open, setOpen] = useState<BookingView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const zone = business.data?.timezone ?? 'UTC';

  const onPush = useCallback(
    (e: AgendaPush) => {
      const label = PUSH_LABEL[e.type];
      if (!label) return;
      setToast(`${label}: ${formatDateTime(e.start, zone)} h`);
      window.setTimeout(() => setToast(null), 5000);
    },
    [zone],
  );
  const live = useAgendaSocket(businessId, onPush);

  const agenda = useQuery({
    enabled: !!business.data && !!range,
    queryKey: key('agenda', range?.from, range?.to),
    queryFn: async () => (await api.get<BookingView[]>('/business/agenda', { params: range })).data,
    placeholderData: (prev) => prev,
  });

  const reschedule = useMutation({
    mutationFn: ({ id, start }: { id: string; start: string }) => api.post(`/bookings/${id}/reschedule`, { start }),
    onSettled: () => qc.invalidateQueries({ queryKey: key('agenda') }),
  });

  const activePros = useMemo(() => (pros.data ?? []).filter((p) => p.active), [pros.data]);
  const colorOf = useMemo(() => new Map(activePros.map((p, i) => [p.id, PALETTE[i % PALETTE.length]])), [activePros]);
  const visiblePros = useMemo(
    () => (proFilter === 'all' ? activePros : activePros.filter((p) => p.id === proFilter)),
    [activePros, proFilter],
  );

  const events: EventInput[] = useMemo(
    () =>
      (agenda.data ?? [])
        .filter((b) => showCancelled || !INACTIVE.includes(b.status))
        .filter((b) => proFilter === 'all' || b.professional.id === proFilter)
        .map((b) => {
          const color = colorOf.get(b.professional.id) ?? '#57534e';
          const inactive = INACTIVE.includes(b.status);
          return {
            id: b.id,
            title: `${b.client?.fullName ?? ''} · ${b.service.name}`,
            start: b.start,
            end: b.end,
            backgroundColor: inactive ? '#f5f5f4' : color,
            borderColor: color,
            textColor: inactive ? '#a8a29e' : '#fff',
            classNames: inactive ? ['line-through'] : b.status === 'NO_SHOW' ? ['opacity-60'] : [],
            // Solo se arrastran turnos activos que todavía no empezaron
            editable: ACTIVE.includes(b.status) && new Date(b.start) > new Date(),
            extendedProps: { booking: b },
          };
        }),
    [agenda.data, showCancelled, proFilter, colorOf],
  );

  const { businessHours, slotMinTime, slotMaxTime } = useMemo(() => hoursFor(visiblePros), [visiblePros]);

  if (business.isLoading || pros.isLoading) return <Spinner />;
  if (business.isError) return <Alert>{errorMessage(business.error)}</Alert>;
  if (!activePros.length) {
    return <EmptyState>Todavía no hay profesionales activos. Agregalos en "Profesionales y horarios".</EmptyState>;
  }

  const onDrop = (info: EventDropArg) => {
    setDropError(null);
    const booking = info.event.extendedProps.booking as BookingView;
    // startStr viene con el offset de la zona del negocio (plugin de Luxon)
    const start = new Date(info.event.startStr).toISOString();
    reschedule.mutate(
      { id: booking.id, start },
      {
        onError: (e) => {
          info.revert();
          setDropError(errorMessage(e));
        },
      },
    );
  };

  const counted = (agenda.data ?? []).filter((b) => ['CONFIRMED', 'ATTENDED'].includes(b.status));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Agenda</h1>
          <p className="flex items-center gap-2 text-sm text-stone-500">
            <span
              className={`inline-block h-2 w-2 rounded-full ${live ? 'bg-brand-500' : 'bg-stone-300'}`}
              title={live ? 'Conectado en vivo' : 'Sin conexión en vivo'}
            />
            {live ? 'En vivo' : 'Conectando…'} · {counted.length} turnos ·{' '}
            {formatPrice(counted.reduce((a, b) => a + b.priceCents, 0))} · hora de {zone.split('/').pop()?.replace(/_/g, ' ')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select className="input w-auto" value={proFilter} onChange={(e) => setProFilter(e.target.value)} aria-label="Profesional">
            <option value="all">Todos los profesionales</option>
            {activePros.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Cancelados
          </label>
        </div>
      </div>

      {proFilter === 'all' && activePros.length > 1 && (
        <div className="flex flex-wrap gap-3 text-xs text-stone-600">
          {activePros.map((p) => (
            <span key={p.id} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorOf.get(p.id) }} />
              {p.displayName}
            </span>
          ))}
        </div>
      )}

      {dropError && <Alert>No se pudo mover el turno: {dropError}</Alert>}
      {agenda.isError && <Alert>{errorMessage(agenda.error)}</Alert>}

      <div className="agenda rounded-xl border border-stone-200 bg-white p-3">
        <FullCalendar
          plugins={[timeGridPlugin, interactionPlugin, luxon3Plugin]}
          locale={esLocale}
          timeZone={zone}
          initialView={window.innerWidth < 768 ? 'timeGridDay' : 'timeGridWeek'}
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek' }}
          allDaySlot={false}
          nowIndicator
          height="auto"
          slotDuration="00:15:00"
          slotLabelInterval="01:00"
          slotMinTime={slotMinTime}
          slotMaxTime={slotMaxTime}
          businessHours={businessHours}
          eventDurationEditable={false}
          snapDuration="00:15:00"
          events={events}
          eventClick={(info: EventClickArg) => setOpen(info.event.extendedProps.booking as BookingView)}
          eventDrop={onDrop}
          datesSet={(arg: DatesSetArg) => setRange({ from: arg.start.toISOString(), to: arg.end.toISOString() })}
          eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
        />
      </div>
      <p className="text-xs text-stone-500">Arrastrá un turno para reprogramarlo. El cliente recibe un email con el nuevo horario.</p>

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-stone-900 px-4 py-3 text-sm text-white shadow-lg" role="status">
          {toast}
        </div>
      )}
      {open && <BookingDrawer booking={open} zone={zone} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Horario de atención (sombreado) y rango visible, a partir de los horarios semanales. */
function hoursFor(pros: ProfessionalRow[]) {
  const ranges = pros.flatMap((p) => p.schedules);
  const businessHours = ranges.map((r) => ({ daysOfWeek: [r.weekday], startTime: r.startTime, endTime: r.endTime }));
  const starts = ranges.map((r) => Number(r.startTime.slice(0, 2)));
  const ends = ranges.map((r) => (r.endTime <= r.startTime ? 24 : Math.ceil(toMinutes(r.endTime) / 60)));
  const min = Math.max(0, Math.min(8, ...starts) - 1);
  const max = Math.min(24, Math.max(20, ...ends) + 1);
  return {
    businessHours,
    slotMinTime: `${String(min).padStart(2, '0')}:00:00`,
    slotMaxTime: `${String(max).padStart(2, '0')}:00:00`,
  };
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
