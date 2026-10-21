"""Internal review of applicant-portal applications (view and status moves)."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from .. import audit, db
from ..deps import audit_context, require
from ..domain import AuditContext, AuthUser

router = APIRouter(prefix="/applications", tags=["applications"])

APPLICATION_STATUSES = [
    "submitted", "under_review", "shortlisted", "interview", "offer", "hired", "rejected", "withdrawn",
]


class StatusBody(BaseModel):
    status: Literal[
        "submitted", "under_review", "shortlisted", "interview", "offer", "hired", "rejected", "withdrawn"
    ]
    note: str | None = None


@router.get("")
async def list_applications(
    jobId: str | None = Query(default=None),
    status: str | None = Query(default=None),
    me: AuthUser = Depends(require("candidates.view", "candidates.view_assigned")),
):
    params: list = []
    where = ["TRUE"]
    if jobId:
        params.append(jobId)
        where.append(f"ap.job_id = ${len(params)}")
    if status:
        params.append(status)
        where.append(f"ap.status = ${len(params)}")
    return await db.many(
        f"""SELECT ap.id, ap.status, ap.cover_letter, ap.cv_file_name, ap.notes, ap.created_at, ap.updated_at,
                   ap.candidate_id,
                   a.id AS applicant_id, a.full_name, a.email, a.phone, a.headline, a.summary, a.location, a.skills,
                   j.id AS job_id, j.title, j.ref_code, d.name AS department,
                   c.status AS candidate_status,
                   e.status AS evaluation_status, e.overall_score, e.recommendation AS ai_recommendation, e.relevant_years, e.engine,
                   COALESCE(o.to_rec, e.recommendation) AS recommendation
            FROM applications ap
            JOIN applicants a ON a.id = ap.applicant_id
            JOIN jobs j ON j.id = ap.job_id
            LEFT JOIN departments d ON d.id = j.department_id
            LEFT JOIN candidates c ON c.id = ap.candidate_id
            LEFT JOIN evaluations e ON e.candidate_id = c.id AND e.is_current
            LEFT JOIN recommendation_overrides o ON o.candidate_id = c.id AND o.is_active
            WHERE {' AND '.join(where)} ORDER BY ap.created_at DESC LIMIT 500""",
        params,
    )


class ShortlistBody(BaseModel):
    reason: str | None = None


@router.post("/{application_id}/shortlist")
async def shortlist(
    application_id: UUID,
    body: ShortlistBody,
    me: AuthUser = Depends(require("evaluations.override", "shortlist.review", "workflow.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    """Move an applicant's CV to the interview shortlist: set the candidate status
    and, when the engine recommended otherwise, record a Shortlist override."""
    row = await db.one(
        """SELECT ap.id, ap.candidate_id, ap.job_id, e.id AS evaluation_id, e.recommendation
           FROM applications ap
           LEFT JOIN evaluations e ON e.candidate_id = ap.candidate_id AND e.is_current AND e.status='completed'
           WHERE ap.id = $1""",
        [str(application_id)],
    )
    if not row or not row["candidate_id"]:
        raise HTTPException(400, detail="No CV is attached to this application to shortlist")
    if not row["evaluation_id"]:
        raise HTTPException(400, detail="The CV evaluation has not completed yet")
    reason = (body.reason or "Shortlisted for interview from applicant review").strip()
    if len(reason) < 10:
        raise HTTPException(400, detail="Provide a reason of at least 10 characters")

    async def run(q: db.Conn) -> None:
        await q.exec(
            "UPDATE candidates SET status='shortlisted', updated_at=now() WHERE id=$1",
            [row["candidate_id"]],
        )
        if row["recommendation"] != "Shortlist":
            await q.exec(
                "UPDATE recommendation_overrides SET is_active=false WHERE candidate_id=$1 AND is_active",
                [row["candidate_id"]],
            )
            await q.exec(
                """INSERT INTO recommendation_overrides
                     (candidate_id, evaluation_id, from_rec, to_rec, reason, is_active, user_id)
                   VALUES ($1,$2,$3,'Shortlist',$4,true,$5)""",
                [row["candidate_id"], row["evaluation_id"], row["recommendation"], reason, me.id],
            )
        await audit.record(
            ctx, "application.shortlisted", "application", str(application_id),
            {"candidateId": str(row["candidate_id"]), "reason": reason},
            q,
        )

    await db.tx(run)
    return {"ok": True, "shortlisted": True}


@router.patch("/{application_id}/status")
async def set_status(
    application_id: UUID,
    body: StatusBody,
    me: AuthUser = Depends(require("candidates.status", "workflow.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    row = await db.one("SELECT id, applicant_id, job_id, status FROM applications WHERE id=$1", [str(application_id)])
    if not row:
        raise HTTPException(404, detail="Application not found")
    await db.execute(
        """UPDATE applications SET status=$2, notes = CASE WHEN $3::text IS NULL OR $3::text = '' THEN notes ELSE $3::text END,
             updated_at=now() WHERE id=$1""",
        [str(application_id), body.status, body.note],
    )
    await audit.record(
        ctx, "application.status_changed", "application", str(application_id),
        {"from": row["status"], "to": body.status, "applicantId": str(row["applicant_id"])},
    )
    return {"ok": True, "status": body.status}
