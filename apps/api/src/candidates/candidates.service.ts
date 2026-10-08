import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '../config';
import { Db } from '../common/db.service';
import { CryptoService } from '../common/crypto.service';
import { StorageService } from '../common/storage.service';
import { AuditContext, AuditService } from '../common/audit.service';
import { AuthUser } from '../common/types';
import { EvaluationService } from '../evaluation/evaluation.service';
import { detectType, extractText, UnreadableCvError } from '../evaluation/engine/extract';
import { parseCV } from '../evaluation/engine/parser';

export interface IncomingFile { originalname: string; mimetype: string; buffer: Buffer; size: number }

@Injectable()
export class CandidatesService {
  constructor(private db: Db, private crypto: CryptoService, private storage: StorageService,
              private audit: AuditService, private evals: EvaluationService) {}

  async ingest(job: any, files: IncomingFile[], me: AuthUser, ctx: AuditContext) {
    if (job.status !== 'open') throw new BadRequestException('CVs can only be added to open vacancies');
    if (!files.length) throw new BadRequestException('Attach at least one CV');
    if (files.length > config.storage.maxBulkFiles) throw new BadRequestException(`Upload at most ${config.storage.maxBulkFiles} files at a time`);
    const batchId = randomUUID();
    const created: { id: string; name: string; file: string }[] = [];
    const skipped: { file: string; reason: string }[] = [];

    for (const f of files) {
      const name = f.originalname.slice(0, 200);
      try {
        if (f.size > config.storage.maxUploadMb * 1024 * 1024) throw new BadRequestException(`Larger than ${config.storage.maxUploadMb} MB`);
        const type = detectType(name, f.mimetype, f.buffer);
        if (!type) throw new BadRequestException('Only PDF, DOCX and TXT files are accepted');
        const text = await extractText(f.buffer, type);
        const sha = this.crypto.sha256(f.buffer);
        const dup = await this.db.one('SELECT id, full_name FROM candidates WHERE job_id=$1 AND file_sha256=$2 AND erased_at IS NULL', [job.id, sha]);
        if (dup) throw new BadRequestException(`Duplicate of ${dup.full_name}'s CV already on this vacancy`);
        const cv = parseCV(text);
        const id = randomUUID();
        const key = `${job.id}/${id}.${type}`;
        await this.storage.put(key, f.buffer);
        const evaluationId = await this.db.tx(async (q) => {
          await q.query(
            `INSERT INTO candidates (id, job_id, full_name, email_enc, phone_enc, file_key, file_name, file_mime, file_sha256, cv_text_enc, search_text, created_by, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [id, job.id, cv.name, this.crypto.encrypt(cv.email), this.crypto.encrypt(cv.phone), key, name, f.mimetype, sha,
              this.crypto.encrypt(text), cv.name.toLowerCase(), me.id, files.length > 1 ? 'bulk-upload' : 'upload']);
          const evId = await this.evals.request(id, me.id, batchId, q);
          await this.audit.record(ctx, 'candidate.uploaded', 'candidate', id, { jobId: job.id, file: name, batchId }, q);
          return evId;
        });
        await this.evals.enqueue(evaluationId, batchId);
        created.push({ id, name: cv.name, file: name });
      } catch (e) {
        const reason = e instanceof UnreadableCvError || e instanceof BadRequestException ? (e as Error).message : `Could not read the file (${(e as Error).message})`;
        skipped.push({ file: name, reason });
      }
    }
    if (files.length > 1) await this.audit.record(ctx, 'candidate.bulk_upload', 'job', job.id, { batchId, received: files.length, created: created.length, skipped: skipped.length });
    return { batchId, created, skipped };
  }

  /** Data-protection erasure: removes personal data, keeps anonymised scores for reporting. */
  async erase(candidateId: string, ctx: AuditContext, reason: string) {
    const c = await this.db.one('SELECT * FROM candidates WHERE id=$1', [candidateId]);
    if (!c || c.erased_at) throw new BadRequestException('Candidate not found or already erased');
    if (c.file_key) await this.storage.remove(c.file_key).catch(() => undefined);
    await this.db.tx(async (q) => {
      await q.query(
        `UPDATE candidates SET full_name='Erased candidate', email_enc=NULL, phone_enc=NULL, cv_text_enc=NULL, file_key=NULL, file_name=NULL,
           file_sha256=NULL, profile=NULL, search_text='', erased_at=now(), updated_at=now() WHERE id=$1`, [candidateId]);
      await q.query(
        `UPDATE evaluations SET narrative=NULL,
           strengths=(SELECT COALESCE(jsonb_agg(s - 'evidence'), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(strengths,'[]'::jsonb)) s),
           requirement_checks=(SELECT COALESCE(jsonb_agg(r - 'evidence'), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(requirement_checks,'[]'::jsonb)) r),
           llm_discarded=NULL
         WHERE candidate_id=$1`, [candidateId]);
      await q.query(`UPDATE interview_scores SET comments='[erased]' WHERE interview_id IN (SELECT id FROM interviews WHERE candidate_id=$1)`, [candidateId]);
      await this.audit.record(ctx, 'candidate.erased', 'candidate', candidateId, { reason }, q);
    });
  }
}
