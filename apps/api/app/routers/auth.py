"""Sign-in, session refresh, password change and single sign-on."""
from __future__ import annotations

import base64
import hashlib
import logging
import secrets
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from .. import audit, config, crypto, db, security
from ..deps import audit_context, current_user, load_auth_user, login_rate_limit, public_audit_context
from ..domain import AuditContext, AuthUser
from ..validation import EMAIL_PATTERN

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("auth")

REFRESH_COOKIE = "ts_refresh"
HANDSHAKE_COOKIE = "ts_oidc"


def _secure() -> bool:
    return config.public_url.startswith("https")


def _set_refresh(res: Response, token: str) -> None:
    res.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=config.refresh_ttl_days * 86400,
        path="/api/auth",
        httponly=True,
        secure=_secure() or config.cookie_samesite == "none",
        samesite=config.cookie_samesite,
    )


def _access_token(u: AuthUser) -> str:
    return security.access_token(u.id, u.name, u.role)


def issue_refresh_token() -> str:
    return crypto.token()


async def _store_refresh(user_id: str, token: str, ctx: AuditContext) -> None:
    await db.execute(
        """INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
           VALUES ($1,$2, now() + ($3 || ' days')::interval, $4, $5)""",
        [user_id, crypto.sha256(token), str(config.refresh_ttl_days), (ctx.userAgent or None) and ctx.userAgent[:300], ctx.ip],
    )


class LoginBody(BaseModel):
    email: str = Field(pattern=EMAIL_PATTERN, max_length=254)
    password: str = Field(min_length=1)


class ChangePasswordBody(BaseModel):
    current: str
    next: str


@router.get("/providers")
async def providers():
    return {
        "local": config.local_login_enabled,
        "oidc": {"name": config.oidc_display_name} if config.oidc_enabled else None,
    }


@router.post("/login", dependencies=[Depends(login_rate_limit)])
async def login(
    body: LoginBody,
    ctx: AuditContext = Depends(public_audit_context),
) -> Response:
    if not config.local_login_enabled:
        raise HTTPException(400, detail="Password sign-in is disabled. Use single sign-on.")

    email = body.email.strip()
    u = await db.one("SELECT * FROM users WHERE lower(email) = lower($1)", [email])

    async def fail(why: str) -> None:
        await audit.record(
            AuditContext(user=None), "auth.login_failed", "user",
            str(u["id"]) if u else None,
            {"email": email.lower(), "reason": why},
        )
        raise HTTPException(401, detail="Email or password is incorrect")

    if not u or not u.get("password_hash"):
        await fail("unknown user or SSO-only")
    if not u["is_active"]:
        await fail("suspended")
    locked_until = u.get("locked_until")
    if locked_until and locked_until > datetime.now(timezone.utc):
        raise HTTPException(
            401,
            detail=f"Too many failed attempts. Try again after {locked_until.astimezone().strftime('%H:%M:%S')}.",
        )
    if not security.verify_password(body.password, u["password_hash"]):
        n = (u.get("failed_logins") or 0) + 1
        lock = n >= config.max_failed_logins
        await db.execute(
            """UPDATE users SET failed_logins=$2,
                 locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE NULL END
               WHERE id=$1""",
            [u["id"], 0 if lock else n, lock, str(config.lockout_minutes)],
        )
        await fail("bad password, account locked" if lock else "bad password")

    await db.execute(
        "UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1",
        [u["id"]],
    )
    user = await load_auth_user(str(u["id"]))
    assert user is not None
    await audit.record(AuditContext(user=user, ip=ctx.ip, userAgent=ctx.userAgent), "auth.login", "user", user.id, {"method": "password"})
    refresh = issue_refresh_token()
    await _store_refresh(user.id, refresh, ctx)

    res = JSONResponse({
        "accessToken": _access_token(user),
        "user": user.as_dict(),
        "mustChangePassword": bool(u["must_change_password"]),
    })
    _set_refresh(res, refresh)
    return res


@router.post("/refresh")
async def refresh(request: Request, ctx: AuditContext = Depends(public_audit_context)) -> Response:
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(401, detail="No session")
    row = await db.one("SELECT * FROM refresh_tokens WHERE token_hash = $1", [crypto.sha256(token)])
    if not row:
        raise HTTPException(401, detail="Session not recognised")
    if row["revoked_at"]:
        await db.execute(
            "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
            [row["user_id"]],
        )
        await audit.record(AuditContext(user=None), "auth.refresh_reuse_detected", "user", str(row["user_id"]), {})
        raise HTTPException(401, detail="Session ended for security reasons. Sign in again.")
    expires_at = row["expires_at"]
    if expires_at and expires_at < datetime.now(timezone.utc):
        raise HTTPException(401, detail="Session expired")
    user = await load_auth_user(str(row["user_id"]))
    if not user:
        raise HTTPException(401, detail="Account suspended")
    await db.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [row["id"]])
    mcp = await db.one("SELECT must_change_password FROM users WHERE id=$1", [user.id])
    new_token = issue_refresh_token()
    await _store_refresh(user.id, new_token, ctx)

    res = JSONResponse({
        "accessToken": _access_token(user),
        "user": user.as_dict(),
        "mustChangePassword": bool(mcp and mcp["must_change_password"]),
    })
    _set_refresh(res, new_token)
    return res


@router.post("/logout", status_code=204)
async def logout(request: Request, ctx: AuditContext = Depends(public_audit_context)) -> Response:
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        await db.execute(
            "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
            [crypto.sha256(token)],
        )
    if ctx.user:
        await audit.record(ctx, "auth.logout", "user", ctx.user.id, {})
    res = Response(status_code=204)
    res.delete_cookie(REFRESH_COOKIE, path="/api/auth")
    return res


@router.get("/me")
async def me(user: AuthUser = Depends(current_user)):
    return user.as_dict()


@router.post("/change-password", status_code=204)
async def change_password(
    body: ChangePasswordBody,
    user: AuthUser = Depends(current_user),
    ctx: AuditContext = Depends(audit_context),
) -> Response:
    row = await db.one("SELECT password_hash FROM users WHERE id = $1", [user.id])
    if not row or not security.verify_password(body.current, row["password_hash"]):
        raise HTTPException(400, detail="Current password is incorrect")
    if not security.strong_password(body.next):
        raise HTTPException(400, detail=security.PASSWORD_RULE)
    await db.execute(
        "UPDATE users SET password_hash=$2, must_change_password=false, updated_at=now() WHERE id=$1",
        [user.id, security.hash_password(body.next)],
    )
    await db.execute(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [user.id],
    )
    await audit.record(ctx, "auth.password_changed", "user", user.id, {})
    return Response(status_code=204)


# ------------------------------------------------------------- OIDC (Entra ID / Keycloak)


async def _metadata() -> dict[str, Any]:
    if not config.oidc_enabled:
        raise HTTPException(400, detail="Single sign-on is not enabled")
    url = config.oidc_issuer.rstrip("/") + "/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.json()


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    return verifier, challenge


@router.get("/oidc/login")
async def oidc_login() -> Response:
    meta = await _metadata()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    verifier, challenge = _pkce()
    params = {
        "response_type": "code",
        "client_id": config.oidc_client_id,
        "redirect_uri": config.oidc_redirect_uri,
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    url = meta["authorization_endpoint"] + "?" + urlencode(params)
    handshake = security.sign(
        {"state": state, "nonce": nonce, "verifier": verifier}, expires_in=600, audience="oidc-handshake"
    )
    res = RedirectResponse(url)
    res.set_cookie(
        HANDSHAKE_COOKIE,
        handshake,
        max_age=600,
        path="/api/auth/oidc",
        httponly=True,
        secure=_secure() or config.cookie_samesite == "none",
        samesite="lax",
    )
    return res


def _claims_from_id_token(id_token: str, nonce: str) -> dict[str, Any]:
    jwks = jwt.PyJWKClient(_metadata_cache["jwks_uri"])
    signing_key = jwks.get_signing_key_from_jwt(id_token)
    return jwt.decode(
        id_token,
        signing_key.key,
        algorithms=_metadata_cache.get("id_token_signing_alg_values_supported") or ["RS256"],
        audience=config.oidc_client_id,
        issuer=config.oidc_issuer,
    )


_metadata_cache: dict[str, Any] = {}


@router.get("/oidc/callback")
async def oidc_callback(
    request: Request,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    ctx: AuditContext = Depends(public_audit_context),
) -> Response:
    try:
        result = await _complete_oidc(request, code, state, ctx)
    except Exception as e:  # redirect back to the sign-in page with a readable reason
        log.warning("OIDC callback failed: %s", e)
        return RedirectResponse(config.web_url + "/login?error=" + _url_encode(str(getattr(e, "detail", e))))
    res = RedirectResponse(config.web_url + "/?sso=1")
    res.delete_cookie(HANDSHAKE_COOKIE, path="/api/auth/oidc")
    _set_refresh(res, result)
    return res


async def _complete_oidc(
    request: Request, code: str | None, state: str | None, ctx: AuditContext
) -> str:
    handshake = request.cookies.get(HANDSHAKE_COOKIE) or ""
    try:
        hs = security.verify(handshake, audience="oidc-handshake")
    except Exception:
        raise HTTPException(401, detail="Sign-in took too long or started in another browser. Try again.")
    if not code:
        raise HTTPException(400, detail="Missing authorization code")
    meta = await _metadata()
    _metadata_cache.update(meta)
    verifier = hs["verifier"]
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": config.oidc_redirect_uri,
        "client_id": config.oidc_client_id,
        "code_verifier": verifier,
    }
    if config.oidc_client_secret:
        data["client_secret"] = config.oidc_client_secret
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(meta["token_endpoint"], data=data)
        if r.status_code >= 400:
            raise HTTPException(401, detail="Sign-in with the identity provider failed")
        tokens = r.json()
    id_token = tokens.get("id_token")
    if not id_token:
        raise HTTPException(401, detail="Your identity provider did not return an identity token")
    claims = _claims_from_id_token(id_token, hs["nonce"])

    sub = str(claims.get("oid") or claims.get("sub"))
    email = str(
        claims.get("email") or claims.get("preferred_username") or claims.get("upn") or ""
    ).lower()
    name = str(claims.get("name") or email)
    role_claim = claims.get(config.oidc_roles_claim)
    if isinstance(role_claim, list):
        claimed_roles = [str(x) for x in role_claim]
    elif role_claim:
        claimed_roles = [str(role_claim)]
    else:
        claimed_roles = []
    if not email:
        raise HTTPException(401, detail="Your identity provider did not return an email address")

    # App roles from Entra (values must equal role keys, e.g. "hr_admin") take precedence.
    role_rows = await db.many("SELECT id, key FROM roles")
    order = ["super_admin", "hr_admin", "hiring_manager", "recruiter", "interview_panel", "viewer"]
    candidates = [x for x in role_rows if x["key"] in claimed_roles]
    candidates.sort(key=lambda x: order.index(x["key"]) if x["key"] in order else 99)
    mapped = candidates[0] if candidates else None

    u = await db.one(
        """SELECT * FROM users
           WHERE (auth_provider=$1 AND external_id=$2) OR lower(email)=$3
           ORDER BY external_id NULLS LAST LIMIT 1""",
        ["oidc", sub, email],
    )
    if not u:
        if not config.oidc_auto_provision:
            raise HTTPException(
                401, detail="No TalentScreen account exists for you yet. Ask an administrator to add you."
            )
        role_id = mapped["id"] if mapped else next(
            (r["id"] for r in role_rows if r["key"] == config.oidc_default_role), None
        )
        u = await db.one(
            """INSERT INTO users (email, full_name, auth_provider, external_id, role_id)
               VALUES ($1,$2,'oidc',$3,$4) RETURNING *""",
            [email, name, sub, role_id],
        )
        await audit.record(
            AuditContext(user=None), "user.provisioned_sso", "user", str(u["id"]),
            {"email": email, "role": mapped["key"] if mapped else config.oidc_default_role},
        )
    else:
        await db.execute(
            """UPDATE users SET auth_provider='oidc', external_id=$2, full_name=$3,
                 role_id=COALESCE($4, role_id), last_login_at=now() WHERE id=$1""",
            [u["id"], sub, name, mapped["id"] if mapped else None],
        )
    user = await load_auth_user(str(u["id"]))
    if not user:
        raise HTTPException(401, detail="This account is suspended")
    await audit.record(
        AuditContext(user=user, ip=ctx.ip, userAgent=ctx.userAgent), "auth.login", "user", user.id,
        {"method": "oidc", "issuer": config.oidc_issuer},
    )
    token = issue_refresh_token()
    await _store_refresh(user.id, token, ctx)
    return token


def _url_encode(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")
