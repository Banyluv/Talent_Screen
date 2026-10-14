# ECEWS TalentScreen

AI-assisted recruitment and shortlisting for **Excellence Community Education Welfare Scheme (ECEWS)**.
HR uploads CVs against a vacancy; the system extracts each candidate's profile, scores it against the vacancy's
requirements with configurable weights, explains every score with quoted CV evidence, and ranks the pool.
People make every decision: recommendations can be overridden with a recorded reason, and every action is audited.

> **Decision support only.** TalentScreen never hires, rejects or contacts anyone by itself.

---

## Contents
1. [Quick start (Docker)](#quick-start-docker)
2. [What's inside](#whats-inside)
3. [Roles](#roles)
4. [How a CV is evaluated](#how-a-cv-is-evaluated)
5. [Configuration](#configuration)
6. [Single sign-on with Microsoft Entra ID](#single-sign-on-with-microsoft-entra-id)
7. [Using Azure OpenAI](#using-azure-openai)
8. [Going to production](#going-to-production)
9. [Operations](#operations)
10. [Development](#development)
11. [Project layout](#project-layout)

---

## Quick start (Docker)

Requirements: Docker Engine 24+ with Compose v2.24+, and `openssl`.

```bash
cp .env.example .env
./scripts/init-env.sh            # generates database, storage, JWT and encryption secrets
docker compose up -d --build     # first build takes a few minutes
docker compose logs migrate      # shows the one-time Super Administrator password
```

Open **http://localhost:8080** and sign in as `BOOTSTRAP_ADMIN_EMAIL` with the password from the `migrate` log
(or the one you set in `.env`). You will be asked to choose a new password.

With `SEED_DEMO_DATA=true` (the default in `.env.example`) you also get two vacancies, seven fictitious CVs
already evaluated, and one account per role, all with the password `Demo-Password-2026`:

| Role | Email |
|---|---|
| HR Administrator | `hr.admin@demo.ecews.local` |
| Hiring Manager | `hiring.manager@demo.ecews.local` |
| Recruiter | `recruiter@demo.ecews.local` |
| Interview Panel | `panel.it@demo.ecews.local`, `panel.si@demo.ecews.local` |
| Viewer | `viewer@demo.ecews.local` |

Check the whole stack end to end (45 checks: sign-in, RBAC, upload, evaluation, override, interviews, exports, audit):

```bash
pip install requests
python3 scripts/smoke_test.py --base http://localhost:8080 --admin-email <admin email> --admin-password '<password>'
```

**HTTPS on a server:** set `DOMAIN` and `PUBLIC_URL=https://…` in `.env`, point DNS at the host, open ports 80/443, then
`docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d`. Caddy obtains and renews the certificate.

**No MinIO?** Set `STORAGE_DRIVER=local` to keep encrypted CV files on the `uploads` Docker volume instead.

API documentation (OpenAPI/Swagger) is served at **/api/docs**.

---

## What's inside

| Service | Image | Purpose |
|---|---|---|
| `web` | `talentscreen-web` (nginx) | React app; proxies `/api`; security headers |
| `api` | `talentscreen-api` | FastAPI (Python) REST API: auth, RBAC, vacancies, candidates, evaluations, interviews, reports, audit |
| `worker` | `talentscreen-api` | Evaluates queued CVs; nightly data-retention sweep. Scale with `WORKER_REPLICAS` |
| `migrate` | `talentscreen-api` | One-shot: applies SQL migrations, seeds roles and permissions, creates the first admin |
| `postgres` | `postgres:16-alpine` | All data, plus the durable job queue (a table in Postgres) |
| `minio` | `minio/minio` | S3-compatible store for encrypted CV files (console on `127.0.0.1:9001`) |

Front-end pages: sign-in, dashboard, vacancies (create, request, approve, edit, close), CV upload (single, bulk,
pasted text), candidate list and search, candidate assessment, ranking/shortlist, side-by-side comparison,
interviews (schedule, panel scoring, hiring recommendation), reports with PDF/Excel/CSV export, users, roles and
permissions, scoring and AI settings, audit log, notification centre, account.

---

## Roles

Permissions are stored in the database; a Super Administrator can change any role's grants or create new roles
on **Roles & permissions** without a code change. Defaults:

| | Super Admin | HR Admin | Hiring Manager | Recruiter | Interview Panel | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Users, roles, organisations | ✓ | | | | | |
| Scoring and AI settings | ✓ | | | | | |
| Audit log | ✓ | | | | | |
| Create / approve vacancies | ✓ | ✓ | | | | |
| Raise hiring requests | ✓ | | ✓ | | | |
| Upload CVs | ✓ | ✓ | | ✓ | | |
| View evaluations and rankings | ✓ | ✓ | ✓ | ✓ | | |
| Override recommendations | ✓ | ✓ | | | | |
| Schedule interviews | ✓ | ✓ | | ✓ | | |
| Score interviews | ✓ | | ✓ | | ✓ | |
| Hiring recommendations | ✓ | | ✓ | | | |
| Reports (view) | ✓ | ✓ | ✓ | | | ✓ |
| Reports (export) | ✓ | ✓ | | | | |
| Erase candidate data | ✓ | ✓ | | | | |

Row-level rules apply on top: recruiters and hiring managers see only vacancies assigned to them; panel members see
only candidates they interview (and never contact details); viewers see aggregate reports only.

---

## How a CV is evaluated

1. **Extract** text from PDF (pdf.js), DOCX (mammoth) or TXT. File type is checked by content, not the browser's claim.
   Scanned image-only PDFs are rejected with a clear message.
2. **Parse** a structured profile: contacts, employment history with dates (overlaps merged), education level,
   certifications, skills, languages, memberships, awards, publications, projects.
3. **Match** every requirement (mandatory, technical, certifications, soft, preferred, industry, nice-to-have)
   against the CV using a synonym dictionary (`apps/api/src/evaluation/engine/aliases.ts`); each match keeps the
   CV line that proves it.
4. **Optional AI step** (Azure OpenAI or OpenAI): only requirements the rules could *not* evidence are sent, with the
   CV passages retrieved for each one (BM25 retrieval), after removing the candidate's name, email and phone.
   The model must quote the CV word for word; any claim whose quote is not in the retrieved passages is discarded
   and logged. AI-matched evidence is labelled and flagged for human confirmation.
5. **Score**, always deterministically:
   `overall = Σ(component × weight) / 100` over qualifications, technical skills, relevant experience,
   certifications, preferred skills and career progression. Weights are configurable per organisation and per vacancy.
6. **Recommend**: hard rules first (missing mandatory requirement, or experience below the minimum → Reject;
   both switchable), then thresholds (default Shortlist ≥ 85, Consider ≥ 65, Hold ≥ 50, else Reject).
7. **Explain**: strengths with quoted evidence, gaps, a one-paragraph justification and, if AI is on, a short
   narrative written only from the computed facts.

Name, gender, age, photo, religion, marital status and state of origin are never used. A unit test proves that
adding them to a CV does not change the score.

---

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the full, commented list. Key ones:

| Variable | Notes |
|---|---|
| `PUBLIC_URL` | Address users type. Use `https://…` in production (enables Secure cookies). |
| `DATA_ENCRYPTION_KEY` | 32 bytes, base64. Encrypts CV files, CV text and contact details (AES-256-GCM). **Back it up**; without it stored CVs cannot be read. |
| `JWT_SECRET` | Signs 15-minute access tokens. Refresh tokens are random, hashed, rotated, httpOnly. |
| `STORAGE_DRIVER` | `s3` (MinIO/S3), `azure` (Blob Storage, `AZURE_STORAGE_CONNECTION_STRING`) or `local`. |
| `SEED_DEMO_DATA` | `false` in production. |
| `SMTP_HOST` | Outbound email (e.g. to interview panel members). Set with `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`; test from **Settings → Outbound email**. |
| `LOCAL_LOGIN_ENABLED` | Set `false` once SSO works to make Entra ID the only sign-in. |

Scoring weights, thresholds, hard rules, AI provider, evidence and redaction options and the retention period are
changed in the app (**Scoring & AI**), and every change is audited.

---

## Single sign-on with Microsoft Entra ID

1. Entra admin centre → **App registrations → New registration**: name `TalentScreen`, single tenant,
   redirect URI (Web) `https://<your host>/api/auth/oidc/callback`.
2. **Certificates & secrets** → new client secret.
3. **App roles** → create roles whose **Value** equals the TalentScreen role key:
   `super_admin`, `hr_admin`, `hiring_manager`, `recruiter`, `interview_panel`, `viewer`.
4. **Enterprise applications → TalentScreen → Users and groups**: assign people or groups to roles.
5. In `.env`:
   ```
   OIDC_ENABLED=true
   OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
   OIDC_CLIENT_ID=<application (client) id>
   OIDC_CLIENT_SECRET=<secret value>
   ```
6. `docker compose up -d`. The sign-in page shows **Sign in with Microsoft Entra ID**.

Users are created on first sign-in with the role from their Entra app role (or `OIDC_DEFAULT_ROLE`). If a user has
no app role, their TalentScreen role is kept. Keycloak and other OIDC providers work the same way.

---

## Using Azure OpenAI

1. Create an Azure OpenAI resource and deploy a chat model (e.g. `gpt-4o-mini`).
2. Set `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` in `.env` and restart `api` and `worker`.
3. **Scoring & AI → Evaluation engine → Azure OpenAI + rules → Save.**

If the provider is unreachable, evaluations fall back to the rules engine and the note is shown on the candidate.

---

## Going to production

- [ ] `SEED_DEMO_DATA=false`; set `BOOTSTRAP_ADMIN_EMAIL` to a real administrator.
- [ ] HTTPS (Caddy overlay, or your own reverse proxy/ingress). Set `PUBLIC_URL=https://…`.
- [ ] Store `DATA_ENCRYPTION_KEY`, `JWT_SECRET` and database credentials in a secret store (e.g. Azure Key Vault).
- [ ] Back up Postgres daily (`docker compose exec postgres pg_dump -U talentscreen talentscreen | gzip > backup.sql.gz`) and the MinIO volume; test a restore.
- [ ] Enable SSO and set `LOCAL_LOGIN_ENABLED=false` when ready.
- [ ] Review default role grants and the retention period with HR and your Data Protection Officer (NDPA 2023 / GDPR).
- [ ] Configure SMTP if you want email notifications.

Kubernetes (AKS) manifests are in [`deploy/k8s`](deploy/k8s): run the migrate Job, then apply the app manifests.
Use Azure Database for PostgreSQL Flexible Server (allow-list the `pgcrypto` and `pg_trgm` extensions) and
`STORAGE_DRIVER=azure`. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs unit tests and the end-to-end smoke
test against Postgres, then pushes both images to GHCR.

---

## Operations

| Task | Command |
|---|---|
| Logs | `docker compose logs -f api worker` |
| More evaluation throughput | `WORKER_REPLICAS=3 docker compose up -d worker` (and/or `WORKER_CONCURRENCY`) |
| Upgrade | `git pull && docker compose up -d --build` (migrations run automatically) |
| Verify audit integrity | Audit log page, or `GET /api/audit/verify` |
| Re-score a vacancy | Vacancy → **Re-score all** |
| Erase a candidate (data-protection request) | Candidate → **Erase personal data** |

The audit log is append-only at the database level (UPDATE/DELETE/TRUNCATE are rejected by triggers) and each entry
is hash-chained to the previous one, so tampering by a database superuser is detectable.

---

## Development

The API is Python 3.12+ (FastAPI). The front end is React + Vite and talks to the API
directly, so the API needs to allow the dev origin (the default `CORS_ORIGINS` already
includes `http://localhost:5173`).

```bash
# Postgres 16 on localhost:5432 with database/user "talentscreen", then:
cd apps/api
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m app.migrate                              # applies SQL migrations, seeds reference data
EVALUATE_INLINE=true python -m app.main            # http://localhost:8000 (docs at /api/docs)
python -m app.worker                               # or run the worker alongside the API
python -m pytest test/test_engine.py               # engine unit tests

cd apps/web && npm install && npm run dev          # http://localhost:5173 → API on :8000
```

**Windows, without Docker.** `scripts/dev-windows.ps1` starts the API and the web
dev server together and writes their logs to `.logs/`:

```powershell
./scripts/dev-windows.ps1 -Seed     # run migrations + seed the demo data, then start
./scripts/dev-windows.ps1           # start API on :8000 and web on :5173
./scripts/dev-windows.ps1 -Stop     # stop both
```

It points `DATABASE_URL` at `127.0.0.1` on purpose: `localhost` resolves to `::1`,
which a local PostgreSQL often authenticates differently from IPv4.

Point the front end at a different API with `VITE_API_URL` (defaults to
`http://localhost:8000` in development and to the web app's own origin in a build,
which is what the Docker/nginx reverse proxy uses).

To wipe the demonstration content from the database:

```bash
cd apps/api && python -m app.clear_demo
```

It removes the `DEMO-` vacancies with everything hanging off them, the
`@demo.ecews.local` accounts, and any notification or finished queue entry still
pointing at deleted content. Safe to re-run; reference data and the append-only,
hash-chained audit trail (which the database refuses to modify) are left alone.

---

## Project layout

```
apps/api/                FastAPI (Python) API + worker (one image)
  app/engine/            extract → parse → match → (RAG + LLM) → score
  app/routers/           REST endpoints
  app/services/          evaluation, candidates, report exports
  migrations/            SQL schema (append-only audit, encrypted columns, job queue)
  seed/                  fictitious demo vacancies and CVs
  test/                  engine unit tests (pytest)
apps/web/                React + Vite front end, nginx config
deploy/k8s/              Kubernetes manifests (AKS reference)
deploy/caddy/            HTTPS reverse proxy for the TLS overlay
docs/                    system design document
scripts/                 init-env.sh, smoke_test.py
docker-compose.yml       full stack;  docker-compose.tls.yml  HTTPS overlay
```
