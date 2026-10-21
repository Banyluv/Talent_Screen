"""External applicant portal: self-registration, profile, CV upload, public job
browsing, applications and status tracking.

Applicants are a separate population from internal users and authenticate with
their own JWT audience, so a portal session can never reach internal routes.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import config, crypto, db, security, storage
from ..access import job_expiry_cutoff
from ..deps import current_applicant, login_rate_limit
from ..engine import extract, parser
from ..services.evaluation import service as evaluations
from ..validation import EMAIL_PATTERN

router = APIRouter(prefix="/portal", tags=["applicant-portal"])
log = logging.getLogger("portal")

REFRESH_COOKIE = "ts_app_refresh"


def _set_refresh(res: Response, token: str) -> None:
    secure = config.public_url.startswith("https") or config.cookie_samesite == "none"
    res.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=config.refresh_ttl_days * 86400,
        path="/api/portal",
        httponly=True,
        secure=secure,
        samesite=config.cookie_samesite,
    )


async def _store_refresh(applicant_id: str, token: str, request: Request) -> None:
    await db.execute(
        """INSERT INTO applicant_tokens (applicant_id, token_hash, expires_at, user_agent, ip)
           VALUES ($1,$2, now() + ($3 || ' days')::interval, $4, $5)""",
        [
            applicant_id,
            crypto.sha256(token),
            str(config.refresh_ttl_days),
            (request.headers.get("user-agent") or "")[:300],
            request.client.host if request.client else None,
        ],
    )


async def _applicant(applicant_id: str) -> dict[str, Any] | None:
    return await db.one(
        """SELECT id, email, full_name, phone, headline, summary, location, skills,
                  cv_file_name, cv_file_mime, created_at, updated_at
           FROM applicants WHERE id = $1""",
        [applicant_id],
    )


class RegisterBody(BaseModel):
    email: str = Field(pattern=EMAIL_PATTERN, max_length=254)
    password: str = Field(min_length=12, max_length=200)
    fullName: str = Field(min_length=2, max_length=120)


class LoginBody(BaseModel):
    email: str = Field(pattern=EMAIL_PATTERN, max_length=254)
    password: str = Field(min_length=1)


class ProfileBody(BaseModel):
    fullName: str = Field(min_length=2, max_length=120)
    phone: str = Field(default="", max_length=40)
    headline: str = Field(default="", max_length=160)
    summary: str = Field(default="", max_length=4000)
    location: str = Field(default="", max_length=160)
    skills: list[str] = Field(default_factory=list, max_length=40)


async def _login_response(applicant_id: str, request: Request, response: Response) -> JSONResponse:
    a = await db.one("SELECT id, email, full_name FROM applicants WHERE id=$1", [applicant_id])
    refresh = crypto.token()
    await _store_refresh(applicant_id, refresh, request)
    token = security.applicant_access_token(applicant_id, a["full_name"])
    res = JSONResponse({
        "accessToken": token,
        "applicant": {"id": str(a["id"]), "email": a["email"], "fullName": a["full_name"]},
    })
    _set_refresh(res, refresh)
    return res


@router.post("/register", status_code=201)
async def register(body: RegisterBody, request: Request, response: Response):
    email = body.email.strip().lower()
    if not security.strong_password(body.password):
        raise HTTPException(400, detail=security.PASSWORD_RULE)
    exists = await db.value("SELECT 1 FROM applicants WHERE lower(email)=lower($1)", [email])
    if exists:
        raise HTTPException(409, detail="An account with this email already exists")
    applicant_id = str(uuid.uuid4())
    await db.execute(
        """INSERT INTO applicants (id, email, password_hash, full_name)
           VALUES ($1,$2,$3,$4)""",
        [applicant_id, email, security.hash_password(body.password), body.fullName.strip()],
    )
    return await _login_response(applicant_id, request, response)


@router.post("/login", dependencies=[Depends(login_rate_limit)])
async def login(body: LoginBody, request: Request, response: Response):
    email = body.email.strip().lower()
    a = await db.one("SELECT * FROM applicants WHERE lower(email)=lower($1)", [email])
    if not a:
        raise HTTPException(401, detail="Email or password is incorrect")
    if not a["is_active"]:
        raise HTTPException(401, detail="This account has been suspended")
    locked = a.get("locked_until")
    if locked and locked > datetime.now(timezone.utc):
        raise HTTPException(401, detail="Too many failed attempts. Try again later.")
    if not security.verify_password(body.password, a["password_hash"]):
        n = (a.get("failed_logins") or 0) + 1
        lock = n >= config.max_failed_logins
        await db.execute(
            """UPDATE applicants SET failed_logins=$2,
                 locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE NULL END
               WHERE id=$1""",
            [a["id"], 0 if lock else n, lock, str(config.lockout_minutes)],
        )
        raise HTTPException(401, detail="Email or password is incorrect")
    await db.execute(
        "UPDATE applicants SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1",
        [a["id"]],
    )
    return await _login_response(str(a["id"]), request, response)


@router.post("/refresh")
async def refresh(request: Request, response: Response):
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(401, detail="No session")
    row = await db.one("SELECT * FROM applicant_tokens WHERE token_hash=$1", [crypto.sha256(token)])
    if not row or row["revoked_at"]:
        raise HTTPException(401, detail="Session not recognised")
    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(401, detail="Session expired")
    a = await db.one("SELECT id, email, full_name, is_active FROM applicants WHERE id=$1", [row["applicant_id"]])
    if not a or not a["is_active"]:
        raise HTTPException(401, detail="Account suspended")
    await db.execute("UPDATE applicant_tokens SET revoked_at=now() WHERE id=$1", [row["id"]])
    return await _login_response(str(a["id"]), request, response)


@router.post("/logout", status_code=204)
async def logout(request: Request):
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        await db.execute(
            "UPDATE applicant_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
            [crypto.sha256(token)],
        )
    res = Response(status_code=204)
    res.delete_cookie(REFRESH_COOKIE, path="/api/portal")
    return res


@router.get("/me")
async def me(applicant: dict = Depends(current_applicant)):
    a = await _applicant(applicant["id"])
    return {"applicant": a}


@router.put("/me")
async def update_profile(body: ProfileBody, applicant: dict = Depends(current_applicant)):
    await db.execute(
        """UPDATE applicants SET full_name=$2, phone=$3, headline=$4, summary=$5, location=$6,
             skills=$7, updated_at=now() WHERE id=$1""",
        [
            applicant["id"], body.fullName.strip(), body.phone.strip(), body.headline.strip(),
            body.summary.strip(), body.location.strip(), [s.strip() for s in body.skills if s.strip()],
        ],
    )
    a = await _applicant(applicant["id"])
    return {"applicant": a}


@router.post("/me/cv")
async def upload_cv(file: UploadFile = File(...), applicant: dict = Depends(current_applicant)):
    data = await file.read()
    name = (file.filename or "cv")[:200]
    if len(data) > config.max_upload_mb * 1024 * 1024:
        raise HTTPException(400, detail=f"Larger than {config.max_upload_mb} MB")
    type_ = extract.detect_type(name, file.content_type or "", data)
    if not type_:
        raise HTTPException(400, detail="Only PDF, DOCX and TXT files are accepted")
    store = await storage.get()
    key = f"{applicant['id']}/{str(uuid.uuid4())}.{type_}"
    await store.put(key, data)
    await db.execute(
        """UPDATE applicants SET cv_file_key=$2, cv_file_name=$3, cv_file_mime=$4, cv_file_sha256=$5,
             updated_at=now() WHERE id=$1""",
        [applicant["id"], key, name, file.content_type or "", crypto.sha256(data)],
    )
    a = await _applicant(applicant["id"])
    return {"applicant": a}


# ---------------------------------------------------------------- public jobs
@router.get("/jobs")
async def list_jobs(
    q: str | None = Query(default=None),
    department: str | None = Query(default=None),
    location: str | None = Query(default=None),
    employmentType: str | None = Query(default=None),
):
    params: list[Any] = [job_expiry_cutoff()]
    where = ["j.status = 'open'", "(j.closes_on IS NULL OR j.closes_on >= $1::date)"]
    if q and q.strip():
        params.append(f"%{q.strip()}%")
        where.append(
            f"(j.title ILIKE ${len(params)} OR j.ref_code ILIKE ${len(params)} OR j.location ILIKE ${len(params)}"
            f" OR j.description ILIKE ${len(params)} OR d.name ILIKE ${len(params)})"
        )
    if department and department.strip():
        params.append(department.strip())
        where.append(f"d.name = ${len(params)}")
    if location and location.strip():
        params.append(f"%{location.strip()}%")
        where.append(f"j.location ILIKE ${len(params)}")
    if employmentType and employmentType.strip():
        params.append(employmentType.strip())
        where.append(f"j.employment_type = ${len(params)}")
    return await db.many(
        f"""SELECT j.id, j.ref_code, j.title, j.location, j.employment_type, j.description, j.project,
                   j.number_of_positions, j.reports_to, j.level_of_effort, j.minimum_recruitment_standard,
                   j.closes_on, j.created_at, d.name AS department
            FROM jobs j LEFT JOIN departments d ON d.id = j.department_id
            WHERE {' AND '.join(where)} ORDER BY j.created_at DESC""",
        params,
    )


@router.get("/jobs/{job_id}")
async def get_job(job_id: uuid.UUID):
    j = await db.one(
        """SELECT j.id, j.ref_code, j.title, j.location, j.employment_type, j.description, j.project,
                  j.number_of_positions, j.reports_to, j.level_of_effort, j.minimum_recruitment_standard,
                  j.closes_on, j.created_at, d.name AS department
           FROM jobs j LEFT JOIN departments d ON d.id = j.department_id
           WHERE j.id = $1 AND j.status = 'open'""",
        [str(job_id)],
    )
    if not j:
        raise HTTPException(404, detail="Vacancy not found or no longer open")
    return j


# ---------------------------------------------------------------- applications
@router.post("/jobs/{job_id}/apply", status_code=201)
async def apply(
    job_id: uuid.UUID,
    coverLetter: str = Form(default=""),
    file: UploadFile | None = File(default=None),
    applicant: dict = Depends(current_applicant),
):
    job = await db.one("SELECT id, status, title FROM jobs WHERE id=$1", [str(job_id)])
    if not job or job["status"] != "open":
        raise HTTPException(404, detail="This vacancy is no longer open for applications")
    existing = await db.value(
        "SELECT 1 FROM applications WHERE applicant_id=$1 AND job_id=$2", [applicant["id"], str(job_id)]
    )
    if existing:
        raise HTTPException(409, detail="You have already applied to this vacancy")

    a = await db.one(
        "SELECT full_name, email, phone, cv_file_key, cv_file_name, cv_file_mime FROM applicants WHERE id=$1",
        [applicant["id"]],
    )
    key, name, mime = a["cv_file_key"], a["cv_file_name"], a["cv_file_mime"]
    store = await storage.get()
    data: bytes | None = None

    if file is not None:
        data = await file.read()
        name = (file.filename or "cv")[:200]
        if len(data) > config.max_upload_mb * 1024 * 1024:
            raise HTTPException(400, detail=f"Larger than {config.max_upload_mb} MB")
        type_ = extract.detect_type(name, file.content_type or "", data)
        if not type_:
            raise HTTPException(400, detail="Only PDF, DOCX and TXT files are accepted")
        key = f"{applicant['id']}/{str(uuid.uuid4())}.{type_}"
        await store.put(key, data)
        mime = file.content_type or ""
    elif key:
        # Apply using the profile CV: read it back so it can be scored too.
        try:
            data = await store.get(key)
        except Exception:
            data = None

    candidate_id = None
    if data:
        candidate_id = await _create_candidate_and_evaluate(job, a, name, mime, data, key)

    app_id = await db.value(
        """INSERT INTO applications (applicant_id, job_id, cover_letter, cv_file_key, cv_file_name, cv_file_mime, candidate_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
        [applicant["id"], str(job_id), coverLetter.strip()[:5000], key, name, mime, candidate_id],
    )
    return {
        "applicationId": str(app_id),
        "status": "submitted",
        "jobTitle": job["title"],
        "evaluating": candidate_id is not None,
    }


async def _create_candidate_and_evaluate(
    job: dict[str, Any],
    applicant: dict[str, Any],
    file_name: str,
    file_mime: str,
    data: bytes,
    file_key: str | None,
) -> str | None:
    """Create an internal candidate from an applicant CV and queue it for scoring.

    Returns the new candidate id, or None if the CV could not be parsed.
    """
    type_ = extract.detect_type(file_name, file_mime, data)
    if not type_:
        return None
    try:
        text = extract.extract_text(data, type_)
        cv = parser.parse_cv(text)
    except Exception:
        log.warning("Could not parse applicant CV for job %s", job["id"])
        return None

    sha = crypto.sha256(data)
    dup = await db.one(
        "SELECT id FROM candidates WHERE job_id=$1 AND file_sha256=$2 AND erased_at IS NULL",
        [job["id"], sha],
    )
    if dup:
        return str(dup["id"])

    cand_id = str(uuid.uuid4())
    key = file_key or f"{job['id']}/{cand_id}.{type_}"
    if not file_key:
        store = await storage.get()
        await store.put(key, data)

    batch_id = str(uuid.uuid4())

    async def write(q: db.Conn) -> str:
        await q.exec(
            """INSERT INTO candidates (id, job_id, full_name, email_enc, phone_enc, file_key, file_name,
                 file_mime, file_sha256, cv_text_enc, search_text, source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'application')""",
            [
                cand_id, job["id"], applicant["full_name"] or cv["name"],
                crypto.encrypt(applicant["email"]), crypto.encrypt(applicant["phone"]),
                key, file_name, file_mime, sha, crypto.encrypt(text), cv["name"].lower(),
            ],
        )
        return await evaluations.request(cand_id, None, batch_id, q)

    evaluation_id = await db.tx(write)
    await evaluations.enqueue(evaluation_id, batch_id)
    return cand_id


@router.get("/applications")
async def list_applications(applicant: dict = Depends(current_applicant)):
    return await db.many(
        """SELECT ap.id, ap.status, ap.cover_letter, ap.cv_file_name, ap.created_at, ap.updated_at,
                  j.id AS job_id, j.title, j.ref_code, j.location, j.employment_type, d.name AS department
           FROM applications ap JOIN jobs j ON j.id = ap.job_id
           LEFT JOIN departments d ON d.id = j.department_id
           WHERE ap.applicant_id = $1 ORDER BY ap.created_at DESC""",
        [applicant["id"]],
    )


@router.post("/applications/{application_id}/withdraw")
async def withdraw(application_id: uuid.UUID, applicant: dict = Depends(current_applicant)):
    row = await db.one(
        "SELECT id, status FROM applications WHERE id=$1 AND applicant_id=$2",
        [str(application_id), applicant["id"]],
    )
    if not row:
        raise HTTPException(404, detail="Application not found")
    if row["status"] not in ("submitted", "under_review"):
        raise HTTPException(400, detail="This application can no longer be withdrawn")
    await db.execute(
        "UPDATE applications SET status='withdrawn', updated_at=now() WHERE id=$1", [row["id"]]
    )
    return {"status": "withdrawn"}
