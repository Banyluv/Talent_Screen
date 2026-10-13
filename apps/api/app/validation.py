"""Shared input validation helpers.

Note on email: the API's own accounts use the reserved `.local` domain
(e.g. admin@ecews.local), which pydantic's EmailStr rejects. A permissive
pattern keeps parity with the previous `@IsEmail()` behaviour.

Note on dates: asyncpg requires real `datetime`/`date` objects for timestamp
columns (the previous driver accepted ISO strings), so user-supplied dates are
parsed here.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


def parse_datetime(value: str | datetime | None) -> datetime | None:
    """ISO-8601 (with or without offset/Z) → aware datetime. Naive input is treated as UTC."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            try:
                dt = datetime.combine(parse_date(text), datetime.min.time())  # type: ignore[arg-type]
            except ValueError:
                raise ValueError(f'"{text}" is not a valid date and time')
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def parse_date(value: str | date | datetime | None) -> date | None:
    """ISO date (or timestamp) → date."""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        raise ValueError(f'"{text}" is not a valid date')

