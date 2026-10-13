"""Interviews: scheduling, panel management, scoring and hiring recommendations."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, db, notifications
from ..access import assert_candidate, job_scope
from ..deps import audit_context, current_user, require
from ..domain import AuditContext, AuthUser
from ..validation import parse_datetime

router = APIRouter(tags=["interviews"])

WAT = timezone(timedelta(hours=1))  # Africa/Lagos


class ScheduleBody(BaseModel):
    candidateId: UUID
    scheduledAt: str
    durationMin: int | None = Field(default=None, ge=15, le=480)
    mode: str | None = None
    location: str | None = None
    panelistIds: list[UUID] = Field(min_length=1)


class UpdateBody(BaseModel):
    scheduledAt: str | None = None
    status: Literal["scheduled", "completed", "cancelled"] | None = None
    location: str | None = None


class ScoreBody(BaseModel):
    technical: int = Field(ge=1, le=5)
    problemSolving: int = Field(ge=1, le=5)
    communication: int = Field(ge=1, le=5)
    teamFit: int = Field(ge=1, le=5)
    comments: str = Field(min_length=10, max_length=4000)


class RecommendationBody(BaseModel):
    decision: Literal["hire", "hold", "no_hire"]
    justification: str = Field(min_length=10, max_length=2000)


def _wat(moment: datetime) -> datetime:
    """A stored timestamp as Africa/Lagos local time."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(WAT)


def _panel_message(
    job_title: str,
    job_ref: str,
    candidate: str,
    when: datetime,
    duration: int,
    mode: str,
    location: str,
) -> tuple[str, str]:
    """Subject and body the panel receives: the position, date and time.

    The subject is kept ASCII: a non-ASCII character here forces RFC 2047
    encoded-words, which some clients render poorly when the line folds.
    """
    subject = f"Interview panel: {candidate} - {job_title}"
    where = f"{mode} · {location}" if location else mode
    body = "\n".join([
        f"Position: {job_title} ({job_ref})",
        f"Candidate: {candidate}",
        f"Date: {when.strftime('%A %d %B %Y')}",
        f"Time: {when.strftime('%H:%M')} WAT, {duration} minutes",
        f"Mode: {where}",
    ])
    return subject, body


@router.get("/interviews")
async def list_interviews(
    me: AuthUser = Depends(require("interviews.view", "interviews.score", "interviews.schedule")),
):
    only_mine = (
        "interviews.view" not in me.permissions and "interviews.schedule" not in me.permissions
    )
    scope = (
        "EXISTS (SELECT 1 FROM interview_panelists p2 WHERE p2.interview_id=i.id AND p2.user_id=$1)"
        if only_mine
        else job_scope(me)
    )
    return await db.many(
        f"""SELECT i.id, i.candidate_id, c.full_name AS candidate, i.job_id, j.title AS job_title, i.scheduled_at,
                   i.duration_min, i.mode, i.location, i.status,
                   json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.full_name, 'scored', s.id IS NOT NULL)) AS panel,
                   (SELECT round(avg(total)::numeric,1) FROM interview_scores x WHERE x.interview_id=i.id) AS avg_total,
                   (SELECT count(*)::int FROM interview_scores x WHERE x.interview_id=i.id) AS scores_in,
                   bool_or(ip.user_id = $1) AS i_am_panelist,
                   bool_or(ip.user_id = $1 AND s.id IS NOT NULL) AS i_have_scored,
                   (SELECT decision FROM hiring_recommendations h WHERE h.candidate_id=i.candidate_id
                      ORDER BY created_at DESC LIMIT 1) AS latest_recommendation
            FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=i.job_id
            JOIN interview_panelists ip ON ip.interview_id=i.id JOIN users u ON u.id=ip.user_id
            LEFT JOIN interview_scores s ON s.interview_id=i.id AND s.panelist_id=ip.user_id
            WHERE c.erased_at IS NULL AND {scope}
            GROUP BY i.id, c.full_name, j.title ORDER BY i.scheduled_at""",
        [me.id],
    )


@router.post("/interviews")
async def schedule(
    body: ScheduleBody,
    me: AuthUser = Depends(require("interviews.schedule")),
    ctx: AuditContext = Depends(audit_context),
):
    cand = await assert_candidate(me, str(body.candidateId))
    ev = await db.one(
        "SELECT 1 FROM evaluations WHERE candidate_id=$1 AND is_current AND status='completed'",
        [str(cand["id"])],
    )
    if not ev:
        raise HTTPException(400, detail="Wait for the evaluation to finish before scheduling")

    panelist_ids = [str(x) for x in body.panelistIds]
    unique_ids = list(dict.fromkeys(panelist_ids))
    panel = await db.many(
        """SELECT u.id FROM users u JOIN role_permissions rp ON rp.role_id=u.role_id
           WHERE u.id = ANY($1::uuid[]) AND u.is_active AND rp.permission_key='interviews.score'""",
        [unique_ids],
    )
    if len(panel) != len(unique_ids):
        raise HTTPException(
            400, detail="Every panel member needs an active account with permission to score interviews"
        )

    async def run(q: db.Conn) -> str:
        new_id = await db.value(
            """INSERT INTO interviews (candidate_id, job_id, scheduled_at, duration_min, mode, location, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
            [
                str(cand["id"]), str(cand["job_id"]), parse_datetime(body.scheduledAt),
                body.durationMin or 45, body.mode or "Microsoft Teams", body.location or "", me.id,
            ],
            q,
        )
        await q.exec(
            "INSERT INTO interview_panelists SELECT $1, unnest($2::uuid[])", [str(new_id), unique_ids]
        )
        await q.exec(
            """UPDATE candidates SET status='interview', updated_at=now()
               WHERE id=$1 AND status IN ('new','screening','shortlisted')""",
            [str(cand["id"])],
        )
        await audit.record(
            ctx, "interview.scheduled", "interview", str(new_id),
            {"candidateId": str(cand["id"]), "at": body.scheduledAt, "panel": panelist_ids}, q,
        )
        return str(new_id)

    interview_id = await db.tx(run)
    job = await db.one("SELECT title, ref_code FROM jobs WHERE id=$1", [str(cand["job_id"])])
    subject, message = _panel_message(
        (job or {}).get("title") or "", (job or {}).get("ref_code") or "",
        cand["full_name"], _wat(parse_datetime(body.scheduledAt)),
        body.durationMin or 45, body.mode or "Microsoft Teams", body.location or "",
    )
    await notifications.to_users(unique_ids, "interview.assigned", subject, message, "/interviews")
    return {"id": interview_id}


class PanelistsBody(BaseModel):
    panelistIds: list[UUID] = Field(min_length=1)


async def _panel_interview(interview_id: str) -> dict:
    """The interview plus the labels the panel email needs."""
    row = await db.one(
        """SELECT i.*, c.full_name AS candidate, j.title AS job_title, j.ref_code AS job_ref
           FROM interviews i JOIN candidates c ON c.id=i.candidate_id JOIN jobs j ON j.id=i.job_id
           WHERE i.id=$1""",
        [interview_id],
    )
    if not row:
        raise HTTPException(404, detail="Interview not found")
    return row


async def _panel_of(interview_id: str) -> list[dict]:
    return await db.many(
        """SELECT u.id, u.full_name AS name, (s.id IS NOT NULL) AS scored
           FROM interview_panelists ip JOIN users u ON u.id=ip.user_id
           LEFT JOIN interview_scores s ON s.interview_id=ip.interview_id AND s.panelist_id=ip.user_id
           WHERE ip.interview_id=$1 ORDER BY u.full_name""",
        [interview_id],
    )


async def _score_eligible(user_ids: list[str]) -> list[str]:
    """Keep only active users whose role may score interviews."""
    rows = await db.many(
        """SELECT u.id FROM users u JOIN role_permissions rp ON rp.role_id=u.role_id
           WHERE u.id = ANY($1::uuid[]) AND u.is_active AND rp.permission_key='interviews.score'""",
        [user_ids],
    )
    return [str(r["id"]) for r in rows]


async def _mail_panel(interview: dict, user_ids: list[str]) -> None:
    subject, message = _panel_message(
        interview["job_title"], interview["job_ref"], interview["candidate"],
        _wat(interview["scheduled_at"]), interview["duration_min"],
        interview["mode"], interview["location"] or "",
    )
    await notifications.to_users(user_ids, "interview.assigned", subject, message, "/interviews")


@router.put("/interviews/{interview_id}/panelists")
async def set_panel(
    interview_id: UUID,
    body: PanelistsBody,
    me: AuthUser = Depends(require("interviews.schedule")),
    ctx: AuditContext = Depends(audit_context),
):
    """Replace the interview panel.

    Everything is validated before anything is written, so a rejected change
    leaves the panel untouched. Added members are emailed the position, date and
    time; removed members are told they are no longer on the panel.
    """
    iid = str(interview_id)
    interview = await _panel_interview(iid)
    if interview["status"] == "cancelled":
        raise HTTPException(400, detail="This interview was cancelled")

    wanted = list(dict.fromkeys(str(x) for x in body.panelistIds))
    current = {str(p["id"]): p for p in await _panel_of(iid)}
    removed = [uid for uid in current if uid not in wanted]
    added = [uid for uid in wanted if uid not in current]

    scored = [current[uid]["name"] for uid in removed if current[uid]["scored"]]
    if scored:
        raise HTTPException(
            400,
            detail=f"{', '.join(scored)} already scored this interview, which is part of the record. "
                   "Cancel the interview and schedule another instead.",
        )
    if len(await _score_eligible(wanted)) != len(wanted):
        raise HTTPException(
            400, detail="Every panel member needs an active account with permission to score interviews"
        )

    if added or removed:
        async def run(q: db.Conn) -> None:
            if removed:
                await q.exec(
                    "DELETE FROM interview_panelists WHERE interview_id=$1 AND user_id = ANY($2::uuid[])",
                    [iid, removed],
                )
            if added:
                await q.exec(
                    "INSERT INTO interview_panelists SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
                    [iid, added],
                )
            await audit.record(
                ctx, "interview.panel_changed", "interview", iid,
                {"added": added, "removed": removed}, q,
            )

        await db.tx(run)
        if added:
            await _mail_panel(interview, added)
        for uid in removed:
            await notifications.to_users(
                [uid], "interview.removed",
                f"Removed from the panel: {interview['candidate']} - {interview['job_title']}",
                f"You are no longer on the panel for {interview['job_title']} "
                f"({interview['job_ref']}) on "
                f"{_wat(interview['scheduled_at']).strftime('%d %b %Y at %H:%M')} WAT.",
                "/interviews",
            )

    return {"panel": await _panel_of(iid), "added": added, "removed": removed}


@router.patch("/interviews/{interview_id}")
async def update_interview(
    interview_id: UUID,
    body: UpdateBody,
    me: AuthUser = Depends(require("interviews.schedule")),
    ctx: AuditContext = Depends(audit_context),
):
    iid = str(interview_id)
    n = await db.execute(
        """UPDATE interviews SET scheduled_at=COALESCE($2,scheduled_at), status=COALESCE($3,status),
             location=COALESCE($4,location) WHERE id=$1""",
        [iid, parse_datetime(body.scheduledAt), body.status, body.location],
    )
    if not n:
        raise HTTPException(404, detail="Interview not found")
    await audit.record(ctx, "interview.updated", "interview", iid, body.model_dump(exclude_none=True))
    return {"ok": True}


@router.post("/interviews/{interview_id}/scores")
async def score(
    interview_id: UUID,
    body: ScoreBody,
    me: AuthUser = Depends(require("interviews.score")),
    ctx: AuditContext = Depends(audit_context),
):
    iid = str(interview_id)
    p = await db.one(
        """SELECT i.status FROM interview_panelists ip JOIN interviews i ON i.id=ip.interview_id
           WHERE ip.interview_id=$1 AND ip.user_id=$2""",
        [iid, me.id],
    )
    if not p:
        raise HTTPException(403, detail="You are not on this interview panel")
    if p["status"] == "cancelled":
        raise HTTPException(400, detail="This interview was cancelled")
    scores = {
        "technical": body.technical,
        "problemSolving": body.problemSolving,
        "communication": body.communication,
        "teamFit": body.teamFit,
    }
    total = sum(scores.values())
    await db.execute(
        """INSERT INTO interview_scores (interview_id, panelist_id, scores, total, comments)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (interview_id, panelist_id) DO UPDATE
             SET scores=EXCLUDED.scores, total=EXCLUDED.total, comments=EXCLUDED.comments, submitted_at=now()""",
        [iid, me.id, scores, total, body.comments],
    )
    await audit.record(ctx, "interview.scored", "interview", iid, {"total": total})
    return {"total": total}


@router.post("/candidates/{candidate_id}/recommendations")
async def recommend(
    candidate_id: UUID,
    body: RecommendationBody,
    me: AuthUser = Depends(require("recommendations.create")),
    ctx: AuditContext = Depends(audit_context),
):
    cid = str(candidate_id)
    cand = await assert_candidate(me, cid)
    await db.execute(
        """INSERT INTO hiring_recommendations (candidate_id, user_id, decision, justification)
           VALUES ($1,$2,$3,$4)""",
        [cid, me.id, body.decision, body.justification],
    )
    await audit.record(ctx, "hiring.recommendation", "candidate", cid, {"decision": body.decision})
    await notifications.to_permission(
        ["workflow.manage"], "hiring.recommendation",
        f"Hiring recommendation for {cand['full_name']}: {body.decision.replace('_', ' ')}",
        f"From {me.name}", f"/candidates/{cid}", me.id,
    )
    return {"ok": True}
