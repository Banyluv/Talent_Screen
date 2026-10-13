"""Async PostgreSQL access (asyncpg pool) with the small helper surface used across routers.

Placeholders are `$1, $2 …` — the same SQL style this project always used.
"""
from __future__ import annotations

import json
import uuid as _uuid
from typing import Any, Iterable, Sequence

import asyncpg
from asyncpg.pgproto.pgproto import UUID as PgUUID

from . import config

_pool: asyncpg.Pool | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    # Pass Python objects straight through for json/jsonb columns.
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


_UUID_TYPES = (_uuid.UUID, PgUUID)


def _norm(value: Any) -> Any:
    """UUIDs read from the database are not always accepted back as parameters.

    asyncpg hands back `pgproto.UUID` objects, which it accepts for `uuid`
    columns but rejects for `text` ones (and `jsonb` payloads cannot hold them
    either). Strings work everywhere, so normalise them here rather than at
    every call site.
    """
    if isinstance(value, _UUID_TYPES):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_norm(v) for v in value]
    if isinstance(value, dict):
        return {k: _norm(v) for k, v in value.items()}
    return value


def _params(params: Sequence[Any]) -> list[Any]:
    return [_norm(p) for p in params]


async def connect() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=config.db_url,
            min_size=1,
            max_size=config.db_pool_max,
            ssl="require" if config.db_ssl else None,
            init=_init_connection,
        )
    return _pool


async def close() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def _affected(status: str) -> int:
    parts = status.split()
    if not parts:
        return 0
    try:
        return int(parts[-1])
    except ValueError:
        return 0


class Conn:
    """Queryable wrapper: the pool itself or a connection inside a transaction."""

    def __init__(self, c: asyncpg.Pool | asyncpg.Connection) -> None:
        self._c = c

    async def many(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return [dict(r) for r in await self._c.fetch(sql, *_params(params))]

    async def one(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        r = await self._c.fetchrow(sql, *_params(params))
        return dict(r) if r is not None else None

    async def exec(self, sql: str, params: Sequence[Any] = ()) -> int:
        return _affected(await self._c.execute(sql, *_params(params)))

    async def value(self, sql: str, params: Sequence[Any] = ()) -> Any:
        return await self._c.fetchval(sql, *_params(params))

    async def query(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return await self.many(sql, params)


async def many(sql: str, params: Sequence[Any] = (), c: Conn | None = None) -> list[dict[str, Any]]:
    if c is not None:
        return await c.many(sql, params)
    return [dict(r) for r in await (await connect()).fetch(sql, *_params(params))]


async def one(sql: str, params: Sequence[Any] = (), c: Conn | None = None) -> dict[str, Any] | None:
    if c is not None:
        return await c.one(sql, params)
    r = await (await connect()).fetchrow(sql, *_params(params))
    return dict(r) if r is not None else None


async def execute(sql: str, params: Sequence[Any] = (), c: Conn | None = None) -> int:
    if c is not None:
        return await c.exec(sql, params)
    return _affected(await (await connect()).execute(sql, *_params(params)))


async def value(sql: str, params: Sequence[Any] = (), c: Conn | None = None) -> Any:
    if c is not None:
        return await c.value(sql, params)
    return await (await connect()).fetchval(sql, *_params(params))


class Tx(Conn):
    """A transaction-scoped queryable."""


async def tx(fn):
    """Run `fn(queryable)` inside a transaction."""
    pool_ = await connect()
    async with pool_.acquire() as conn:
        async with conn.transaction():
            return await fn(Tx(conn))


def rows(rs: Iterable[asyncpg.Record]) -> list[dict[str, Any]]:
    return [dict(r) for r in rs]
