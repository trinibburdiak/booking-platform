import type { ApiError, AuthResponse } from '@turnos/contracts';
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

/** Access token en memoria (nunca en localStorage). El refresh vive en una cookie httpOnly. */
let accessToken: string | null = null;
let onSession: ((s: AuthResponse | null) => void) | null = null;

export const BUSINESS_KEY = 'turnos.businessId';

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function onSessionChange(cb: (s: AuthResponse | null) => void) {
  onSession = cb;
}

export const api = axios.create({ baseURL: '/api/v1', withCredentials: true });

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  if (config.url === '/business' || config.url?.startsWith('/business/')) {
    const businessId = safeGet(BUSINESS_KEY);
    if (businessId) config.headers['X-Business-Id'] = businessId;
  }
  return config;
});

let refreshing: Promise<AuthResponse | null> | null = null;

export function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= axios
    .post<AuthResponse>('/api/v1/auth/refresh', null, { withCredentials: true })
    .then((r) => {
      setAccessToken(r.data.accessToken);
      onSession?.(r.data);
      return r.data;
    })
    .catch(() => {
      setAccessToken(null);
      onSession?.(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// Si el access token venció, renueva la sesión una vez y reintenta.
api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
  const isAuthRoute = original?.url?.startsWith('/auth/');
  if (error.response?.status === 401 && original && !original._retried && !isAuthRoute) {
    original._retried = true;
    const session = await refreshSession();
    if (session) return api(original);
  }
  throw error;
});

export function errorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data as Partial<ApiError> | undefined;
    if (data?.message) return Array.isArray(data.message) ? data.message.join(', ') : data.message;
    if (e.response?.status === 429) return 'Demasiados intentos, esperá un minuto.';
    return e.message;
  }
  return 'Ocurrió un error inesperado';
}

export function errorCode(e: unknown): string | undefined {
  return axios.isAxiosError(e) ? (e.response?.data as Partial<ApiError> | undefined)?.code : undefined;
}

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* almacenamiento no disponible */
  }
}
