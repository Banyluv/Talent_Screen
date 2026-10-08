import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { Response } from 'express';
import { config } from '../config';
import { Ctx, Me, Perms, hasPerm } from '../common/auth';
import { AuditContext, AuditService } from '../common/audit.service';
import { Db } from '../common/db.service';
import { CryptoService } from '../common/crypto.service';
import { StorageService } from '../common/storage.service';
import { assertCandidate, assertJob, candidateScope } from '../common/access';
import { AuthUser, RECOMMENDATIONS } from '../common/types';
import { EvaluationService } from '../evaluation/evaluation.service';
import { CandidatesService, IncomingFile } from './candidates.service';

class PasteDto { @IsString() @MinLength(80) text: string; @IsOptional() @IsString() fileName?: string }
class StatusDto { @IsIn(['new', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn']) status: string; @IsOptional() @IsString() note?: string }
class OverrideDto { @IsIn(RECOMMENDATIONS) recommendation: string; @IsString() @Length(10, 1000) reason: string }
class EraseDto { @IsString() @Length(5, 500) reason: string }

/** Status moves a recruiter may make without workflow.manage. */
const RECRUITER_MOVES = ['new', 'screening', 'interview', 'withdrawn'];

export const EVAL_SUMMARY = `
  e.id AS evaluation_id, e.status AS evaluation_status, e.version, e.overall_score, e.recommendation AS ai_recommendation,
  COALESCE(o.to_rec, e.recommendation) AS recommendation, o.reason AS override_reason, o.created_at AS overridden_at,
  e.total_years, e.relevant_years, e.qualification_match, e.skills_match, e.engine`;

@ApiTags('candidates')
@Controller()
export class CandidatesController {
  constructor(private db: Db, private svc: CandidatesService, private crypto: CryptoService, private storage: StorageService,
              private audit: AuditService, private evals: EvaluationService) {}

  @Post('jobs/:jobId/candidates') @Perms('candidates.upload') @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('files', 200, { limits: { fileSize: 1024 * 1024 * 50 } }))
  async upload(@Param('jobId', ParseUUIDPipe) jobId: string, @UploadedFiles() files: IncomingFile[], @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const job = await assertJob(this.db, me, jobId);
    return this.svc.ingest(job, files ?? [], me, ctx);
  }

  @Post('jobs/:jobId/candidates/text') @Perms('candidates.upload')
  async paste(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() dto: PasteDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const job = await assertJob(this.db, me, jobId);
    const buf = Buffer.from(dto.text, 'utf8');
    return this.svc.ingest(job, [{ originalname: (dto.fileName || 'pasted-cv') + '.txt', mimetype: 'text/plain', buffer: buf, size: buf.length }], me, ctx);
  }

  @Get('candidates') @Perms('candidates.view', 'candidates.view_assigned')
  async list(@Me() me: AuthUser, @Query('jobId') jobId?: string, @Query('q') q?: string, @Query('status') status?: string, @Query('recommendation') rec?: string) {
    return this.db.many(
      `SELECT c.id, c.job_id, j.title AS job_title, c.full_name, c.status, c.file_name, c.created_at, c.source, ${EVAL_SUMMARY}
       FROM candidates c JOIN jobs j ON j.id=c.job_id
       LEFT JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
       LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
       WHERE c.erased_at IS NULL AND ${candidateScope(me)}
         AND ($2::uuid IS NULL OR c.job_id=$2) AND ($3::text IS NULL OR c.search_text % $3 OR c.search_text ILIKE '%'||lower($3)||'%')
         AND ($4::text IS NULL OR c.status=$4) AND ($5::text IS NULL OR COALESCE(o.to_rec, e.recommendation)=$5)
       ORDER BY e.overall_score DESC NULLS LAST, c.created_at DESC LIMIT 1000`,
      [me.id, jobId || null, q?.trim() || null, status || null, rec || null]);
  }

  @Get('candidates/:id') @Perms('candidates.view', 'candidates.view_assigned')
  async get(@Param('id', ParseUUIDPipe) id: string, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const c = await assertCandidate(this.db, me, id);
    const fullAccess = hasPerm(me, 'candidates.view');
    const job = await this.db.one('SELECT id, title, ref_code, requirements FROM jobs WHERE id=$1', [c.job_id]);
    const evaluation = await this.db.one('SELECT * FROM evaluations WHERE candidate_id=$1 AND is_current', [id]);
    const override = await this.db.one(
      `SELECT o.*, u.full_name AS by_name FROM recommendation_overrides o JOIN users u ON u.id=o.user_id WHERE o.candidate_id=$1 AND o.is_active`, [id]);
    const history = fullAccess ? await this.db.many(
      `SELECT e.id, e.version, e.status, e.overall_score, e.recommendation, e.engine, e.created_at, u.full_name AS requested_by
       FROM evaluations e LEFT JOIN users u ON u.id=e.requested_by WHERE e.candidate_id=$1 ORDER BY e.version DESC`, [id]) : [];
    const overrides = fullAccess ? await this.db.many(
      `SELECT o.from_rec, o.to_rec, o.reason, o.is_active, o.created_at, u.full_name AS by_name
       FROM recommendation_overrides o JOIN users u ON u.id=o.user_id WHERE o.candidate_id=$1 ORDER BY o.created_at DESC`, [id]) : [];
    const interviews = await this.db.many(
      `SELECT i.id, i.scheduled_at, i.mode, i.location, i.status,
              COALESCE(json_agg(json_build_object('panelist', u.full_name, 'total', s.total, 'scores', s.scores, 'comments', s.comments)) FILTER (WHERE s.id IS NOT NULL), '[]') AS feedback
       FROM interviews i LEFT JOIN interview_scores s ON s.interview_id=i.id LEFT JOIN users u ON u.id=s.panelist_id
       WHERE i.candidate_id=$1 GROUP BY i.id ORDER BY i.scheduled_at`, [id]);
    const recommendations = await this.db.many(
      `SELECT h.decision, h.justification, h.created_at, u.full_name AS by_name FROM hiring_recommendations h JOIN users u ON u.id=h.user_id WHERE h.candidate_id=$1 ORDER BY h.created_at DESC`, [id]);
    await this.audit.record(ctx, 'candidate.viewed', 'candidate', id, {});
    return {
      id: c.id, fullName: c.full_name, status: c.status, fileName: c.file_name, createdAt: c.created_at, source: c.source,
      email: fullAccess ? this.crypto.decrypt(c.email_enc) : undefined,
      phone: fullAccess ? this.crypto.decrypt(c.phone_enc) : undefined,
      cvText: fullAccess ? this.crypto.decrypt(c.cv_text_enc) : undefined,
      profile: c.profile, job, evaluation, override, history, overrides, interviews, recommendations,
    };
  }

  @Get('candidates/:id/file') @Perms('candidates.view')
  async file(@Param('id', ParseUUIDPipe) id: string, @Me() me: AuthUser, @Ctx() ctx: AuditContext, @Res() res: Response) {
    const c = await assertCandidate(this.db, me, id);
    if (!c.file_key) throw new BadRequestException('No original file stored');
    const buf = await this.storage.get(c.file_key);
    await this.audit.record(ctx, 'candidate.file_downloaded', 'candidate', id, { file: c.file_name });
    res.setHeader('Content-Type', c.file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(c.file_name)}"`);
    res.send(buf);
  }

  @Patch('candidates/:id/status') @Perms('candidates.status', 'workflow.manage')
  async setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    const c = await assertCandidate(this.db, me, id);
    if (!hasPerm(me, 'workflow.manage') && !RECRUITER_MOVES.includes(dto.status)) {
      throw new ForbiddenException('Only HR can move a candidate to shortlisted, offer, hired or rejected');
    }
    await this.db.exec('UPDATE candidates SET status=$2, updated_at=now() WHERE id=$1', [id, dto.status]);
    await this.audit.record(ctx, 'candidate.status_changed', 'candidate', id, { from: c.status, to: dto.status, note: dto.note ?? '' });
    return { ok: true };
  }

  @Post('candidates/:id/evaluate') @Perms('evaluations.run')
  async evaluate(@Param('id', ParseUUIDPipe) id: string, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    await assertCandidate(this.db, me, id);
    const evId = await this.evals.request(id, me.id);
    await this.evals.enqueue(evId);
    await this.audit.record(ctx, 'evaluation.requested', 'candidate', id, { evaluationId: evId });
    return { evaluationId: evId };
  }

  @Post('candidates/:id/override') @Perms('evaluations.override')
  async override(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OverrideDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    await assertCandidate(this.db, me, id);
    const ev = await this.db.one(`SELECT * FROM evaluations WHERE candidate_id=$1 AND is_current AND status='completed'`, [id]);
    if (!ev) throw new BadRequestException('There is no completed evaluation to override yet');
    await this.db.tx(async (q) => {
      await q.query('UPDATE recommendation_overrides SET is_active=false WHERE candidate_id=$1 AND is_active', [id]);
      await q.query(`INSERT INTO recommendation_overrides (candidate_id, evaluation_id, from_rec, to_rec, reason, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, ev.id, ev.recommendation, dto.recommendation, dto.reason.trim(), me.id]);
      await this.audit.record(ctx, 'evaluation.overridden', 'candidate', id, { evaluationId: ev.id, from: ev.recommendation, to: dto.recommendation, reason: dto.reason.trim() }, q);
    });
    return { ok: true };
  }

  @Delete('candidates/:id/override') @HttpCode(204) @Perms('evaluations.override')
  async clearOverride(@Param('id', ParseUUIDPipe) id: string, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    await assertCandidate(this.db, me, id);
    const n = await this.db.exec('UPDATE recommendation_overrides SET is_active=false WHERE candidate_id=$1 AND is_active', [id]);
    if (n) await this.audit.record(ctx, 'evaluation.override_removed', 'candidate', id, {});
  }

  @Post('candidates/:id/erase') @Perms('data.erase')
  async erase(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EraseDto, @Me() me: AuthUser, @Ctx() ctx: AuditContext) {
    await assertCandidate(this.db, me, id);
    await this.svc.erase(id, ctx, dto.reason);
    return { ok: true };
  }

  // ------------------------------------------------------------- ranking & comparison
  @Get('jobs/:jobId/ranking') @Perms('evaluations.view', 'shortlist.review')
  async ranking(@Param('jobId', ParseUUIDPipe) jobId: string, @Me() me: AuthUser) {
    await assertJob(this.db, me, jobId);
    const rows = await this.db.many(
      `SELECT c.id, c.full_name, c.status, ${EVAL_SUMMARY}, e.strengths, e.gaps, e.hard_rule_failures, e.justification
       FROM candidates c JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
       LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
       WHERE c.job_id=$1 AND c.erased_at IS NULL ORDER BY e.status='completed' DESC, e.overall_score DESC NULLS LAST, e.relevant_years DESC NULLS LAST`, [jobId]);
    let rank = 0;
    return rows.map((r) => ({
      ...r, rank: r.evaluation_status === 'completed' ? ++rank : null,
      // lead with distinctive evidence (skills, certifications) rather than baseline facts
      key_strengths: [...(r.strengths ?? [])].sort((a: any, b: any) => +/^(Holds|Evidence|Sector|Clear)/.test(b.text) - +/^(Holds|Evidence|Sector|Clear)/.test(a.text)).slice(0, 3).map((s: any) => s.text),
      key_gaps: (r.gaps ?? []).slice(0, 3).map((g: any) => g.text),
      strengths: undefined, gaps: undefined,
    }));
  }

  @Get('jobs/:jobId/compare') @Perms('evaluations.view', 'shortlist.review')
  async compare(@Param('jobId', ParseUUIDPipe) jobId: string, @Query('ids') ids: string, @Me() me: AuthUser) {
    await assertJob(this.db, me, jobId);
    const list = (ids ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 4);
    if (list.length < 2) throw new BadRequestException('Choose two to four candidates to compare');
    return this.db.many(
      `SELECT c.id, c.full_name, ${EVAL_SUMMARY}, e.component_scores, e.weights, e.requirement_checks, e.strengths, e.gaps, e.hard_rule_failures
       FROM candidates c JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
       LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
       WHERE c.job_id=$1 AND c.id = ANY($2::uuid[]) ORDER BY e.overall_score DESC`, [jobId, list]);
  }
}
