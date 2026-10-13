import type { AuthResponse, LoginInput, MeResponse, RegisterInput } from '@turnos/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, BUSINESS_KEY, onSessionChange, refreshSession, safeGet, safeSet, setAccessToken } from '../../shared/lib/api';

interface AuthState {
  user: MeResponse | null;
  ready: boolean;
  businessId: string | null;
  login: (input: LoginInput) => Promise<MeResponse>;
  register: (input: RegisterInput) => Promise<MeResponse>;
  logout: () => Promise<void>;
  reloadUser: () => Promise<MeResponse | null>;
  selectBusiness: (id: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<MeResponse | null>(null);
  const [ready, setReady] = useState(false);
  const [businessId, setBusinessId] = useState<string | null>(() => safeGet(BUSINESS_KEY));

  const selectBusiness = useCallback(
    (id: string) => {
      safeSet(BUSINESS_KEY, id);
      setBusinessId(id);
      qc.removeQueries({ queryKey: ['business'] });
    },
    [qc],
  );

  // Si el negocio guardado ya no es del usuario, elegir el primero que tenga.
  useEffect(() => {
    if (!user) return;
    const ids = user.memberships.map((m) => m.businessId);
    if (ids.length && (!businessId || !ids.includes(businessId))) selectBusiness(ids[0]);
  }, [user, businessId, selectBusiness]);

  useEffect(() => {
    onSessionChange((s) => setUser(s?.user ?? null));
    refreshSession().finally(() => setReady(true));
  }, []);

  const accept = useCallback((data: AuthResponse) => {
    setAccessToken(data.accessToken);
    setUser(data.user);
    return data.user;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      businessId,
      selectBusiness,
      login: async (input) => accept((await api.post<AuthResponse>('/auth/login', input)).data),
      register: async (input) => accept((await api.post<AuthResponse>('/auth/register', input)).data),
      logout: async () => {
        await api.post('/auth/logout').catch(() => undefined);
        setAccessToken(null);
        setUser(null);
        qc.clear();
      },
      reloadUser: async () => {
        const me = (await api.get<MeResponse>('/auth/me')).data;
        setUser(me);
        return me;
      },
    }),
    [user, ready, businessId, selectBusiness, accept, qc],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fuera de AuthProvider');
  return ctx;
}
