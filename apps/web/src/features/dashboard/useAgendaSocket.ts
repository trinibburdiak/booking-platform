import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccessToken, refreshSession } from '../../shared/lib/api';

export interface AgendaPush {
  type: string;
  bookingId: string;
  start: string;
  professionalId: string;
}

/**
 * Conexión en vivo con la agenda del negocio. Cada evento invalida las queries
 * de agenda (TanStack Query las vuelve a pedir) y se pasa a `onEvent` para avisar.
 */
export function useAgendaSocket(businessId: string | null, onEvent?: (e: AgendaPush) => void) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!businessId) return;
    let socket: Socket | null = null;
    let retried = false;
    let cancelled = false;

    const connect = () => {
      socket = io({ path: '/socket.io', auth: { token: getAccessToken(), businessId }, transports: ['websocket'] });
      socket.on('ready', () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));
      socket.on('agenda', (e: AgendaPush) => {
        qc.invalidateQueries({ queryKey: ['business', businessId, 'agenda'] });
        onEventRef.current?.(e);
      });
      // Token vencido: renovar la sesión una vez y reconectar.
      socket.on('unauthorized', async () => {
        socket?.close();
        if (retried || cancelled) return;
        retried = true;
        if (await refreshSession()) connect();
      });
    };
    connect();

    return () => {
      cancelled = true;
      socket?.close();
      setConnected(false);
    };
  }, [businessId, qc]);

  return connected;
}
