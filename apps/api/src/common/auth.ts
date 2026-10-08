import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { Request } from 'express';
import { config } from '../config';
import { Db } from './db.service';
import { AuthUser } from './types';
import { AuditContext } from './audit.service';

export const IS_PUBLIC = 'isPublic';
export const PERMS = 'perms';
/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route needs at least one of these permissions. */
export const Perms = (...perms: string[]) => SetMetadata(PERMS, perms);

export const Me = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): AuditContext => {
  const req: Request & { user?: AuthUser } = ctx.switchToHttp().getRequest();
  return { user: req.user, ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip, userAgent: req.headers['user-agent'] };
});

export function hasPerm(u: AuthUser, p: string) { return u.permissions.includes(p); }

export async function loadAuthUser(db: Db, userId: string): Promise<AuthUser | null> {
  const row = await db.one(
    `SELECT u.id, u.email, u.full_name, u.is_active, r.key AS role, r.name AS role_name,
            COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
     FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE u.id = $1 GROUP BY u.id, r.key, r.name`, [userId]);
  if (!row || !row.is_active) return null;
  return { id: row.id, email: row.email, name: row.full_name, role: row.role, roleName: row.role_name, permissions: row.permissions };
}

/**
 * Global guard: validates the Bearer access token (HS256 JWT), loads the user's
 * current role and permissions from the database on every request (so role
 * changes and suspensions take effect immediately), then enforces @Perms.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw new UnauthorizedException('Sign in to continue');
    let sub: string;
    try {
      const p = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'], issuer: 'talentscreen', audience: 'talentscreen-web' }) as jwt.JwtPayload;
      sub = p.sub as string;
    } catch {
      throw new UnauthorizedException('Your session has expired. Sign in again.');
    }
    const user = await loadAuthUser(this.db, sub);
    if (!user) throw new UnauthorizedException('This account is suspended or no longer exists');
    req.user = user;

    const needed = this.reflector.getAllAndOverride<string[]>(PERMS, [ctx.getHandler(), ctx.getClass()]);
    if (needed?.length && !needed.some((p) => user.permissions.includes(p))) {
      throw new ForbiddenException(`Your role (${user.roleName}) does not allow this action`);
    }
    return true;
  }
}
