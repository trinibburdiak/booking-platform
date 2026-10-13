import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { AuthResponse, LoginInput, loginSchema, RegisterInput, registerSchema } from '@turnos/contracts';
import { Request, Response } from 'express';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../common/auth';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService, IssuedSession, REFRESH_TTL_DAYS } from './auth.service';

const REFRESH_COOKIE = 'turnos_rt';
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async register(
    @Body(new ZodPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(await this.auth.register(body), res);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(await this.auth.login(body), res);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.respond(await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]), res);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  private respond(session: IssuedSession, res: Response): AuthResponse {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: COOKIE_PATH,
      maxAge: REFRESH_TTL_DAYS * 86_400_000,
    });
    return { accessToken: session.accessToken, user: session.user };
  }
}
