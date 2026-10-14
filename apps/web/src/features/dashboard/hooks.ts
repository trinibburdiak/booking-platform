import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/lib/api';
import { useAuth } from '../auth/useAuth';

export interface BusinessSettings {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  address: string | null;
  cancellationHours: number;
  bookingWindowDays: number;
  minNoticeMinutes: number;
  requiresDeposit: boolean;
}

export interface ServiceRow {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  priceCents: number;
  depositCents: number;
  active: boolean;
}

export interface ProfessionalRow {
  id: string;
  displayName: string;
  active: boolean;
  userId: string | null;
  serviceIds: string[];
  schedules: { id: string; weekday: number; startTime: string; endTime: string }[];
}

/** Todas las queries del panel llevan el businessId en la key, así cambiar de negocio no mezcla datos. */
export function useBusinessKey() {
  const { businessId } = useAuth();
  return (...parts: unknown[]) => ['business', businessId, ...parts];
}

export function useBusiness() {
  const key = useBusinessKey();
  return useQuery({ queryKey: key('settings'), queryFn: async () => (await api.get<BusinessSettings>('/business')).data });
}

export function useServices() {
  const key = useBusinessKey();
  return useQuery({ queryKey: key('services'), queryFn: async () => (await api.get<ServiceRow[]>('/business/services')).data });
}

export function useProfessionals() {
  const key = useBusinessKey();
  return useQuery({
    queryKey: key('professionals'),
    queryFn: async () => (await api.get<ProfessionalRow[]>('/business/professionals')).data,
  });
}
