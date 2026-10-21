"""Delete one vacancy (job) and everything attached to it.

The API only lets an operator change a vacancy's status, so this maintenance
command is the way to remove one outright. One vacancy must match exactly,
which the ``--ref``, ``--id`` or exact ``--title`` selector guarantees.

Deleting the row cascades to its candidates, evaluations, interviews,
applications and assignments; notifications that deep-link to the vacancy go
with it, and the CV objects of its candidates are removed from storage unless
a portal applicant still points at the same file. The removal is recorded in
the append-only audit trail as a system action.

Usage:
    python -m app.delete_job --ref ECEWS-2026-001 --yes
    python -m app.delete_job --title "Data Engineer" --yes
    python -m app.delete_job --id a0cab5ca-e264-48f9-869c-abaf2f1ac734 --yes
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from . import audit, db, storage
from .domain import AuditContext

log = logging.getLogger("delete-job")
logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m app.delete_job",
        description="Delete one vacancy and everything attached to it.",
    )
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--ref", help="vacancy reference code, e.g. ECEWS-2026-001")
    selector.add_argument("--id", help="vacancy UUID")
    selector.add_argument("--title", help="exact vacancy title (case-insensitive)")
    parser.add_argument("--yes", action="store_true", help="delete; without it only report the match")
    return parser.parse_args(argv)


async def find_job(args: argparse.Namespace) -> dict:
    if args.id:
        rows = await db.many("SELECT * FROM jobs WHERE id=$1", [args.id])
    elif args.ref:
        rows = await db.many("SELECT * FROM jobs WHERE ref_code=$1", [args.ref])
    else:
        rows = await db.many("SELECT * FROM jobs WHERE title ILIKE $1", [args.title])
    if not rows:
        raise SystemExit("No vacancy matches that --ref/--id/--title")
    if len(rows) > 1:
        listing = "\n".join(
            f"  {r['ref_code']}  {r['title']}  ({r['status']})  id={r['id']}" for r in rows
        )
        raise SystemExit(f"{len(rows)} vacancies match; narrow it down with --ref or --id:\n{listing}")
    return rows[0]


async def dependencies(job_id: str) -> tuple[dict[str, int], list[str]]:
    """Rows the cascade will take with it, plus the stored CV objects to purge."""
    counts: dict[str, int] = {}
    queries = {
        "candidates": ("SELECT count(*) AS n FROM candidates WHERE job_id=$1", job_id),
        "evaluations": ("SELECT count(*) AS n FROM evaluations WHERE job_id=$1", job_id),
        "interviews": ("SELECT count(*) AS n FROM interviews WHERE job_id=$1", job_id),
        "applications": ("SELECT count(*) AS n FROM applications WHERE job_id=$1", job_id),
        "assignments": ("SELECT count(*) AS n FROM job_assignments WHERE job_id=$1", job_id),
        "notifications": ("SELECT count(*) AS n FROM notifications WHERE link LIKE $1", f"/vacancies/{job_id}%"),
    }
    for name, (sql, param) in queries.items():
        counts[name] = (await db.one(sql, [param]))["n"]

    # Candidate and portal rows can share one stored object key, so only files
    # that nothing else references may be removed.
    rows = await db.many(
        "SELECT file_key FROM candidates WHERE job_id=$1 AND file_key IS NOT NULL", [job_id]
    )
    keys = {r["file_key"] for r in rows}
    shared = await db.many(
        """SELECT cv_file_key AS key FROM applicants WHERE cv_file_key IS NOT NULL
           UNION
           SELECT cv_file_key AS key FROM applications WHERE cv_file_key IS NOT NULL"""
    )
    shared_keys = {r["key"] for r in shared}
    counts["files_kept_shared"] = len(keys & shared_keys)
    return counts, sorted(keys - shared_keys)


async def delete_job(job: dict, counts: dict[str, int], removable: list[str]) -> dict[str, int]:
    job_id = str(job["id"])

    # Fail before deleting rows if the storage backend cannot be reached.
    store = await storage.get()

    async def run(q: db.Conn) -> None:
        # Children go with the FK cascade; notification deep-links do not have
        # one, so remove them explicitly.
        counts["deleted"] = await q.exec("DELETE FROM jobs WHERE id=$1", [job_id])
        counts["notifications_deleted"] = await q.exec(
            "DELETE FROM notifications WHERE link LIKE $1", [f"/vacancies/{job_id}%"]
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
            "job.deleted",
            "job",
            job_id,
            {
                "refCode": job["ref_code"],
                "title": job["title"],
                "status": job["status"],
                "candidates": counts["candidates"],
                "evaluations": counts["evaluations"],
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


async def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    await db.connect()
    try:
        job = await find_job(args)
        counts, removable = await dependencies(str(job["id"]))
        counts["files_removable"] = len(removable)
        log.info(
            "Matched %s — %s (%s), closes %s",
            job["ref_code"], job["title"], job["status"], job["closes_on"] or "—",
        )
        if not args.yes:
            for name, value in counts.items():
                log.info("%-22s %s", name, value)
            log.info("Re-run with --yes to delete this vacancy.")
            return
        await delete_job(job, counts, removable)
    finally:
        await db.close()

    for name, value in counts.items():
        log.info("%-22s %s", name, value)
    log.info("Vacancy %s (%s) deleted", job["ref_code"], job["title"])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        log.error("%s", e)
        sys.exit(1)
