"""Row-level access rules (on top of route permissions).

  - jobs.view_all          → every vacancy
  - jobs.view_assigned     → vacancies where I am hiring manager, requester or an assigned recruiter
  - candidates.view_assigned (panel) → only vacancies/candidates I interview
  - reports.view only (Viewer) → aggregate figures for live vacancies, never candidate detail

Return a SQL predicate over alias `j` (or `c`/`j`); `$1` must be the user id.
"""
from __future__ import annotations

from fastapi import HTTPException

from . import db
from .domain import AuthUser


def job_scope(me: AuthUser) -> str:
    # always references $1 so Postgres can type it
    return f"({_job_scope_raw(me)} AND $1::uuid IS NOT NULL)"


def _job_scope_raw(me: AuthUser) -> str:
    p = me.permissions
    if "jobs.view_all" in p:
        return "TRUE"
    parts: list[str] = []
    if "jobs.view_assigned" in p:
        parts.append(
            "(j.hiring_manager_id = $1 OR j.requested_by = $1 OR EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id = j.id AND a.user_id = $1))"
        )
    if "candidates.view_assigned" in p:
        parts.append(
            "EXISTS (SELECT 1 FROM interviews i JOIN interview_panelists ip ON ip.interview_id = i.id WHERE i.job_id = j.id AND ip.user_id = $1)"
        )
    if "reports.view" in p:
        parts.append("j.status <> 'requested'")
    return f"({' OR '.join(parts)})" if parts else "FALSE"


def candidate_scope(me: AuthUser) -> str:
    """Candidate-level predicate over aliases `c` (candidates) and `j` (jobs); `$1` = user id."""
    return f"({_candidate_scope_raw(me)} AND $1::uuid IS NOT NULL)"


def _candidate_scope_raw(me: AuthUser) -> str:
    p = me.permissions
    if "candidates.view" in p and "jobs.view_all" in p:
        return "TRUE"
    parts: list[str] = []
    if "candidates.view" in p:
        parts.append(
            "(j.hiring_manager_id = $1 OR j.requested_by = $1 OR EXISTS (SELECT 1 FROM job_assignments a WHERE a.job_id = j.id AND a.user_id = $1))"
        )
    if "candidates.view_assigned" in p:
        parts.append(
            "EXISTS (SELECT 1 FROM interviews i JOIN interview_panelists ip ON ip.interview_id = i.id WHERE i.candidate_id = c.id AND ip.user_id = $1)"
        )
    return f"({' OR '.join(parts)})" if parts else "FALSE"


async def assert_job(me: AuthUser, job_id: str, c: db.Conn | None = None) -> dict:
    j = await db.one(
        f"SELECT j.* FROM jobs j WHERE j.id = $2 AND {job_scope(me)}", [me.id, job_id], c
    )
    if not j:
        raise HTTPException(404, detail="Vacancy not found or not available to your role")
    return j


async def assert_candidate(me: AuthUser, candidate_id: str, c: db.Conn | None = None) -> dict:
    cand = await db.one(
        f"SELECT c.* FROM candidates c JOIN jobs j ON j.id = c.job_id WHERE c.id = $2 AND {candidate_scope(me)}",
        [me.id, candidate_id],
        c,
    )
    if not cand:
        raise HTTPException(404, detail="Candidate not found or not available to your role")
    if cand.get("erased_at"):
        raise HTTPException(403, detail="This candidate's personal data has been erased")
    return cand
