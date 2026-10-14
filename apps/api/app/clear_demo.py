"""Remove demonstration content from the database.

Deletes the demo vacancies (ref_code starting DEMO-), everything hanging off
them, and the demo accounts (@demo.ecews.local). Reference data (roles,
permissions, departments, scoring profiles) and real accounts are untouched.

Rows left pointing at content that no longer exists are removed as well
(notifications with dead links, finished queue entries whose evaluation is
gone), so repeated runs converge on a clean database. The append-only audit
trail is deliberately preserved.

Usage:  python -m app.clear_demo
"""
from __future__ import annotations

import asyncio
import logging
import sys

from . import db, storage

log = logging.getLogger("clear-demo")
logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")

DEMO_JOB_FILTER = "ref_code LIKE 'DEMO-%'"
DEMO_USER_FILTER = "email LIKE '%@demo.ecews.local'"


async def clear_demo() -> dict[str, int]:
    counts: dict[str, int] = {}

    demo_jobs = await db.many(f"SELECT id FROM jobs WHERE {DEMO_JOB_FILTER}")
    job_ids = [str(j["id"]) for j in demo_jobs]

    if job_ids:
        # Collect the encrypted CV object keys before the rows disappear.
        files = await db.many(
            "SELECT c.file_key FROM candidates c WHERE c.job_id = ANY($1::uuid[]) AND c.file_key IS NOT NULL",
            [job_ids],
        )
        store = await storage.get()
        removed = 0
        for f in files:
            try:
                await store.remove(f["file_key"])
                removed += 1
            except Exception as e:
                log.warning("Could not remove stored file %s: %s", f["file_key"], e)
        counts["files_removed"] = removed

        async def run(q: db.Conn) -> None:
            # Children first, then the vacancies themselves.
            counts["interview_scores"] = await q.exec(
                "DELETE FROM interview_scores WHERE interview_id IN (SELECT id FROM interviews WHERE job_id = ANY($1::uuid[]))",
                [job_ids],
            )
            counts["interview_panelists"] = await q.exec(
                "DELETE FROM interview_panelists WHERE interview_id IN (SELECT id FROM interviews WHERE job_id = ANY($1::uuid[]))",
                [job_ids],
            )
            counts["interviews"] = await q.exec(
                "DELETE FROM interviews WHERE job_id = ANY($1::uuid[])", [job_ids]
            )
            counts["hiring_recommendations"] = await q.exec(
                "DELETE FROM hiring_recommendations WHERE candidate_id IN (SELECT id FROM candidates WHERE job_id = ANY($1::uuid[]))",
                [job_ids],
            )
            counts["recommendation_overrides"] = await q.exec(
                "DELETE FROM recommendation_overrides WHERE candidate_id IN (SELECT id FROM candidates WHERE job_id = ANY($1::uuid[]))",
                [job_ids],
            )
            counts["evaluations"] = await q.exec(
                "DELETE FROM evaluations WHERE job_id = ANY($1::uuid[])", [job_ids]
            )
            counts["notifications_for_jobs"] = await q.exec(
                """DELETE FROM notifications WHERE link LIKE '/vacancies/%'
                     AND split_part(split_part(link, '/vacancies/', 2), '/', 1) = ANY($1::text[])""",
                [job_ids],
            )
            counts["candidates"] = await q.exec(
                "DELETE FROM candidates WHERE job_id = ANY($1::uuid[])", [job_ids]
            )
            counts["job_assignments"] = await q.exec(
                "DELETE FROM job_assignments WHERE job_id = ANY($1::uuid[])", [job_ids]
            )
            counts["jobs"] = await q.exec("DELETE FROM jobs WHERE id = ANY($1::uuid[])", [job_ids])

        await db.tx(run)

    # Notifications pointing at a vacancy or candidate that no longer exists
    # (content removed by an earlier cleanup) would only open a dead link. This
    # also sweeps up whatever previous runs left behind.
    counts["notifications_dangling"] = await db.execute(
        """DELETE FROM notifications n
            WHERE (n.link LIKE '/vacancies/%' AND NOT EXISTS (
                       SELECT 1 FROM jobs j
                        WHERE j.id::text = split_part(split_part(n.link, '/vacancies/', 2), '/', 1)))
               OR (n.link LIKE '/candidates/%' AND NOT EXISTS (
                       SELECT 1 FROM candidates c
                        WHERE c.id::text = split_part(split_part(n.link, '/candidates/', 2), '/', 1)))"""
    )

    # Queue entries that finished for an evaluation which has since been deleted
    # can never be retried; the worker's own purge would only age them out.
    counts["job_queue"] = await db.execute(
        """DELETE FROM job_queue q
            WHERE q.state IN ('completed', 'failed') AND q.data ->> 'evaluationId' IS NOT NULL
              AND NOT EXISTS (
                    SELECT 1 FROM evaluations e WHERE e.id::text = q.data ->> 'evaluationId')"""
    )

    # Demo accounts. The audit trail is append-only (and deliberately kept), but
    # anything else that still references these users blocks the delete: rather
    # than cascading into records that are not demo data, report and keep them.
    counts["refresh_tokens"] = await db.execute(
        f"DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE {DEMO_USER_FILTER})"
    )
    counts["notifications_for_users"] = await db.execute(
        f"DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE {DEMO_USER_FILTER})"
    )
    try:
        counts["demo_users"] = await db.execute(f"DELETE FROM users WHERE {DEMO_USER_FILTER}")
    except Exception as e:
        remaining = await db.many(f"SELECT email FROM users WHERE {DEMO_USER_FILTER}")
        counts["demo_users"] = 0
        counts["demo_users_kept"] = len(remaining)
        log.warning(
            "Kept %s demo account(s) still referenced by other records (%s): %s",
            len(remaining),
            e,
            ", ".join(r["email"] for r in remaining),
        )

    return counts


async def main() -> None:
    await db.connect()
    counts = await clear_demo()
    await db.close()
    for k, v in counts.items():
        log.info("%-24s %s", k, v)
    log.info("Demo data cleared")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        log.error("%s", e)
        sys.exit(1)
