"""Candidates: upload, browse, status, evaluation, override, erasure, ranking and comparison."""
from __future__ import annotations

from typing import Any, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field

from .. import audit, crypto, db, storage
from ..access import assert_candidate, assert_job, candidate_scope
from ..deps import audit_context, current_user, require
from ..domain import RECOMMENDATIONS, AuditContext, AuthUser
from ..services import candidates as candidates_service
from ..services.evaluation import service as evaluations

router = APIRouter(tags=["candidates"])

EVAL_SUMMARY = """
  e.id AS evaluation_id, e.status AS evaluation_status, e.version, e.overall_score, e.recommendation AS ai_recommendation,
  COALESCE(o.to_rec, e.recommendation) AS recommendation, o.reason AS override_reason, o.created_at AS overridden_at,
  e.total_years, e.relevant_years, e.qualification_match, e.skills_match, e.engine"""

# Status moves a recruiter may make without workflow.manage.
RECRUITER_MOVES = ["new", "screening", "interview", "withdrawn"]


class PasteBody(BaseModel):
    text: str = Field(min_length=80)
    fileName: str | None = None


class StatusBody(BaseModel):
    status: Literal[
        "new", "screening", "shortlisted", "interview", "offer", "hired", "rejected", "withdrawn"
    ]
    note: str | None = None


class OverrideBody(BaseModel):
    recommendation: Literal["Shortlist", "Consider", "Hold", "Reject"]
    reason: str = Field(min_length=10, max_length=1000)


class EraseBody(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


@router.post("/jobs/{job_id}/candidates")
async def upload(
    job_id: UUID,
    files: list[UploadFile] = File(default_factory=list),
    me: AuthUser = Depends(require("candidates.upload")),
    ctx: AuditContext = Depends(audit_context),
):
    job = await assert_job(me, str(job_id))
    incoming: list[dict[str, Any]] = []
    for f in files:
        data = await f.read()
        incoming.append({
            "originalname": f.filename or "",
            "mimetype": f.content_type or "",
            "buffer": data,
            "size": len(data),
        })
    return await candidates_service.ingest(job, incoming, me, ctx)


@router.post("/jobs/{job_id}/candidates/text")
async def paste(
    job_id: UUID,
    body: PasteBody,
    me: AuthUser = Depends(require("candidates.upload")),
    ctx: AuditContext = Depends(audit_context),
):
    job = await assert_job(me, str(job_id))
    data = body.text.encode("utf-8")
    incoming = [{
        "originalname": (body.fileName or "pasted-cv") + ".txt",
        "mimetype": "text/plain",
        "buffer": data,
        "size": len(data),
    }]
    return await candidates_service.ingest(job, incoming, me, ctx)


@router.get("/candidates")
async def list_candidates(
    jobId: str | None = Query(default=None),
    q: str | None = Query(default=None),
    status: str | None = Query(default=None),
    recommendation: str | None = Query(default=None),
    me: AuthUser = Depends(require("candidates.view", "candidates.view_assigned")),
):
    return await db.many(
        f"""SELECT c.id, c.job_id, j.title AS job_title, c.full_name, c.status, c.file_name, c.created_at,
                   c.source, {EVAL_SUMMARY}
            FROM candidates c JOIN jobs j ON j.id=c.job_id
            LEFT JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
            LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
            WHERE c.erased_at IS NULL AND {candidate_scope(me)}
              AND ($2::uuid IS NULL OR c.job_id=$2)
              AND ($3::text IS NULL OR c.search_text % $3 OR c.search_text ILIKE '%'||lower($3)||'%')
              AND ($4::text IS NULL OR c.status=$4)
              AND ($5::text IS NULL OR COALESCE(o.to_rec, e.recommendation)=$5)
            ORDER BY e.overall_score DESC NULLS LAST, c.created_at DESC LIMIT 1000""",
        [me.id, jobId or None, (q or "").strip() or None, status or None, recommendation or None],
    )


@router.get("/candidates/{candidate_id}")
async def get_candidate(
    candidate_id: UUID,
    me: AuthUser = Depends(require("candidates.view", "candidates.view_assigned")),
    ctx: AuditContext = Depends(audit_context),
):
    cid = str(candidate_id)
    c = await assert_candidate(me, cid)
    full_access = "candidates.view" in me.permissions
    job = await db.one("SELECT id, title, ref_code, requirements FROM jobs WHERE id=$1", [c["job_id"]])
    evaluation = await db.one("SELECT * FROM evaluations WHERE candidate_id=$1 AND is_current", [cid])
    override = await db.one(
        """SELECT o.*, u.full_name AS by_name FROM recommendation_overrides o JOIN users u ON u.id=o.user_id
           WHERE o.candidate_id=$1 AND o.is_active""",
        [cid],
    )
    history = await db.many(
        """SELECT e.id, e.version, e.status, e.overall_score, e.recommendation, e.engine, e.created_at,
                  u.full_name AS requested_by
           FROM evaluations e LEFT JOIN users u ON u.id=e.requested_by
           WHERE e.candidate_id=$1 ORDER BY e.version DESC""",
        [cid],
    ) if full_access else []
    overrides = await db.many(
        """SELECT o.from_rec, o.to_rec, o.reason, o.is_active, o.created_at, u.full_name AS by_name
           FROM recommendation_overrides o JOIN users u ON u.id=o.user_id
           WHERE o.candidate_id=$1 ORDER BY o.created_at DESC""",
        [cid],
    ) if full_access else []
    interviews = await db.many(
        """SELECT i.id, i.scheduled_at, i.mode, i.location, i.status,
                  COALESCE(json_agg(json_build_object('panelist', u.full_name, 'total', s.total, 'scores', s.scores, 'comments', s.comments))
                     FILTER (WHERE s.id IS NOT NULL), '[]') AS feedback
           FROM interviews i LEFT JOIN interview_scores s ON s.interview_id=i.id
           LEFT JOIN users u ON u.id=s.panelist_id
           WHERE i.candidate_id=$1 GROUP BY i.id ORDER BY i.scheduled_at""",
        [cid],
    )
    recommendations = await db.many(
        """SELECT h.decision, h.justification, h.created_at, u.full_name AS by_name
           FROM hiring_recommendations h JOIN users u ON u.id=h.user_id
           WHERE h.candidate_id=$1 ORDER BY h.created_at DESC""",
        [cid],
    )
    await audit.record(ctx, "candidate.viewed", "candidate", cid, {})

    out: dict[str, Any] = {
        "id": str(c["id"]),
        "fullName": c["full_name"],
        "status": c["status"],
        "fileName": c["file_name"],
        "createdAt": c["created_at"],
        "source": c["source"],
        "profile": c["profile"],
        "job": job,
        "evaluation": evaluation,
        "override": override,
        "history": history,
        "overrides": overrides,
        "interviews": interviews,
        "recommendations": recommendations,
    }
    if full_access:
        out["email"] = crypto.decrypt(c["email_enc"])
        out["phone"] = crypto.decrypt(c["phone_enc"])
        out["cvText"] = crypto.decrypt(c["cv_text_enc"])
    return out


@router.get("/candidates/{candidate_id}/file")
async def candidate_file(
    candidate_id: UUID,
    me: AuthUser = Depends(require("candidates.view")),
    ctx: AuditContext = Depends(audit_context),
):
    cid = str(candidate_id)
    c = await assert_candidate(me, cid)
    if not c.get("file_key"):
        raise HTTPException(400, detail="No original file stored")
    store = await storage.get()
    buf = await store.get(c["file_key"])
    await audit.record(ctx, "candidate.file_downloaded", "candidate", cid, {"file": c["file_name"]})
    return Response(
        content=buf,
        media_type=c.get("file_mime") or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{quote(c["file_name"] or "cv", safe="")}"'},
    )


@router.patch("/candidates/{candidate_id}/status")
async def set_status(
    candidate_id: UUID,
    body: StatusBody,
    me: AuthUser = Depends(require("candidates.status", "workflow.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    cid = str(candidate_id)
    c = await assert_candidate(me, cid)
    if "workflow.manage" not in me.permissions and body.status not in RECRUITER_MOVES:
        raise HTTPException(403, detail="Only HR can move a candidate to shortlisted, offer, hired or rejected")
    await db.execute("UPDATE candidates SET status=$2, updated_at=now() WHERE id=$1", [cid, body.status])
    await audit.record(
        ctx, "candidate.status_changed", "candidate", cid,
        {"from": c["status"], "to": body.status, "note": body.note or ""},
    )
    return {"ok": True}


@router.post("/candidates/{candidate_id}/evaluate")
async def evaluate(
    candidate_id: UUID,
    me: AuthUser = Depends(require("evaluations.run")),
    ctx: AuditContext = Depends(audit_context),
):
    cid = str(candidate_id)
    await assert_candidate(me, cid)
    ev_id = await evaluations.request(cid, me.id)
    await evaluations.enqueue(ev_id)
    await audit.record(ctx, "evaluation.requested", "candidate", cid, {"evaluationId": ev_id})
    return {"evaluationId": ev_id}


@router.post("/candidates/{candidate_id}/override")
async def override(
    candidate_id: UUID,
    body: OverrideBody,
    me: AuthUser = Depends(require("evaluations.override")),
    ctx: AuditContext = Depends(audit_context),
):
    cid = str(candidate_id)
    await assert_candidate(me, cid)
    ev = await db.one(
        "SELECT * FROM evaluations WHERE candidate_id=$1 AND is_current AND status='completed'", [cid]
    )
    if not ev:
        raise HTTPException(400, detail="There is no completed evaluation to override yet")

    async def run(q: db.Conn) -> None:
        await q.exec("UPDATE recommendation_overrides SET is_active=false WHERE candidate_id=$1 AND is_active", [cid])
        await q.exec(
            """INSERT INTO recommendation_overrides (candidate_id, evaluation_id, from_rec, to_rec, reason, user_id)
               VALUES ($1,$2,$3,$4,$5,$6)""",
            [cid, ev["id"], ev["recommendation"], body.recommendation, body.reason.strip(), me.id],
        )
        await audit.record(
            ctx, "evaluation.overridden", "candidate", cid,
            {
                "evaluationId": str(ev["id"]),
                "from": ev["recommendation"],
                "to": body.recommendation,
                "reason": body.reason.strip(),
            },
            q,
        )

    await db.tx(run)
    return {"ok": True}


@router.delete("/candidates/{candidate_id}/override", status_code=204)
async def clear_override(
    candidate_id: UUID,
    me: AuthUser = Depends(require("evaluations.override")),
    ctx: AuditContext = Depends(audit_context),
) -> Response:
    cid = str(candidate_id)
    await assert_candidate(me, cid)
    n = await db.execute("UPDATE recommendation_overrides SET is_active=false WHERE candidate_id=$1 AND is_active", [cid])
    if n:
        await audit.record(ctx, "evaluation.override_removed", "candidate", cid, {})
    return Response(status_code=204)


@router.post("/candidates/{candidate_id}/erase")
async def erase(
    candidate_id: UUID,
    body: EraseBody,
    me: AuthUser = Depends(require("data.erase")),
    ctx: AuditContext = Depends(audit_context),
):
    cid = str(candidate_id)
    await assert_candidate(me, cid)
    await candidates_service.erase(cid, ctx, body.reason)
    return {"ok": True}


# ------------------------------------------------------------- ranking & comparison


@router.get("/jobs/{job_id}/ranking")
async def ranking(
    job_id: UUID,
    me: AuthUser = Depends(require("evaluations.view", "shortlist.review")),
):
    jid = str(job_id)
    await assert_job(me, jid)
    rows = await db.many(
        f"""SELECT c.id, c.full_name, c.status, {EVAL_SUMMARY}, e.strengths, e.gaps, e.hard_rule_failures, e.justification
            FROM candidates c JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
            LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
            WHERE c.job_id=$1 AND c.erased_at IS NULL
            ORDER BY e.status='completed' DESC, e.overall_score DESC NULLS LAST, e.relevant_years DESC NULLS LAST""",
        [jid],
    )
    import re

    distinctive = re.compile(r"^(Holds|Evidence|Sector|Clear)")
    severity_rank = {"critical": 0, "moderate": 1, "minor": 2}
    rank = 0
    out = []
    for r in rows:
        if r["evaluation_status"] == "completed":
            rank += 1
            r["rank"] = rank
        else:
            r["rank"] = None
        strengths = list(r.get("strengths") or [])
        # lead with distinctive evidence (skills, certifications) rather than baseline facts
        strengths.sort(key=lambda s: 0 if distinctive.match(s.get("text") or "") else 1)
        r["key_strengths"] = [s.get("text") for s in strengths[:3]]
        r["key_gaps"] = [g.get("text") for g in sorted((r.get("gaps") or []), key=lambda g: severity_rank.get(g.get("severity"), 1))[:3]]
        r.pop("strengths", None)
        r.pop("gaps", None)
        out.append(r)
    return out


@router.get("/jobs/{job_id}/compare")
async def compare(
    job_id: UUID,
    ids: str = Query(default=""),
    me: AuthUser = Depends(require("evaluations.view", "shortlist.review")),
):
    jid = str(job_id)
    await assert_job(me, jid)
    import re

    selected = [x for x in (ids or "").split(",") if re.fullmatch(r"[0-9a-fA-F-]{36}", x)][:4]
    if len(selected) < 2:
        raise HTTPException(400, detail="Choose two to four candidates to compare")
    return await db.many(
        f"""SELECT c.id, c.full_name, {EVAL_SUMMARY}, e.component_scores, e.weights, e.requirement_checks,
                   e.strengths, e.gaps, e.hard_rule_failures
            FROM candidates c JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
            LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
            WHERE c.job_id=$1 AND c.id = ANY($2::uuid[]) ORDER BY e.overall_score DESC""",
        [jid, selected],
    )
