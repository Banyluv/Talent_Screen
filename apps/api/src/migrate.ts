import 'reflect-metadata';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { config } from './config';
import { createPool } from './common/db.service';
import { DEFAULT_ROLES, PERMISSIONS } from './common/permissions';

const log = new Logger('Migrate');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const SEED_DIR = path.join(__dirname, '..', 'seed');

async function migrate(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(777001)');      // safe if two replicas start at once
      const again = await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (!again.rowCount) {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        log.log(`Applied ${f}`);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
}

/** Reference data. Safe to run on every start: inserts only what is missing. */
async function seedReference(pool: Pool) {
  for (const p of PERMISSIONS) {
    await pool.query(`INSERT INTO permissions (key, category, description) VALUES ($1,$2,$3)
      ON CONFLICT (key) DO UPDATE SET category=EXCLUDED.category, description=EXCLUDED.description`, [p.key, p.category, p.description]);
  }
  for (const r of DEFAULT_ROLES) {
    const ins = await pool.query(`INSERT INTO roles (key, name, description, is_system) VALUES ($1,$2,$3,true) ON CONFLICT (key) DO NOTHING RETURNING id`, [r.key, r.name, r.description]);
    if (ins.rowCount) {  // only grant defaults when the role is first created; admins own them afterwards
      await pool.query('INSERT INTO role_permissions SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [ins.rows[0].id, r.permissions]);
    }
  }
  // Super Administrator always holds every permission, including ones added in later releases.
  await pool.query(`INSERT INTO role_permissions SELECT r.id, p.key FROM roles r CROSS JOIN permissions p WHERE r.key='super_admin' ON CONFLICT DO NOTHING`);

  const org = await pool.query(`INSERT INTO organisations (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [config.bootstrap.organisation]);
  for (const d of ['Information Technology', 'Human Resources', 'Strategic Information', 'Programmes', 'Finance & Administration']) {
    await pool.query('INSERT INTO departments (organisation_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [org.rows[0].id, d]);
  }
  await pool.query(`INSERT INTO scoring_profiles (name, weights, thresholds, rules, is_default)
    SELECT 'Default', $1, $2, $3, true WHERE NOT EXISTS (SELECT 1 FROM scoring_profiles WHERE is_default)`, [
    { qualifications: 20, technical: 30, experience: 30, certifications: 10, preferred: 5, progression: 5 },
    { shortlist: 85, consider: 65, hold: 50 },
    { enforceMinExperience: true, enforceMandatory: true, experienceBasis: 'relevant' }]);
  await pool.query(`INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT DO NOTHING`);

  const admins = await pool.query(`SELECT 1 FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='super_admin' LIMIT 1`);
  if (!admins.rowCount) {
    const generated = !config.bootstrap.adminPassword;
    const pwd = config.bootstrap.adminPassword || randomBytes(12).toString('base64url') + 'A1';
    await pool.query(`INSERT INTO users (email, full_name, password_hash, role_id, must_change_password)
      VALUES ($1,$2,$3,(SELECT id FROM roles WHERE key='super_admin'), $4)`,
      [config.bootstrap.adminEmail.toLowerCase(), config.bootstrap.adminName, await bcrypt.hash(pwd, 12), generated]);
    log.warn(`Created Super Administrator ${config.bootstrap.adminEmail}${generated ? ` with one-time password: ${pwd}  (change it at first sign-in)` : ''}`);
  }
}

/** Optional demonstration data (SEED_DEMO_DATA=true). Every record is clearly fictitious. */
async function seedDemo(pool: Pool) {
  const exists = await pool.query(`SELECT 1 FROM jobs WHERE ref_code LIKE 'DEMO-%' LIMIT 1`);
  if (exists.rowCount) return;
  log.log('Seeding demonstration data');
  const demoPwd = process.env.DEMO_USER_PASSWORD || 'Demo-Password-2026';
  const hash = await bcrypt.hash(demoPwd, 12);
  const dept = async (n: string) => (await pool.query('SELECT id FROM departments WHERE name=$1', [n])).rows[0]?.id;
  const users: Record<string, string> = {};
  for (const [key, email, name, role, d] of [
    ['hr', 'hr.admin@demo.ecews.local', 'Funmilayo Adeyemi', 'hr_admin', 'Human Resources'],
    ['hm', 'hiring.manager@demo.ecews.local', 'Dr. Kelechi Nwosu', 'hiring_manager', 'Strategic Information'],
    ['rec', 'recruiter@demo.ecews.local', 'Bisi Lawal', 'recruiter', 'Human Resources'],
    ['p1', 'panel.it@demo.ecews.local', 'Emeka Obi', 'interview_panel', 'Information Technology'],
    ['p2', 'panel.si@demo.ecews.local', 'Ngozi Ibe', 'interview_panel', 'Strategic Information'],
    ['view', 'viewer@demo.ecews.local', 'Musa Danladi', 'viewer', 'Programmes'],
  ] as const) {
    const r = await pool.query(`INSERT INTO users (email, full_name, password_hash, role_id, department_id) VALUES ($1,$2,$3,(SELECT id FROM roles WHERE key=$4),$5)
      ON CONFLICT DO NOTHING RETURNING id`, [email, name, hash, role, await dept(d)]);
    users[key] = r.rows[0]?.id ?? (await pool.query('SELECT id FROM users WHERE lower(email)=$1', [email])).rows[0].id;
  }
  const jobs = JSON.parse(await fs.readFile(path.join(SEED_DIR, 'demo-jobs.json'), 'utf8'));
  const jobIds: Record<string, string> = {};
  for (const j of jobs) {
    const r = await pool.query(`INSERT INTO jobs (ref_code, title, department_id, location, employment_type, description, status, requirements, hiring_manager_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9) RETURNING id`,
      [j.ref, j.title, await dept(j.department), j.location, j.type, j.description, j.requirements, users.hm, users.hr]);
    jobIds[j.key] = r.rows[0].id;
    await pool.query(`INSERT INTO job_assignments (job_id, user_id, kind) VALUES ($1,$2,'recruiter')`, [r.rows[0].id, users.rec]);
  }
  // CVs go through the real pipeline (encryption, storage, evaluation) via the worker module.
  const { WorkerModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['warn', 'error'] });
  const { CryptoService } = await import('./common/crypto.service');
  const { StorageService } = await import('./common/storage.service');
  const { EvaluationService } = await import('./evaluation/evaluation.service');
  const { parseCV } = await import('./evaluation/engine/parser');
  const crypto = app.get(CryptoService); const storage = app.get(StorageService); const evals = app.get(EvaluationService);
  for (const j of jobs) {
    for (const file of j.cvs as string[]) {
      const buf = await fs.readFile(path.join(SEED_DIR, 'demo-cvs', file));
      const text = buf.toString('utf8'); const cv = parseCV(text); const id = randomUUID();
      const key = `${jobIds[j.key]}/${id}.txt`;
      await storage.put(key, buf);
      await pool.query(`INSERT INTO candidates (id, job_id, full_name, email_enc, phone_enc, file_key, file_name, file_mime, file_sha256, cv_text_enc, search_text, created_by, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'text/plain',$8,$9,$10,$11,'demo')`,
        [id, jobIds[j.key], cv.name, crypto.encrypt(cv.email), crypto.encrypt(cv.phone), key, file, crypto.sha256(buf), crypto.encrypt(text), cv.name.toLowerCase(), users.rec]);
      const ev = await evals.request(id, users.rec);
      await evals.process(ev);
    }
  }
  await app.close();
  log.warn(`Demo users created (password "${demoPwd}"): hr.admin@, hiring.manager@, recruiter@, panel.it@, panel.si@, viewer@ demo.ecews.local`);
}

async function main() {
  const pool = createPool();
  for (let i = 1; ; i++) {      // wait for the database container
    try { await pool.query('SELECT 1'); break; } catch (e) {
      if (i >= 30) throw e;
      log.log(`Waiting for database (${i})…`); await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await migrate(pool);
  await seedReference(pool);
  if (config.bootstrap.seedDemo) await seedDemo(pool);
  await pool.end();
  log.log('Database ready');
  process.exit(0);
}
main().catch((e) => { log.error(e.stack || e.message); process.exit(1); });
