import { zodResolver } from '@hookform/resolvers/zod';
import { ExceptionInput, exceptionSchema } from '@turnos/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, errorMessage } from '../../shared/lib/api';
import { WEEKDAYS } from '../../shared/lib/format';
import { Alert, EmptyState, Field, Modal, Spinner } from '../../shared/ui';
import { useAuth } from '../auth/useAuth';
import { ProfessionalRow, useBusinessKey, useProfessionals, useServices } from '../dashboard/hooks';

// Lunes primero, como en un calendario local
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function ProfessionalsPage() {
  const pros = useProfessionals();
  const { user, businessId } = useAuth();
  const isOwner = user?.memberships.find((m) => m.businessId === businessId)?.role === 'OWNER';
  const [editing, setEditing] = useState<ProfessionalRow | 'new' | null>(null);
  const [schedule, setSchedule] = useState<ProfessionalRow | null>(null);
  const [exceptions, setExceptions] = useState<ProfessionalRow | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Profesionales y horarios</h1>
        {isOwner && (
          <button className="btn-primary" onClick={() => setEditing('new')}>
            + Profesional
          </button>
        )}
      </div>
      {pros.isLoading && <Spinner />}
      {pros.isError && <Alert>{errorMessage(pros.error)}</Alert>}
      {pros.data && !pros.data.length && <EmptyState>Todavía no cargaste profesionales.</EmptyState>}
      <div className="grid gap-4 md:grid-cols-2">
        {pros.data?.map((p) => (
          <article key={p.id} className={`card space-y-3 ${p.active ? '' : 'opacity-60'}`}>
            <div className="flex items-start justify-between">
              <h2 className="font-semibold">
                {p.displayName} {!p.active && <span className="text-xs font-normal">(inactivo)</span>}
              </h2>
              {isOwner && (
                <button className="text-sm font-medium text-brand-600 hover:underline" onClick={() => setEditing(p)}>
                  Editar
                </button>
              )}
            </div>
            <ScheduleSummary pro={p} />
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => setSchedule(p)}>
                Horario semanal
              </button>
              <button className="btn-secondary" onClick={() => setExceptions(p)}>
                Feriados y excepciones
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing && <ProfessionalForm pro={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {schedule && <ScheduleEditor pro={schedule} onClose={() => setSchedule(null)} />}
      {exceptions && <ExceptionsDialog pro={exceptions} onClose={() => setExceptions(null)} />}
    </div>
  );
}

function ScheduleSummary({ pro }: { pro: ProfessionalRow }) {
  if (!pro.schedules.length) return <p className="text-sm text-stone-500">Sin horario cargado.</p>;
  return (
    <ul className="space-y-0.5 text-sm text-stone-600">
      {WEEK_ORDER.map((d) => {
        const ranges = pro.schedules.filter((s) => s.weekday === d);
        if (!ranges.length) return null;
        return (
          <li key={d}>
            <span className="inline-block w-24 text-stone-500">{WEEKDAYS[d]}</span>
            {ranges.map((r) => `${r.startTime}–${r.endTime}`).join(', ')}
          </li>
        );
      })}
    </ul>
  );
}

function ProfessionalForm({ pro, onClose }: { pro: ProfessionalRow | null; onClose: () => void }) {
  const services = useServices();
  const qc = useQueryClient();
  const key = useBusinessKey();
  const [name, setName] = useState(pro?.displayName ?? '');
  const [active, setActive] = useState(pro?.active ?? true);
  const [serviceIds, setServiceIds] = useState<string[]>(pro?.serviceIds ?? []);
  const done = () => {
    qc.invalidateQueries({ queryKey: key() });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { displayName: name, active, serviceIds };
      return pro ? api.put(`/business/professionals/${pro.id}`, body) : api.post('/business/professionals', body);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/business/professionals/${pro!.id}`), onSuccess: done });

  return (
    <Modal title={pro ? 'Editar profesional' : 'Nuevo profesional'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {(save.isError || remove.isError) && <Alert>{errorMessage(save.error ?? remove.error)}</Alert>}
        <Field label="Nombre visible">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </Field>
        <fieldset>
          <legend className="label">Servicios que ofrece</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {services.data?.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={serviceIds.includes(s.id)}
                  onChange={(e) =>
                    setServiceIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)))
                  }
                />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activo
        </label>
        <div className="flex justify-between gap-2 pt-2">
          {pro ? (
            <button type="button" className="btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Eliminar
            </button>
          ) : (
            <span />
          )}
          <button className="btn-primary" disabled={save.isPending}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}

type Range = { weekday: number; startTime: string; endTime: string };

/** Editor visual del horario semanal: varios tramos por día (ej. 9–13 y 16–20). */
function ScheduleEditor({ pro, onClose }: { pro: ProfessionalRow; onClose: () => void }) {
  const qc = useQueryClient();
  const key = useBusinessKey();
  const [ranges, setRanges] = useState<Range[]>(() =>
    pro.schedules.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime })),
  );
  const save = useMutation({
    mutationFn: () => api.put(`/business/professionals/${pro.id}/schedule`, { ranges }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key() });
      onClose();
    },
  });

  const update = (idx: number, patch: Partial<Range>) =>
    setRanges((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const copyMondayToWeekdays = () => {
    const monday = ranges.filter((r) => r.weekday === 1);
    setRanges((rs) => [...rs.filter((r) => ![2, 3, 4, 5].includes(r.weekday)), ...[2, 3, 4, 5].flatMap((d) => monday.map((r) => ({ ...r, weekday: d })))]);
  };

  return (
    <Modal title={`Horario de ${pro.displayName}`} onClose={onClose}>
      <div className="space-y-3">
        {WEEK_ORDER.map((d) => (
          <div key={d} className="flex flex-wrap items-start gap-2 border-b border-stone-100 pb-3">
            <span className="w-24 pt-2 text-sm font-medium">{WEEKDAYS[d]}</span>
            <div className="flex-1 space-y-2">
              {ranges.map((r, idx) =>
                r.weekday === d ? (
                  <div key={idx} className="flex items-center gap-2">
                    <input type="time" className="input w-28" value={r.startTime} onChange={(e) => update(idx, { startTime: e.target.value })} />
                    <span className="text-stone-400">a</span>
                    <input type="time" className="input w-28" value={r.endTime} onChange={(e) => update(idx, { endTime: e.target.value })} />
                    <button
                      type="button"
                      className="text-stone-400 hover:text-red-600"
                      onClick={() => setRanges((rs) => rs.filter((_, i) => i !== idx))}
                      aria-label="Quitar tramo"
                    >
                      ✕
                    </button>
                  </div>
                ) : null,
              )}
              <button
                type="button"
                className="text-sm font-medium text-brand-600 hover:underline"
                onClick={() => setRanges((rs) => [...rs, { weekday: d, startTime: '09:00', endTime: '13:00' }])}
              >
                + tramo
              </button>
            </div>
          </div>
        ))}
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={copyMondayToWeekdays}>
            Copiar lunes a mar–vie
          </button>
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Guardar horario
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface ExceptionRow {
  id: string;
  date: string;
  type: 'CLOSED' | 'EXTRA_HOURS';
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

function ExceptionsDialog({ pro, onClose }: { pro: ProfessionalRow; onClose: () => void }) {
  const qc = useQueryClient();
  const key = useBusinessKey();
  const listKey = key('exceptions', pro.id);
  const list = useQuery({
    queryKey: listKey,
    queryFn: async () => (await api.get<ExceptionRow[]>(`/business/professionals/${pro.id}/exceptions`)).data,
  });
  const form = useForm<ExceptionInput>({ resolver: zodResolver(exceptionSchema), defaultValues: { type: 'CLOSED' } });
  const create = useMutation({
    mutationFn: (v: ExceptionInput) =>
      api.post(`/business/professionals/${pro.id}/exceptions`, { ...v, reason: v.reason || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey });
      form.reset({ type: 'CLOSED' });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/business/professionals/${pro.id}/exceptions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
  const type = form.watch('type');

  return (
    <Modal title={`Excepciones de ${pro.displayName}`} onClose={onClose}>
      <div className="space-y-5">
        {list.isLoading && <Spinner />}
        {list.data && !list.data.length && <p className="text-sm text-stone-500">Sin feriados ni excepciones cargadas.</p>}
        <ul className="divide-y divide-stone-100 text-sm">
          {list.data?.map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2">
              <span>
                <b>{e.date}</b> · {e.type === 'CLOSED' ? 'Cerrado' : 'Horas extra'}
                {e.startTime && ` ${e.startTime}–${e.endTime}`}
                {e.reason && <span className="text-stone-500"> · {e.reason}</span>}
              </span>
              <button className="text-stone-400 hover:text-red-600" onClick={() => remove.mutate(e.id)} aria-label="Eliminar">
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-3 rounded-xl bg-stone-50 p-4">
          <p className="text-sm font-medium">Agregar excepción</p>
          {create.isError && <Alert>{errorMessage(create.error)}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Fecha" error={form.formState.errors.date?.message}>
              <input type="date" className="input" {...form.register('date')} />
            </Field>
            <Field label="Tipo">
              <select className="input" {...form.register('type')}>
                <option value="CLOSED">Cerrado (feriado, vacaciones)</option>
                <option value="EXTRA_HOURS">Horas extra</option>
              </select>
            </Field>
            <Field
              label={type === 'CLOSED' ? 'Desde (vacío = todo el día)' : 'Desde'}
              error={form.formState.errors.startTime?.message}
            >
              <input type="time" className="input" {...form.register('startTime')} />
            </Field>
            <Field label="Hasta">
              <input type="time" className="input" {...form.register('endTime')} />
            </Field>
          </div>
          <Field label="Motivo (opcional)">
            <input className="input" {...form.register('reason')} />
          </Field>
          <button className="btn-primary" disabled={create.isPending}>
            Agregar
          </button>
        </form>
      </div>
    </Modal>
  );
}
