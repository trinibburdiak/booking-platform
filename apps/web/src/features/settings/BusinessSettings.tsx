import { zodResolver } from '@hookform/resolvers/zod';
import { UpdateBusinessInput, updateBusinessSchema } from '@turnos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { api, errorMessage } from '../../shared/lib/api';
import { Alert, Field, Spinner } from '../../shared/ui';
import { useAuth } from '../auth/useAuth';
import { useBusiness, useBusinessKey } from '../dashboard/hooks';

export const TIMEZONES = [
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Cordoba',
  'America/Argentina/Mendoza',
  'America/Montevideo',
  'America/Santiago',
  'America/Asuncion',
  'America/Sao_Paulo',
  'America/Lima',
  'America/Bogota',
  'America/Mexico_City',
  'America/New_York',
  'Europe/Madrid',
];

export function BusinessSettings() {
  const business = useBusiness();
  const { user, businessId, reloadUser } = useAuth();
  const isOwner = user?.memberships.find((m) => m.businessId === businessId)?.role === 'OWNER';
  const qc = useQueryClient();
  const key = useBusinessKey();
  const form = useForm<UpdateBusinessInput>({ resolver: zodResolver(updateBusinessSchema) });

  useEffect(() => {
    if (business.data) {
      const { name, timezone, address, cancellationHours, bookingWindowDays, minNoticeMinutes } = business.data;
      form.reset({ name, timezone, address, cancellationHours, bookingWindowDays, minNoticeMinutes });
    }
  }, [business.data, form]);

  const save = useMutation({
    mutationFn: (values: UpdateBusinessInput) => api.patch('/business', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key() });
      void reloadUser();
    },
  });

  if (business.isLoading) return <Spinner />;
  const err = form.formState.errors;
  const num = { valueAsNumber: true };

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Configuración</h1>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="card space-y-4">
        {save.isSuccess && <Alert kind="success">Cambios guardados.</Alert>}
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        <fieldset disabled={!isOwner} className="space-y-4">
          <Field label="Nombre" error={err.name?.message}>
            <input className="input" {...form.register('name')} />
          </Field>
          <Field label="Dirección" error={err.address?.message}>
            <input className="input" {...form.register('address')} />
          </Field>
          <Field label="Zona horaria" error={err.timezone?.message}>
            <select className="input" {...form.register('timezone')}>
              {[...new Set([business.data?.timezone, ...TIMEZONES])].filter(Boolean).map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Cancelar hasta (h antes)" error={err.cancellationHours?.message}>
              <input className="input" type="number" {...form.register('cancellationHours', num)} />
            </Field>
            <Field label="Reservas a (días)" error={err.bookingWindowDays?.message}>
              <input className="input" type="number" {...form.register('bookingWindowDays', num)} />
            </Field>
            <Field label="Aviso mínimo (min)" error={err.minNoticeMinutes?.message}>
              <input className="input" type="number" {...form.register('minNoticeMinutes', num)} />
            </Field>
          </div>
        </fieldset>
        {isOwner ? (
          <button className="btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
          </button>
        ) : (
          <p className="text-sm text-stone-500">Solo el dueño puede cambiar la configuración.</p>
        )}
      </form>
    </div>
  );
}
