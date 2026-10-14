"""Administration: users, roles & permissions, organisations, scoring and AI settings, audit, notifications."""
from __future__ import annotations

import re
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from .. import audit, db, notifications, security
from ..deps import audit_context, current_user, require
from ..domain import WEIGHT_KEYS, AuditContext, AuthUser
from ..engine.llm import provider_ready
from ..permissions import PERMISSIONS
from ..services.evaluation import service as evaluations
from ..validation import EMAIL_PATTERN

router = APIRouter(tags=["administration"])

ROLE_KEY_RE = re.compile(r"^[a-z][a-z0-9_]+$")
ROLE_ORDER = ["super_admin", "hr_admin", "hiring_manager", "recruiter", "interview_panel", "viewer"]


class CreateUserBody(BaseModel):
    email: str = Field(pattern=EMAIL_PATTERN, max_length=254)
    fullName: str = Field(min_length=2, max_length=120)
    roleKey: str
    departmentId: UUID | None = None
    password: str | None = None  # omit for SSO-only accounts


class UpdateUserBody(BaseModel):
    fullName: str | None = Field(default=None, min_length=2, max_length=120)
    roleKey: str | None = None
    departmentId: UUID | None = None
    isActive: bool | None = None


class ResetPasswordBody(BaseModel):
    password: str


class RoleBody(BaseModel):
    key: str = Field(min_length=2, max_length=40)
    name: str = Field(min_length=2, max_length=80)
    description: str | None = None
    permissions: list[str]


class RolePermsBody(BaseModel):
    permissions: list[str]
    name: str | None = None
    description: str | None = None


class NameBody(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    organisationId: UUID | None = None


class ScoringBody(BaseModel):
    name: str | None = None
    weights: dict[str, Any]
    thresholds: dict[str, Any]
    rules: dict[str, Any]
    rescore: bool | None = None


class AiBody(BaseModel):
    provider: Literal["rules", "azure-openai", "openai"]
    temperature: float = Field(ge=0, le=1)
    requireEvidence: bool
    redactPii: bool
    generateNarrative: bool
    retentionMonths: int = Field(ge=1, le=120)


class MarkReadBody(BaseModel):
    ids: list[str] | None = None


class MailTestBody(BaseModel):
    to: str = Field(pattern=EMAIL_PATTERN, max_length=254)


def validate_scoring(dto: ScoringBody) -> None:
    w = dto.weights
    for k in WEIGHT_KEYS:
        v = w.get(k)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0:
            raise HTTPException(400, detail=f'Weight "{k}" must be a number of 0 or more')
    total = sum(w.get(k, 0) for k in WEIGHT_KEYS)
    if total != 100:
        raise HTTPException(400, detail=f"Weights total {total}%. They must total 100%.")
    t = dto.thresholds
    shortlist, consider, hold = t.get("shortlist"), t.get("consider"), t.get("hold")
    if not (
        isinstance(shortlist, (int, float))
        and isinstance(consider, (int, float))
        and isinstance(hold, (int, float))
        and shortlist > consider > hold >= 0
        and shortlist <= 100
    ):
        raise HTTPException(400, detail="Thresholds must descend: Shortlist > Consider > Hold, all between 0 and 100")
    if dto.rules.get("experienceBasis") not in ("relevant", "total"):
        raise HTTPException(400, detail='experienceBasis must be "relevant" or "total"')


def _check_perms(p: list[str]) -> None:
    known = {x["key"] for x in PERMISSIONS}
    bad = [x for x in p if x not in known]
    if bad:
        raise HTTPException(400, detail=f"Unknown permission(s): {', '.join(bad)}")


# ------------------------------------------------------------------------ users


@router.get("/users")
async def users(me: AuthUser = Depends(require("users.manage", "interviews.schedule", "jobs.create", "jobs.approve"))):
    full = "users.manage" in me.permissions
    rows = await db.many(
        """SELECT u.id, u.email, u.full_name, u.auth_provider, u.is_active, u.last_login_at, u.created_at,
                  u.locked_until, r.key AS role_key, r.name AS role_name, d.id AS department_id, d.name AS department,
                  EXISTS (SELECT 1 FROM role_permissions rp
                          WHERE rp.role_id = u.role_id AND rp.permission_key = 'interviews.score') AS can_score
           FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN departments d ON d.id=u.department_id
           ORDER BY u.full_name"""
    )
    # non-admins only need a directory for pickers (panel members, recruiters)
    if full:
        return rows
    return [
        {
            "id": r["id"],
            "full_name": r["full_name"],
            "role_key": r["role_key"],
            "role_name": r["role_name"],
            "department": r["department"],
            "can_score": r["can_score"],
        }
        for r in rows
        if r["is_active"]
    ]


@router.post("/users")
async def create_user(
    body: CreateUserBody,
    me: AuthUser = Depends(require("users.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    role = await db.one("SELECT id, name FROM roles WHERE key=$1", [body.roleKey])
    if not role:
        raise HTTPException(400, detail="Unknown role")
    if body.password and not security.strong_password(body.password):
        raise HTTPException(400, detail=security.PASSWORD_RULE)
    exists = await db.one("SELECT 1 FROM users WHERE lower(email)=lower($1)", [body.email])
    if exists:
        raise HTTPException(400, detail="A user with this email already exists")
    new_id = await db.value(
        """INSERT INTO users (email, full_name, password_hash, auth_provider, role_id, department_id, must_change_password)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
        [
            body.email.lower(), body.fullName,
            security.hash_password(body.password) if body.password else None,
            "local" if body.password else "oidc",
            role["id"], str(body.departmentId) if body.departmentId else None, bool(body.password),
        ],
    )
    await audit.record(ctx, "user.created", "user", str(new_id), {"email": body.email.lower(), "role": body.roleKey})
    return {"id": str(new_id)}


@router.patch("/users/{user_id}")
async def update_user(
    user_id: UUID,
    body: UpdateUserBody,
    me: AuthUser = Depends(require("users.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    uid = str(user_id)
    provided = body.model_fields_set
    u = await db.one(
        "SELECT u.*, r.key AS role_key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1", [uid]
    )
    if not u:
        raise HTTPException(404, detail="User not found")
    if uid == me.id and (body.roleKey or body.isActive is False):
        raise HTTPException(400, detail="You cannot change your own role or suspend yourself")
    role_id = u["role_id"]
    if body.roleKey:
        r = await db.one("SELECT id FROM roles WHERE key=$1", [body.roleKey])
        if not r:
            raise HTTPException(400, detail="Unknown role")
        role_id = r["id"]
    # keep at least one active Super Administrator
    if u["role_key"] == "super_admin" and (
        (body.roleKey and body.roleKey != "super_admin") or body.isActive is False
    ):
        n = await db.value(
            """SELECT count(*)::int FROM users u JOIN roles r ON r.id=u.role_id
               WHERE r.key='super_admin' AND u.is_active"""
        )
        if n <= 1:
            raise HTTPException(400, detail="At least one active Super Administrator is required")
    await db.execute(
        """UPDATE users SET full_name=COALESCE($2, full_name), role_id=$3,
             department_id=CASE WHEN $4::boolean THEN $5::uuid ELSE department_id END,
             is_active=COALESCE($6, is_active), updated_at=now() WHERE id=$1""",
        [
            uid, body.fullName, role_id, "departmentId" in provided,
            str(body.departmentId) if body.departmentId else None,
            body.isActive if "isActive" in provided else None,
        ],
    )
    if body.isActive is False:
        await db.execute(
            "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [uid]
        )
    await audit.record(
        ctx, "user.updated", "user", uid,
        {"changes": body.model_dump(exclude_unset=True, mode="json"), "previousRole": u["role_key"]},
    )
    return {"ok": True}


@router.post("/users/{user_id}/reset-password", status_code=204)
async def reset_password(
    user_id: UUID,
    body: ResetPasswordBody,
    me: AuthUser = Depends(require("users.manage")),
    ctx: AuditContext = Depends(audit_context),
) -> Response:
    if not security.strong_password(body.password):
        raise HTTPException(400, detail=security.PASSWORD_RULE)
    uid = str(user_id)
    n = await db.execute(
        """UPDATE users SET password_hash=$2, auth_provider='local', must_change_password=true,
             failed_logins=0, locked_until=NULL WHERE id=$1""",
        [uid, security.hash_password(body.password)],
    )
    if not n:
        raise HTTPException(404, detail="User not found")
    await db.execute("UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [uid])
    await audit.record(ctx, "user.password_reset", "user", uid, {})
    return Response(status_code=204)


# ------------------------------------------------------------- roles & permissions


@router.get("/permissions")
async def permissions(me: AuthUser = Depends(require("roles.manage", "users.manage"))):
    return PERMISSIONS


@router.get("/roles")
async def roles(me: AuthUser = Depends(require("roles.manage", "users.manage"))):
    return await db.many(
        """SELECT r.id, r.key, r.name, r.description, r.is_system,
                  COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
                           FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions,
                  (SELECT count(*)::int FROM users u WHERE u.role_id=r.id) AS user_count
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY r.id
           ORDER BY COALESCE(array_position(ARRAY['super_admin','hr_admin','hiring_manager','recruiter','interview_panel','viewer'], r.key), 99), r.name"""
    )


@router.post("/roles")
async def create_role(
    body: RoleBody,
    me: AuthUser = Depends(require("roles.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    if not ROLE_KEY_RE.match(body.key):
        raise HTTPException(400, detail="Role key must be lower-case letters, digits and underscores")
    _check_perms(body.permissions)

    async def run(q: db.Conn) -> str:
        new_id = await db.value(
            "INSERT INTO roles (key, name, description) VALUES ($1,$2,$3) RETURNING id",
            [body.key, body.name, body.description or ""],
            q,
        )
        await q.exec(
            "INSERT INTO role_permissions SELECT $1, unnest($2::text[])", [str(new_id), body.permissions]
        )
        return str(new_id)

    role_id = await db.tx(run)
    await audit.record(ctx, "role.created", "role", role_id, {"key": body.key, "permissions": body.permissions})
    return {"id": role_id}


@router.put("/roles/{key}")
async def update_role(
    key: str,
    body: RolePermsBody,
    me: AuthUser = Depends(require("roles.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    _check_perms(body.permissions)
    role = await db.one("SELECT * FROM roles WHERE key=$1", [key])
    if not role:
        raise HTTPException(404, detail="Role not found")
    if key == "super_admin" and not {"users.manage", "roles.manage"}.issubset(set(body.permissions)):
        raise HTTPException(400, detail="Super Administrator must keep users.manage and roles.manage")
    before = await db.many("SELECT permission_key FROM role_permissions WHERE role_id=$1", [role["id"]])
    rid = str(role["id"])

    async def run(q: db.Conn) -> None:
        await q.exec(
            "UPDATE roles SET name=COALESCE($2,name), description=COALESCE($3,description) WHERE id=$1",
            [rid, body.name, body.description],
        )
        await q.exec("DELETE FROM role_permissions WHERE role_id=$1", [rid])
        if body.permissions:
            await q.exec("INSERT INTO role_permissions SELECT $1, unnest($2::text[])", [rid, body.permissions])

    await db.tx(run)
    b = [x["permission_key"] for x in before]
    await audit.record(
        ctx, "role.permissions_changed", "role", rid,
        {
            "key": key,
            "added": [p for p in body.permissions if p not in b],
            "removed": [p for p in b if p not in body.permissions],
        },
    )
    return {"ok": True}


@router.delete("/roles/{key}", status_code=204)
async def delete_role(
    key: str,
    me: AuthUser = Depends(require("roles.manage")),
    ctx: AuditContext = Depends(audit_context),
) -> Response:
    role = await db.one(
        "SELECT r.*, (SELECT count(*)::int FROM users WHERE role_id=r.id) AS n FROM roles r WHERE key=$1", [key]
    )
    if not role:
        raise HTTPException(404, detail="Role not found")
    if role["is_system"]:
        raise HTTPException(400, detail="Built-in roles cannot be deleted")
    if role["n"]:
        raise HTTPException(400, detail=f"Move the {role['n']} user(s) on this role first")
    await db.execute("DELETE FROM roles WHERE id=$1", [role["id"]])
    await audit.record(ctx, "role.deleted", "role", str(role["id"]), {"key": key})
    return Response(status_code=204)


# ------------------------------------------------- organisations & departments


@router.get("/departments")
async def departments(me: AuthUser = Depends(current_user)):
    return await db.many(
        """SELECT d.id, d.name, o.id AS organisation_id, o.name AS organisation
           FROM departments d JOIN organisations o ON o.id=d.organisation_id ORDER BY o.name, d.name"""
    )


@router.get("/organisations")
async def organisations(me: AuthUser = Depends(require("org.manage"))):
    return await db.many("SELECT * FROM organisations ORDER BY name")


@router.post("/organisations")
async def create_org(
    body: NameBody,
    me: AuthUser = Depends(require("org.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    o = await db.one("INSERT INTO organisations (name) VALUES ($1) RETURNING id", [body.name])
    await audit.record(ctx, "organisation.created", "organisation", str(o["id"]), {"name": body.name})
    return o


@router.post("/departments")
async def create_department(
    body: NameBody,
    me: AuthUser = Depends(require("org.manage")),
    ctx: AuditContext = Depends(audit_context),
):
    org = str(body.organisationId) if body.organisationId else await db.value(
        "SELECT id FROM organisations ORDER BY created_at LIMIT 1"
    )
    if not org:
        raise HTTPException(400, detail="Create an organisation first")
    d = await db.one(
        "INSERT INTO departments (organisation_id, name) VALUES ($1,$2) RETURNING id", [org, body.name]
    )
    await audit.record(ctx, "department.created", "department", str(d["id"]), {"name": body.name})
    return d


# ---------------------------------------------------- scoring configuration


@router.get("/settings/scoring")
async def scoring_profiles(me: AuthUser = Depends(require("scoring.configure", "jobs.create", "jobs.edit"))):
    return await db.many("SELECT * FROM scoring_profiles ORDER BY is_default DESC, name")


@router.put("/settings/scoring/default")
async def update_default_scoring(
    body: ScoringBody,
    me: AuthUser = Depends(require("scoring.configure")),
    ctx: AuditContext = Depends(audit_context),
):
    validate_scoring(body)
    before = await db.one("SELECT * FROM scoring_profiles WHERE is_default")
    await db.execute(
        "UPDATE scoring_profiles SET weights=$2, thresholds=$3, rules=$4, updated_by=$5, updated_at=now() WHERE id=$1",
        [before["id"], body.weights, body.thresholds, body.rules, me.id],
    )
    await audit.record(
        ctx, "scoring.updated", "scoring_profile", str(before["id"]),
        {
            "before": {"weights": before["weights"], "thresholds": before["thresholds"], "rules": before["rules"]},
            "after": {"weights": body.weights, "thresholds": body.thresholds, "rules": body.rules},
        },
    )
    requeued = 0
    if body.rescore:
        jobs = await db.many(
            """SELECT id FROM jobs WHERE status IN ('open','closed')
               AND (scoring_profile_id IS NULL OR scoring_profile_id=$1)""",
            [before["id"]],
        )
        for j in jobs:
            requeued += await evaluations.rescore_job(str(j["id"]), me.id)
    return {"ok": True, "requeued": requeued}


@router.get("/settings/ai")
async def ai_settings(me: AuthUser = Depends(require("ai.configure", "scoring.configure"))):
    s = await db.one("SELECT * FROM ai_settings WHERE id=1")
    return {
        **(s or {}),
        "status": {
            "azure-openai": provider_ready("azure-openai"),
            "openai": provider_ready("openai"),
            "rules": {"ok": True},
        },
    }


@router.put("/settings/ai")
async def update_ai(
    body: AiBody,
    me: AuthUser = Depends(require("ai.configure")),
    ctx: AuditContext = Depends(audit_context),
):
    ready = provider_ready(body.provider)
    if not ready.get("ok"):
        raise HTTPException(
            400, detail=f"{body.provider} is not configured on the server: {ready.get('reason')}"
        )
    await db.execute(
        """UPDATE ai_settings SET provider=$1, temperature=$2, require_evidence=$3, redact_pii=$4,
             generate_narrative=$5, retention_months=$6, updated_by=$7, updated_at=now() WHERE id=1""",
        [
            body.provider, body.temperature, body.requireEvidence, body.redactPii,
            body.generateNarrative, body.retentionMonths, me.id,
        ],
    )
    await audit.record(ctx, "ai_settings.updated", "ai_settings", "1", body.model_dump())
    return {"ok": True}


# ---------------------------------------------------------------------- mail


@router.get("/settings/mail")
async def mail_settings(me: AuthUser = Depends(require("ai.configure", "scoring.configure"))):
    return notifications.mail_status()


@router.post("/settings/mail/test")
async def send_test_mail(
    body: MailTestBody,
    me: AuthUser = Depends(require("ai.configure")),
    ctx: AuditContext = Depends(audit_context),
):
    result = await notifications.send_test_email(body.to)
    await audit.record(ctx, "mail.test", "settings", "mail", {"to": body.to, "ok": result["ok"]})
    return result


# ---------------------------------------------------------------------- audit


@router.get("/audit")
async def audit_log(
    q: str | None = Query(default=None),
    action: str | None = Query(default=None),
    limit: str = Query(default="200"),
    before: str | None = Query(default=None),
    me: AuthUser = Depends(require("audit.view")),
):
    try:
        lim = min(int(limit or 200), 1000)
    except ValueError:
        lim = 200
    return await db.many(
        """SELECT id, at, actor_email, actor_role, action, entity_type, entity_id, details, ip FROM audit_logs
           WHERE ($1::text IS NULL OR action ILIKE '%'||$1||'%' OR actor_email ILIKE '%'||$1||'%' OR details::text ILIKE '%'||$1||'%')
             AND ($2::text IS NULL OR action LIKE $2||'%')
             AND ($3::bigint IS NULL OR id < $3)
           ORDER BY id DESC LIMIT $4""",
        [q or None, action or None, int(before) if before else None, lim],
    )


@router.get("/audit/verify")
async def verify_audit(me: AuthUser = Depends(require("audit.view"))):
    return await audit.verify()


@router.get("/audit/export")
async def audit_export(
    me: AuthUser = Depends(require("audit.view")),
    ctx: AuditContext = Depends(audit_context),
):
    from ..services.report_export import audit_csv

    rows = await db.many(
        """SELECT id, at, actor_email, actor_role, action, entity_type, entity_id, details, ip, hash
           FROM audit_logs ORDER BY id"""
    )
    await audit.record(ctx, "audit.exported", None, None, {"rows": len(rows)})
    return Response(
        content=audit_csv(rows),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="talentscreen-audit-{_today()}.csv"'},
    )


def _today() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ------------------------------------------------------------- notifications


@router.get("/notifications")
async def list_notifications(me: AuthUser = Depends(current_user)):
    return await db.many(
        """SELECT * FROM notifications WHERE user_id=$1 AND type <> 'evaluation.batch.marker'
           ORDER BY created_at DESC LIMIT 100""",
        [me.id],
    )


@router.post("/notifications/read", status_code=204)
async def mark_read(
    body: MarkReadBody = Body(default=MarkReadBody()),
    me: AuthUser = Depends(current_user),
) -> Response:
    ids = body.ids if body else None
    await db.execute(
        """UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL
             AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))""",
        [me.id, ids],
    )
    return Response(status_code=204)
