-- Durable job queue (replaces pg-boss). Created by the Python backend's migration runner.

CREATE TABLE IF NOT EXISTS job_queue (
  id            bigserial PRIMARY KEY,
  queue         text        NOT NULL,
  key           text,
  data          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state         text        NOT NULL DEFAULT 'created',   -- created | active | completed | failed
  attempts      int         NOT NULL DEFAULT 0,
  max_attempts  int         NOT NULL DEFAULT 3,
  run_at        timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS job_queue_poll_idx ON job_queue (queue, state, run_at);

-- At most one live job per (queue, singleton key): prevents duplicate evaluations.
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_singleton_idx
  ON job_queue (queue, key) WHERE key IS NOT NULL AND state IN ('created', 'active');
