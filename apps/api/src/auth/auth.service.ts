import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { Db } from '../common/db.service';
import { CryptoService } from '../common/crypto.service';
import { AuditContext, AuditService } from '../common/audit.service';
import { loadAuthUser } from '../common/auth';
import { AuthUser } from '../common/types';

export const PASSWORD_RULE = 'At least 12 characters, including upper- and lower-case letters and a number';
export function strongPassword(p: string) { return p.length >= 12 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p); }

@Injectable()
export class AuthService {
  private log = new Logger('Auth');
  private oidcClient: any;

  constructor(private db: Db, private crypto: CryptoService, private audit: AuditService) {}

  accessToken(u: AuthUser) {
    return jwt.sign({ name: u.name, role: u.role }, config.auth.jwtSecret,
      { subject: u.id, expiresIn: config.auth.accessTtlSec, issuer: 'talentscreen', audience: 'talentscreen-web', algorithm: 'HS256' });
  }

  async issueRefresh(userId: string, ctx: AuditContext): Promise<string> {
    const token = this.crypto.token();
    await this.db.exec(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip) VALUES ($1,$2, now() + ($3 || ' days')::interval, $4, $5)`,
      [userId, this.crypto.sha256(token), String(config.auth.refreshTtlDays), ctx.userAgent?.slice(0, 300) ?? null, ctx.ip ?? null]);
    return token;
  }

  async login(email: string, password: string, ctx: AuditContext) {
    if (!config.auth.localLoginEnabled) throw new BadRequestException('Password sign-in is disabled. Use single sign-on.');
    const u = await this.db.one('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
    const fail = async (why: string) => {
      await this.audit.record({ ...ctx, user: null }, 'auth.login_failed', 'user', u?.id ?? null, { email: email.trim().toLowerCase(), reason: why });
      throw new UnauthorizedException('Email or password is incorrect');
    };
    if (!u || !u.password_hash) return fail('unknown user or SSO-only');
    if (!u.is_active) return fail('suspended');
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new UnauthorizedException(`Too many failed attempts. Try again after ${new Date(u.locked_until).toLocaleTimeString('en-GB')}.`);
    }
    if (!(await bcrypt.compare(password, u.password_hash))) {
      const n = u.failed_logins + 1;
      const lock = n >= config.auth.maxFailedLogins;
      await this.db.exec(`UPDATE users SET failed_logins=$2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE NULL END WHERE id=$1`,
        [u.id, lock ? 0 : n, lock, String(config.auth.lockoutMinutes)]);
      return fail(lock ? 'bad password, account locked' : 'bad password');
    }
    await this.db.exec('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
    const user = (await loadAuthUser(this.db, u.id))!;
    await this.audit.record({ ...ctx, user }, 'auth.login', 'user', u.id, { method: 'password' });
    return { user, mustChangePassword: u.must_change_password, accessToken: this.accessToken(user), refreshToken: await this.issueRefresh(u.id, ctx) };
  }

  /** Rotating refresh tokens: each use revokes the old token; reuse of a revoked token revokes the whole family. */
  async refresh(token: string, ctx: AuditContext) {
    if (!token) throw new UnauthorizedException('No session');
    const row = await this.db.one('SELECT * FROM refresh_tokens WHERE token_hash = $1', [this.crypto.sha256(token)]);
    if (!row) throw new UnauthorizedException('Session not recognised');
    if (row.revoked_at) {
      await this.db.exec('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
      await this.audit.record({ ...ctx, user: null }, 'auth.refresh_reuse_detected', 'user', row.user_id, {});
      throw new UnauthorizedException('Session ended for security reasons. Sign in again.');
    }
    if (new Date(row.expires_at) < new Date()) throw new UnauthorizedException('Session expired');
    const user = await loadAuthUser(this.db, row.user_id);
    if (!user) throw new UnauthorizedException('Account suspended');
    await this.db.exec('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    const mcp = await this.db.one('SELECT must_change_password FROM users WHERE id=$1', [user.id]);
    return { user, mustChangePassword: !!mcp?.must_change_password, accessToken: this.accessToken(user), refreshToken: await this.issueRefresh(user.id, ctx) };
  }

  async logout(token: string | undefined, ctx: AuditContext) {
    if (token) await this.db.exec('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [this.crypto.sha256(token)]);
    if (ctx.user) await this.audit.record(ctx, 'auth.logout', 'user', ctx.user.id, {});
  }

  async changePassword(user: AuthUser, current: string, next: string, ctx: AuditContext) {
    const u = await this.db.one('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!u?.password_hash || !(await bcrypt.compare(current, u.password_hash))) throw new BadRequestException('Current password is incorrect');
    if (!strongPassword(next)) throw new BadRequestException(PASSWORD_RULE);
    await this.db.exec('UPDATE users SET password_hash=$2, must_change_password=false, updated_at=now() WHERE id=$1', [user.id, await bcrypt.hash(next, 12)]);
    await this.db.exec('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    await this.audit.record(ctx, 'auth.password_changed', 'user', user.id, {});
  }

  // ------------------------------------------------------------- OIDC (Entra ID / Keycloak)
  private async oidc() {
    if (!config.auth.oidc.enabled) throw new BadRequestException('Single sign-on is not enabled');
    if (!this.oidcClient) {
      const { Issuer } = await import('openid-client');
      const issuer = await Issuer.discover(config.auth.oidc.issuer);
      this.oidcClient = new issuer.Client({
        client_id: config.auth.oidc.clientId, client_secret: config.auth.oidc.clientSecret,
        redirect_uris: [config.auth.oidc.redirectUri], response_types: ['code'],
      });
    }
    return this.oidcClient;
  }

  async oidcStart() {
    const { generators } = await import('openid-client');
    const client = await this.oidc();
    const state = generators.state(); const nonce = generators.nonce(); const verifier = generators.codeVerifier();
    const url = client.authorizationUrl({
      scope: 'openid profile email', state, nonce,
      code_challenge: generators.codeChallenge(verifier), code_challenge_method: 'S256',
    });
    const handshake = jwt.sign({ state, nonce, verifier }, config.auth.jwtSecret, { expiresIn: 600, audience: 'oidc-handshake' });
    return { url, handshake };
  }

  async oidcCallback(params: Record<string, string>, handshake: string, ctx: AuditContext) {
    let hs: any;
    try { hs = jwt.verify(handshake, config.auth.jwtSecret, { audience: 'oidc-handshake' }); }
    catch { throw new UnauthorizedException('Sign-in took too long or started in another browser. Try again.'); }
    const client = await this.oidc();
    const ts = await client.callback(config.auth.oidc.redirectUri, client.callbackParams({ query: params } as any),
      { state: hs.state, nonce: hs.nonce, code_verifier: hs.verifier });
    const claims = ts.claims();
    const sub = String(claims.oid ?? claims.sub);
    const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? '').toLowerCase();
    const name = String(claims.name ?? email);
    const roleClaim = claims[config.auth.oidc.rolesClaim];
    const claimedRoles: string[] = Array.isArray(roleClaim) ? roleClaim.map(String) : roleClaim ? [String(roleClaim)] : [];
    if (!email) throw new UnauthorizedException('Your identity provider did not return an email address');

    // App roles from Entra (values must equal role keys, e.g. "hr_admin") take precedence; otherwise keep the local role.
    const roleRows = await this.db.many<{ id: string; key: string }>('SELECT id, key FROM roles');
    const order = ['super_admin', 'hr_admin', 'hiring_manager', 'recruiter', 'interview_panel', 'viewer'];
    const mapped = claimedRoles.map((r) => roleRows.find((x) => x.key === r)).filter(Boolean)
      .sort((a, b) => order.indexOf(a!.key) - order.indexOf(b!.key))[0];

    let u = await this.db.one('SELECT * FROM users WHERE (auth_provider=$1 AND external_id=$2) OR lower(email)=$3 ORDER BY external_id NULLS LAST LIMIT 1', ['oidc', sub, email]);
    if (!u) {
      if (!config.auth.oidc.autoProvision) throw new UnauthorizedException('No TalentScreen account exists for you yet. Ask an administrator to add you.');
      const roleId = mapped?.id ?? roleRows.find((r) => r.key === config.auth.oidc.defaultRole)?.id;
      u = await this.db.one(`INSERT INTO users (email, full_name, auth_provider, external_id, role_id) VALUES ($1,$2,'oidc',$3,$4) RETURNING *`, [email, name, sub, roleId]);
      await this.audit.record({ ...ctx, user: null }, 'user.provisioned_sso', 'user', u.id, { email, role: mapped?.key ?? config.auth.oidc.defaultRole });
    } else {
      await this.db.exec(`UPDATE users SET auth_provider='oidc', external_id=$2, full_name=$3, role_id=COALESCE($4, role_id), last_login_at=now() WHERE id=$1`,
        [u.id, sub, name, mapped?.id ?? null]);
    }
    const user = await loadAuthUser(this.db, u.id);
    if (!user) throw new UnauthorizedException('This account is suspended');
    await this.audit.record({ ...ctx, user }, 'auth.login', 'user', user.id, { method: 'oidc', issuer: config.auth.oidc.issuer });
    return { user, refreshToken: await this.issueRefresh(user.id, ctx) };
  }
}
