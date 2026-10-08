import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Ctx, Me, Perms, hasPerm } from '../common/auth';
import { AuditContext, AuditService } from '../common/audit.service';
import { Db } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { assertJob, jobScope } from '../common/access';
import { AuthUser, JobRequirements, WEIGHT_KEYS } from '../common/types';
import { EvaluationService } from '../evaluation/evaluation.service';

class JobDto {
  @IsString() @Length(3, 160) title: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsIn(['Full-time', 'Part-time', 'Contract', 'Consultancy', 'Internship', 'Temporary']) employmentType?: string;
  @IsOptional() @IsString() description?: string;
  @IsObject() requirements: Partial<JobRequirements>;
  @IsOptional() @IsObject() weightsOverride?: Record<string, number> | null;
  @IsOptional() @IsUUID() hiringManagerId?: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) recruiterIds?: string[];
  @IsOptional() @IsString() closesOn?: string;
}
class StatusDto { @IsIn(['open', 'closed', 'filled', 'draft']) status: string }
class DecisionDto { @IsIn(['approve', 'reject']) decision: string; @IsOptional() @IsString() note?: string }

const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]/) : [])
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 60);

export function normaliseRequirements(r: Partial<JobRequirements>): JobRequirements {
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const req: JobRequirements = {
    minQualificationLevel: n(r.minQualificationLevel, 3),
    fieldsOfStudy: list(r.fieldsOfStudy).map((s) => s.toLowerCase()),
    requiredQualifications: list(r.requiredQualifications),
    preferredQualifications: list(r.preferredQualifications),
    requiredCertifications: list(r.requiredCertifications),
    technicalSkills: list(r.technicalSkills),
    softSkills: list(r.softSkills),
    preferredSkills: list(r.preferredSkills),
    minYears: n(r.minYears, 0),
    preferredYears: n(r.preferredYears, n(r.minYears, 0)),
    industryExperience: list(r.industryExperience),
    locationRequirements: String(r.locationRequirements ?? ''),
    mandatory: list(r.mandatory),
    niceToHave: list(r.niceToHave),
  };
  if (![1, 2, 3, 3.5, 4, 5].includes(req.minQualificationLevel)) throw new BadRequestException('Unknown qualification level');
  if (req.minYears < 0 || req.minYears > 40 || req.preferredYears < req.minYears) throw new BadRequestException('Preferred years must be at least the minimum years');
  if (!req.technicalSkills.length) throw new BadRequestException('Add at least one required technical skill');
  return req;
}

function checkWeights(w?: Record<string, number> | null) {
  if (!w) return;
  const sum = WEIGHT_KEYS.reduce((s, k) => s + (Number(w[k]) || 0), 0);
  if (sum !== 100) throw new BadRequestException(`Weights total ${sum}%. They must total 100%.`);
}

@ApiTags('vacancies')
@Controller('jobs')
export class JobsController {
  constructor(private db: Db, private audit: AuditService, private evals: EvaluationService, private notify: NotificationsService) {}

  @Get()
  async list(@Me() me: AuthUser) {
    return this.db.many(
      `SELECT j.id, j.ref_code, j.title, j.location, j.employment_type, j.status, j.created_at, j.closes_on,
              d.name AS department, hm.full_name AS hiring_manager, rq.full_name AS requested_by_name,
              (SELECT count(*)::int FROM candidates c WHERE c.job_id=j.id AND c.erased_at IS NULL) AS applicants,
              (SELECT count(*)::int FROM evaluations e LEFT JOIN recommendation_overrides o ON o.candidate_id=e.candidate_id AND o.is_active
                 WHERE e.job_id=j.id AND e.is_current AND COALESCE(o.to_rec, e.recommendation)='Shortlist') AS shortlisted,
              (SELECT count(*)::int FROM evaluations e WHERE e.job_id=j.id AND e.is_current AND e.status IN ('pending','running')) AS evaluating
       FROM jobs j LEFT JOIN departments d ON d.id=j.department_id LEFT JOIN users hm ON hm.id=j.hiring_manager_id LEFT JOIN users rq ON rq.id=j.requested_by
       WHERE ${jobScope(me)} ORDER BY (j.status='requested') DESC, (j.status='open') DESC, j.created_at DESC`, [me.id]);
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string, @Me() me: AuthUser) {
    const j = await assertJob(this.db, me, id);
    const recruiters = await this.db.many(`SELECT u.id, u.full_name FROM job_assignments a JOIN users u ON u.id=a.user_id WHERE a.job_id=$1 AND a.kind='recruiter'`, [id]);
    const scoring = await this.evals.scoringFor(id);
    return { ...j, recruiters, effectiveWeights: scoring.weights, thresholds: scoring.thresholds, rules: scoring.rules };
  }

  @Post() @Perms('jobs.create', 'hiring_requests.create')
  async create(@Body() dto: JobDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const isRequest = !hasPerm(me, 'jobs.create');
    const req = normaliseRequirements(dto.requirements);
    checkWeights(dto.weightsOverride);
    const id = await this.db.tx(async (q) => {
      const seq = await this.db.one(`SELECT count(*)::int + 1 AS n FROM jobs`, [], q);
      const ref = `ECEWS-${new Date().getFullYear()}-${String(seq.n).padStart(3, '0')}`;
      const j = await this.db.one(
        `INSERT INTO jobs (ref_code, title, department_id, location, employment_type, description, status, requirements, weights_override,
                           hiring_manager_id, requested_by, created_by, closes_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [ref, dto.title, dto.departmentId ?? null, dto.location ?? '', dto.employmentType ?? 'Full-time', dto.description ?? '',
          isRequest ? 'requested' : 'open', req, dto.weightsOverride ?? null,
          isRequest ? me.id : dto.hiringManagerId ?? null, isRequest ? me.id : null, me.id, dto.closesOn || null], q);
      if (!isRequest && dto.recruiterIds?.length) {
        await q.query(`INSERT INTO job_assignments (job_id, user_id, kind) SELECT $1, unnest($2::uuid[]), 'recruiter' ON CONFLICT DO NOTHING`, [j.id, dto.recruiterIds]);
      }
      await this.audit.record(ctx, isRequest ? 'job.requested' : 'job.created', 'job', j.id, { ref, title: dto.title }, q);
      return j.id;
    });
    if (isRequest) await this.notify.toPermission(['jobs.approve'], 'job.requested', `Hiring request: ${dto.title}`, `Raised by ${me.name}`, `/vacancies/${id}`, me.id);
    else if (dto.recruiterIds?.length) await this.notify.toUsers(dto.recruiterIds, 'job.assigned', `You were assigned to ${dto.title}`, '', `/vacancies/${id}`);
    return { id };
  }

  @Put(':id') @Perms('jobs.edit')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: JobDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const before = await assertJob(this.db, me, id);
    const req = normaliseRequirements(dto.requirements);
    checkWeights(dto.weightsOverride);
    await this.db.tx(async (q) => {
      await q.query(
        `UPDATE jobs SET title=$2, department_id=$3, location=$4, employment_type=$5, description=$6, requirements=$7, weights_override=$8,
           hiring_manager_id=$9, closes_on=$10, updated_at=now() WHERE id=$1`,
        [id, dto.title, dto.departmentId ?? null, dto.location ?? '', dto.employmentType ?? 'Full-time', dto.description ?? '', req,
          dto.weightsOverride ?? null, dto.hiringManagerId ?? before.hiring_manager_id, dto.closesOn || null]);
      if (dto.recruiterIds) {
        await q.query(`DELETE FROM job_assignments WHERE job_id=$1 AND kind='recruiter'`, [id]);
        if (dto.recruiterIds.length) await q.query(`INSERT INTO job_assignments (job_id, user_id, kind) SELECT $1, unnest($2::uuid[]), 'recruiter'`, [id, dto.recruiterIds]);
      }
      await this.audit.record(ctx, 'job.updated', 'job', id, { title: dto.title, requirementsChanged: JSON.stringify(before.requirements) !== JSON.stringify(req) }, q);
    });
    const changed = JSON.stringify(before.requirements) !== JSON.stringify(req) || JSON.stringify(before.weights_override) !== JSON.stringify(dto.weightsOverride ?? null) || before.title !== dto.title;
    const requeued = changed ? await this.evals.rescoreJob(id, me.id) : 0;
    return { ok: true, requeued };
  }

  @Post(':id/decision') @Perms('jobs.approve')
  async decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const j = await this.db.one(`SELECT * FROM jobs WHERE id=$1 AND status='requested'`, [id]);
    if (!j) throw new NotFoundException('No pending hiring request with this id');
    const status = dto.decision === 'approve' ? 'open' : 'rejected';
    await this.db.exec('UPDATE jobs SET status=$2, approved_by=$3, updated_at=now() WHERE id=$1', [id, status, me.id]);
    await this.audit.record(ctx, `job.request_${dto.decision === 'approve' ? 'approved' : 'rejected'}`, 'job', id, { note: dto.note ?? '' });
    await this.notify.toUsers([j.requested_by], 'job.decision', `Hiring request ${dto.decision === 'approve' ? 'approved' : 'declined'}: ${j.title}`, dto.note ?? '', `/vacancies/${id}`);
    return { status };
  }

  @Patch(':id/status') @Perms('jobs.edit', 'workflow.manage')
  async status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const j = await assertJob(this.db, me, id);
    if (j.status === 'requested') throw new BadRequestException('Approve the hiring request first');
    await this.db.exec('UPDATE jobs SET status=$2, updated_at=now() WHERE id=$1', [id, dto.status]);
    await this.audit.record(ctx, 'job.status_changed', 'job', id, { from: j.status, to: dto.status });
    return { ok: true };
  }

  @Post(':id/rescore') @Perms('evaluations.run')
  async rescore(@Param('id', ParseUUIDPipe) id: string, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    await assertJob(this.db, me, id);
    const n = await this.evals.rescoreJob(id, me.id);
    await this.audit.record(ctx, 'job.rescored', 'job', id, { candidates: n });
    return { requeued: n };
  }
}
