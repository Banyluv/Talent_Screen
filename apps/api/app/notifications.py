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
