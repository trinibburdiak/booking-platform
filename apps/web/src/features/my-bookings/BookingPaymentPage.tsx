import type { BookingView, PaymentView } from '@turnos/contracts';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../shared/lib/api';
import { formatDateLong, formatPrice, formatTime } from '../../shared/lib/format';
import { Alert, Spinner, StatusBadge } from '../../shared/ui';

/**
 * Estado de un turno con seña: espera el link de pago (lo crea payments-service al
 * recibir booking.created), lleva al checkout y, a la vuelta, espera la confirmación
 * (payment.approved → booking.confirmed). Todo es asíncrono, así que se consulta seguido.
 */
export function BookingPaymentPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const returned = params.get('pago');

  const booking = useQuery({
    queryKey: ['booking', id],
    queryFn: async () => (await api.get<BookingView>(`/bookings/${id}`)).data,
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? 2_000 : false),
  });
  const pending = booking.data?.status === 'PENDING';
  const payment = useQuery({
    enabled: !!booking.data && booking.data.depositCents > 0,
    queryKey: ['payment', id],
    queryFn: async () => {
      try {
        return (await api.get<PaymentView>(`/payments/booking/${id}`)).data;
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 404) return null; // todavía no se creó
        throw e;
      }
    },
    refetchInterval: (q) => (pending && !q.state.data?.checkoutUrl ? 1_000 : pending ? 3_000 : false),
  });

  if (booking.isLoading) return <Spinner />;
  if (booking.isError) return <Alert>{errorMessage(booking.error)}</Alert>;
  const b = booking.data!;
  const zone = b.business.timezone;

  return (
    <div className="mx-auto max-w-lg space-y-5 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tu turno</h1>
        <StatusBadge status={b.status} />
      </div>

      <section className="card space-y-1 text-sm">
        <p className="text-base font-semibold">
          {formatDateLong(b.start, zone)} · {formatTime(b.start, zone)} h
        </p>
        <p className="text-stone-600">
          {b.service.name} con {b.professional.displayName} en {b.business.name}
        </p>
        <p className="text-stone-600">
          Precio {formatPrice(b.priceCents)}
          {b.depositCents > 0 && ` · seña ${formatPrice(b.depositCents)}`}
        </p>
      </section>

      {b.status === 'PENDING' && (
        <section className="card space-y-4">
          {returned === 'aprobado' ? (
            <Alert kind="info">Recibimos el pago. Confirmando el turno…</Alert>
          ) : (
            <>
              {returned === 'rechazado' && <Alert>El pago fue rechazado.</Alert>}
              <p className="text-sm text-stone-700">
                Te guardamos el horario. Pagá la seña para confirmarlo
                {b.expiresAt && (
                  <>
                    {' '}
                    antes de que pase el tiempo: <Countdown until={b.expiresAt} />
                  </>
                )}
                .
              </p>
              {payment.data?.checkoutUrl ? (
                <a className="btn-primary w-full" href={payment.data.checkoutUrl}>
                  Pagar {formatPrice(b.depositCents)}
                  {payment.data.provider === 'mercadopago' ? ' con Mercado Pago' : ''}
                </a>
              ) : (
                <Spinner label="Preparando el link de pago…" />
              )}
            </>
          )}
        </section>
      )}

      {b.status === 'CONFIRMED' && (
        <Alert kind="success">
          ¡Turno confirmado! Te mandamos un email con los detalles. Podés cancelar hasta {b.business.cancellationHours} h antes.
        </Alert>
      )}
      {b.status === 'EXPIRED' && (
        <Alert>
          La reserva se venció porque {returned === 'rechazado' ? 'el pago fue rechazado' : 'no se pagó la seña a tiempo'}. El horario
          quedó libre.{' '}
          <Link className="font-medium underline" to={`/b/${b.business.slug}`}>
            Reservar de nuevo
          </Link>
        </Alert>
      )}
      {b.status === 'CANCELLED' && <Alert kind="info">Este turno está cancelado.</Alert>}

      <Link to="/mis-turnos" className="btn-secondary w-full">
        Ver mis turnos
      </Link>
    </div>
  );
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1_000);
  return (
    <b className="tabular-nums">
      {m}:{String(s).padStart(2, '0')}
    </b>
  );
}
