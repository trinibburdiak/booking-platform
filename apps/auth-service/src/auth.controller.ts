import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, UserGuard, ZodPipe } from '@turnos/common';
import { AuthResponse, LoginInput, loginSchema, RegisterInput, registerSchema } from '@turnos/contracts';
import { Request, Response } from 'express';
import { AuthService, IssuedSession, REFRESH_TTL_DAYS } from './auth.service';

const REFRESH_COOKIE = 'turnos_rt';
const COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  async register(
    @Body(new ZodPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(await this.auth.register(body), res);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(loginSchema)) body: LoginInput, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
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
  @UseGuards(UserGuard)
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

/** Solo servicio a servicio (el gateway no expone /internal). */
@Controller('internal/users')
export class InternalUsersController {
  constructor(private readonly auth: AuthService) {}

  @Get(':id/memberships')
  memberships(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.auth.memberships(id);
  }
}
