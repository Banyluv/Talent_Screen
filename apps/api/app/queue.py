"""Durable job queue on PostgreSQL — no extra broker to run.

The API enqueues; the worker service consumes. Rows are claimed with
`FOR UPDATE SKIP LOCKED`, so adding worker replicas is safe. Swap for Azure
Service Bus or RabbitMQ behind this module if you outgrow it.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable

from . import config, db

log = logging.getLogger("queue")

EVALUATE_QUEUE = "evaluate-candidate"
RETENTION_QUEUE = "retention-sweep"

_inline_handler: Callable[[dict[str, Any]], Awaitable[None]] | None = None


def set_inline_handler(fn: Callable[[dict[str, Any]], Awaitable[None]] | None) -> None:
    global _inline_handler
    _inline_handler = fn


async def enqueue_evaluation(job: dict[str, Any]) -> None:
    """job = {evaluationId, batchId?, batchSize?, userId?}"""
    if config.queue_inline and _inline_handler is not None:
        import asyncio

        async def run() -> None:
            try:
                assert _inline_handler is not None
                await _inline_handler(job)
            except Exception as e:  # never crash the API process
                log.error("%s", e)

        asyncio.get_running_loop().create_task(run())
        return
    await send(EVALUATE_QUEUE, job, singleton_key=job.get("evaluationId"))


async def send(
    queue: str,
    data: dict[str, Any] | None = None,
    *,
    singleton_key: str | None = None,
    delay_seconds: int = 0,
    max_attempts: int = 3,
) -> int | None:
    row = await db.one(
        """INSERT INTO job_queue (queue, key, data, max_attempts, run_at)
           VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval)
           ON CONFLICT DO NOTHING
           RETURNING id""",
        [queue, singleton_key, data or {}, max_attempts, str(delay_seconds)],
    )
    return row["id"] if row else None


async def claim(queue: str) -> dict[str, Any] | None:
    """Atomically take the next due job, marking it active."""
    return await db.one(
        """UPDATE job_queue SET state='active', started_at=now(), attempts=attempts+1
           WHERE id = (
             SELECT id FROM job_queue
             WHERE queue=$1 AND state='created' AND run_at <= now()
             ORDER BY id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           RETURNING *""",
        [queue],
    )


async def complete(job_id: int) -> None:
    await db.execute(
        "UPDATE job_queue SET state='completed', completed_at=now() WHERE id=$1", [job_id]
    )


async def fail(job: dict[str, Any], error: str) -> None:
    """Retry with backoff, or give up after max_attempts."""
    if job["attempts"] >= job["max_attempts"]:
        await db.execute(
            "UPDATE job_queue SET state='failed', completed_at=now() WHERE id=$1", [job["id"]]
        )
        log.error("Job %s failed permanently: %s", job["id"], error)
        return
    backoff = min(30 * (2 ** (job["attempts"] - 1)), 600)
    await db.execute(
        """UPDATE job_queue SET state='created', run_at = now() + ($2 || ' seconds')::interval
           WHERE id=$1""",
        [job["id"], str(backoff)],
    )
    log.warning("Job %s failed (attempt %s): %s", job["id"], job["attempts"], error)


async def purge_completed(older_than_days: int = 7) -> int:
    return await db.execute(
        "DELETE FROM job_queue WHERE state IN ('completed','failed') AND completed_at < now() - ($1 || ' days')::interval",
        [str(older_than_days)],
    )


def job_data(job: dict[str, Any]) -> dict[str, Any]:
    d = job.get("data")
    return d if isinstance(d, dict) else json.loads(d or "{}")
