import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { config } from '../config';
import { Ctx, Me, Public } from '../common/auth';
import { AuditContext } from '../common/audit.service';
import { AuthUser } from '../common/types';
import { AuthService } from './auth.service';

class LoginDto { @IsEmail() email: string; @IsString() @MinLength(1) password: string }
class ChangePasswordDto { @IsString() current: string; @IsString() next: string }

const REFRESH_COOKIE = 'ts_refresh';
const HANDSHAKE_COOKIE = 'ts_oidc';
const secure = () => config.publicUrl.startsWith('https');

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  private setRefresh(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: 'strict', path: '/api/auth', maxAge: config.auth.refreshTtlDays * 864e5 });
  }

  @Public() @Get('providers')
  providers() {
    return { local: config.auth.localLoginEnabled, oidc: config.auth.oidc.enabled ? { name: config.auth.oidc.displayName } : null };
  }

  @Public() @Post('login') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(@Body() dto: LoginDto, @Ctx() ctx: AuditContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto.email, dto.password, ctx);
    this.setRefresh(res, r.refreshToken);
    return { accessToken: r.accessToken, user: r.user, mustChangePassword: r.mustChangePassword };
  }

  @Public() @Post('refresh') @HttpCode(200)
  async refresh(@Req() req: Request, @Ctx() ctx: AuditContext, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], ctx);
    this.setRefresh(res, r.refreshToken);
    return { accessToken: r.accessToken, user: r.user, mustChangePassword: r.mustChangePassword };
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request, @Ctx() ctx: AuditContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE], ctx);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  @Get('me')
  me(@Me() user: AuthUser) { return user; }

  @Post('change-password') @HttpCode(204)
  async changePassword(@Me() user: AuthUser, @Body() dto: ChangePasswordDto, @Ctx() ctx: AuditContext) {
    await this.auth.changePassword(user, dto.current, dto.next, ctx);
  }

  @Public() @Get('oidc/login')
  async oidcLogin(@Res() res: Response) {
    const { url, handshake } = await this.auth.oidcStart();
    res.cookie(HANDSHAKE_COOKIE, handshake, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/api/auth/oidc', maxAge: 600000 });
    res.redirect(url);
  }

  @Public() @Get('oidc/callback')
  async oidcCallback(@Query() q: Record<string, string>, @Req() req: Request, @Ctx() ctx: AuditContext, @Res() res: Response) {
    try {
      const r = await this.auth.oidcCallback(q, req.cookies?.[HANDSHAKE_COOKIE] ?? '', ctx);
      res.clearCookie(HANDSHAKE_COOKIE, { path: '/api/auth/oidc' });
      this.setRefresh(res, r.refreshToken);
      res.redirect('/?sso=1');
    } catch (e) {
      res.redirect('/login?error=' + encodeURIComponent((e as Error).message));
    }
  }
}
