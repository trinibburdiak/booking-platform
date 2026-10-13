import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InternalMembership, LoginInput, MeResponse, RegisterInput, TOPICS, UserRegisteredPayload } from '@turnos/contracts';
import { envelope, OutboxRelay, outboxRecord } from '@turnos/kafka';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';

export const REFRESH_TTL_DAYS = 30;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  user: MeResponse;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly relay: OutboxRelay,
  ) {}

  /** Crea el usuario y publica user.registered (booking lo usa para mostrar clientes en la agenda). */
  async register(input: RegisterInput): Promise<IssuedSession> {
    const email = input.email.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Ya existe una cuenta con ese email');
    const passwordHash = await argon2.hash(input.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email, passwordHash, fullName: input.fullName, phone: input.phone } });
      const event = envelope<'user.registered', UserRegisteredPayload>('user.registered', null, {
        userId: u.id,
        email: u.email,
        fullName: u.fullName,
        phone: u.phone,
      });
      await tx.outboxEvent.create({ data: outboxRecord(TOPICS.auth, u.id, event) });
      return u;
    });
    this.relay.kick();
    return this.issue(user.id);
  }

  async login(input: LoginInput): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }
    return this.issue(user.id);
  }

  /**
   * Refresh tokens rotativos: cada uso revoca el anterior. Si llega uno ya
   * revocado, se asume robo y se revocan todas las sesiones del usuario.
   */
  async refresh(rawToken: string | undefined): Promise<IssuedSession> {
    if (!rawToken) throw new UnauthorizedException('Sin sesión');
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!stored || stored.expiresAt < new Date()) throw new UnauthorizedException('Sesión vencida');
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Sesión inválida');
    }
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issue(stored.userId);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { business: true } } },
    });
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      memberships: user.memberships.map((m) => ({
        businessId: m.businessId,
        role: m.role,
        businessName: m.business.name,
        businessSlug: m.business.slug,
      })),
    };
  }

  /** Lo consulta el gateway (con caché) para resolver el negocio de cada request. */
  async memberships(userId: string): Promise<InternalMembership[]> {
    const rows = await this.prisma.membership.findMany({ where: { userId } });
    return rows.map((m) => ({ businessId: m.businessId, role: m.role }));
  }

  private async issue(userId: string): Promise<IssuedSession> {
    const user = await this.me(userId);
    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
      },
    });
    return { accessToken, refreshToken, user };
  }
}
