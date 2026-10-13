import type { BookingView, PublicBusiness } from '@turnos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { useMemo, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { api, errorCode, errorMessage } from '../../shared/lib/api';
import { formatDateLong, formatPrice, formatTime } from '../../shared/lib/format';
import { Alert, Spinner } from '../../shared/ui';
import { useAuth } from '../auth/useAuth';
import { SlotPicker } from './SlotPicker';

const ANY = 'any';

/**
 * Página pública del negocio con el wizard de reserva:
 * servicio → profesional (o "cualquiera") → día y horario → confirmación.
 * El estado vive en la URL, así sobrevive al login y se puede compartir.
 */
export function BusinessPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [takenNotice, setTakenNotice] = useState(false);
  const business = useQuery({
    queryKey: ['public-business', slug],
    queryFn: async () => (await api.get<PublicBusiness>(`/public/businesses/${slug}`)).data,
  });

  if (business.isLoading) return <Spinner />;
  if (business.isError) return <Alert>{errorMessage(business.error)}</Alert>;
  const b = business.data!;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: false });
  };

  const service = b.services.find((s) => s.id === params.get('service'));
  const pro = params.get('pro');
  const start = params.get('start');
  const slotPro = params.get('slotPro');
  const date = params.get('date') ?? DateTime.now().setZone(b.timezone).toISODate()!;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="pt-4">
        <p className="text-sm font-medium text-brand-600">Reservá tu turno online</p>
        <h1 className="text-3xl font-semibold">{b.name}</h1>
        {b.address && <p className="mt-1 text-stone-600">{b.address}</p>}
      </header>

      <Step n={1} title="Elegí el servicio" done={!!service} onEdit={() => update({ service: null, pro: null, start: null })}>
        {service ? (
          <p className="font-medium">
            {service.name} · {service.durationMin} min · {formatPrice(service.priceCents)}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {b.services.map((s) => (
              <button
                key={s.id}
                className="card text-left transition hover:border-brand-500 disabled:opacity-50"
                disabled={!s.professionalIds.length}
                onClick={() => update({ service: s.id, pro: s.professionalIds.length > 1 ? null : s.professionalIds[0] })}
              >
                <p className="font-semibold">{s.name}</p>
                <p className="text-sm text-stone-600">
                  {s.durationMin} min · {formatPrice(s.priceCents)}
                </p>
              </button>
            ))}
          </div>
        )}
      </Step>

      {service && (
        <Step n={2} title="¿Con quién?" done={!!pro} onEdit={() => update({ pro: null, start: null })}>
          {pro ? (
            <p className="font-medium">
              {pro === ANY ? 'Cualquier profesional' : b.professionals.find((p) => p.id === pro)?.displayName}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={() => update({ pro: ANY })}>
                Cualquiera
              </button>
              {b.professionals
                .filter((p) => service.professionalIds.includes(p.id))
                .map((p) => (
                  <button key={p.id} className="btn-secondary" onClick={() => update({ pro: p.id })}>
                    {p.displayName}
                  </button>
                ))}
            </div>
          )}
        </Step>
      )}

      {service && pro && (
        <Step n={3} title="Día y horario" done={!!start} onEdit={() => update({ start: null })}>
          {takenNotice && !start && (
            <div className="mb-3">
              <Alert>Ese horario se acaba de ocupar. Elegí otro, por favor.</Alert>
            </div>
          )}
          {start ? (
            <p className="font-medium">
              {formatDateLong(start, b.timezone)} · {formatTime(start, b.timezone)} h
            </p>
          ) : (
            <SlotPicker
              slug={slug}
              serviceId={service.id}
              professionalId={pro === ANY ? undefined : pro}
              zone={b.timezone}
              date={date}
              onDateChange={(d) => update({ date: d })}
              onPick={(s) => {
                setTakenNotice(false);
                update({ start: s.start, slotPro: s.professionalId });
              }}
            />
          )}
        </Step>
      )}

      {service && pro && start && slotPro && (
        <Confirm
          business={b}
          serviceId={service.id}
          professionalId={pro === ANY ? slotPro : pro}
          start={start}
          onSlotTaken={() => {
            setTakenNotice(true);
            update({ start: null, slotPro: null });
          }}
        />
      )}
    </div>
  );
}

function Confirm(props: {
  business: PublicBusiness;
  serviceId: string;
  professionalId: string;
  start: string;
  onSlotTaken: () => void;
}) {
  const { business, serviceId, professionalId, start, onSlotTaken } = props;
  const { user } = useAuth();
  const location = useLocation();
  const qc = useQueryClient();

  // Se genera al abrir la confirmación: un doble click no reserva dos veces.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [serviceId, professionalId, start]);

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<BookingView>(
          '/bookings',
          { businessSlug: business.slug, serviceId, professionalId, start },
          { headers: { 'Idempotency-Key': idempotencyKey } },
        )
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-bookings'] }),
    onError: (e) => {
      if (errorCode(e) === 'SLOT_TAKEN') {
        qc.invalidateQueries({ queryKey: ['availability'] });
        onSlotTaken();
      }
    },
  });

  const pro = business.professionals.find((p) => p.id === professionalId);
  const service = business.services.find((s) => s.id === serviceId)!;
  const next = encodeURIComponent(location.pathname + location.search);

  if (mutation.isSuccess) {
    const b = mutation.data;
    return (
      <div className="card border-brand-100 bg-brand-50">
        <h3 className="text-lg font-semibold text-brand-700">¡Turno confirmado!</h3>
        <p className="mt-1 text-stone-700">
          {b.service.name} con {b.professional.displayName} · {formatDateLong(b.start, business.timezone)} a las{' '}
          {formatTime(b.start, business.timezone)} h
        </p>
        <p className="mt-2 text-sm text-stone-600">
          Podés cancelar o reprogramar hasta {business.cancellationHours} h antes.
        </p>
        <Link to="/mis-turnos" className="btn-primary mt-4">
          Ver mis turnos
        </Link>
      </div>
    );
  }

  return (
    <section className="card space-y-4">
      <h3 className="text-lg font-semibold">Confirmá tu turno</h3>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-stone-500">Servicio</dt>
        <dd>{service.name}</dd>
        <dt className="text-stone-500">Profesional</dt>
        <dd>{pro?.displayName}</dd>
        <dt className="text-stone-500">Cuándo</dt>
        <dd>
          {formatDateLong(start, business.timezone)}, {formatTime(start, business.timezone)} h
        </dd>
        <dt className="text-stone-500">Precio</dt>
        <dd>{formatPrice(service.priceCents)}</dd>
      </dl>
      {mutation.isError && errorCode(mutation.error) !== 'SLOT_TAKEN' && <Alert>{errorMessage(mutation.error)}</Alert>}
      {user ? (
        <button className="btn-primary w-full" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? 'Reservando…' : 'Confirmar reserva'}
        </button>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link className="btn-primary flex-1" to={`/ingresar?next=${next}`}>
            Ingresá para confirmar
          </Link>
          <Link className="btn-secondary flex-1" to={`/registro?next=${next}`}>
            Crear cuenta
          </Link>
        </div>
      )}
    </section>
  );
}

function Step(props: { n: number; title: string; done: boolean; onEdit: () => void; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
              props.done ? 'bg-brand-600 text-white' : 'bg-stone-200 text-stone-700'
            }`}
          >
            {props.done ? '✓' : props.n}
          </span>
          {props.title}
        </h2>
        {props.done && (
          <button className="text-sm font-medium text-brand-600 hover:underline" onClick={props.onEdit}>
            Cambiar
          </button>
        )}
      </div>
      {props.children}
    </section>
  );
}

