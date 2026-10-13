import { zodResolver } from '@hookform/resolvers/zod';
import { LoginInput, loginSchema, RegisterInput, registerSchema } from '@turnos/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../../shared/lib/api';
import { Alert, Field } from '../../shared/ui';
import { useAuth } from './useAuth';

/** Solo se aceptan rutas internas como destino, para no redirigir afuera. */
function useNext() {
  const [params] = useSearchParams();
  const next = params.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const next = useNext();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const user = await login(values);
      navigate(next ?? (user.memberships.length ? '/panel' : '/mis-turnos'));
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <AuthCard title="Ingresar">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Email" error={form.formState.errors.email?.message}>
          <input className="input" type="email" autoComplete="email" {...form.register('email')} />
        </Field>
        <Field label="Contraseña" error={form.formState.errors.password?.message}>
          <input className="input" type="password" autoComplete="current-password" {...form.register('password')} />
        </Field>
        <button className="btn-primary w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Ingresando…' : 'Ingresar'}
        </button>
        <p className="text-center text-sm text-stone-600">
          ¿No tenés cuenta?{' '}
          <Link className="font-medium text-brand-600" to={`/registro${next ? `?next=${encodeURIComponent(next)}` : ''}`}>
            Registrate
          </Link>
        </p>
        <p className="rounded-lg bg-stone-50 p-3 text-xs text-stone-500">
          Probá la demo con <b>cliente@turnos.dev</b> (cliente) o <b>demo@turnos.dev</b> (dueña). Contraseña: demo1234
        </p>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const next = useNext();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await register(values);
      navigate(next ?? '/mis-turnos');
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  const err = form.formState.errors;
  return (
    <AuthCard title="Crear cuenta">
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Nombre y apellido" error={err.fullName?.message}>
          <input className="input" autoComplete="name" {...form.register('fullName')} />
        </Field>
        <Field label="Email" error={err.email?.message}>
          <input className="input" type="email" autoComplete="email" {...form.register('email')} />
        </Field>
        <Field label="Teléfono (opcional)" error={err.phone?.message}>
          <input className="input" type="tel" autoComplete="tel" {...form.register('phone')} />
        </Field>
        <Field label="Contraseña" error={err.password?.message}>
          <input className="input" type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        <button className="btn-primary w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Creando…' : 'Crear cuenta'}
        </button>
        <p className="text-center text-sm text-stone-600">
          ¿Ya tenés cuenta?{' '}
          <Link className="font-medium text-brand-600" to={`/ingresar${next ? `?next=${encodeURIComponent(next)}` : ''}`}>
            Ingresá
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm py-10">
      <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
      <div className="card">{children}</div>
    </div>
  );
}
