import { createBusinessSchema } from '@turnos/contracts';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../shared/lib/api';
import { Alert, Field } from '../../shared/ui';
import { useAuth } from '../auth/useAuth';
import { TIMEZONES } from '../settings/BusinessSettings';

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Crea el negocio y, en el mismo paso, su primer servicio y profesional con horario de lunes a viernes. */
export function CreateBusinessWizard() {
  const { reloadUser, selectBusiness } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [biz, setBiz] = useState({ name: '', slug: '', slugTouched: false, timezone: 'America/Argentina/Cordoba', address: '' });
  const [service, setService] = useState({ name: 'Corte', durationMin: 30, price: 8000 });
  const [pro, setPro] = useState({ displayName: '', from: '09:00', to: '18:00' });

  const parsed = createBusinessSchema.safeParse({ ...biz, address: biz.address || undefined });

  const finish = async () => {
    setError(null);
    setBusy(true);
    try {
      const { data: created } = await api.post<{ id: string }>('/businesses', parsed.data);
      // La membresía OWNER la crea auth-service al recibir el evento business.created:
      // se espera a que aparezca antes de seguir (suele tardar milisegundos).
      for (let i = 0; i < 40; i++) {
        const me = await reloadUser();
        if (me?.memberships.some((m) => m.businessId === created.id)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      selectBusiness(created.id);
      const headers = { 'X-Business-Id': created.id };
      const { data: svc } = await api.post<{ id: string }>(
        '/business/services',
        { name: service.name, durationMin: service.durationMin, priceCents: Math.round(service.price * 100) },
        { headers },
      );
      const { data: p } = await api.post<{ id: string }>(
        '/business/professionals',
        { displayName: pro.displayName, serviceIds: [svc.id] },
        { headers },
      );
      await api.put(
        `/business/professionals/${p.id}/schedule`,
        { ranges: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: pro.from, endTime: pro.to })) },
        { headers },
      );
      await reloadUser();
      navigate('/panel');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-6 py-6">
      <div>
        <p className="text-sm font-medium text-brand-600">Paso {step} de 3</p>
        <h1 className="text-2xl font-semibold">
          {step === 1 ? 'Tu negocio' : step === 2 ? 'Tu primer servicio' : 'Quién atiende'}
        </h1>
      </div>
      <div className="card space-y-4">
        {error && <Alert>{error}</Alert>}
        {step === 1 && (
          <>
            <Field label="Nombre del negocio">
              <input
                className="input"
                value={biz.name}
                onChange={(e) =>
                  setBiz((b) => ({ ...b, name: e.target.value, slug: b.slugTouched ? b.slug : slugify(e.target.value) }))
                }
                placeholder="Peluquería Lola"
              />
            </Field>
            <Field
              label="Dirección de tu página"
              error={biz.slug && !parsed.success ? parsed.error.issues.find((i) => i.path[0] === 'slug')?.message : undefined}
            >
              <div className="flex items-center rounded-lg border border-stone-300 bg-stone-50 pl-3 text-sm text-stone-500">
                /b/
                <input
                  className="input rounded-l-none border-0 border-l"
                  value={biz.slug}
                  onChange={(e) => setBiz((b) => ({ ...b, slug: e.target.value, slugTouched: true }))}
                />
              </div>
            </Field>
            <Field label="Zona horaria">
              <select className="input" value={biz.timezone} onChange={(e) => setBiz((b) => ({ ...b, timezone: e.target.value }))}>
                {TIMEZONES.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </select>
            </Field>
            <Field label="Dirección (opcional)">
              <input className="input" value={biz.address} onChange={(e) => setBiz((b) => ({ ...b, address: e.target.value }))} />
            </Field>
            <button className="btn-primary w-full" disabled={!parsed.success} onClick={() => setStep(2)}>
              Siguiente
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <Field label="Servicio">
              <input className="input" value={service.name} onChange={(e) => setService((s) => ({ ...s, name: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Duración (min)">
                <input
                  className="input"
                  type="number"
                  value={service.durationMin}
                  onChange={(e) => setService((s) => ({ ...s, durationMin: Number(e.target.value) }))}
                />
              </Field>
              <Field label="Precio ($)">
                <input
                  className="input"
                  type="number"
                  value={service.price}
                  onChange={(e) => setService((s) => ({ ...s, price: Number(e.target.value) }))}
                />
              </Field>
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => setStep(1)}>
                Atrás
              </button>
              <button
                className="btn-primary flex-1"
                disabled={service.name.length < 2 || service.durationMin < 5}
                onClick={() => setStep(3)}
              >
                Siguiente
              </button>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <Field label="Nombre del profesional">
              <input
                className="input"
                value={pro.displayName}
                onChange={(e) => setPro((p) => ({ ...p, displayName: e.target.value }))}
                placeholder="Lola"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Lunes a viernes, desde">
                <input type="time" className="input" value={pro.from} onChange={(e) => setPro((p) => ({ ...p, from: e.target.value }))} />
              </Field>
              <Field label="hasta">
                <input type="time" className="input" value={pro.to} onChange={(e) => setPro((p) => ({ ...p, to: e.target.value }))} />
              </Field>
            </div>
            <p className="text-xs text-stone-500">Después podés cargar más tramos, sábados, feriados y más profesionales.</p>
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => setStep(2)}>
                Atrás
              </button>
              <button className="btn-primary flex-1" disabled={pro.displayName.length < 2 || busy} onClick={finish}>
                {busy ? 'Creando…' : 'Crear negocio'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
