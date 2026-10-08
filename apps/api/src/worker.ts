import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config } from './config';
import { WorkerModule } from './app.module';
import { EVALUATE_QUEUE, EvaluateJob, QueueService, RETENTION_QUEUE } from './common/queue.service';
import { EvaluationService } from './evaluation/evaluation.service';
import { Db } from './common/db.service';
import { StorageService } from './common/storage.service';
import { AuditService } from './common/audit.service';

/**
 * Background worker: evaluates queued CVs and runs the nightly data-retention sweep.
 * Scale horizontally by running more replicas; pg-boss hands each job to one worker.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  const log = new Logger('Worker');
  const queue = app.get(QueueService);
  const evals = app.get(EvaluationService);
  const db = app.get(Db); const storage = app.get(StorageService); const audit = app.get(AuditService);

  await queue.boss.work<EvaluateJob>(EVALUATE_QUEUE, { teamSize: config.queue.concurrency, teamConcurrency: config.queue.concurrency }, async (job) => {
    const started = Date.now();
    await evals.process(job.data.evaluationId);
    log.log(`Evaluated ${job.data.evaluationId} in ${Date.now() - started} ms`);
  });

  // Catch evaluations whose queue message was lost (e.g. API crashed between commit and send).
  setInterval(async () => {
    const stuck = await db.many(`SELECT id, batch_id FROM evaluations WHERE status='pending' AND created_at < now() - interval '10 minutes' LIMIT 50`);
    for (const s of stuck) await queue.boss.send(EVALUATE_QUEUE, { evaluationId: s.id, batchId: s.batch_id ?? undefined }, { singletonKey: s.id });
  }, 5 * 60 * 1000).unref();

  // Data retention: erase candidates on closed/filled vacancies older than the configured retention period.
  await queue.boss.schedule(RETENTION_QUEUE, '30 2 * * *', {}, { tz: 'Africa/Lagos' });
  await queue.boss.work(RETENTION_QUEUE, async () => {
    const s = await db.one('SELECT retention_months FROM ai_settings WHERE id=1');
    const due = await db.many(
      `SELECT c.id, c.file_key FROM candidates c JOIN jobs j ON j.id=c.job_id
       WHERE c.erased_at IS NULL AND j.status IN ('closed','filled') AND c.status <> 'hired'
         AND c.created_at < now() - ($1 || ' months')::interval LIMIT 500`, [String(s?.retention_months ?? 24)]);
    for (const c of due) {
      if (c.file_key) await storage.remove(c.file_key).catch(() => undefined);
      await db.exec(`UPDATE candidates SET full_name='Erased candidate', email_enc=NULL, phone_enc=NULL, cv_text_enc=NULL, file_key=NULL, file_name=NULL,
        file_sha256=NULL, profile=NULL, search_text='', erased_at=now() WHERE id=$1`, [c.id]);
      await db.exec(`UPDATE evaluations SET narrative=NULL, llm_discarded=NULL,
        strengths=(SELECT COALESCE(jsonb_agg(x - 'evidence'),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(strengths,'[]'::jsonb)) x),
        requirement_checks=(SELECT COALESCE(jsonb_agg(x - 'evidence'),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(requirement_checks,'[]'::jsonb)) x)
        WHERE candidate_id=$1`, [c.id]);
    }
    if (due.length) await audit.record({ user: null }, 'retention.sweep', null, null, { erased: due.length, months: s?.retention_months });
  });

  log.log(`Worker started (concurrency ${config.queue.concurrency})`);
}
bootstrap();
