import type { AvailabilityResponse, AvailableSlot } from '@turnos/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../shared/lib/api';
import { nextDays } from '../../shared/lib/format';
import { Alert, EmptyState, Spinner } from '../../shared/ui';

interface Props {
  slug: string;
  serviceId: string;
  professionalId?: string;
  zone: string;
  date: string;
  onDateChange: (date: string) => void;
  selected?: string;
  onPick: (slot: AvailableSlot) => void;
}

export const availabilityKey = (slug: string, serviceId: string, professionalId: string | undefined, date: string) =>
  ['availability', slug, serviceId, professionalId ?? 'any', date];

export function SlotPicker({ slug, serviceId, professionalId, zone, date, onDateChange, selected, onPick }: Props) {
  const days = nextDays(zone, 14);
  const query = useQuery({
    queryKey: availabilityKey(slug, serviceId, professionalId, date),
    queryFn: async () =>
      (
        await api.get<AvailabilityResponse>(`/public/businesses/${slug}/availability`, {
          params: { serviceId, professionalId, date },
        })
      ).data,
    staleTime: 15_000,
  });

  const groups = groupByPeriod(query.data?.slots ?? []);

  return (
    <div className="space-y-4">
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            onClick={() => onDateChange(d.date)}
            className={`flex min-w-[64px] flex-col items-center rounded-xl border px-3 py-2 text-sm transition ${
              d.date === date
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-stone-200 bg-white text-stone-700 hover:border-brand-500'
            }`}
            aria-pressed={d.date === date}
          >
            <span className="text-xs capitalize opacity-80">{d.weekday}</span>
            <span className="text-lg font-semibold leading-tight">{d.day}</span>
            <span className="text-xs capitalize opacity-80">{d.month}</span>
          </button>
        ))}
      </div>

      {query.isLoading && <Spinner label="Buscando horarios…" />}
      {query.isError && <Alert>{errorMessage(query.error)}</Alert>}
      {query.data && !query.data.slots.length && (
        <EmptyState>No hay horarios libres este día. Probá con otro.</EmptyState>
      )}
      {groups.map(([label, slots]) => (
        <div key={label}>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</h4>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {slots.map((s) => (
              <button
                key={s.start}
                type="button"
                onClick={() => onPick(s)}
                className={`rounded-lg border py-2 text-sm font-medium transition ${
                  selected === s.start
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-stone-200 bg-white hover:border-brand-500 hover:text-brand-700'
                }`}
                aria-pressed={selected === s.start}
              >
                {s.localStart}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function groupByPeriod(slots: AvailableSlot[]): [string, AvailableSlot[]][] {
  const groups: Record<string, AvailableSlot[]> = { Mañana: [], Tarde: [], Noche: [] };
  for (const s of slots) {
    const h = Number(s.localStart.slice(0, 2));
    groups[h < 13 ? 'Mañana' : h < 19 ? 'Tarde' : 'Noche'].push(s);
  }
  return Object.entries(groups).filter(([, v]) => v.length);
}
