import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Db } from './db.service';
import { AuthUser } from './types';

/**
 * Row-level access rules (on top of route permissions).
 *  - jobs.view_all          → every vacancy
 *  - jobs.view_assigned     → vacancies where I am hiring manager, requester or an assigned recruiter
 *  - candidates.view_assigned (panel) → only vacancies/candidates I interview
 *  - reports.view only (Viewer) → aggregate figures for live vacancies, never candidate detail
 * Returns a SQL predicate over alias `j`; `$1` must be the user id.
 */
export function jobScope(me: AuthUser): string {
  return `(${jobScopeRaw(me)} AND $1::uuid IS NOT NULL)`; // always references $1 so Postgres can type it
}
function jobScopeRaw(me: AuthUser): string {
  const p = me.permissions;
  if (p.includes('jobs.view_all')) return 'TRUE';
  const parts: string[] = [];
  if (p.includes('jobs.view_assigned')) {
    parts.push(`(j.hiring_manager_id = $1 OR j.requested_by = $1 OR EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id = j.id AND a.user_id = $1))`);
  }
  if (p.includes('candidates.view_assigned')) {
    parts.push(`EXISTS (SELECT 1 FROM interviews i JOIN interview_panelists ip ON ip.interview_id = i.id WHERE i.job_id = j.id AND ip.user_id = $1)`);
  }
  if (p.includes('reports.view')) parts.push(`j.status <> 'requested'`);
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

/** Candidate-level predicate over aliases `c` (candidates) and `j` (jobs); `$1` = user id. */
export function candidateScope(me: AuthUser): string {
  return `(${candidateScopeRaw(me)} AND $1::uuid IS NOT NULL)`;
}
function candidateScopeRaw(me: AuthUser): string {
  const p = me.permissions;
  if (p.includes('candidates.view') && p.includes('jobs.view_all')) return 'TRUE';
  const parts: string[] = [];
  if (p.includes('candidates.view')) {
    parts.push(`(j.hiring_manager_id = $1 OR j.requested_by = $1 OR EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id = j.id AND a.user_id = $1))`);
  }
  if (p.includes('candidates.view_assigned')) {
    parts.push(`EXISTS (SELECT 1 FROM interviews i JOIN interview_panelists ip ON ip.interview_id = i.id WHERE i.candidate_id = c.id AND ip.user_id = $1)`);
  }
  return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
}

export async function assertJob(db: Db, me: AuthUser, jobId: string) {
  const j = await db.one(`SELECT j.* FROM jobs j WHERE j.id = $2 AND ${jobScope(me)}`, [me.id, jobId]);
  if (!j) throw new NotFoundException('Vacancy not found or not available to your role');
  return j;
}

export async function assertCandidate(db: Db, me: AuthUser, candidateId: string) {
  const c = await db.one(`SELECT c.* FROM candidates c JOIN jobs j ON j.id = c.job_id WHERE c.id = $2 AND ${candidateScope(me)}`, [me.id, candidateId]);
  if (!c) throw new NotFoundException('Candidate not found or not available to your role');
  if (c.erased_at) throw new ForbiddenException('This candidate\'s personal data has been erased');
  return c;
}
