"""Vacancies: listing, create/edit, hiring requests, status moves and re-scoring."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, db, notifications
from ..access import assert_job, job_scope
from ..deps import audit_context, current_user, require
from ..domain import WEIGHT_KEYS, AuditContext, AuthUser
from ..services.evaluation import service as evaluations
from ..validation import parse_date

router = APIRouter(prefix="/jobs", tags=["vacancies"])


def _list(v: Any) -> list[str]:
    if isinstance(v, list):
        items = v
    elif isinstance(v, str):
        items = [part for chunk in v.split("\n") for part in chunk.replace(",", "\n").replace(";", "\n").split("\n")]
    else:
        items = []
    out: list[str] = []
    for s in items:
        t = str(s).strip()
        if t:
            out.append(t)
    return out[:60]


def _num(v: Any, d: float) -> float:
    if v is None or v == "":
        return d
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def normalise_requirements(r: dict[str, Any] | None) -> dict[str, Any]:
    r = r or {}
    req = {
        "minQualificationLevel": _num(r.get("minQualificationLevel"), 3),
        "fieldsOfStudy": [s.lower() for s in _list(r.get("fieldsOfStudy"))],
        "requiredQualifications": _list(r.get("requiredQualifications")),
        "preferredQualifications": _list(r.get("preferredQualifications")),
        "requiredCertifications": _list(r.get("requiredCertifications")),
        "technicalSkills": _list(r.get("technicalSkills")),
        "softSkills": _list(r.get("softSkills")),
        "preferredSkills": _list(r.get("preferredSkills")),
        "minYears": _num(r.get("minYears"), 0),
        "preferredYears": _num(r.get("preferredYears"), _num(r.get("minYears"), 0)),
        "industryExperience": _list(r.get("industryExperience")),
        "locationRequirements": str(r.get("locationRequirements") or ""),
        "mandatory": _list(r.get("mandatory")),
        "niceToHave": _list(r.get("niceToHave")),
    }
    if req["minQualificationLevel"] not in (1, 2, 3, 3.5, 4, 5):
        raise HTTPException(400, detail="Unknown qualification level")
    if req["minYears"] < 0 or req["minYears"] > 40 or req["preferredYears"] < req["minYears"]:
        raise HTTPException(400, detail="Preferred years must be at least the minimum years")
    if not req["technicalSkills"]:
        raise HTTPException(400, detail="Add at least one required technical skill")
    return req


def _check_weights(w: dict[str, Any] | None) -> None:
    if not w:
        return
    total = sum((float(w.get(k) or 0) for k in WEIGHT_KEYS), 0.0)
    if int(total) != 100:
        raise HTTPException(400, detail=f"Weights total {int(total)}%. They must total 100%.")


class JobBody(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    departmentId: UUID | None = None
    location: str | None = None
    employmentType: str | None = None
    description: str | None = None
    requirements: dict[str, Any]
    weightsOverride: dict[str, Any] | None = None
    hiringManagerId: UUID | None = None
    recruiterIds: list[UUID] | None = None
    closesOn: str | None = None


class StatusBody(BaseModel):
    status: Literal["open", "closed", "filled", "draft"]


class DecisionBody(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = None


@router.get("")
async def list_jobs(me: AuthUser = Depends(current_user)):
    return await db.many(
        f"""SELECT j.id, j.ref_code, j.title, j.location, j.employment_type, j.status, j.created_at, j.closes_on,
                   d.name AS department, hm.full_name AS hiring_manager, rq.full_name AS requested_by_name,
                   (SELECT count(*)::int FROM candidates c WHERE c.job_id=j.id AND c.erased_at IS NULL) AS applicants,
                   (SELECT count(*)::int FROM evaluations e LEFT JOIN recommendation_overrides o ON o.candidate_id=e.candidate_id AND o.is_active
                      WHERE e.job_id=j.id AND e.is_current AND COALESCE(o.to_rec, e.recommendation)='Shortlist') AS shortlisted,
                   (SELECT count(*)::int FROM evaluations e WHERE e.job_id=j.id AND e.is_current AND e.status IN ('pending','running')) AS evaluating
            FROM jobs j LEFT JOIN departments d ON d.id=j.department_id
            LEFT JOIN users hm ON hm.id=j.hiring_manager_id LEFT JOIN users rq ON rq.id=j.requested_by
            WHERE {job_scope(me)} ORDER BY (j.status='requested') DESC, (j.status='open') DESC, j.created_at DESC""",
        [me.id],
    )


@router.get("/{job_id}")
async def get_job(job_id: UUID, me: AuthUser = Depends(current_user)):
    j = await assert_job(me, str(job_id))
    recruiters = await db.many(
        "SELECT u.id, u.full_name FROM job_assignments a JOIN users u ON u.id=a.user_id WHERE a.job_id=$1 AND a.kind='recruiter'",
        [str(job_id)],
    )
    scoring = await evaluations.scoring_for(str(job_id))
    return {
        **j,
        "recruiters": recruiters,
        "effectiveWeights": scoring["weights"],
        "thresholds": scoring["thresholds"],
        "rules": scoring["rules"],
    }


@router.post("")
async def create_job(
    body: JobBody,
    me: AuthUser = Depends(require("jobs.create", "hiring_requests.create")),
    ctx: AuditContext = Depends(audit_context),
):
    is_request = "jobs.create" not in me.permissions
    req = normalise_requirements(body.requirements)
    _check_weights(body.weightsOverride)

    async def run(q: db.Conn) -> str:
        seq = await db.value("SELECT count(*)::int + 1 FROM jobs", [], q)
        ref = f"ECEWS-{datetime.now(timezone.utc).year}-{int(seq):03d}"
        new_id = await db.value(
            """INSERT INTO jobs (ref_code, title, department_id, location, employment_type, description, status,
                 requirements, weights_override, hiring_manager_id, requested_by, created_by, closes_on)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id""",
            [
                ref, body.title, str(body.departmentId) if body.departmentId else None,
                body.location or "", body.employmentType or "Full-time", body.description or "",
                "requested" if is_request else "open", req, body.weightsOverride,
                me.id if is_request else (str(body.hiringManagerId) if body.hiringManagerId else None),
                me.id if is_request else None, me.id, parse_date(body.closesOn),
            ],
            q,
        )
        if not is_request and body.recruiterIds:
            await q.exec(
                """INSERT INTO job_assignments (job_id, user_id, kind)
                   SELECT $1, unnest($2::uuid[]), 'recruiter' ON CONFLICT DO NOTHING""",
                [str(new_id), [str(x) for x in body.recruiterIds]],
            )
        await audit.record(
            ctx, "job.requested" if is_request else "job.created", "job", str(new_id),
            {"ref": ref, "title": body.title}, q,
        )
        return str(new_id)

    job_id = await db.tx(run)
    if is_request:
        await notifications.to_permission(
            ["jobs.approve"], "job.requested", f"Hiring request: {body.title}",
            f"Raised by {me.name}", f"/vacancies/{job_id}", me.id,
        )
    elif body.recruiterIds:
        await notifications.to_users(
            [str(x) for x in body.recruiterIds], "job.assigned",
            f"You were assigned to {body.title}", "", f"/vacancies/{job_id}",
        )
    return {"id": job_id}


@router.put("/{job_id}")
async def update_job(
    job_id: UUID,
    body: JobBody,
    me: AuthUser = Depends(require("jobs.edit")),
    ctx: AuditContext = Depends(audit_context),
):
    jid = str(job_id)
    before = await assert_job(me, jid)
    req = normalise_requirements(body.requirements)
    _check_weights(body.weightsOverride)
    changed = (
        before["requirements"] != req
        or before.get("weights_override") != body.weightsOverride
        or before["title"] != body.title
    )

    async def run(q: db.Conn) -> None:
        await q.exec(
            """UPDATE jobs SET title=$2, department_id=$3, location=$4, employment_type=$5, description=$6,
                 requirements=$7, weights_override=$8, hiring_manager_id=$9, closes_on=$10, updated_at=now()
               WHERE id=$1""",
            [
                jid, body.title, str(body.departmentId) if body.departmentId else None,
                body.location or "", body.employmentType or "Full-time", body.description or "",
                req, body.weightsOverride,
                str(body.hiringManagerId) if body.hiringManagerId else before["hiring_manager_id"],
                parse_date(body.closesOn),
            ],
        )
        if body.recruiterIds is not None:
            await q.exec("DELETE FROM job_assignments WHERE job_id=$1 AND kind='recruiter'", [jid])
            if body.recruiterIds:
                await q.exec(
                    """INSERT INTO job_assignments (job_id, user_id, kind)
                       SELECT $1, unnest($2::uuid[]), 'recruiter'""",
                    [jid, [str(x) for x in body.recruiterIds]],
                )
        await audit.record(
            ctx, "job.updated", "job", jid,
            {"title": body.title, "requirementsChanged": before["requirements"] != req}, q,
        )

    await db.tx(run)
    requeued = await evaluations.rescore_job(jid, me.id) if changed else 0
    return {"ok": True, "requeued": requeued}


@router.post("/{job_id}/decision")
async def decide(
    job_id: UUID,
    body: DecisionBody,
    me: AuthUser = Depends(require("jobs.approve")),
    ctx: AuditContext = Depends(audit_context),
):
    jid = str(job_id)
    j = await db.one("SELECT * FROM jobs WHERE id=$1 AND status='requested'", [jid])
    if not j:
        raise HTTPException(404, detail="No pending hiring request with this id")
    status = "open" if body.decision == "approve" else "rejected"
    await db.execute("UPDATE jobs SET status=$2, approved_by=$3, updated_at=now() WHERE id=$1", [jid, status, me.id])
    await audit.record(
        ctx, f"job.request_{'approved' if body.decision == 'approve' else 'rejected'}", "job", jid,
        {"note": body.note or ""},
    )
    await notifications.to_users(
        [str(j["requested_by"])] if j["requested_by"] else [],
        "job.decision",
        f"Hiring request {'approved' if body.decision == 'approve' else 'declined'}: {j['title']}",
        body.note or "", f"/vacancies/{jid}",
    )
    return {"status": status}


@router.patch("/{job_id}/status")
async def set_status(
    job_id: UUID,
    body: StatusBody,
    me: AuthUser = Depends(require("jobs.edit", "workflow.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    jid = str(job_id)
    j = await assert_job(me, jid)
    if j["status"] == "requested":
        raise HTTPException(400, detail="Approve the hiring request first")
    await db.execute("UPDATE jobs SET status=$2, updated_at=now() WHERE id=$1", [jid, body.status])
    await audit.record(ctx, "job.status_changed", "job", jid, {"from": j["status"], "to": body.status})
    return {"ok": True}


@router.post("/{job_id}/rescore")
async def rescore(
    job_id: UUID,
    me: AuthUser = Depends(require("evaluations.run")),
    ctx: AuditContext = Depends(audit_context),
):
    jid = str(job_id)
    await assert_job(me, jid)
    n = await evaluations.rescore_job(jid, me.id)
    await audit.record(ctx, "job.rescored", "job", jid, {"candidates": n})
    return {"requeued": n}
