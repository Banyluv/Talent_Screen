"""FastAPI application: REST API for the React frontend."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, db, queue, storage
from .routers import admin, auth, candidates, interviews, jobs, reports
from .services.evaluation import service as evaluations

logging.basicConfig(level=logging.INFO, format="%(levelname)s [%(name)s] %(message)s")
log = logging.getLogger("bootstrap")


async def _inline_handler(job: dict) -> None:
    await evaluations.process(job["evaluationId"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await storage.get()
    if config.queue_inline:
        queue.set_inline_handler(_inline_handler)
        log.warning(
            "EVALUATE_INLINE=true: CVs are evaluated inside the API process. "
            "Use the worker service in production."
        )
    log.info("API listening on :%s (docs at /api/docs)", config.port)
    yield
    queue.set_inline_handler(None)
    await db.close()


app = FastAPI(
    title="ECEWS TalentScreen API",
    version="1.0",
    description=(
        "AI-assisted recruitment decision support. All routes need a bearer token except "
        "/auth/login, /auth/refresh, /auth/providers, /auth/oidc/* and /health."
    ),
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


@app.middleware("http")
async def security_and_limit(request: Request, call_next):
    from .deps import global_rate_limit

    try:
        await global_rate_limit(request)
    except StarletteHTTPException as e:
        return JSONResponse({"statusCode": e.status_code, "message": e.detail}, status_code=e.status_code)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    message = exc.detail if exc.detail is not None else "Request failed"
    return JSONResponse({"statusCode": exc.status_code, "message": message}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    messages = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", []) if p not in ("body", "query", "path"))
        messages.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
    return JSONResponse({"statusCode": 400, "message": messages}, status_code=400)


@app.get("/api/health", tags=["health"])
async def health():
    await db.value("SELECT 1")
    return {"status": "ok", "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"}


for r in (auth.router, admin.router, jobs.router, candidates.router, interviews.router, reports.router):
    app.include_router(r, prefix="/api")


def main() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=config.port, log_level="info")


if __name__ == "__main__":
    main()
