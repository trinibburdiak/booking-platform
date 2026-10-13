import type { AvailableSlot, BookingView } from '@turnos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../shared/lib/api';
import { formatDateLong, formatDateTime, formatPrice, formatTime } from '../../shared/lib/format';
import { Alert, EmptyState, Modal, Spinner, StatusBadge } from '../../shared/ui';
import { SlotPicker } from '../public-booking/SlotPicker';

const ACTIVE = ['PENDING', 'CONFIRMED'];

export function MyBookingsPage() {
  const query = useQuery({
    queryKey: ['my-bookings'],
    queryFn: async () => (await api.get<BookingView[]>('/me/bookings')).data,
  });
  const [cancelling, setCancelling] = useState<BookingView | null>(null);
  const [rescheduling, setRescheduling] = useState<BookingView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (query.isLoading) return <Spinner />;
  if (query.isError) return <Alert>{errorMessage(query.error)}</Alert>;

  const now = Date.now();
  const all = query.data!;
  const upcoming = all
    .filter((b) => ACTIVE.includes(b.status) && new Date(b.end).getTime() > now)
    .sort((a, b) => a.start.localeCompare(b.start));
  const past = all.filter((b) => !upcoming.includes(b));

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="pt-4 text-2xl font-semibold">Mis turnos</h1>
      {notice && <Alert kind="success">{notice}</Alert>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Próximos</h2>
        {!upcoming.length && (
          <EmptyState>
            No tenés turnos próximos.{' '}
            <Link className="font-medium text-brand-600" to="/b/barberia-demo">
              Reservá uno
            </Link>
          </EmptyState>
        )}
        {upcoming.map((b) => (
          <article key={b.id} className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold">
                {formatDateLong(b.start, b.business.timezone)} · {formatTime(b.start, b.business.timezone)} h
              </p>
              <p className="text-sm text-stone-600">
                {b.service.name} con {b.professional.displayName} en{' '}
                <Link className="text-brand-600" to={`/b/${b.business.slug}`}>
                  {b.business.name}
                </Link>{' '}
                · {formatPrice(b.priceCents)}
              </p>
              {!b.canClientCancel && (
                <p className="mt-1 text-xs text-amber-700">
                  Faltan menos de {b.business.cancellationHours} h: para cambios, comunicate con el negocio.
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button className="btn-secondary" disabled={!b.canClientCancel} onClick={() => setRescheduling(b)}>
                Reprogramar
              </button>
              <button className="btn-danger" disabled={!b.canClientCancel} onClick={() => setCancelling(b)}>
                Cancelar
              </button>
            </div>
          </article>
        ))}
      </section>

      {!!past.length && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Historial</h2>
          <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
            {past.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  {formatDateTime(b.start, b.business.timezone)} · {b.service.name} ·{' '}
                  {b.business.name}
                </span>
                <StatusBadge status={b.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {cancelling && (
        <CancelDialog
          booking={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => {
            setCancelling(null);
            setNotice('Turno cancelado. El horario quedó libre para otra persona.');
          }}
        />
      )}
      {rescheduling && (
        <RescheduleDialog
          booking={rescheduling}
          onClose={() => setRescheduling(null)}
          onDone={(b) => {
            setRescheduling(null);
            setNotice(`Turno reprogramado para el ${formatDateTime(b.start, b.business.timezone)} h.`);
          }}
        />
      )}
    </div>
  );
}

function CancelDialog({ booking, onClose, onDone }: { booking: BookingView; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.post(`/bookings/${booking.id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-bookings'] });
      qc.invalidateQueries({ queryKey: ['availability'] });
      onDone();
    },
  });
  return (
    <Modal title="¿Cancelar el turno?" onClose={onClose}>
      <p className="text-sm text-stone-600">
        {formatDateTime(booking.start, booking.business.timezone)} h ·{' '}
        {booking.service.name} con {booking.professional.displayName}.
      </p>
      {m.isError && (
        <div className="mt-3">
          <Alert>{errorMessage(m.error)}</Alert>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>
          Volver
        </button>
        <button className="btn-danger" onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending ? 'Cancelando…' : 'Sí, cancelar'}
        </button>
      </div>
    </Modal>
  );
}

function RescheduleDialog(props: { booking: BookingView; onClose: () => void; onDone: (b: BookingView) => void }) {
  const { booking, onClose, onDone } = props;
  const zone = booking.business.timezone;
  const qc = useQueryClient();
  const [date, setDate] = useState(() => DateTime.fromISO(booking.start, { zone }).toISODate()!);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const m = useMutation({
    mutationFn: async () =>
      (await api.post<BookingView>(`/bookings/${booking.id}/reschedule`, { start: slot!.start })).data,
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['my-bookings'] });
      qc.invalidateQueries({ queryKey: ['availability'] });
      onDone(b);
    },
    onError: () => qc.invalidateQueries({ queryKey: ['availability'] }),
  });

  return (
    <Modal title="Reprogramar turno" onClose={onClose}>
      <p className="mb-4 text-sm text-stone-600">
        {booking.service.name} con {booking.professional.displayName}. Ahora:{' '}
        {formatDateTime(booking.start, zone)} h
      </p>
      <SlotPicker
        slug={booking.business.slug}
        serviceId={booking.service.id}
        professionalId={booking.professional.id}
        zone={zone}
        date={date}
        onDateChange={(d) => {
          setDate(d);
          setSlot(null);
        }}
        selected={slot?.start}
        onPick={setSlot}
      />
      {m.isError && (
        <div className="mt-3">
          <Alert>{errorMessage(m.error)}</Alert>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>
          Volver
        </button>
        <button className="btn-primary" disabled={!slot || m.isPending} onClick={() => m.mutate()}>
          {slot ? `Mover a las ${slot.localStart}` : 'Elegí un horario'}
        </button>
      </div>
    </Modal>
  );
}

/** Cancelación desde el link del email, sin login. */
export function CancelByTokenPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const m = useMutation({
    mutationFn: async () => (await api.post<BookingView>('/bookings/cancel', null, { params: { token } })).data,
  });

  return (
    <div className="mx-auto max-w-md py-10">
      <div className="card space-y-4">
        <h1 className="text-xl font-semibold">Cancelar turno</h1>
        {m.isSuccess ? (
          <Alert kind="success">
            Listo, cancelamos tu turno de {m.data.service.name} del{' '}
            {formatDateTime(m.data.start, m.data.business.timezone)} h.
          </Alert>
        ) : (
          <>
            <p className="text-sm text-stone-600">¿Querés cancelar el turno asociado a este link?</p>
            {m.isError && <Alert>{errorMessage(m.error)}</Alert>}
            <button className="btn-danger w-full" disabled={!token || m.isPending} onClick={() => m.mutate()}>
              {m.isPending ? 'Cancelando…' : 'Cancelar turno'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
