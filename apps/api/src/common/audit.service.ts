import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Db, Queryable } from './db.service';
import { AuthUser } from './types';

/** Stable JSON (sorted keys) so hashes survive jsonb key re-ordering. */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon((v as any)[k])).join(',') + '}';
}

export interface AuditContext { user?: AuthUser | null; ip?: string; userAgent?: string }

/**
 * Append-only, hash-chained audit trail. The table rejects UPDATE/DELETE/TRUNCATE
 * at the database level; each row also stores the hash of the previous row so
 * tampering by a DB superuser is detectable (GET /api/audit/verify).
 */
@Injectable()
export class AuditService {
  private log = new Logger('Audit');
  constructor(private db: Db) {}

  async record(ctx: AuditContext, action: string, entityType: string | null, entityId: string | null, details: Record<string, unknown> = {}, c?: Queryable) {
    try {
      const run = async (q: Queryable) => {
        // serialise writers so the hash chain is linear
        await q.query('SELECT pg_advisory_xact_lock(424242)');
        const prev = await q.query('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
        const prevHash: string | null = prev.rows[0]?.hash ?? null;
        const at = new Date().toISOString();
        const payload = canon([at, ctx.user?.id ?? null, action, entityType, entityId, details, prevHash]);
        const hash = createHash('sha256').update(payload).digest('hex');
        await q.query(
          `INSERT INTO audit_logs (at, actor_id, actor_email, actor_role, action, entity_type, entity_id, details, ip, user_agent, prev_hash, hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [at, ctx.user?.id ?? null, ctx.user?.email ?? 'system', ctx.user?.roleName ?? 'System', action, entityType, entityId,
            JSON.stringify(details), ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null, prevHash, hash],
        );
      };
      if (c) await run(c); else await this.db.tx(run);
    } catch (e) {
      // Never let auditing silently disappear: surface loudly, but don't break the user action.
      this.log.error(`Failed to write audit entry "${action}": ${(e as Error).message}`);
      if (c) throw e;
    }
  }

  async verify(): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
    const rows = await this.db.many('SELECT id, at, actor_id, action, entity_type, entity_id, details, prev_hash, hash FROM audit_logs ORDER BY id');
    let prev: string | null = null;
    for (const r of rows) {
      const payload = canon([new Date(r.at).toISOString(), r.actor_id, r.action, r.entity_type, r.entity_id, r.details, r.prev_hash]);
      const h = createHash('sha256').update(payload).digest('hex');
      if (r.prev_hash !== prev || h !== r.hash) return { ok: false, checked: rows.length, brokenAt: Number(r.id) };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length };
  }
}
