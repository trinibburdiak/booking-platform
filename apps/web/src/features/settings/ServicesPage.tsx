import { zodResolver } from '@hookform/resolvers/zod';
import { ServiceInput, serviceSchema } from '@turnos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { api, errorMessage } from '../../shared/lib/api';
import { formatPrice } from '../../shared/lib/format';
import { Alert, EmptyState, Field, Modal, Spinner } from '../../shared/ui';
import { ServiceRow, useBusinessKey, useServices } from '../dashboard/hooks';

export function ServicesPage() {
  const services = useServices();
  const [editing, setEditing] = useState<ServiceRow | 'new' | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Servicios</h1>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          + Servicio
        </button>
      </div>
      {services.isLoading && <Spinner />}
      {services.isError && <Alert>{errorMessage(services.error)}</Alert>}
      {services.data && !services.data.length && <EmptyState>Todavía no cargaste servicios.</EmptyState>}
      {!!services.data?.length && (
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-4 py-2 font-medium">Servicio</th>
                <th className="px-4 py-2 font-medium">Duración</th>
                <th className="px-4 py-2 font-medium">Buffer</th>
                <th className="px-4 py-2 font-medium">Precio</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {services.data.map((s) => (
                <tr key={s.id} className={s.active ? '' : 'text-stone-400'}>
                  <td className="px-4 py-3 font-medium">
                    {s.name} {!s.active && <span className="text-xs">(inactivo)</span>}
                  </td>
                  <td className="px-4 py-3">{s.durationMin} min</td>
                  <td className="px-4 py-3">{s.bufferMin} min</td>
                  <td className="px-4 py-3">{formatPrice(s.priceCents)}</td>
                  <td className="px-4 py-3 text-right">
                    <button className="font-medium text-brand-600 hover:underline" onClick={() => setEditing(s)}>
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ServiceForm service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

type FormValues = Omit<ServiceInput, 'priceCents'> & { price: number };

function ServiceForm({ service, onClose }: { service: ServiceRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const key = useBusinessKey();
  const form = useForm<FormValues>({
    resolver: zodResolver(serviceSchema.omit({ priceCents: true }).extend({ price: serviceSchema.shape.priceCents })),
    defaultValues: service
      ? { ...service, price: service.priceCents / 100 }
      : { name: '', durationMin: 30, bufferMin: 0, price: 0, depositCents: 0, active: true },
  });
  const done = () => {
    qc.invalidateQueries({ queryKey: key() });
    onClose();
  };
  const save = useMutation({
    mutationFn: ({ price, ...v }: FormValues) => {
      const body: ServiceInput = { ...v, priceCents: Math.round(price * 100) };
      return service ? api.put(`/business/services/${service.id}`, body) : api.post('/business/services', body);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/business/services/${service!.id}`), onSuccess: done });
  const err = form.formState.errors;
  const num = { valueAsNumber: true };

  return (
    <Modal title={service ? 'Editar servicio' : 'Nuevo servicio'} onClose={onClose}>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
        {(save.isError || remove.isError) && <Alert>{errorMessage(save.error ?? remove.error)}</Alert>}
        <Field label="Nombre" error={err.name?.message}>
          <input className="input" {...form.register('name')} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Duración (min)" error={err.durationMin?.message}>
            <input className="input" type="number" {...form.register('durationMin', num)} />
          </Field>
          <Field label="Buffer (min)" error={err.bufferMin?.message}>
            <input className="input" type="number" {...form.register('bufferMin', num)} />
          </Field>
          <Field label="Precio ($)" error={err.price?.message}>
            <input className="input" type="number" step="1" {...form.register('price', num)} />
          </Field>
        </div>
        <p className="text-xs text-stone-500">El buffer es el tiempo libre que queda después del turno (limpieza, preparación).</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...form.register('active')} /> Activo (visible para reservar)
        </label>
        <div className="flex justify-between gap-2 pt-2">
          {service ? (
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
