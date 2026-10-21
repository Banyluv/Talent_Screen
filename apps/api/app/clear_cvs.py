"""Remove every CV from the internal candidate pool.

Deletes all candidate records and everything that cascades from them:
evaluations, recommendation overrides, interviews and hiring recommendations.
The encrypted CV objects are removed from storage, except when the same object
is still referenced by a portal applicant's profile CV or an application — a
portal application reuses the applicant's stored file, so deleting it blindly
would break that account.

Vacancies, users, portal accounts and the append-only, hash-chained audit
trail are left untouched. The bulk deletion itself is recorded in the audit
trail as a system action, so the history stays complete.

Usage:  python -m app.clear_cvs --yes
"""
from __future__ import annotations

import asyncio
import logging
import sys

from . import audit, db, storage
from .domain import AuditContext

log = logging.getLogger("clear-cvs")
logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")


async def clear_cvs() -> dict[str, int]:
    counts: dict[str, int] = {}

    # A candidate created from a portal application shares the applicant's
    # stored object key, so only keys nothing else points at may be removed.
    shared = await db.many(
        """SELECT cv_file_key AS key FROM applicants WHERE cv_file_key IS NOT NULL
           UNION
           SELECT cv_file_key AS key FROM applications WHERE cv_file_key IS NOT NULL"""
    )
    shared_keys = {r["key"] for r in shared}

    rows = await db.many("SELECT file_key FROM candidates WHERE file_key IS NOT NULL")
    keys = {r["file_key"] for r in rows}
    removable = sorted(keys - shared_keys)
    counts["files_kept_shared"] = len(keys & shared_keys)

    # Fail before deleting rows if the storage backend cannot be reached.
    store = await storage.get()

    async def run(q: db.Conn) -> None:
        counts["candidates_found"] = (await q.one("SELECT count(*) AS n FROM candidates"))["n"]
        counts["evaluations_found"] = (await q.one("SELECT count(*) AS n FROM evaluations"))["n"]
        counts["interviews_found"] = (await q.one("SELECT count(*) AS n FROM interviews"))["n"]

        # Children (evaluations, overrides, interviews, recommendations) go with
        # the FK cascade; applications keep their own record with candidate_id
        # set to NULL.
        counts["candidates_deleted"] = await q.exec("DELETE FROM candidates")

        # Notifications pointing at a candidate that no longer exists would
        # only open a dead link.
        counts["notifications"] = await q.exec(
            """DELETE FROM notifications n
                WHERE n.link LIKE '/candidates/%' AND NOT EXISTS (
                          SELECT 1 FROM candidates c
                           WHERE c.id::text = split_part(split_part(n.link, '/candidates/', 2), '/', 1))"""
        )

        # Retained queue entries for an evaluation that has since been deleted
        # can never run; the worker's own purge would only age them out.
        counts["job_queue"] = await q.exec(
            """DELETE FROM job_queue q
                WHERE q.data ->> 'evaluationId' IS NOT NULL
                  AND NOT EXISTS (
                        SELECT 1 FROM evaluations e WHERE e.id::text = q.data ->> 'evaluationId')"""
        )

        await audit.record(
            AuditContext(),
            "candidate.bulk_cleared",
            None,
            None,
            {
                "candidates": counts["candidates_found"],
                "evaluations": counts["evaluations_found"],
                "filesRemoved": len(removable),
            },
            q,
        )

    await db.tx(run)

    removed = 0
    for key in removable:
        try:
            await store.remove(key)
            removed += 1
        except Exception as e:  # noqa: BLE001 - one bad object must not stop the sweep
            log.warning("Could not remove stored file %s: %s", key, e)
    counts["files_removed"] = removed

    return counts


async def main() -> None:
    confirmed = "--yes" in sys.argv[1:]
    await db.connect()
    try:
        if not confirmed:
            candidates = await db.value("SELECT count(*) FROM candidates")
            evaluations = await db.value("SELECT count(*) FROM evaluations")
            log.info(
                "Would delete %s candidate(s) and %s evaluation(s). Re-run with --yes to proceed.",
                candidates,
                evaluations,
            )
            return
        counts = await clear_cvs()
    finally:
        await db.close()

    for k, v in counts.items():
        log.info("%-24s %s", k, v)
    log.info("All CVs cleared")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        log.error("%s", e)
        sys.exit(1)
