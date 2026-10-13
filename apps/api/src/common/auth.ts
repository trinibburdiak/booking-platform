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
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthUser {
  id: string;
  email: string;
}

export interface Tenant {
  businessId: string;
  role: Role;
}

type AuthedRequest = Request & { user?: AuthUser; tenant?: Tenant };

/** Valida el access token (Bearer) y deja el usuario en `req.user`. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Falta el token');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(header.slice(7));
      req.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o vencido');
    }
  }
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Resuelve el negocio de las rutas de gestión. El negocio activo llega en el
 * header `X-Business-Id`, pero solo se acepta si el usuario tiene una membresía
 * en él: nunca se confía en un businessId del body. Debe ir después de JwtAuthGuard.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const businessId = req.headers['x-business-id'];
    if (typeof businessId !== 'string' || !/^[0-9a-f-]{36}$/i.test(businessId)) {
      throw new ForbiddenException('Falta el header X-Business-Id');
    }
    const membership = await this.prisma.membership.findUnique({
      where: { userId_businessId: { userId: req.user!.id, businessId } },
    });
    if (!membership) throw new ForbiddenException('No pertenecés a este negocio');

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(membership.role)) throw new ForbiddenException('Permisos insuficientes');

    req.tenant = { businessId, role: membership.role };
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest<AuthedRequest>().user!,
);

export const CurrentTenant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Tenant => ctx.switchToHttp().getRequest<AuthedRequest>().tenant!,
);
