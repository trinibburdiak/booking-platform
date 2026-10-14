import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../shared/lib/api';
import { formatPrice, WEEKDAYS } from '../../shared/lib/format';
import { Alert, EmptyState, Spinner } from '../../shared/ui';
import { useBusinessKey } from './hooks';

interface Metrics {
  totals: {
    attended: number;
    noShow: number;
    cancelled: number;
    expired: number;
    booked: number;
    upcoming: number;
    noShowRate: number | null;
    revenueCents: number;
  };
  byProfessional: { professionalId: string; displayName: string; attended: number; noShow: number; cancelled: number; noShowRate: number | null }[];
  byWeekday: { weekday: number; attended: number; noShow: number; noShowRate: number | null }[];
  repeatNoShows: { clientId: string; fullName: string; email: string; noShows: number }[];
}

const RANGES = [
  { days: 30, label: 'Últimos 30 días' },
  { days: 90, label: 'Últimos 90 días' },
  { days: 365, label: 'Último año' },
];

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** Ausentismo: de los turnos que ya pasaron, qué parte no vino. Los cancelados a tiempo no cuentan. */
export function MetricsPage() {
  const key = useBusinessKey();
  const [days, setDays] = useState(30);
  const metrics = useQuery({
    queryKey: key('metrics', days),
    queryFn: async () => {
      const to = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      return (await api.get<Metrics>('/business/metrics', { params: { from: from.toISOString(), to: to.toISOString() } })).data;
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Ausentismo</h1>
          <p className="text-sm text-stone-500">Turnos que ya pasaron: quién vino y quién no.</p>
        </div>
        <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Período">
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {metrics.isLoading && <Spinner />}
      {metrics.isError && <Alert>{errorMessage(metrics.error)}</Alert>}
      {metrics.data && <MetricsBody m={metrics.data} />}
    </div>
  );
}

function MetricsBody({ m }: { m: Metrics }) {
  const t = m.totals;
  const resolved = t.attended + t.noShow;
  if (!t.booked) return <EmptyState>Todavía no hay turnos en este período.</EmptyState>;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Tasa de ausentismo" value={pct(t.noShowRate)} hint={resolved ? `${t.noShow} de ${resolved} turnos pasados` : 'Sin turnos pasados'} />
        <Stat label="Asistieron" value={String(t.attended)} hint={resolved ? `${Math.round((t.attended / resolved) * 100)}% de los turnos pasados` : "Sin turnos pasados"} />
        <Stat label="Cancelados" value={String(t.cancelled)} hint={t.expired ? `${t.expired} vencidos sin seña` : 'No cuentan como ausentismo'} />
        <Stat label="Facturado" value={formatPrice(t.revenueCents)} hint="Turnos con asistencia" />
      </div>

      <section className="card space-y-4">
        <h2 className="font-semibold">Por profesional</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-stone-500">
            <tr>
              <th className="pb-2 font-medium">Profesional</th>
              <th className="pb-2 text-right font-medium">Asistió</th>
              <th className="pb-2 text-right font-medium">No vino</th>
              <th className="pb-2 pl-4 font-medium">Ausentismo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {m.byProfessional.map((p) => (
              <tr key={p.professionalId}>
                <td className="py-2 font-medium">{p.displayName}</td>
                <td className="py-2 text-right tabular-nums">{p.attended}</td>
                <td className="py-2 text-right tabular-nums">{p.noShow}</td>
                <td className="w-1/2 py-2 pl-4">
                  <RateBar rate={p.noShowRate} title={`${p.displayName}: ${pct(p.noShowRate)} (${p.noShow} de ${p.attended + p.noShow})`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold">Por día de la semana</h2>
          <p className="text-xs text-stone-500">Útil para decidir en qué días pedir seña o confirmar por mensaje.</p>
        </div>
        {m.byWeekday.length ? (
          <div className="flex h-44 items-end gap-3" role="img" aria-label="Ausentismo por día de la semana">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => {
              const w = m.byWeekday.find((x) => x.weekday === d);
              const rate = w?.noShowRate ?? null;
              return (
                <div key={d} className="group flex flex-1 flex-col items-center gap-1" title={`${WEEKDAYS[d]}: ${pct(rate)}${w ? ` (${w.noShow} de ${w.attended + w.noShow})` : ''}`}>
                  <span className="text-xs tabular-nums text-stone-700">{pct(rate)}</span>
                  <div className="flex h-28 w-full items-end">
                    <div
                      className="w-full rounded-t bg-brand-600 transition group-hover:bg-brand-700"
                      style={{ height: rate === null ? 0 : `${Math.max(rate * 100, 2)}%` }}
                    />
                  </div>
                  <span className="border-t border-stone-300 pt-1 text-xs text-stone-500">{WEEKDAYS[d].slice(0, 3)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-stone-500">Todavía no hay turnos con asistencia marcada.</p>
        )}
      </section>

      {!!m.repeatNoShows.length && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Clientes que faltaron más de una vez</h2>
          <ul className="divide-y divide-stone-100 text-sm">
            {m.repeatNoShows.map((c) => (
              <li key={c.clientId} className="flex justify-between py-2">
                <span>
                  {c.fullName} <span className="text-stone-500">· {c.email}</span>
                </span>
                <span className="font-medium tabular-nums">{c.noShows} faltas</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="card">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-stone-500">{hint}</p>
    </div>
  );
}

function RateBar({ rate, title }: { rate: number | null; title: string }) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="h-2 flex-1 rounded-full bg-stone-100">
        <div className="h-2 rounded-full bg-brand-600" style={{ width: rate === null ? 0 : `${Math.max(rate * 100, 1)}%` }} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-stone-700">{pct(rate)}</span>
    </div>
  );
}
