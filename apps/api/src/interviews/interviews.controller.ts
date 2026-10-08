import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Ctx, Me, Perms, hasPerm } from '../common/auth';
import { AuditContext, AuditService } from '../common/audit.service';
import { Db } from '../common/db.service';
import { NotificationsService } from '../common/notifications.service';
import { assertCandidate, jobScope } from '../common/access';
import { AuthUser } from '../common/types';

class ScheduleDto {
  @IsUUID() candidateId: string;
  @IsISO8601() scheduledAt: string;
  @IsOptional() @IsInt() @Min(15) @Max(480) durationMin?: number;
  @IsOptional() @IsString() mode?: string;
  @IsOptional() @IsString() location?: string;
  @IsArray() @ArrayMinSize(1) @IsUUID('all', { each: true }) panelistIds: string[];
}
class UpdateDto { @IsOptional() @IsISO8601() scheduledAt?: string; @IsOptional() @IsIn(['scheduled', 'completed', 'cancelled']) status?: string; @IsOptional() @IsString() location?: string }
class ScoreDto {
  @IsInt() @Min(1) @Max(5) technical: number;
  @IsInt() @Min(1) @Max(5) problemSolving: number;
  @IsInt() @Min(1) @Max(5) communication: number;
  @IsInt() @Min(1) @Max(5) teamFit: number;
  @IsString() @Length(10, 4000) comments: string;
}
class RecommendationDto { @IsIn(['hire', 'hold', 'no_hire']) decision: string; @IsString() @Length(10, 2000) justification: string }

@ApiTags('interviews')
@Controller()
export class InterviewsController {
  constructor(private db: Db, private audit: AuditService, private notify: NotificationsService) {}

  @Get('interviews') @Perms('interviews.view', 'interviews.score', 'interviews.schedule')
  list(@Me() me: AuthUser) {
    const onlyMine = !hasPerm(me, 'interviews.view') && !hasPerm(me, 'interviews.schedule');
    return this.db.many(
      `SELECT i.id, i.candidate_id, c.full_name AS candidate, i.job_id, j.title AS job_title, i.scheduled_at, i.duration_min, i.mode, i.location, i.status,
              json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.full_name, 'scored', s.id IS NOT NULL)) AS panel,
              (SELECT round(avg(total)::numeric,1) FROM interview_scores x WHERE x.interview_id=i.id) AS avg_total,
              (SELECT count(*)::int FROM interview_scores x WHERE x.interview_id=i.id) AS scores_in,
              bool_or(ip.user_id = $1) AS i_am_panelist,
              bool_or(ip.user_id = $1 AND s.id IS NOT NULL) AS i_have_scored,
              (SELECT decision FROM hiring_recommendations h WHERE h.candidate_id=i.candidate_id ORDER BY created_at DESC LIMIT 1) AS latest_recommendation
       FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=i.job_id
       JOIN interview_panelists ip ON ip.interview_id=i.id JOIN users u ON u.id=ip.user_id
       LEFT JOIN interview_scores s ON s.interview_id=i.id AND s.panelist_id=ip.user_id
       WHERE c.erased_at IS NULL AND ${onlyMine ? 'EXISTS (SELECT 1 FROM interview_panelists p2 WHERE p2.interview_id=i.id AND p2.user_id=$1)' : jobScope(me)}
       GROUP BY i.id, c.full_name, j.title ORDER BY i.scheduled_at`, [me.id]);
  }

  @Post('interviews') @Perms('interviews.schedule')
  async schedule(@Body() dto: ScheduleDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const c = await assertCandidate(this.db, me, dto.candidateId);
    const ev = await this.db.one(`SELECT 1 FROM evaluations WHERE candidate_id=$1 AND is_current AND status='completed'`, [c.id]);
    if (!ev) throw new BadRequestException('Wait for the evaluation to finish before scheduling');
    const panel = await this.db.many(`SELECT u.id FROM users u JOIN role_permissions rp ON rp.role_id=u.role_id
      WHERE u.id = ANY($1) AND u.is_active AND rp.permission_key='interviews.score'`, [dto.panelistIds]);
    if (panel.length !== new Set(dto.panelistIds).size) throw new BadRequestException('Every panel member needs an active account with permission to score interviews');
    const id = await this.db.tx(async (q) => {
      const i = await this.db.one(`INSERT INTO interviews (candidate_id, job_id, scheduled_at, duration_min, mode, location, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [c.id, c.job_id, dto.scheduledAt, dto.durationMin ?? 45, dto.mode ?? 'Microsoft Teams', dto.location ?? '', me.id], q);
      await q.query('INSERT INTO interview_panelists SELECT $1, unnest($2::uuid[])', [i.id, [...new Set(dto.panelistIds)]]);
      await q.query(`UPDATE candidates SET status='interview', updated_at=now() WHERE id=$1 AND status IN ('new','screening','shortlisted')`, [c.id]);
      await this.audit.record(ctx, 'interview.scheduled', 'interview', i.id, { candidateId: c.id, at: dto.scheduledAt, panel: dto.panelistIds }, q);
      return i.id;
    });
    const when = new Date(dto.scheduledAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' });
    await this.notify.toUsers(dto.panelistIds, 'interview.assigned', `Interview panel: ${c.full_name}`, `${when} WAT · ${dto.mode ?? 'Microsoft Teams'}`, `/interviews`);
    return { id };
  }

  @Patch('interviews/:id') @Perms('interviews.schedule')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDto, @Ctx() ctx: AuditContext) {
    const n = await this.db.exec(`UPDATE interviews SET scheduled_at=COALESCE($2,scheduled_at), status=COALESCE($3,status), location=COALESCE($4,location) WHERE id=$1`,
      [id, dto.scheduledAt ?? null, dto.status ?? null, dto.location ?? null]);
    if (!n) throw new NotFoundException('Interview not found');
    await this.audit.record(ctx, 'interview.updated', 'interview', id, { ...dto });
    return { ok: true };
  }

  @Post('interviews/:id/scores') @Perms('interviews.score')
  async score(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScoreDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const p = await this.db.one('SELECT i.status FROM interview_panelists ip JOIN interviews i ON i.id=ip.interview_id WHERE ip.interview_id=$1 AND ip.user_id=$2', [id, me.id]);
    if (!p) throw new ForbiddenException('You are not on this interview panel');
    if (p.status === 'cancelled') throw new BadRequestException('This interview was cancelled');
    const scores = { technical: dto.technical, problemSolving: dto.problemSolving, communication: dto.communication, teamFit: dto.teamFit };
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    await this.db.exec(
      `INSERT INTO interview_scores (interview_id, panelist_id, scores, total, comments) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (interview_id, panelist_id) DO UPDATE SET scores=EXCLUDED.scores, total=EXCLUDED.total, comments=EXCLUDED.comments, submitted_at=now()`,
      [id, me.id, scores, total, dto.comments]);
    await this.audit.record(ctx, 'interview.scored', 'interview', id, { total });
    return { total };
  }

  @Post('candidates/:id/recommendations') @Perms('recommendations.create')
  async recommend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecommendationDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const c = await assertCandidate(this.db, me, id);
    await this.db.exec('INSERT INTO hiring_recommendations (candidate_id, user_id, decision, justification) VALUES ($1,$2,$3,$4)', [id, me.id, dto.decision, dto.justification]);
    await this.audit.record(ctx, 'hiring.recommendation', 'candidate', id, { decision: dto.decision });
    await this.notify.toPermission(['workflow.manage'], 'hiring.recommendation',
      `Hiring recommendation for ${c.full_name}: ${dto.decision.replace('_', ' ')}`, `From ${me.name}`, `/candidates/${id}`, me.id);
    return { ok: true };
  }
}
