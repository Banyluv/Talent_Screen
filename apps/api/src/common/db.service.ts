import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

export type Queryable = Pick<PoolClient, 'query'>;

export function createPool() {
  return new Pool({
    connectionString: config.db.url,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
    max: config.db.poolMax,
  });
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = createPool();

  async many<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], c?: Queryable): Promise<T[]> {
    const r = await (c ?? this.pool).query<T>(sql, params as any[]);
    return r.rows;
  }
  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], c?: Queryable): Promise<T | null> {
    const rows = await this.many<T>(sql, params, c);
    return rows[0] ?? null;
  }
  async exec(sql: string, params: unknown[] = [], c?: Queryable): Promise<number> {
    const r = await (c ?? this.pool).query(sql, params as any[]);
    return r.rowCount ?? 0;
  }
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy() { await this.pool.end(); }
}
