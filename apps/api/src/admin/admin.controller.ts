import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import bcrypt from 'bcryptjs';
import { Ctx, Me, Perms } from '../common/auth';
import { AuditContext, AuditService } from '../common/audit.service';
import { Db } from '../common/db.service';
import { CryptoService } from '../common/crypto.service';
import { PERMISSIONS } from '../common/permissions';
import { AuthUser, WEIGHT_KEYS } from '../common/types';
import { PASSWORD_RULE, strongPassword } from '../auth/auth.service';
import { EvaluationService } from '../evaluation/evaluation.service';
import { providerReady } from '../evaluation/engine/llm';

class CreateUserDto {
  @IsEmail() email: string;
  @IsString() @Length(2, 120) fullName: string;
  @IsString() roleKey: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() password?: string;   // omit for SSO-only accounts
}
class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 120) fullName?: string;
  @IsOptional() @IsString() roleKey?: string;
  @IsOptional() @IsUUID() departmentId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class ResetPasswordDto { @IsString() password: string }
class RoleDto {
  @IsString() @Length(2, 40) key: string;
  @IsString() @Length(2, 80) name: string;
  @IsOptional() @IsString() description?: string;
  @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[];
}
class RolePermsDto { @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[]; @IsOptional() @IsString() name?: string; @IsOptional() @IsString() description?: string }
class NameDto { @IsString() @Length(2, 120) name: string; @IsOptional() @IsUUID() organisationId?: string }
class ScoringDto {
  @IsOptional() @IsString() name?: string;
  @IsObject() weights: Record<string, number>;
  @IsObject() thresholds: { shortlist: number; consider: number; hold: number };
  @IsObject() rules: { enforceMinExperience: boolean; enforceMandatory: boolean; experienceBasis: 'relevant' | 'total' };
  @IsOptional() @IsBoolean() rescore?: boolean;
}
class AiDto {
  @IsIn(['rules', 'azure-openai', 'openai']) provider: string;
  @IsNumber() @Min(0) @Max(1) temperature: number;
  @IsBoolean() requireEvidence: boolean;
  @IsBoolean() redactPii: boolean;
  @IsBoolean() generateNarrative: boolean;
  @IsInt() @Min(1) @Max(120) retentionMonths: number;
}

export function validateScoring(dto: ScoringDto) {
  const w = dto.weights;
  for (const k of WEIGHT_KEYS) if (typeof w[k] !== 'number' || w[k] < 0) throw new BadRequestException(`Weight "${k}" must be a number of 0 or more`);
  const sum = WEIGHT_KEYS.reduce((s, k) => s + w[k], 0);
  if (sum !== 100) throw new BadRequestException(`Weights total ${sum}%. They must total 100%.`);
  const t = dto.thresholds;
  if (!(t.shortlist > t.consider && t.consider > t.hold && t.hold >= 0 && t.shortlist <= 100)) {
    throw new BadRequestException('Thresholds must descend: Shortlist > Consider > Hold, all between 0 and 100');
  }
  if (!['relevant', 'total'].includes(dto.rules.experienceBasis)) throw new BadRequestException('experienceBasis must be "relevant" or "total"');
}

@ApiTags('administration')
@Controller()
export class AdminController {
  constructor(private db: Db, private audit: AuditService, private evals: EvaluationService, private crypto: CryptoService) {}

  // ------------------------------------------------------------- users
  @Get('users') @Perms('users.manage', 'interviews.schedule', 'jobs.create', 'jobs.approve')
  async users(@Me() me: AuthUser) {
    const full = me.permissions.includes('users.manage');
    const rows = await this.db.many(
      `SELECT u.id, u.email, u.full_name, u.auth_provider, u.is_active, u.last_login_at, u.created_at, u.locked_until,
              r.key AS role_key, r.name AS role_name, d.id AS department_id, d.name AS department
       FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN departments d ON d.id=u.department_id ORDER BY u.full_name`);
    // non-admins only need a directory for pickers (panel members, recruiters)
    return full ? rows : rows.filter((r) => r.is_active).map(({ id, full_name, role_key, role_name, department }) => ({ id, full_name, role_key, role_name, department }));
  }

  @Post('users') @Perms('users.manage')
  async createUser(@Body() dto: CreateUserDto, @Ctx() ctx: AuditContext) {
    const role = await this.db.one('SELECT id, name FROM roles WHERE key=$1', [dto.roleKey]);
    if (!role) throw new BadRequestException('Unknown role');
    if (dto.password && !strongPassword(dto.password)) throw new BadRequestException(PASSWORD_RULE);
    const exists = await this.db.one('SELECT 1 FROM users WHERE lower(email)=lower($1)', [dto.email]);
    if (exists) throw new BadRequestException('A user with this email already exists');
    const u = await this.db.one(
      `INSERT INTO users (email, full_name, password_hash, auth_provider, role_id, department_id, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [dto.email.toLowerCase(), dto.fullName, dto.password ? await bcrypt.hash(dto.password, 12) : null,
        dto.password ? 'local' : 'oidc', role.id, dto.departmentId ?? null, !!dto.password]);
    await this.audit.record(ctx, 'user.created', 'user', u.id, { email: dto.email.toLowerCase(), role: dto.roleKey });
    return { id: u.id };
  }

  @Patch('users/:id') @Perms('users.manage')
  async updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const u = await this.db.one('SELECT u.*, r.key AS role_key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1', [id]);
    if (!u) throw new NotFoundException('User not found');
    if (id === me.id && (dto.roleKey || dto.isActive === false)) throw new BadRequestException('You cannot change your own role or suspend yourself');
    let roleId = u.role_id;
    if (dto.roleKey) {
      const r = await this.db.one('SELECT id FROM roles WHERE key=$1', [dto.roleKey]);
      if (!r) throw new BadRequestException('Unknown role');
      roleId = r.id;
    }
    // keep at least one active Super Administrator
    if ((u.role_key === 'super_admin') && (dto.roleKey && dto.roleKey !== 'super_admin' || dto.isActive === false)) {
      const n = await this.db.one(`SELECT count(*)::int n FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='super_admin' AND u.is_active`);
      if (n.n <= 1) throw new BadRequestException('At least one active Super Administrator is required');
    }
    await this.db.exec(
      `UPDATE users SET full_name=COALESCE($2, full_name), role_id=$3, department_id=CASE WHEN $4::boolean THEN $5::uuid ELSE department_id END,
         is_active=COALESCE($6, is_active), updated_at=now() WHERE id=$1`,
      [id, dto.fullName ?? null, roleId, dto.departmentId !== undefined, dto.departmentId ?? null, dto.isActive ?? null]);
    if (dto.isActive === false) await this.db.exec('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    await this.audit.record(ctx, 'user.updated', 'user', id, { changes: dto, previousRole: u.role_key });
    return { ok: true };
  }

  @Post('users/:id/reset-password') @HttpCode(204) @Perms('users.manage')
  async resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto, @Ctx() ctx: AuditContext) {
    if (!strongPassword(dto.password)) throw new BadRequestException(PASSWORD_RULE);
    const n = await this.db.exec(`UPDATE users SET password_hash=$2, auth_provider='local', must_change_password=true, failed_logins=0, locked_until=NULL WHERE id=$1`,
      [id, await bcrypt.hash(dto.password, 12)]);
    if (!n) throw new NotFoundException('User not found');
    await this.db.exec('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    await this.audit.record(ctx, 'user.password_reset', 'user', id, {});
  }

  // ------------------------------------------------------------- roles & permissions
  @Get('permissions') @Perms('roles.manage', 'users.manage')
  permissions() { return PERMISSIONS; }

  @Get('roles') @Perms('roles.manage', 'users.manage')
  roles() {
    return this.db.many(
      `SELECT r.id, r.key, r.name, r.description, r.is_system,
              COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions,
              (SELECT count(*)::int FROM users u WHERE u.role_id=r.id) AS user_count
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY r.id
       ORDER BY COALESCE(array_position(ARRAY['super_admin','hr_admin','hiring_manager','recruiter','interview_panel','viewer'], r.key), 99), r.name`);
  }

  @Post('roles') @Perms('roles.manage')
  async createRole(@Body() dto: RoleDto, @Ctx() ctx: AuditContext) {
    if (!/^[a-z][a-z0-9_]+$/.test(dto.key)) throw new BadRequestException('Role key must be lower-case letters, digits and underscores');
    this.checkPerms(dto.permissions);
    const id = await this.db.tx(async (q) => {
      const r = await this.db.one('INSERT INTO roles (key, name, description) VALUES ($1,$2,$3) RETURNING id', [dto.key, dto.name, dto.description ?? ''], q);
      await q.query('INSERT INTO role_permissions SELECT $1, unnest($2::text[])', [r.id, dto.permissions]);
      return r.id;
    });
    await this.audit.record(ctx, 'role.created', 'role', id, { key: dto.key, permissions: dto.permissions });
    return { id };
  }

  @Put('roles/:key') @Perms('roles.manage')
  async updateRole(@Param('key') key: string, @Body() dto: RolePermsDto, @Ctx() ctx: AuditContext) {
    this.checkPerms(dto.permissions);
    const role = await this.db.one('SELECT * FROM roles WHERE key=$1', [key]);
    if (!role) throw new NotFoundException('Role not found');
    if (key === 'super_admin' && !['users.manage', 'roles.manage'].every((p) => dto.permissions.includes(p))) {
      throw new BadRequestException('Super Administrator must keep users.manage and roles.manage');
    }
    const before = await this.db.many('SELECT permission_key FROM role_permissions WHERE role_id=$1', [role.id]);
    await this.db.tx(async (q) => {
      await q.query('UPDATE roles SET name=COALESCE($2,name), description=COALESCE($3,description) WHERE id=$1', [role.id, dto.name ?? null, dto.description ?? null]);
      await q.query('DELETE FROM role_permissions WHERE role_id=$1', [role.id]);
      if (dto.permissions.length) await q.query('INSERT INTO role_permissions SELECT $1, unnest($2::text[])', [role.id, dto.permissions]);
    });
    const b = before.map((x) => x.permission_key);
    await this.audit.record(ctx, 'role.permissions_changed', 'role', role.id, {
      key, added: dto.permissions.filter((p) => !b.includes(p)), removed: b.filter((p) => !dto.permissions.includes(p)) });
    return { ok: true };
  }

  @Delete('roles/:key') @HttpCode(204) @Perms('roles.manage')
  async deleteRole(@Param('key') key: string, @Ctx() ctx: AuditContext) {
    const role = await this.db.one('SELECT r.*, (SELECT count(*)::int FROM users WHERE role_id=r.id) n FROM roles r WHERE key=$1', [key]);
    if (!role) throw new NotFoundException('Role not found');
    if (role.is_system) throw new BadRequestException('Built-in roles cannot be deleted');
    if (role.n) throw new BadRequestException(`Move the ${role.n} user(s) on this role first`);
    await this.db.exec('DELETE FROM roles WHERE id=$1', [role.id]);
    await this.audit.record(ctx, 'role.deleted', 'role', role.id, { key });
  }

  private checkPerms(p: string[]) {
    const known = new Set(PERMISSIONS.map((x) => x.key));
    const bad = p.filter((x) => !known.has(x));
    if (bad.length) throw new BadRequestException(`Unknown permission(s): ${bad.join(', ')}`);
  }

  // ------------------------------------------------------------- organisations & departments
  @Get('departments')
  departments() {
    return this.db.many(`SELECT d.id, d.name, o.id AS organisation_id, o.name AS organisation FROM departments d JOIN organisations o ON o.id=d.organisation_id ORDER BY o.name, d.name`);
  }
  @Get('organisations') @Perms('org.manage')
  organisations() { return this.db.many('SELECT * FROM organisations ORDER BY name'); }

  @Post('organisations') @Perms('org.manage')
  async createOrg(@Body() dto: NameDto, @Ctx() ctx: AuditContext) {
    const o = await this.db.one('INSERT INTO organisations (name) VALUES ($1) RETURNING id', [dto.name]);
    await this.audit.record(ctx, 'organisation.created', 'organisation', o.id, { name: dto.name });
    return o;
  }
  @Post('departments') @Perms('org.manage')
  async createDept(@Body() dto: NameDto, @Ctx() ctx: AuditContext) {
    const org = dto.organisationId ?? (await this.db.one('SELECT id FROM organisations ORDER BY created_at LIMIT 1'))?.id;
    if (!org) throw new BadRequestException('Create an organisation first');
    const d = await this.db.one('INSERT INTO departments (organisation_id, name) VALUES ($1,$2) RETURNING id', [org, dto.name]);
    await this.audit.record(ctx, 'department.created', 'department', d.id, { name: dto.name });
    return d;
  }

  // ------------------------------------------------------------- scoring configuration
  @Get('settings/scoring') @Perms('scoring.configure', 'jobs.create', 'jobs.edit')
  scoringProfiles() { return this.db.many('SELECT * FROM scoring_profiles ORDER BY is_default DESC, name'); }

  @Put('settings/scoring/default') @Perms('scoring.configure')
  async updateDefaultScoring(@Body() dto: ScoringDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    validateScoring(dto);
    const before = await this.db.one('SELECT * FROM scoring_profiles WHERE is_default');
    await this.db.exec(`UPDATE scoring_profiles SET weights=$2, thresholds=$3, rules=$4, updated_by=$5, updated_at=now() WHERE id=$1`,
      [before.id, dto.weights, dto.thresholds, dto.rules, me.id]);
    await this.audit.record(ctx, 'scoring.updated', 'scoring_profile', before.id,
      { before: { weights: before.weights, thresholds: before.thresholds, rules: before.rules }, after: { weights: dto.weights, thresholds: dto.thresholds, rules: dto.rules } });
    let requeued = 0;
    if (dto.rescore) {
      const jobs = await this.db.many(`SELECT id FROM jobs WHERE status IN ('open','closed') AND (scoring_profile_id IS NULL OR scoring_profile_id=$1)`, [before.id]);
      for (const j of jobs) requeued += await this.evals.rescoreJob(j.id, me.id);
    }
    return { ok: true, requeued };
  }

  @Get('settings/ai') @Perms('ai.configure', 'scoring.configure')
  async aiSettings() {
    const s = await this.db.one('SELECT * FROM ai_settings WHERE id=1');
    return { ...s, status: { 'azure-openai': providerReady('azure-openai'), openai: providerReady('openai'), rules: { ok: true } } };
  }

  @Put('settings/ai') @Perms('ai.configure')
  async updateAi(@Body() dto: AiDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const ready = providerReady(dto.provider as any);
    if (!ready.ok) throw new BadRequestException(`${dto.provider} is not configured on the server: ${ready.reason}`);
    await this.db.exec(
      `UPDATE ai_settings SET provider=$1, temperature=$2, require_evidence=$3, redact_pii=$4, generate_narrative=$5, retention_months=$6, updated_by=$7, updated_at=now() WHERE id=1`,
      [dto.provider, dto.temperature, dto.requireEvidence, dto.redactPii, dto.generateNarrative, dto.retentionMonths, me.id]);
    await this.audit.record(ctx, 'ai_settings.updated', 'ai_settings', '1', { ...dto });
    return { ok: true };
  }

  // ------------------------------------------------------------- audit
  @Get('audit') @Perms('audit.view')
  async auditLog(@Query('q') q?: string, @Query('action') action?: string, @Query('limit') limit = '200', @Query('before') before?: string) {
    return this.db.many(
      `SELECT id, at, actor_email, actor_role, action, entity_type, entity_id, details, ip FROM audit_logs
       WHERE ($1::text IS NULL OR action ILIKE '%'||$1||'%' OR actor_email ILIKE '%'||$1||'%' OR details::text ILIKE '%'||$1||'%')
         AND ($2::text IS NULL OR action LIKE $2||'%') AND ($3::bigint IS NULL OR id < $3)
       ORDER BY id DESC LIMIT $4`, [q || null, action || null, before || null, Math.min(+limit || 200, 1000)]);
  }
  @Get('audit/verify') @Perms('audit.view')
  verify() { return this.audit.verify(); }

  // ------------------------------------------------------------- notifications
  @Get('notifications')
  notifications(@Me() me: AuthUser) {
    return this.db.many(`SELECT * FROM notifications WHERE user_id=$1 AND type <> 'evaluation.batch.marker' ORDER BY created_at DESC LIMIT 100`, [me.id]);
  }
  @Post('notifications/read') @HttpCode(204)
  async markRead(@Me() me: AuthUser, @Body() body: { ids?: string[] }) {
    await this.db.exec(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))`, [me.id, body?.ids ?? null]);
  }
}
