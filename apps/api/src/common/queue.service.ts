import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { config } from '../config';

export const EVALUATE_QUEUE = 'evaluate-candidate';
export const RETENTION_QUEUE = 'retention-sweep';
export interface EvaluateJob { evaluationId: string; batchId?: string; batchSize?: number; userId?: string }

/**
 * Durable job queue on PostgreSQL (pg-boss) — no extra broker to run.
 * The API enqueues; the worker service consumes. Swap for Azure Service Bus
 * or RabbitMQ behind this class if you outgrow it.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Queue');
  boss = new PgBoss({ connectionString: config.db.url, ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined, schema: 'pgboss' });
  private inlineHandler?: (job: EvaluateJob) => Promise<void>;

  async onModuleInit() {
    this.boss.on('error', (e) => this.log.error(e.message));
    await this.boss.start();
  }
  async onModuleDestroy() { await this.boss.stop({ graceful: true, timeout: 10000 }).catch(() => undefined); }

  /** In EVALUATE_INLINE mode the API registers a handler and runs jobs itself. */
  setInlineHandler(fn: (job: EvaluateJob) => Promise<void>) { this.inlineHandler = fn; }

  async enqueueEvaluation(job: EvaluateJob) {
    if (config.queue.inline && this.inlineHandler) {
      setImmediate(() => this.inlineHandler!(job).catch((e) => this.log.error(e.message)));
      return;
    }
    await this.boss.send(EVALUATE_QUEUE, job, { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInMinutes: 15 });
  }
}
