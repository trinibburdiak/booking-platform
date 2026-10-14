import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage, RegisterPage } from '../features/auth/AuthPages';
import { AuthProvider, useAuth } from '../features/auth/useAuth';
import { AgendaPage } from '../features/dashboard/AgendaPage';
import { MetricsPage } from '../features/dashboard/MetricsPage';
import { PanelLayout } from '../features/dashboard/PanelLayout';
import { BookingPaymentPage } from '../features/my-bookings/BookingPaymentPage';
import { CancelByTokenPage, MyBookingsPage } from '../features/my-bookings/MyBookingsPage';
import { CreateBusinessWizard } from '../features/onboarding/CreateBusinessWizard';
import { BusinessPage } from '../features/public-booking/BusinessPage';
import { BusinessSettings } from '../features/settings/BusinessSettings';
import { ProfessionalsPage } from '../features/settings/ProfessionalsPage';
import { ServicesPage } from '../features/settings/ServicesPage';
import { Spinner } from '../shared/ui';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Shell>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/b/:slug" element={<BusinessPage />} />
              <Route path="/ingresar" element={<LoginPage />} />
              <Route path="/registro" element={<RegisterPage />} />
              <Route path="/cancelar" element={<CancelByTokenPage />} />
              <Route path="/mis-turnos" element={<RequireAuth><MyBookingsPage /></RequireAuth>} />
              <Route path="/reservas/:id" element={<RequireAuth><BookingPaymentPage /></RequireAuth>} />
              <Route path="/panel/nuevo" element={<RequireAuth><CreateBusinessWizard /></RequireAuth>} />
              <Route path="/panel" element={<RequireAuth><PanelLayout /></RequireAuth>}>
                <Route index element={<AgendaPage />} />
                <Route path="ausentismo" element={<MetricsPage />} />
                <Route path="servicios" element={<ServicesPage />} />
                <Route path="profesionales" element={<ProfessionalsPage />} />
                <Route path="configuracion" element={<BusinessSettings />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <Spinner />;
  if (!user) return <Navigate to={`/ingresar?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { user, ready, logout } = useAuth();
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? 'bg-stone-100 text-stone-900' : 'text-stone-600 hover:text-stone-900'}`;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="text-lg font-bold tracking-tight text-brand-700">
            turnos
          </Link>
          <nav className="flex items-center gap-1">
            {ready && user && (
              <>
                <NavLink to="/mis-turnos" className={navClass}>
                  Mis turnos
                </NavLink>
                <NavLink to="/panel" className={navClass}>
                  {user.memberships.length ? 'Mi negocio' : 'Tengo un negocio'}
                </NavLink>
                <button className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-900" onClick={() => void logout()}>
                  Salir
                </button>
              </>
            )}
            {ready && !user && (
              <Link to="/ingresar" className="btn-secondary">
                Ingresar
              </Link>
            )}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6">{ready ? children : <Spinner />}</div>
    </div>
  );
}

function Home() {
  return (
    <div className="mx-auto max-w-2xl space-y-8 py-10">
      <div className="space-y-3">
        <h1 className="text-4xl font-bold tracking-tight">Turnos online, sin llamadas ni WhatsApp.</h1>
        <p className="text-lg text-stone-600">
          Tu peluquería, consultorio o taller con su propia página de reservas. Tus clientes eligen servicio, profesional y
          horario; vos ves la agenda al día.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/b/barberia-demo" className="btn-primary">
          Probar reservando en la Barbería Demo
        </Link>
        <Link to="/panel" className="btn-secondary">
          Crear mi negocio
        </Link>
      </div>
      <p className="text-sm text-stone-500">
        Usuarios de prueba: <b>cliente@turnos.dev</b> y <b>demo@turnos.dev</b> (dueña), contraseña <b>demo1234</b>.
      </p>
    </div>
  );
}
