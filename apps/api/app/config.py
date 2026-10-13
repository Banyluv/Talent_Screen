"""Central configuration, read once from environment variables.

Every variable is documented in /.env.example at the repo root.
"""
from __future__ import annotations

import os

_TRUTHY = ("1", "true", "yes", "on")


def _req(name: str, fallback: str | None = None) -> str:
    v = os.environ.get(name, fallback)
    if v is None or v == "":
        raise RuntimeError(f"Missing required environment variable {name}")
    return v


def _bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in _TRUTHY


def _int(name: str, default: int) -> int:
    v = os.environ.get(name)
    if not v:
        return default
    try:
        return int(v, 10)
    except ValueError:
        return default


is_production = os.environ.get("NODE_ENV") == "production"

env = os.environ.get("NODE_ENV") or "development"
port = _int("API_PORT", 8000)
public_url = os.environ.get("PUBLIC_URL") or "http://localhost:8080"
cors_origins = [
    s.strip()
    for s in (os.environ.get("CORS_ORIGINS") or "http://localhost:8080,http://localhost:5173").split(",")
    if s.strip()
]

# ---------------------------------------------------------------- database
db_url = _req("DATABASE_URL", "postgres://talentscreen:talentscreen@localhost:5432/talentscreen")
db_ssl = _bool("DATABASE_SSL")
db_pool_max = _int("DATABASE_POOL_MAX", 10)

# ------------------------------------------------------------------- auth
jwt_secret = _req("JWT_SECRET", None if is_production else "dev-only-change-me-dev-only-change-me")
access_ttl_sec = _int("JWT_ACCESS_TTL_SECONDS", 900)
refresh_ttl_days = _int("JWT_REFRESH_TTL_DAYS", 7)
local_login_enabled = _bool("LOCAL_LOGIN_ENABLED", True)
max_failed_logins = _int("MAX_FAILED_LOGINS", 5)
lockout_minutes = _int("LOCKOUT_MINUTES", 15)

oidc_enabled = _bool("OIDC_ENABLED")
oidc_display_name = os.environ.get("OIDC_DISPLAY_NAME") or "Microsoft Entra ID"
oidc_issuer = os.environ.get("OIDC_ISSUER") or ""
oidc_client_id = os.environ.get("OIDC_CLIENT_ID") or ""
oidc_client_secret = os.environ.get("OIDC_CLIENT_SECRET") or ""
oidc_redirect_uri = os.environ.get("OIDC_REDIRECT_URI") or "http://localhost:8080/api/auth/oidc/callback"
oidc_roles_claim = os.environ.get("OIDC_ROLES_CLAIM") or "roles"
oidc_auto_provision = _bool("OIDC_AUTO_PROVISION", True)
oidc_default_role = os.environ.get("OIDC_DEFAULT_ROLE") or "viewer"

# -------------------------------------------------------------- bootstrap
admin_email = os.environ.get("BOOTSTRAP_ADMIN_EMAIL") or "admin@ecews.local"
admin_password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD") or ""
admin_name = os.environ.get("BOOTSTRAP_ADMIN_NAME") or "System Administrator"
organisation = (
    os.environ.get("ORGANISATION_NAME") or "Excellence Community Education Welfare Scheme (ECEWS)"
)
seed_demo = _bool("SEED_DEMO_DATA")

# A vacancy whose closing date has passed by more than this many days is hidden
# from vacancy listings (see app/access.py: job_visible_sql). 0 hides it the day
# after it closes; the default of 1 keeps it listed for one further day.
job_expiry_grace_days = _int("JOB_EXPIRY_GRACE_DAYS", 1)

# The web app's own origin. The browser calls the API directly, so the API needs
# this to redirect back to the correct origin after single sign-on.
web_url = (os.environ.get("FRONTEND_URL") or public_url).rstrip("/")
# Set to "none" when the web app and the API are served from different sites.
cookie_samesite = os.environ.get("COOKIE_SAMESITE") or "strict"

# ---------------------------------------------------------------- storage
data_key = _req(
    "DATA_ENCRYPTION_KEY",
    None if is_production else "ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE=",
)

storage_driver = os.environ.get("STORAGE_DRIVER") or "local"
storage_local_dir = os.environ.get("STORAGE_LOCAL_DIR") or "./data/uploads"
s3_endpoint = os.environ.get("S3_ENDPOINT") or ""
s3_region = os.environ.get("S3_REGION") or "us-east-1"
s3_bucket = os.environ.get("S3_BUCKET") or "talentscreen-cvs"
s3_access_key_id = os.environ.get("S3_ACCESS_KEY_ID") or ""
s3_secret_access_key = os.environ.get("S3_SECRET_ACCESS_KEY") or ""
s3_force_path_style = _bool("S3_FORCE_PATH_STYLE", True)
azure_connection_string = os.environ.get("AZURE_STORAGE_CONNECTION_STRING") or ""
azure_container = os.environ.get("AZURE_STORAGE_CONTAINER") or "talentscreen-cvs"
max_upload_mb = _int("MAX_UPLOAD_MB", 10)
max_bulk_files = _int("MAX_BULK_FILES", 50)

# --------------------------------------------------------------------- ai
azure_openai_endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT") or ""
azure_openai_api_key = os.environ.get("AZURE_OPENAI_API_KEY") or ""
azure_openai_deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT") or ""
azure_openai_api_version = os.environ.get("AZURE_OPENAI_API_VERSION") or "2024-10-21"
openai_api_key = os.environ.get("OPENAI_API_KEY") or ""
openai_model = os.environ.get("OPENAI_MODEL") or "gpt-4o-mini"
openai_base_url = os.environ.get("OPENAI_BASE_URL") or ""
ai_timeout_ms = _int("AI_TIMEOUT_MS", 60000)

# ------------------------------------------------------------------ queue
# When true the API evaluates CVs in-process (single-container/dev). Production runs the worker service.
queue_inline = _bool("EVALUATE_INLINE")
queue_concurrency = _int("WORKER_CONCURRENCY", 2)

# ------------------------------------------------------------------- mail
mail_host = os.environ.get("SMTP_HOST") or ""
mail_port = _int("SMTP_PORT", 587)
mail_secure = _bool("SMTP_SECURE")
mail_user = os.environ.get("SMTP_USER") or ""
mail_pass = os.environ.get("SMTP_PASS") or ""
mail_from = os.environ.get("SMTP_FROM") or "TalentScreen <no-reply@ecews.org>"
