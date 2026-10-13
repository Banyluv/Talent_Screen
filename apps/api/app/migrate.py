"""One-shot migration runner: applies SQL migrations, seeds reference data and the first admin."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import uuid
from pathlib import Path

import asyncpg

from . import config, crypto, db, security
from .permissions import DEFAULT_ROLES, PERMISSIONS

log = logging.getLogger("migrate")
logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")

API_DIR = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = API_DIR / "migrations"
SEED_DIR = API_DIR / "seed"


async def migrate(pool: asyncpg.Pool) -> None:
    await pool.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    )
    files = sorted(f for f in MIGRATIONS_DIR.iterdir() if f.suffix == ".sql")
    for f in files:
        done = await pool.fetchval("SELECT 1 FROM schema_migrations WHERE name=$1", f.name)
        if done:
            continue
        sql = f.read_text(encoding="utf-8")
        async with pool.acquire() as c:
            async with c.transaction():
                await c.execute("SELECT pg_advisory_xact_lock(777001)")  # safe if two replicas start at once
                again = await c.fetchval("SELECT 1 FROM schema_migrations WHERE name=$1", f.name)
                if not again:
                    await c.execute(sql)
                    await c.execute("INSERT INTO schema_migrations (name) VALUES ($1)", f.name)
                    log.info("Applied %s", f.name)


async def seed_reference(pool: asyncpg.Pool) -> None:
    """Reference data. Safe to run on every start: inserts only what is missing."""
    for p in PERMISSIONS:
        await pool.execute(
            """INSERT INTO permissions (key, category, description) VALUES ($1,$2,$3)
               ON CONFLICT (key) DO UPDATE SET category=EXCLUDED.category, description=EXCLUDED.description""",
            p["key"], p["category"], p["description"],
        )
    for r in DEFAULT_ROLES:
        role_id = await pool.fetchval(
            """INSERT INTO roles (key, name, description, is_system) VALUES ($1,$2,$3,true)
               ON CONFLICT (key) DO NOTHING RETURNING id""",
            r["key"], r["name"], r["description"],
        )
        if role_id:
            # only grant defaults when the role is first created; admins own them afterwards
            await pool.execute(
                "INSERT INTO role_permissions SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING",
                role_id, r["permissions"],
            )
    # Super Administrator always holds every permission, including ones added in later releases.
    await pool.execute(
        """INSERT INTO role_permissions SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
           WHERE r.key='super_admin' ON CONFLICT DO NOTHING"""
    )

    org_id = await pool.fetchval(
        "INSERT INTO organisations (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
        config.organisation,
    )
    for d in [
        "Information Technology", "Human Resources", "Strategic Information", "Programmes",
        "Finance & Administration",
    ]:
        await pool.execute(
            "INSERT INTO departments (organisation_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            org_id, d,
        )
    await pool.execute(
        """INSERT INTO scoring_profiles (name, weights, thresholds, rules, is_default)
           SELECT 'Default', $1, $2, $3, true WHERE NOT EXISTS (SELECT 1 FROM scoring_profiles WHERE is_default)""",
        {"qualifications": 20, "technical": 30, "experience": 30, "certifications": 10, "preferred": 5, "progression": 5},
        {"shortlist": 85, "consider": 65, "hold": 50},
        {"enforceMinExperience": True, "enforceMandatory": True, "experienceBasis": "relevant"},
    )
    await pool.execute("INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT DO NOTHING")

    admins = await pool.fetchval(
        "SELECT 1 FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='super_admin' LIMIT 1"
    )
    if not admins:
        generated = not config.admin_password
        pwd = config.admin_password or (crypto.token(12) + "A1")
        await pool.execute(
            """INSERT INTO users (email, full_name, password_hash, role_id, must_change_password)
               VALUES ($1,$2,$3,(SELECT id FROM roles WHERE key='super_admin'), $4)""",
            config.admin_email.lower(), config.admin_name, security.hash_password(pwd), generated,
        )
        suffix = f" with one-time password: {pwd}  (change it at first sign-in)" if generated else ""
        log.warning("Created Super Administrator %s%s", config.admin_email, suffix)


async def seed_demo(pool: asyncpg.Pool) -> None:
    """Optional demonstration data (SEED_DEMO_DATA=true). Every record is clearly fictitious."""
    exists = await pool.fetchval("SELECT 1 FROM jobs WHERE ref_code LIKE 'DEMO-%' LIMIT 1")
    if exists:
        return
    log.info("Seeding demonstration data")
    from .engine import parser
    from .services import candidates as candidates_service
    from .services.evaluation import service as evaluations
    from .domain import AuditContext
    from . import storage

    demo_pwd = __import__("os").environ.get("DEMO_USER_PASSWORD") or "Demo-Password-2026"
    pwd_hash = security.hash_password(demo_pwd)

    async def dept(name: str) -> str | None:
        return await pool.fetchval("SELECT id FROM departments WHERE name=$1", name)

    users: dict[str, str] = {}
    demo_users = [
        ("hr", "hr.admin@demo.ecews.local", "Funmilayo Adeyemi", "hr_admin", "Human Resources"),
        ("hm", "hiring.manager@demo.ecews.local", "Dr. Kelechi Nwosu", "hiring_manager", "Strategic Information"),
        ("rec", "recruiter@demo.ecews.local", "Bisi Lawal", "recruiter", "Human Resources"),
        ("p1", "panel.it@demo.ecews.local", "Emeka Obi", "interview_panel", "Information Technology"),
        ("p2", "panel.si@demo.ecews.local", "Ngozi Ibe", "interview_panel", "Strategic Information"),
        ("view", "viewer@demo.ecews.local", "Musa Danladi", "viewer", "Programmes"),
    ]
    for key, email, name, role, d in demo_users:
        uid = await pool.fetchval(
            """INSERT INTO users (email, full_name, password_hash, role_id, department_id)
               VALUES ($1,$2,$3,(SELECT id FROM roles WHERE key=$4),$5)
               ON CONFLICT DO NOTHING RETURNING id""",
            email, name, pwd_hash, role, await dept(d),
        )
        users[key] = str(uid) if uid else str(
            await pool.fetchval("SELECT id FROM users WHERE lower(email)=$1", email)
        )

    jobs_data = json.loads((SEED_DIR / "demo-jobs.json").read_text(encoding="utf-8"))
    job_ids: dict[str, str] = {}
    for j in jobs_data:
        jid = await pool.fetchval(
            """INSERT INTO jobs (ref_code, title, department_id, location, employment_type, description, status,
                 requirements, hiring_manager_id, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9) RETURNING id""",
            j["ref"], j["title"], await dept(j["department"]), j["location"], j["type"], j["description"],
            j["requirements"], users["hm"], users["hr"],
        )
        job_ids[j["key"]] = str(jid)
        await pool.execute(
            "INSERT INTO job_assignments (job_id, user_id, kind) VALUES ($1,$2,'recruiter')", jid, users["rec"]
        )

    store = await storage.get()
    ctx = AuditContext(user=None)
    # CVs go through the real pipeline (encryption, storage, evaluation).
    for j in jobs_data:
        for filename in j["cvs"]:
            data = (SEED_DIR / "demo-cvs" / filename).read_bytes()
            text = data.decode("utf-8")
            cv = parser.parse_cv(text)
            cand_id = str(uuid.uuid4())
            key = f"{job_ids[j['key']]}/{cand_id}.txt"
            await store.put(key, data)
            await pool.execute(
                """INSERT INTO candidates (id, job_id, full_name, email_enc, phone_enc, file_key, file_name,
                     file_mime, file_sha256, cv_text_enc, search_text, created_by, source)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,'text/plain',$8,$9,$10,$11,'demo')""",
                cand_id, job_ids[j["key"]], cv["name"], crypto.encrypt(cv["email"]), crypto.encrypt(cv["phone"]),
                key, filename, crypto.sha256(data), crypto.encrypt(text), cv["name"].lower(), users["rec"],
            )
            ev = await evaluations.request(cand_id, users["rec"])
            await evaluations.process(ev)
    log.warning(
        'Demo users created (password "%s"): hr.admin@, hiring.manager@, recruiter@, panel.it@, panel.si@, viewer@ demo.ecews.local',
        demo_pwd,
    )


async def main() -> None:
    pool = await db.connect()
    for i in range(1, 31):  # wait for the database container
        try:
            await pool.fetchval("SELECT 1")
            break
        except Exception:
            if i >= 30:
                raise
            log.info("Waiting for database (%s)…", i)
            await asyncio.sleep(2)
    await migrate(pool)
    await seed_reference(pool)
    if config.seed_demo:
        await seed_demo(pool)
    await db.close()
    log.info("Database ready")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:  # noqa: BLE001
        log.error("%s", e)
        sys.exit(1)
