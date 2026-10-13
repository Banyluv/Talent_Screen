"""Authentication & permission dependencies, plus the audit context.

Mirrors the previous global guard: the JWT (HS256) is verified, then the user's
current role and permissions are loaded from the database on every request (so
role changes and suspensions take effect immediately) before permissions are
enforced.
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Depends, Header, HTTPException, Request

from . import db, security
from .domain import AuditContext, AuthUser


async def load_auth_user(user_id: str) -> AuthUser | None:
    row = await db.one(
        """SELECT u.id, u.email, u.full_name, u.is_active, r.key AS role, r.name AS role_name,
                  COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
           FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN role_permissions rp ON rp.role_id = r.id
           WHERE u.id = $1 GROUP BY u.id, r.key, r.name""",
        [user_id],
    )
    if not row or not row["is_active"]:
        return None
    return AuthUser(
        id=str(row["id"]),
        email=row["email"],
        name=row["full_name"],
        role=row["role"],
        roleName=row["role_name"],
        permissions=list(row["permissions"] or []),
    )


def _subject(payload: dict) -> str | None:
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        return None
    return sub


async def optional_user(authorization: str | None = Header(default=None)) -> AuthUser | None:
    token = ""
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        return None
    try:
        payload = security.verify(token)
    except Exception:
        return None
    sub = _subject(payload)
    if not sub:
        return None
    return await load_auth_user(sub)


async def current_user(authorization: str | None = Header(default=None)) -> AuthUser:
    token = ""
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(401, detail="Sign in to continue")
    try:
        payload = security.verify(token)
    except Exception:
        raise HTTPException(401, detail="Your session has expired. Sign in again.")
    sub = _subject(payload)
    user = await load_auth_user(sub) if sub else None
    if not user:
        raise HTTPException(401, detail="This account is suspended or no longer exists")
    return user


def require(*perms: str):
    """Route needs at least one of these permissions."""

    async def dep(user: AuthUser = Depends(current_user)) -> AuthUser:
        if perms and not any(p in user.permissions for p in perms):
            raise HTTPException(
                403, detail=f"Your role ({user.roleName}) does not allow this action"
            )
        return user

    return dep


async def audit_context(
    request: Request, user: AuthUser | None = Depends(optional_user)
) -> AuditContext:
    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)
    return AuditContext(user=user, ip=ip, userAgent=request.headers.get("user-agent"))


async def public_audit_context(request: Request) -> AuditContext:
    """For endpoints that do not authenticate (login failures are still audited)."""
    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)
    return AuditContext(user=None, ip=ip, userAgent=request.headers.get("user-agent"))


# --------------------------------------------------------------- rate limiting
_hits: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(key: str, limit: int, window_seconds: int) -> None:
    """Simple in-process limiter (per replica)."""
    now = time.time()
    q = _hits[key]
    while q and now - q[0] > window_seconds:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, detail="Too many requests. Please try again shortly.")
    q.append(now)


async def login_rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    rate_limit(f"login:{ip}", 10, 60)


async def global_rate_limit(request: Request) -> None:
    if request.url.path in ("/api/health", "/api/docs", "/api/openapi.json"):
        return
    ip = request.client.host if request.client else "unknown"
    rate_limit(f"global:{ip}", 300, 60)
