import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';

const links = [
  { to: '/panel', label: 'Agenda', end: true },
  { to: '/panel/servicios', label: 'Servicios' },
  { to: '/panel/profesionales', label: 'Profesionales y horarios' },
  { to: '/panel/configuracion', label: 'Configuración' },
];

export function PanelLayout() {
  const { user, businessId, selectBusiness } = useAuth();
  if (!user) return null;
  if (!user.memberships.length) return <Navigate to="/panel/nuevo" replace />;
  const current = user.memberships.find((m) => m.businessId === businessId);
  if (!current) return null;

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="shrink-0 lg:w-56">
        <div className="mb-4 space-y-2">
          {user.memberships.length > 1 ? (
            <select
              className="input font-semibold"
              value={businessId ?? ''}
              onChange={(e) => selectBusiness(e.target.value)}
              aria-label="Negocio"
            >
              {user.memberships.map((m) => (
                <option key={m.businessId} value={m.businessId}>
                  {m.businessName}
                </option>
              ))}
            </select>
          ) : (
            <p className="font-semibold">{current.businessName}</p>
          )}
          <p className="text-xs text-stone-500">
            {current.role === 'OWNER' ? 'Dueño/a' : 'Staff'} ·{' '}
            <a className="text-brand-600 hover:underline" href={`/b/${current.businessSlug}`} target="_blank" rel="noreferrer">
              ver página pública ↗
            </a>
          </p>
        </div>
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${
                  isActive ? 'bg-brand-50 text-brand-700' : 'text-stone-600 hover:bg-stone-100'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
          <NavLink to="/panel/nuevo" className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-stone-500 hover:bg-stone-100">
            + Nuevo negocio
          </NavLink>
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
