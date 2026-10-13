"""Password hashing and JSON Web Tokens (HS256), matching the previous API exactly."""
from __future__ import annotations

import re
import time
from typing import Any

import bcrypt
import jwt

from . import config

PASSWORD_RULE = "At least 12 characters, including upper- and lower-case letters and a number"

_HAS_LOWER = re.compile(r"[a-z]")
_HAS_UPPER = re.compile(r"[A-Z]")
_HAS_DIGIT = re.compile(r"\d")

ISSUER = "talentscreen"
AUDIENCE = "talentscreen-web"


def strong_password(p: str) -> bool:
    return bool(
        p
        and len(p) >= 12
        and _HAS_LOWER.search(p)
        and _HAS_UPPER.search(p)
        and _HAS_DIGIT.search(p)
    )


def hash_password(password: str, rounds: int = 12) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds)).decode("utf-8")


def verify_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def sign(payload: dict[str, Any], *, expires_in: int, audience: str = AUDIENCE) -> str:
    now = int(time.time())
    body = {
        **payload,
        "iat": now,
        "exp": now + expires_in,
        "iss": ISSUER,
        "aud": audience,
    }
    return jwt.encode(body, config.jwt_secret, algorithm="HS256")


def access_token(user_id: str, name: str, role: str) -> str:
    return sign({"sub": user_id, "name": name, "role": role}, expires_in=config.access_ttl_sec)


def verify(token: str, *, audience: str = AUDIENCE) -> dict[str, Any]:
    return jwt.decode(
        token,
        config.jwt_secret,
        algorithms=["HS256"],
        issuer=ISSUER if audience == AUDIENCE else None,
        audience=audience,
    )
