"""Dashboard, recruitment reports and ranking exports."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from .. import audit, db
from ..access import job_expiry_cutoff, job_scope, job_visible_sql
from ..deps import audit_context, current_user, require
from ..domain import AuditContext, AuthUser
from ..services import report_export as xport

router = APIRouter(tags=["reports"])


@router.get("/dashboard")
async def dashboard(me: AuthUser = Depends(current_user)):
    scope = job_scope(me)
    k = await db.one(
        f"""SELECT count(*) FILTER (WHERE j.status='open')::int AS open_jobs,
                   count(*) FILTER (WHERE j.status='requested')::int AS pending_requests
            FROM jobs j WHERE {scope} AND {job_visible_sql(2)}""",
        [me.id, job_expiry_cutoff()],
    )
    c = await db.one(
        f"""SELECT count(c.*)::int AS candidates,
                   count(*) FILTER (WHERE COALESCE(o.to_rec, e.recommendation)='Shortlist')::int AS shortlisted,
                   count(*) FILTER (WHERE e.status IN ('pending','running'))::int AS evaluating,
                   count(*) FILTER (WHERE e.status='completed' AND c.status='screening')::int AS awaiting_review,
                   count(*) FILTER (WHERE c.created_at > now() - interval '7 days')::int AS new_this_week
            FROM candidates c JOIN jobs j ON j.id=c.job_id
            LEFT JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
            LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
            WHERE c.erased_at IS NULL AND {scope}""",
        [me.id],
    )
    my_interviews = await db.one(
        """SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE s.id IS NULL AND i.status <> 'cancelled')::int AS to_score
           FROM interview_panelists ip JOIN interviews i ON i.id=ip.interview_id
           LEFT JOIN interview_scores s ON s.interview_id=i.id AND s.panelist_id=ip.user_id
           WHERE ip.user_id=$1""",
        [me.id],
    )
    upcoming = await db.one(
        f"""SELECT count(*)::int AS n FROM interviews i JOIN jobs j ON j.id=i.job_id
            WHERE i.status='scheduled' AND i.scheduled_at > now() AND {scope}""",
        [me.id],
    )
    top = await db.many(
        f"""SELECT * FROM (
              SELECT j.id AS job_id, j.title, c.id, c.full_name, e.overall_score,
                     COALESCE(o.to_rec, e.recommendation) AS recommendation, e.relevant_years,
                     row_number() OVER (PARTITION BY j.id ORDER BY e.overall_score DESC) AS rn
              FROM jobs j JOIN candidates c ON c.job_id=j.id AND c.erased_at IS NULL
              JOIN evaluations e ON e.candidate_id=c.id AND e.is_current AND e.status='completed'
              LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
              WHERE j.status='open' AND {scope}) t WHERE rn <= 3 ORDER BY title, rn""",
        [me.id],
    ) if ("evaluations.view" in me.permissions or "shortlist.review" in me.permissions) else []
    activity = await db.many(
        """SELECT at, actor_email, action, entity_type, details FROM audit_logs
           WHERE action NOT IN ('candidate.viewed','auth.login') ORDER BY id DESC LIMIT 8"""
    ) if "audit.view" in me.permissions else []

    return {
        **(k or {}),
        **(c or {}),
        "interviewsUpcoming": (upcoming or {}).get("n"),
        "myInterviews": my_interviews,
        "top": top,
        "activity": activity,
    }


@router.get("/reports/summary")
async def summary(jobId: str | None = Query(default=None), me: AuthUser = Depends(require("reports.view"))):
    scope = job_scope(me)
    p = [me.id, jobId or None]
    base = f"""FROM candidates c JOIN jobs j ON j.id=c.job_id
               JOIN evaluations e ON e.candidate_id=c.id AND e.is_current AND e.status='completed'
               LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
               WHERE {scope} AND ($2::uuid IS NULL OR j.id=$2)"""
    totals = await db.one(
        f"""SELECT count(*)::int AS evaluated, round(avg(e.overall_score))::int AS avg_score,
                   count(*) FILTER (WHERE o.id IS NOT NULL)::int AS overrides,
                   count(*) FILTER (WHERE e.engine <> 'rules')::int AS ai_assisted {base}""",
        p,
    )
    by_rec = await db.many(
        f"""SELECT COALESCE(o.to_rec, e.recommendation) AS recommendation, count(*)::int AS n
            {base} GROUP BY 1""",
        p,
    )
    histogram = await db.many(
        f"""SELECT LEAST(width_bucket(e.overall_score, 0, 100, 10), 10) AS bucket, count(*)::int AS n
            {base} GROUP BY 1 ORDER BY 1""",
        p,
    )
    pipeline = await db.many(
        f"""SELECT c.status, count(*)::int AS n FROM candidates c JOIN jobs j ON j.id=c.job_id
            WHERE c.erased_at IS NULL AND {scope} AND ($2::uuid IS NULL OR j.id=$2) GROUP BY 1""",
        p,
    )
    gaps = await db.many(
        f"""SELECT regexp_replace(g->>'text', '[0-9]+(\\.[0-9]+)?( years|-year)', '#\\2', 'g') AS gap,
                   count(*)::int AS n
            {base.replace('WHERE', ', jsonb_array_elements(e.gaps) g WHERE')}
            GROUP BY 1 ORDER BY 2 DESC LIMIT 8""",
        p,
    )
    by_job = await db.many(
        f"""SELECT j.id, j.title, j.status, count(c.*)::int AS applicants,
                   round(avg(e.overall_score))::int AS avg_score,
                   count(*) FILTER (WHERE COALESCE(o.to_rec, e.recommendation)='Shortlist')::int AS shortlisted,
                   count(*) FILTER (WHERE c.status='hired')::int AS hired
            FROM jobs j LEFT JOIN candidates c ON c.job_id=j.id AND c.erased_at IS NULL
            LEFT JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
            LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
            WHERE {scope} AND j.status <> 'requested' AND ($2::uuid IS NULL OR j.id=$2)
            GROUP BY j.id ORDER BY j.created_at DESC""",
        p,
    )
    return {
        "totals": totals,
        "byRec": by_rec,
        "histogram": histogram,
        "pipeline": pipeline,
        "gaps": gaps,
        "byJob": by_job,
    }


@router.get("/reports/export")
async def export(
    jobId: str | None = Query(default=None),
    format: str = Query(default="xlsx"),
    me: AuthUser = Depends(require("reports.export")),
    ctx: AuditContext = Depends(audit_context),
):
    if format not in ("csv", "xlsx", "pdf"):
        raise HTTPException(400, detail="format must be csv, xlsx or pdf")
    rows = await db.many(
        f"""SELECT j.ref_code, j.title AS vacancy, c.full_name, c.status, e.overall_score, e.total_years,
                   e.relevant_years, e.qualification_match, e.skills_match, e.recommendation AS ai_recommendation,
                   COALESCE(o.to_rec, e.recommendation) AS final_recommendation, o.reason AS override_reason,
                   e.strengths, e.gaps, e.justification, e.engine, e.completed_at
            FROM candidates c JOIN jobs j ON j.id=c.job_id
            JOIN evaluations e ON e.candidate_id=c.id AND e.is_current AND e.status='completed'
            LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
            WHERE c.erased_at IS NULL AND {job_scope(me)} AND ($2::uuid IS NULL OR j.id=$2)
            ORDER BY j.title, e.overall_score DESC""",
        [me.id, jobId or None],
    )
    # rank within vacancy
    rank_by: dict[str, int] = {}
    data: list[dict[str, Any]] = []
    for r in rows:
        vacancy = r["vacancy"]
        rank_by[vacancy] = rank_by.get(vacancy, 0) + 1
        data.append({
            **r,
            "rank": rank_by[vacancy],
            "key_strengths": "; ".join((s or {}).get("text", "") for s in (r.get("strengths") or [])[:3]),
            "key_gaps": "; ".join((g or {}).get("text", "") for g in (r.get("gaps") or [])[:3]),
        })

    await audit.record(ctx, "report.exported", "job", jobId or None, {"format": format, "rows": len(data)})
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if format == "csv":
        return Response(
            content=xport.ranking_csv(data),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="talentscreen-ranking-{stamp}.csv"'},
        )
    if format == "xlsx":
        return Response(
            content=xport.ranking_xlsx(data, me.email),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="talentscreen-ranking-{stamp}.xlsx"'},
        )
    return Response(
        content=xport.ranking_pdf(data, me.email),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="talentscreen-ranking-{stamp}.pdf"'},
    )
