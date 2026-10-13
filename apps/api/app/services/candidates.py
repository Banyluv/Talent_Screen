"""CV ingestion (single, bulk and pasted text) and data-protection erasure."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException

from .. import audit, config, crypto, db, storage
from ..domain import AuditContext, AuthUser
from ..engine import extract, parser
from .evaluation import service as evaluations


def _ok(e: Exception) -> str:
    """Message shown to the user for a skipped file."""
    if isinstance(e, (extract.UnreadableCvError, HTTPException)):
        detail = e.detail if isinstance(e, HTTPException) else str(e)
        return str(detail)
    return f"Could not read the file ({e})"


async def ingest(
    job: dict[str, Any],
    files: list[dict[str, Any]],
    me: AuthUser,
    ctx: AuditContext,
) -> dict[str, Any]:
    if job["status"] != "open":
        raise HTTPException(400, detail="CVs can only be added to open vacancies")
    if not files:
        raise HTTPException(400, detail="Attach at least one CV")
    if len(files) > config.max_bulk_files:
        raise HTTPException(400, detail=f"Upload at most {config.max_bulk_files} files at a time")

    store = await storage.get()
    batch_id = str(uuid.uuid4())
    created: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    for f in files:
        name = (f.get("originalname") or "")[:200]
        data: bytes = f.get("buffer") or b""
        try:
            if len(data) > config.max_upload_mb * 1024 * 1024:
                raise HTTPException(400, detail=f"Larger than {config.max_upload_mb} MB")
            type_ = extract.detect_type(name, f.get("mimetype") or "", data)
            if not type_:
                raise HTTPException(400, detail="Only PDF, DOCX and TXT files are accepted")
            text = extract.extract_text(data, type_)
            sha = crypto.sha256(data)
            dup = await db.one(
                "SELECT id, full_name FROM candidates WHERE job_id=$1 AND file_sha256=$2 AND erased_at IS NULL",
                [job["id"], sha],
            )
            if dup:
                raise HTTPException(
                    400, detail=f"Duplicate of {dup['full_name']}'s CV already on this vacancy"
                )
            cv = parser.parse_cv(text)
            cand_id = str(uuid.uuid4())
            key = f"{job['id']}/{cand_id}.{type_}"
            await store.put(key, data)

            async def write(q: db.Conn) -> str:
                await q.exec(
                    """INSERT INTO candidates (id, job_id, full_name, email_enc, phone_enc, file_key, file_name,
                         file_mime, file_sha256, cv_text_enc, search_text, created_by, source)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)""",
                    [
                        cand_id, job["id"], cv["name"], crypto.encrypt(cv["email"]),
                        crypto.encrypt(cv["phone"]), key, name, f.get("mimetype"), sha,
                        crypto.encrypt(text), cv["name"].lower(), me.id,
                        "bulk-upload" if len(files) > 1 else "upload",
                    ],
                )
                ev_id = await evaluations.request(cand_id, me.id, batch_id, q)
                await audit.record(
                    ctx, "candidate.uploaded", "candidate", cand_id,
                    {"jobId": str(job["id"]), "file": name, "batchId": batch_id},
                    q,
                )
                return ev_id

            evaluation_id = await db.tx(write)
            await evaluations.enqueue(evaluation_id, batch_id)
            created.append({"id": cand_id, "name": cv["name"], "file": name})
        except Exception as e:
            skipped.append({"file": name, "reason": _ok(e)})

    if len(files) > 1:
        await audit.record(
            ctx, "candidate.bulk_upload", "job", str(job["id"]),
            {"batchId": batch_id, "received": len(files), "created": len(created), "skipped": len(skipped)},
        )
    return {"batchId": batch_id, "created": created, "skipped": skipped}


async def erase(candidate_id: str, ctx: AuditContext, reason: str) -> None:
    """Data-protection erasure: removes personal data, keeps anonymised scores for reporting."""
    c = await db.one("SELECT * FROM candidates WHERE id=$1", [candidate_id])
    if not c or c.get("erased_at"):
        raise HTTPException(400, detail="Candidate not found or already erased")
    if c.get("file_key"):
        store = await storage.get()
        try:
            await store.remove(c["file_key"])
        except Exception:
            pass

    async def run(q: db.Conn) -> None:
        await q.exec(
            """UPDATE candidates SET full_name='Erased candidate', email_enc=NULL, phone_enc=NULL,
                 cv_text_enc=NULL, file_key=NULL, file_name=NULL, file_sha256=NULL, profile=NULL,
                 search_text='', erased_at=now(), updated_at=now() WHERE id=$1""",
            [candidate_id],
        )
        await q.exec(
            """UPDATE evaluations SET narrative=NULL,
                 strengths=(SELECT COALESCE(jsonb_agg(s - 'evidence'), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(strengths,'[]'::jsonb)) s),
                 requirement_checks=(SELECT COALESCE(jsonb_agg(r - 'evidence'), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(requirement_checks,'[]'::jsonb)) r),
                 llm_discarded=NULL
               WHERE candidate_id=$1""",
            [candidate_id],
        )
        await q.exec(
            "UPDATE interview_scores SET comments='[erased]' WHERE interview_id IN (SELECT id FROM interviews WHERE candidate_id=$1)",
            [candidate_id],
        )
        await audit.record(ctx, "candidate.erased", "candidate", candidate_id, {"reason": reason}, q)

    await db.tx(run)
