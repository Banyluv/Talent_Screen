"""Background worker: evaluates queued CVs and runs the nightly data-retention sweep.

Scale horizontally by running more replicas; the queue hands each job to exactly
one worker.
"""
from __future__ import annotations

import asyncio
import logging
import signal
from datetime import datetime, timedelta, timezone

from . import audit, config, db, queue, storage
from .domain import AuditContext
from .services.evaluation import service as evaluations

log = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")

WAT = timezone(timedelta(hours=1))  # Africa/Lagos
_stop = asyncio.Event()


async def _consume() -> None:
    while not _stop.is_set():
        job = await queue.claim(queue.EVALUATE_QUEUE)
        if not job:
            try:
                await asyncio.wait_for(_stop.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
            continue
        started = asyncio.get_running_loop().time()
        data = queue.job_data(job)
        try:
            await evaluations.process(data["evaluationId"])
            await queue.complete(job["id"])
            elapsed = int((asyncio.get_running_loop().time() - started) * 1000)
            log.info("Evaluated %s in %s ms", data.get("evaluationId"), elapsed)
        except Exception as e:  # keep the queue running; retry with backoff
            await queue.fail(job, str(e))


async def _requeue_stuck() -> None:
    """Catch evaluations whose queue message was lost (e.g. API crashed between commit and send)."""
    while not _stop.is_set():
        try:
            await asyncio.wait_for(_stop.wait(), timeout=300)
            return
        except asyncio.TimeoutError:
            pass
        try:
            stuck = await db.many(
                """SELECT id, batch_id FROM evaluations
                   WHERE status='pending' AND created_at < now() - interval '10 minutes' LIMIT 50"""
            )
            for s in stuck:
                await queue.send(
                    queue.EVALUATE_QUEUE,
                    {"evaluationId": str(s["id"]), "batchId": str(s["batch_id"]) if s["batch_id"] else None},
                    singleton_key=str(s["id"]),
                )
            await queue.purge_completed(7)
        except Exception as e:
            log.warning("Stuck-job sweep failed: %s", e)


async def _retention_sweep() -> None:
    """Data retention: erase candidates on closed/filled vacancies older than the configured period."""
    settings = await db.one("SELECT retention_months FROM ai_settings WHERE id=1")
    months = str((settings or {}).get("retention_months") or 24)
    due = await db.many(
        """SELECT c.id, c.file_key FROM candidates c JOIN jobs j ON j.id=c.job_id
           WHERE c.erased_at IS NULL AND j.status IN ('closed','filled') AND c.status <> 'hired'
             AND c.created_at < now() - ($1 || ' months')::interval LIMIT 500""",
        [months],
    )
    store = await storage.get()
    for c in due:
        if c["file_key"]:
            try:
                await store.remove(c["file_key"])
            except Exception:
                pass
        await db.execute(
            """UPDATE candidates SET full_name='Erased candidate', email_enc=NULL, phone_enc=NULL,
                 cv_text_enc=NULL, file_key=NULL, file_name=NULL, file_sha256=NULL, profile=NULL,
                 search_text='', erased_at=now() WHERE id=$1""",
            [c["id"]],
        )
        await db.execute(
            """UPDATE evaluations SET narrative=NULL, llm_discarded=NULL,
                 strengths=(SELECT COALESCE(jsonb_agg(x - 'evidence'),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(strengths,'[]'::jsonb)) x),
                 requirement_checks=(SELECT COALESCE(jsonb_agg(x - 'evidence'),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(requirement_checks,'[]'::jsonb)) x)
               WHERE candidate_id=$1""",
            [c["id"]],
        )
    if due:
        await audit.record(
            AuditContext(user=None), "retention.sweep", None, None,
            {"erased": len(due), "months": (settings or {}).get("retention_months")},
        )
        log.info("Retention sweep erased %s candidate record(s)", len(due))


async def _nightly_retention() -> None:
    """Run the sweep every day at 02:30 Africa/Lagos."""
    while not _stop.is_set():
        now = datetime.now(WAT)
        nxt = now.replace(hour=2, minute=30, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        try:
            await asyncio.wait_for(_stop.wait(), timeout=(nxt - now).total_seconds())
            return
        except asyncio.TimeoutError:
            pass
        try:
            await _retention_sweep()
        except Exception as e:
            log.warning("Retention sweep failed: %s", e)


async def main() -> None:
    await db.connect()
    await storage.get()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop.set)
        except NotImplementedError:  # Windows
            pass

    log.info("Worker started (concurrency %s)", config.queue_concurrency)
    tasks = [asyncio.create_task(_consume()) for _ in range(max(1, config.queue_concurrency))]
    tasks += [asyncio.create_task(_requeue_stuck()), asyncio.create_task(_nightly_retention())]
    await _stop.wait()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await db.close()
    log.info("Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
