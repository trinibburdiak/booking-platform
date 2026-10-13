import { JwtService } from '@nestjs/jwt';
import { HEADERS, internalGet, internalToken, SERVICE_URLS } from '@turnos/common';
import type { InternalMembership } from '@turnos/contracts';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { createProxyMiddleware, fixRequestBody, RequestHandler } from 'http-proxy-middleware';
import type Redis from 'ioredis';
import { LIMITS, matchRoute } from './routes';

const PREFIX = '/api/v1';
const MEMBERSHIP_TTL_SECONDS = 15;

/** Headers que solo puede poner el gateway: si vienen del cliente, se descartan. */
const TRUSTED = [
  HEADERS.internalToken,
  HEADERS.userId,
  HEADERS.userEmail,
  HEADERS.memberships,
  HEADERS.tenantRole,
];

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ statusCode: status, message });

export function createGateway(deps: { jwt: JwtService; redis: Redis }) {
  const { jwt, redis } = deps;
  const proxies = new Map<string, RequestHandler>();

  /** Un proxy por servicio. Se arma perezosamente porque las URLs salen del entorno. */
  const proxyFor = (target: string) => {
    let p = proxies.get(target);
    if (!p) {
      p = createProxyMiddleware({
        target,
        changeOrigin: true,
        xfwd: true,
        on: {
          proxyReq: fixRequestBody,
          error: (err, _req, res) => {
            const r = res as Response;
            if (!r.headersSent) fail(r, 502, `Servicio no disponible: ${err.message}`);
          },
        },
      });
      proxies.set(target, p);
    }
    return p;
  };

  /** Membresías del usuario (de auth-service), con caché corto en Redis. */
  const memberships = async (userId: string, fresh = false): Promise<InternalMembership[]> => {
    const key = `memberships:${userId}`;
    if (!fresh) {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as InternalMembership[];
    }
    const list = await internalGet<InternalMembership[]>(SERVICE_URLS.auth(), `/internal/users/${userId}/memberships`);
    await redis.set(key, JSON.stringify(list), 'EX', MEMBERSHIP_TTL_SECONDS);
    return list;
  };

  const rateLimited = async (bucket: keyof typeof LIMITS, ip: string) => {
    if (process.env.NODE_ENV === 'test' && !process.env.RATE_LIMIT_IN_TESTS) return false;
    const key = `rl:${bucket}:${ip}:${Math.floor(Date.now() / 60_000)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return count > LIMITS[bucket];
  };

  return async function gateway(req: Request, res: Response, next: NextFunction) {
    if (!req.path.startsWith(`${PREFIX}/`)) return next();
    const path = req.path.slice(PREFIX.length);

    for (const h of TRUSTED) delete req.headers[h];
    const requestId = (req.headers[HEADERS.requestId] as string) || randomUUID();
    req.headers[HEADERS.requestId] = requestId;
    res.setHeader(HEADERS.requestId, requestId);

    const route = matchRoute(req.method, path);
    if (!route) return fail(res, 404, 'Ruta no encontrada');

    try {
      if (await rateLimited(route.bucket ?? 'default', req.ip ?? 'unknown')) {
        return fail(res, 429, 'Demasiados intentos, esperá un minuto.');
      }

      // Token opcional en rutas públicas; obligatorio en el resto
      const header = req.headers.authorization;
      let user: { sub: string; email: string } | null = null;
      if (header?.startsWith('Bearer ')) {
        try {
          user = await jwt.verifyAsync<{ sub: string; email: string }>(header.slice(7));
        } catch {
          if (route.access !== 'none') return fail(res, 401, 'Token inválido o vencido');
        }
      }
      if (route.access !== 'none' && !user) return fail(res, 401, 'Falta el token');

      if (user) {
        let list = await memberships(user.sub);
        req.headers[HEADERS.userId] = user.sub;
        req.headers[HEADERS.userEmail] = user.email;

        if (route.access === 'tenant') {
          const businessId = req.headers[HEADERS.businessId];
          if (typeof businessId !== 'string' || !businessId) return fail(res, 403, 'Falta el header X-Business-Id');
          let m = list.find((x) => x.businessId === businessId);
          // Recién creado el negocio, la membresía puede no estar en caché todavía
          if (!m) {
            list = await memberships(user.sub, true);
            m = list.find((x) => x.businessId === businessId);
          }
          if (!m) return fail(res, 403, 'No pertenecés a este negocio');
          req.headers[HEADERS.tenantRole] = m.role;
        } else {
          delete req.headers[HEADERS.businessId];
        }
        req.headers[HEADERS.memberships] = JSON.stringify(list);
      }

      req.headers[HEADERS.internalToken] = internalToken();
      return proxyFor(route.target())(req, res, next);
    } catch (e) {
      return fail(res, 502, `Error en el gateway: ${(e as Error).message}`);
    }
  };
}

/** Proxy del WebSocket de la agenda hacia notifications-service (que valida el token). */
export function createSocketProxy() {
  return createProxyMiddleware({
    target: SERVICE_URLS.notifications(),
    ws: true,
    changeOrigin: true,
    pathFilter: '/socket.io',
  });
}
