# syntax=docker/dockerfile:1.7
# ECEWS TalentScreen — API, worker and migration image (one image, three commands)

FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    API_PORT=8000 \
    STORAGE_LOCAL_DIR=/data/uploads

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY migrations ./migrations
COPY seed ./seed
COPY assets ./assets

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /data/uploads \
    && chown -R app:app /data /app
USER app

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

# api (default) | worker: python -m app.worker | migrations: python -m app.migrate
CMD ["python", "-m", "app.main"]
