import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Db, Queryable } from '../common/db.service';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../common/audit.service';
import { NotificationsService } from '../common/notifications.service';
import { QueueService } from '../common/queue.service';
import { JobRequirements, ScoringRules, Thresholds, Weights, LEVELS } from '../common/types';
import { parseCV, publicProfile } from './engine/parser';
import { score } from './engine/scorer';
import { chunkCv } from './engine/rag';
import { Provider, providerReady, runLlm, runNarrative } from './engine/llm';

export interface ScoringConfig { weights: Weights; thresholds: Thresholds; rules: ScoringRules; profileId: string }

@Injectable()
export class EvaluationService {
  private log = new Logger('Evaluation');
  constructor(private db: Db, private crypto: CryptoService, private audit: AuditService,
              private notify: NotificationsService, private queue: QueueService) {}

  async scoringFor(jobId: string, c?: Queryable): Promise<ScoringConfig> {
    const row = await this.db.one(
      `SELECT j.weights_override, sp.id, sp.weights, sp.thresholds, sp.rules
       FROM jobs j JOIN scoring_profiles sp ON sp.id = COALESCE(j.scoring_profile_id, (SELECT id FROM scoring_profiles WHERE is_default))
       WHERE j.id = $1`, [jobId], c);
    if (!row) throw new NotFoundException('Vacancy or scoring profile not found');
    return { weights: row.weights_override ?? row.weights, thresholds: row.thresholds, rules: row.rules, profileId: row.id };
  }

  /** Create a new evaluation version for a candidate and queue it. */
  async request(candidateId: string, userId: string | null, batchId?: string, c?: Queryable): Promise<string> {
    const run = async (q: Queryable) => {
      const cand = await this.db.one('SELECT id, job_id FROM candidates WHERE id = $1 AND erased_at IS NULL', [candidateId], q);
      if (!cand) throw new NotFoundException('Candidate not found');
      await q.query('UPDATE evaluations SET is_current = false WHERE candidate_id = $1 AND is_current', [candidateId]);
      const v = await this.db.one<{ v: number }>('SELECT COALESCE(MAX(version),0)+1 AS v FROM evaluations WHERE candidate_id = $1', [candidateId], q);
      const ev = await this.db.one<{ id: string }>(
        `INSERT INTO evaluations (candidate_id, job_id, version, requested_by, batch_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [candidateId, cand.job_id, v!.v, userId, batchId ?? null], q);
      // an override belongs to the evaluation it overrode
      await q.query('UPDATE recommendation_overrides SET is_active = false WHERE candidate_id = $1 AND is_active', [candidateId]);
      return ev!.id;
    };
    const id = c ? await run(c) : await this.db.tx(run);
    return id;
  }

  async enqueue(evaluationId: string, batchId?: string) {
    await this.queue.enqueueEvaluation({ evaluationId, batchId });
  }

  /** Re-score every live candidate on a vacancy (after requirements or weights change). */
  async rescoreJob(jobId: string, userId: string | null) {
    const cands = await this.db.many<{ id: string }>('SELECT id FROM candidates WHERE job_id = $1 AND erased_at IS NULL', [jobId]);
    const batchId = cands.length ? (await this.db.one<{ id: string }>('SELECT gen_random_uuid() AS id'))!.id : undefined;
    for (const c of cands) {
      const id = await this.request(c.id, userId, batchId);
      await this.enqueue(id, batchId);
    }
    return cands.length;
  }

  /** Worker entry point. Idempotent: a completed evaluation is not processed twice. */
  async process(evaluationId: string): Promise<void> {
    const ev = await this.db.one(
      `UPDATE evaluations SET status = 'running' WHERE id = $1 AND status IN ('pending','failed','running') RETURNING *`, [evaluationId]);
    if (!ev) return;
    try {
      const cand = await this.db.one('SELECT * FROM candidates WHERE id = $1', [ev.candidate_id]);
      const job = await this.db.one('SELECT * FROM jobs WHERE id = $1', [ev.job_id]);
      if (!cand || !job || cand.erased_at) throw new Error('Candidate or vacancy no longer exists');
      const ai = await this.db.one('SELECT * FROM ai_settings WHERE id = 1');
      const cfg = await this.scoringFor(job.id);
      const req: JobRequirements = job.requirements;
      const cvText = this.crypto.decrypt(cand.cv_text_enc);
      const cv = parseCV(cvText);

      const base = { cv, jobTitle: job.title, req, weights: cfg.weights, thresholds: cfg.thresholds, rules: cfg.rules };
      let result = score(base);
      let engine = 'rules'; let model: string | null = null; let narrative: string | null = null;
      let discarded: unknown[] = []; let note: string | null = null;

      const provider = (ai?.provider ?? 'rules') as Provider;
      if (provider !== 'rules') {
        const ready = providerReady(provider);
        if (!ready.ok) note = `AI provider "${provider}" is not configured (${ready.reason}). Rules engine used.`;
        else {
          try {
            const unresolved = result.checks.filter((c) => !c.met).map(({ category, requirement }) => ({ category, requirement }));
            const needRoles = cv.roles.length === 0;
            if (unresolved.length || needRoles) {
              const out = await runLlm({ provider, temperature: Number(ai.temperature), cvText, candidateName: cv.name, chunks: chunkCv(cv),
                unresolved, needRoles, jobTitle: job.title, redactPii: ai.redact_pii });
              result = score({ ...base, model: out.verdicts, modelRoles: out.roles });
              discarded = out.discarded; model = out.model;
            }
            engine = `${provider}+rules`;
            if (ai.generate_narrative) {
              narrative = await runNarrative(provider, Number(ai.temperature), {
                vacancy: job.title, overall: result.overall, recommendation: result.recommendation,
                totalYears: result.totalYears, relevantYears: result.relevantYears,
                qualification: LEVELS[cv.highestLevel] ?? 'not found', components: result.components,
                strengths: result.strengths.map((s) => s.text), gaps: result.gaps.map((g) => g.text), hardRules: result.hardRuleFailures,
              });
            }
          } catch (e) {
            note = `AI provider call failed (${(e as Error).message}). Rules engine result kept.`;
            this.log.warn(note);
          }
        }
      }
      if (!ai?.require_evidence) result.strengths = result.strengths.map(({ evidence, ...s }) => s);

      await this.db.tx(async (q) => {
        await q.query(
          `UPDATE evaluations SET status='completed', engine=$2, model=$3, overall_score=$4, recommendation=$5, component_scores=$6,
             weights=$7, thresholds=$8, total_years=$9, relevant_years=$10, qualification_match=$11, skills_match=$12,
             requirement_checks=$13, strengths=$14, gaps=$15, hard_rule_failures=$16, justification=$17, narrative=$18,
             llm_discarded=$19, error=$20, completed_at=now() WHERE id=$1`,
          [ev.id, engine, model, result.overall, result.recommendation, result.components, cfg.weights, cfg.thresholds,
            result.totalYears, result.relevantYears, result.qualificationMatch, result.skillsMatch, JSON.stringify(result.checks),
            JSON.stringify(result.strengths), JSON.stringify(result.gaps), JSON.stringify(result.hardRuleFailures), result.justification,
            narrative, JSON.stringify(discarded), note]);
        const profile = { ...publicProfile(cv), roles: result.roles.map(({ text, ...r }) => r) };
        const search = [cv.name, ...cv.skills, ...cv.certifications, ...result.roles.map((r) => r.title)].join(' ').toLowerCase().slice(0, 4000);
        await q.query(
          `UPDATE candidates SET profile=$2, search_text=$3, status = CASE WHEN status='new' THEN 'screening' ELSE status END, updated_at=now() WHERE id=$1`,
          [cand.id, profile, search]);
        await this.audit.record({ user: null }, 'evaluation.completed', 'candidate', cand.id,
          { evaluationId: ev.id, version: ev.version, score: result.overall, recommendation: result.recommendation, engine }, q);
      });
      await this.finishBatch(ev.batch_id, job);
    } catch (e) {
      await this.db.exec(`UPDATE evaluations SET status='failed', error=$2 WHERE id=$1`, [evaluationId, (e as Error).message.slice(0, 1000)]);
      this.log.error(`Evaluation ${evaluationId} failed: ${(e as Error).message}`);
      throw e;
    }
  }

  private async finishBatch(batchId: string | null, job: any) {
    if (!batchId) return;
    const r = await this.db.one(
      `SELECT count(*) FILTER (WHERE status IN ('pending','running'))::int AS open,
              count(*) FILTER (WHERE status='completed')::int AS done,
              count(*) FILTER (WHERE recommendation='Shortlist')::int AS sl,
              max(requested_by::text) AS by
       FROM evaluations WHERE batch_id = $1`, [batchId]);
    if (r.open > 0) return;
    // Concurrent workers may both see the batch finish: notify once, under a transaction lock.
    const title = `${r.done} evaluation${r.done === 1 ? '' : 's'} ready: ${job.title}`;
    const body = `${r.sl} recommended for shortlist. Review and confirm before any decision.`;
    const link = `/vacancies/${job.id}/ranking?batch=${batchId}`;
    await this.db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [batchId]);
      const seen = await q.query(`SELECT 1 FROM notifications WHERE type='evaluation.batch' AND link = $1 LIMIT 1`, [link]);
      if (seen.rowCount) return;
      const others = await q.query(
        `SELECT user_id FROM job_assignments WHERE job_id=$1 UNION SELECT hiring_manager_id FROM jobs WHERE id=$1 AND hiring_manager_id IS NOT NULL`, [job.id]);
      await this.notify.toUsers([r.by, ...others.rows.map((o: any) => o.user_id)].filter(Boolean), 'evaluation.batch', title, body, link, q);
    });
  }
}
