"""Evaluation orchestration: versioning, queueing, scoring and batch notifications."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

from .. import audit, crypto, db, notifications, queue
from ..domain import LEVELS, AuditContext
from ..engine import llm as llm_engine
from ..engine import parser, rag, scorer


def _score_input(cv: dict, job_title: str, req: dict, weights: dict, thresholds: dict, rules: dict,
                 model: Any = None, model_roles: Any = None) -> dict:
    payload: dict[str, Any] = {
        "cv": cv,
        "jobTitle": job_title,
        "req": req,
        "weights": weights,
        "thresholds": thresholds,
        "rules": rules,
    }
    if model is not None:
        payload["model"] = model
    if model_roles is not None:
        payload["modelRoles"] = model_roles
    return payload


class EvaluationService:
    def __init__(self) -> None:
        self.log = logging.getLogger("evaluation")

    async def scoring_for(self, job_id: str, c: db.Conn | None = None) -> dict[str, Any]:
        row = await db.one(
            """SELECT j.weights_override, sp.id, sp.weights, sp.thresholds, sp.rules
               FROM jobs j JOIN scoring_profiles sp
                 ON sp.id = COALESCE(j.scoring_profile_id, (SELECT id FROM scoring_profiles WHERE is_default))
               WHERE j.id = $1""",
            [job_id],
            c,
        )
        if not row:
            raise HTTPException(404, detail="Vacancy or scoring profile not found")
        return {
            "weights": row["weights_override"] or row["weights"],
            "thresholds": row["thresholds"],
            "rules": row["rules"],
            "profileId": row["id"],
        }

    async def request(
        self,
        candidate_id: str,
        user_id: str | None,
        batch_id: str | None = None,
        c: db.Conn | None = None,
    ) -> str:
        """Create a new evaluation version for a candidate."""

        async def run(q: db.Conn) -> str:
            cand = await db.one(
                "SELECT id, job_id FROM candidates WHERE id = $1 AND erased_at IS NULL",
                [candidate_id],
                q,
            )
            if not cand:
                raise HTTPException(404, detail="Candidate not found")
            await q.exec(
                "UPDATE evaluations SET is_current = false WHERE candidate_id = $1 AND is_current",
                [candidate_id],
            )
            version = await db.value(
                "SELECT COALESCE(MAX(version),0)+1 FROM evaluations WHERE candidate_id = $1",
                [candidate_id],
                q,
            )
            ev_id = await db.value(
                """INSERT INTO evaluations (candidate_id, job_id, version, requested_by, batch_id)
                   VALUES ($1,$2,$3,$4,$5) RETURNING id""",
                [candidate_id, cand["job_id"], version, user_id, batch_id],
                q,
            )
            # an override belongs to the evaluation it overrode
            await q.exec(
                "UPDATE recommendation_overrides SET is_active = false WHERE candidate_id = $1 AND is_active",
                [candidate_id],
            )
            return str(ev_id)

        if c is not None:
            return await run(c)
        return await db.tx(run)

    async def enqueue(self, evaluation_id: str, batch_id: str | None = None) -> None:
        await queue.enqueue_evaluation({"evaluationId": evaluation_id, "batchId": batch_id})

    async def rescore_job(self, job_id: str, user_id: str | None) -> int:
        """Re-score every live candidate on a vacancy (after requirements or weights change)."""
        cands = await db.many(
            "SELECT id FROM candidates WHERE job_id = $1 AND erased_at IS NULL", [job_id]
        )
        batch_id = None
        if cands:
            batch_id = str(await db.value("SELECT gen_random_uuid()"))
        for c in cands:
            ev_id = await self.request(str(c["id"]), user_id, batch_id)
            await self.enqueue(ev_id, batch_id)
        return len(cands)

    async def process(self, evaluation_id: str) -> None:
        """Worker entry point. Idempotent: a completed evaluation is not processed twice."""
        ev = await db.one(
            """UPDATE evaluations SET status = 'running'
               WHERE id = $1 AND status IN ('pending','failed','running') RETURNING *""",
            [evaluation_id],
        )
        if not ev:
            return
        try:
            cand = await db.one("SELECT * FROM candidates WHERE id = $1", [ev["candidate_id"]])
            job = await db.one("SELECT * FROM jobs WHERE id = $1", [ev["job_id"]])
            if not cand or not job or cand.get("erased_at"):
                raise RuntimeError("Candidate or vacancy no longer exists")
            ai = await db.one("SELECT * FROM ai_settings WHERE id = 1")
            cfg = await self.scoring_for(str(job["id"]))
            req = job["requirements"] or {}
            cv_text = crypto.decrypt(cand["cv_text_enc"])
            cv = parser.parse_cv(cv_text)

            result = scorer.score(_score_input(
                cv, job["title"], req, cfg["weights"], cfg["thresholds"], cfg["rules"]
            ))
            engine = "rules"
            model: str | None = None
            # The rules engine always writes a job-specific suitability review;
            # a configured AI provider may later replace it with its own prose.
            narrative: str | None = result.get("review")
            discarded: list[Any] = []
            note: str | None = None

            provider = (ai or {}).get("provider") or "rules"
            if provider != "rules":
                ready = llm_engine.provider_ready(provider)
                if not ready.get("ok"):
                    note = f'AI provider "{provider}" is not configured ({ready.get("reason")}). Rules engine used.'
                else:
                    try:
                        unresolved = [
                            {"category": c["category"], "requirement": c["requirement"]}
                            for c in result["checks"]
                            if not c["met"]
                        ]
                        need_roles = len(cv["roles"]) == 0
                        if unresolved or need_roles:
                            out = await llm_engine.run_llm({
                                "provider": provider,
                                "temperature": float(ai["temperature"]),
                                "cvText": cv_text,
                                "candidateName": cv["name"],
                                "chunks": rag.chunk_cv(cv),
                                "unresolved": unresolved,
                                "needRoles": need_roles,
                                "jobTitle": job["title"],
                                "redactPii": ai["redact_pii"],
                            })
                            result = scorer.score(_score_input(
                                cv, job["title"], req, cfg["weights"], cfg["thresholds"], cfg["rules"],
                                model=out.get("verdicts"), model_roles=out.get("roles"),
                            ))
                            discarded = out.get("discarded") or []
                            model = out.get("model")
                        engine = f"{provider}+rules"
                        if ai["generate_narrative"]:
                            narrative = await llm_engine.run_narrative(
                                provider,
                                float(ai["temperature"]),
                                {
                                    "vacancy": job["title"],
                                    "overall": result["overall"],
                                    "recommendation": result["recommendation"],
                                    "totalYears": result["totalYears"],
                                    "relevantYears": result["relevantYears"],
                                    "qualification": LEVELS.get(cv["highestLevel"], "not found"),
                                    "components": result["components"],
                                    "strengths": [s["text"] for s in result["strengths"]],
                                    "gaps": [g["text"] for g in result["gaps"]],
                                    "hardRules": result["hardRuleFailures"],
                                    "requirements": {
                                        "mandatoryMet": [c["requirement"] for c in result["checks"] if c["category"] == "mandatory" and c["met"]],
                                        "mandatoryMiss": [c["requirement"] for c in result["checks"] if c["category"] == "mandatory" and not c["met"]],
                                        "technicalMet": [c["requirement"] for c in result["checks"] if c["category"] == "technical" and c["met"]],
                                        "technicalMiss": [c["requirement"] for c in result["checks"] if c["category"] == "technical" and not c["met"]],
                                        "certificationsMet": [c["requirement"] for c in result["checks"] if c["category"] == "certification" and c["met"]],
                                        "certificationsMiss": [c["requirement"] for c in result["checks"] if c["category"] == "certification" and not c["met"]],
                                    },
                                },
                            )
                    except Exception as e:
                        note = f"AI provider call failed ({e}). Rules engine result kept."
                        self.log.warning("%s", note)
            if not (ai or {}).get("require_evidence"):
                result["strengths"] = [
                    {k: v for k, v in s.items() if k != "evidence"} for s in result["strengths"]
                ]

            cand_id = str(cand["id"])

            async def write(q: db.Conn) -> None:
                await q.exec(
                    """UPDATE evaluations SET status='completed', engine=$2, model=$3, overall_score=$4,
                         recommendation=$5, component_scores=$6, weights=$7, thresholds=$8, total_years=$9,
                         relevant_years=$10, qualification_match=$11, skills_match=$12, requirement_checks=$13,
                         strengths=$14, gaps=$15, hard_rule_failures=$16, justification=$17, narrative=$18,
                         llm_discarded=$19, error=$20, match_summary=$21, completed_at=now() WHERE id=$1""",
                    [
                        ev["id"], engine, model, result["overall"], result["recommendation"],
                        result["components"], cfg["weights"], cfg["thresholds"], result["totalYears"],
                        result["relevantYears"], result["qualificationMatch"], result["skillsMatch"],
                        result["checks"], result["strengths"], result["gaps"], result["hardRuleFailures"],
                        result["justification"], narrative, discarded, note,
                        result.get("matchSummary"),
                    ],
                )
                profile = {
                    **parser.public_profile(cv),
                    "roles": [{k: v for k, v in r.items() if k != "text"} for r in result["roles"]],
                }
                search = " ".join(
                    [cv["name"], *cv["skills"], *cv["certifications"], *[r["title"] for r in result["roles"]]]
                ).lower()[:4000]
                await q.exec(
                    """UPDATE candidates SET profile=$2, search_text=$3,
                         status = CASE WHEN status='new' THEN 'screening' ELSE status END, updated_at=now()
                       WHERE id=$1""",
                    [cand_id, profile, search],
                )
                await audit.record(
                    AuditContext(user=None), "evaluation.completed", "candidate", cand_id,
                    {
                        "evaluationId": str(ev["id"]),
                        "version": ev["version"],
                        "score": result["overall"],
                        "recommendation": result["recommendation"],
                        "engine": engine,
                    },
                    q,
                )

            await db.tx(write)
            await self.finish_batch(ev["batch_id"], job)
        except Exception as e:
            await db.execute(
                "UPDATE evaluations SET status='failed', error=$2 WHERE id=$1",
                [evaluation_id, str(e)[:1000]],
            )
            self.log.error("Evaluation %s failed: %s", evaluation_id, e)
            raise

    async def finish_batch(self, batch_id: str | None, job: dict[str, Any]) -> None:
        if not batch_id:
            return
        r = await db.one(
            """SELECT count(*) FILTER (WHERE status IN ('pending','running'))::int AS open,
                      count(*) FILTER (WHERE status='completed')::int AS done,
                      count(*) FILTER (WHERE recommendation='Shortlist')::int AS sl,
                      max(requested_by::text) AS by
               FROM evaluations WHERE batch_id = $1""",
            [batch_id],
        )
        if not r or r["open"] > 0:
            return
        # Concurrent workers may both see the batch finish: notify once, under a transaction lock.
        title = f"{r['done']} evaluation{'s' if r['done'] != 1 else ''} ready: {job['title']}"
        body = f"{r['sl']} recommended for shortlist. Review and confirm before any decision."
        link = f"/vacancies/{job['id']}/ranking?batch={batch_id}"

        async def run(q: db.Conn) -> None:
            await q.exec("SELECT pg_advisory_xact_lock(hashtext($1))", [batch_id])
            seen = await db.one(
                "SELECT 1 FROM notifications WHERE type='evaluation.batch' AND link = $1 LIMIT 1",
                [link],
                q,
            )
            if seen:
                return
            others = await db.many(
                """SELECT user_id FROM job_assignments WHERE job_id=$1
                   UNION SELECT hiring_manager_id FROM jobs WHERE id=$1 AND hiring_manager_id IS NOT NULL""",
                [job["id"]],
                q,
            )
            recipients = [r["by"], *[o["user_id"] for o in others]]
            await notifications.to_users(
                [x for x in recipients if x], "evaluation.batch", title, body, link, q
            )

        await db.tx(run)


service = EvaluationService()
