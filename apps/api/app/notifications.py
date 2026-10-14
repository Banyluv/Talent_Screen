"""In-app notifications, with optional email when SMTP is configured."""
from __future__ import annotations

import asyncio
import logging
import smtplib
from email.message import EmailMessage

from . import config, db

log = logging.getLogger("notify")


def _send_mail(to: str, subject: str, body: str, link: str | None) -> None:
    msg = EmailMessage()
    msg["From"] = config.mail_from
    msg["To"] = to
    msg["Subject"] = f"[TalentScreen] {subject}"
    msg.set_content(f"{body}\n\n{config.public_url + link if link else config.public_url}")
    with smtplib.SMTP(config.mail_host, config.mail_port, timeout=20) as smtp:
        if config.mail_secure:
            smtp.starttls()
        if config.mail_user:
            smtp.login(config.mail_user, config.mail_pass)
        smtp.send_message(msg)


def mail_status() -> dict:
    """What the admin settings screen needs to show: is outbound email configured.

    Never includes the SMTP password (or the username): credentials stay in the
    server environment, exactly like the AI provider keys.
    """
    configured = bool(config.mail_host)
    return {
        "configured": configured,
        "host": config.mail_host or "",
        "port": config.mail_port,
        "secure": config.mail_secure,
        "authenticated": bool(config.mail_user),
        "from": config.mail_from,
        "reason": (
            None
            if configured
            else "Set SMTP_HOST (and SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) "
            "in the server environment and restart the API"
        ),
    }


async def send_test_email(to: str) -> dict:
    """Send a test message through the configured SMTP server (blocking, off-thread)."""
    if not config.mail_host:
        return {
            "ok": False,
            "message": "Outbound email is not configured. Set SMTP_HOST (and SMTP_PORT, "
            "SMTP_USER, SMTP_PASS, SMTP_FROM) in the server environment and restart the API.",
        }
    try:
        await asyncio.to_thread(
            _send_mail,
            to,
            "Test email",
            "This is a test message from TalentScreen. If you received it, outbound email is working.",
            None,
        )
        return {"ok": True, "message": f"Test email sent to {to}"}
    except Exception as e:  # surface the SMTP server's real complaint to the admin
        return {"ok": False, "message": str(e)}


async def to_users(
    user_ids: list[str],
    type_: str,
    title: str,
    body: str = "",
    link: str | None = None,
    c: db.Conn | None = None,
) -> None:
    ids = list({u for u in user_ids if u})
    if not ids:
        return
    await db.execute(
        """INSERT INTO notifications (user_id, type, title, body, link)
           SELECT u, $2, $3, $4, $5 FROM unnest($1::uuid[]) u""",
        [ids, type_, title, body, link],
        c,
    )
    if config.mail_host:
        users = await db.many(
            "SELECT email FROM users WHERE id = ANY($1::uuid[]) AND is_active", [ids]
        )

        async def mail(email: str) -> None:
            try:
                await asyncio.to_thread(_send_mail, email, title, body, link)
            except Exception as e:
                log.warning("Email to %s failed: %s", email, e)

        await asyncio.gather(*(mail(u["email"]) for u in users))


async def to_permission(
    perms: list[str],
    type_: str,
    title: str,
    body: str = "",
    link: str | None = None,
    except_user_id: str | None = None,
) -> None:
    """Notify every active user holding any of the given permissions."""
    rows = await db.many(
        """SELECT DISTINCT u.id FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id
           WHERE u.is_active AND rp.permission_key = ANY($1::text[])""",
        [perms],
    )
    await to_users(
        [r["id"] for r in rows if r["id"] != except_user_id], type_, title, body, link
    )
