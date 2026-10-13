"""Append-only, hash-chained audit trail.

The table rejects UPDATE/DELETE/TRUNCATE at the database level; each row also
stores the hash of the previous row so tampering by a DB superuser is detectable
(GET /api/audit/verify).
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

from . import db
from .domain import AuditContext

log = logging.getLogger("audit")


def _js_number(v: int | float) -> str:
    """Format a number the way JSON.stringify does (no trailing .0 for whole floats)."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if v != v or v in (float("inf"), float("-inf")):
        return "null"
    if float(v).is_integer():
        return str(int(v))
    return repr(v)


def canon(v: Any) -> str:
    """Stable JSON (sorted keys) so hashes survive jsonb key re-ordering."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return _js_number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canon(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = [k for k in v.keys() if v[k] is not None]
        keys.sort()
        return "{" + ",".join(json.dumps(k) + ":" + canon(v[k]) for k in keys) + "}"
    return json.dumps(str(v), ensure_ascii=False)


def js_iso(dt: datetime) -> str:
    """JavaScript Date#toISOString(): UTC, millisecond precision, trailing Z."""
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return js_iso(datetime.now(timezone.utc))


async def record(
    ctx: AuditContext,
    action: str,
    entity_type: str | None,
    entity_id: str | None,
    details: dict[str, Any] | None = None,
    c: db.Conn | None = None,
) -> None:
    details = details or {}
    try:
        async def run(q: db.Conn) -> None:
            # serialise writers so the hash chain is linear
            await q.exec("SELECT pg_advisory_xact_lock(424242)")
            prev = await q.one("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1")
            prev_hash = prev["hash"] if prev else None
            now = datetime.now(timezone.utc).replace(microsecond=(datetime.now(timezone.utc).microsecond // 1000) * 1000)
            at = js_iso(now)
            payload = canon([
                at,
                ctx.user.id if ctx.user else None,
                action,
                entity_type,
                entity_id,
                details,
                prev_hash,
            ])
            h = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            await q.exec(
                """INSERT INTO audit_logs (at, actor_id, actor_email, actor_role, action, entity_type, entity_id, details, ip, user_agent, prev_hash, hash)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)""",
                [
                    now,
                    ctx.user.id if ctx.user else None,
                    ctx.user.email if ctx.user else "system",
                    ctx.user.roleName if ctx.user else "System",
                    action,
                    entity_type,
                    entity_id,
                    details,
                    ctx.ip,
                    (ctx.userAgent or None) and ctx.userAgent[:300],
                    prev_hash,
                    h,
                ],
            )

        if c is not None:
            await run(c)
        else:
            await db.tx(run)
    except Exception as e:  # never let auditing silently disappear, but don't break the user action
        log.error('Failed to write audit entry "%s": %s', action, e)
        if c is not None:
            raise


async def verify() -> dict[str, Any]:
    records = await db.many(
        "SELECT id, at, actor_id, action, entity_type, entity_id, details, prev_hash, hash FROM audit_logs ORDER BY id"
    )
    prev: str | None = None
    for r in records:
        payload = canon([
            js_iso(r["at"]),            r["actor_id"],
            r["action"],
            r["entity_type"],
            r["entity_id"],
            r["details"],
            r["prev_hash"],
        ])
        h = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        if r["prev_hash"] != prev or h != r["hash"]:
            return {"ok": False, "checked": len(records), "brokenAt": r["id"]}
        prev = r["hash"]
    return {"ok": True, "checked": len(records)}
