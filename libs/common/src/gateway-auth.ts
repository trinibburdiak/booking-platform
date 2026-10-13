import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { InternalMembership } from '@turnos/contracts';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Contrato entre el gateway y los servicios. El gateway valida el JWT y la
 * membresía, y pasa el resultado en estos headers. Los servicios no validan
 * tokens: confían en los headers solo si llega el `x-internal-token` correcto,
 * que únicamente conocen el gateway y los servicios.
 */
export const HEADERS = {
  internalToken: 'x-internal-token',
  userId: 'x-user-id',
  userEmail: 'x-user-email',
  memberships: 'x-user-memberships',
  businessId: 'x-business-id',
  tenantRole: 'x-tenant-role',
  requestId: 'x-request-id',
} as const;

export type Role = 'OWNER' | 'STAFF';

export interface AuthUser {
  id: string;
  email: string;
  memberships: InternalMembership[];
}

export interface Tenant {
  businessId: string;
  role: Role;
}

type Req = Request & { user?: AuthUser; tenant?: Tenant };

export function internalToken(): string {
  return process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const PUBLIC_HEALTH = 'publicHealth';
/** Marca un endpoint que no exige el token interno (solo /health). */
export const NoInternalToken = () => SetMetadata(PUBLIC_HEALTH, true);

/** Guard global de cada servicio: rechaza todo lo que no venga del gateway o de otro servicio. */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_HEALTH, [ctx.getHandler(), ctx.getClass()])) return true;
    const token = ctx.switchToHttp().getRequest<Req>().headers[HEADERS.internalToken];
    if (typeof token !== 'string' || !safeEqual(token, internalToken())) {
      throw new UnauthorizedException('Acceso directo no permitido: entrá por el gateway');
    }
    return true;
  }
}

function parseMemberships(raw: unknown): InternalMembership[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as InternalMembership[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Exige un usuario autenticado (el gateway ya validó el JWT). */
@Injectable()
export class UserGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Req>();
    const id = req.headers[HEADERS.userId];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException('Falta el token');
    req.user = {
      id,
      email: String(req.headers[HEADERS.userEmail] ?? ''),
      memberships: parseMemberships(req.headers[HEADERS.memberships]),
    };
    return true;
  }
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Rutas de gestión: el gateway ya verificó que el usuario pertenece al negocio de
 * `X-Business-Id` y pasa el rol. Acá solo se aplican los roles del endpoint.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Req>();
    new UserGuard().canActivate(ctx);
    const businessId = req.headers[HEADERS.businessId];
    const role = req.headers[HEADERS.tenantRole];
    if (typeof businessId !== 'string' || (role !== 'OWNER' && role !== 'STAFF')) {
      throw new ForbiddenException('Falta el header X-Business-Id');
    }
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(role)) throw new ForbiddenException('Permisos insuficientes');
    req.tenant = { businessId, role };
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Req>().user!;
});

export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): Tenant => {
  return ctx.switchToHttp().getRequest<Req>().tenant!;
});

/** ¿El usuario pertenece a este negocio? (según lo que resolvió el gateway) */
export function isMemberOf(user: AuthUser, businessId: string): boolean {
  return user.memberships.some((m) => m.businessId === businessId);
}
