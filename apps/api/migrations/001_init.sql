-- ECEWS TalentScreen — initial schema
-- PostgreSQL 16. All timestamps are timestamptz (UTC).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy candidate / skill search

-- ---------------------------------------------------------------- organisation
CREATE TABLE organisations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

-- ---------------------------------------------------------------- RBAC
CREATE TABLE permissions (
  key          text PRIMARY KEY,
  category     text NOT NULL,
  description  text NOT NULL
);

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_system    boolean NOT NULL DEFAULT false,   -- system roles cannot be deleted
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key  text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  full_name      text NOT NULL,
  password_hash  text,                                   -- null for SSO-only accounts
  auth_provider  text NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local','oidc')),
  external_id    text,                                   -- OIDC subject / Entra object id
  role_id        uuid NOT NULL REFERENCES roles(id),
  department_id  uuid REFERENCES departments(id) ON DELETE SET NULL,
  is_active      boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_external_uq ON users (auth_provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_agent  text,
  ip          text
);

-- ---------------------------------------------------------------- configuration
CREATE TABLE scoring_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  weights     jsonb NOT NULL,      -- {qualifications, technical, experience, certifications, preferred, progression}
  thresholds  jsonb NOT NULL,      -- {shortlist, consider, hold}
  rules       jsonb NOT NULL,      -- {enforceMinExperience, enforceMandatory, experienceBasis}
  is_default  boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scoring_profiles_one_default ON scoring_profiles (is_default) WHERE is_default;

CREATE TABLE ai_settings (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton
  provider           text NOT NULL DEFAULT 'rules' CHECK (provider IN ('rules','azure-openai','openai')),
  model              text NOT NULL DEFAULT '',
  temperature        numeric(3,2) NOT NULL DEFAULT 0,
  require_evidence   boolean NOT NULL DEFAULT true,
  redact_pii         boolean NOT NULL DEFAULT true,
  generate_narrative boolean NOT NULL DEFAULT true,
  retention_months   int NOT NULL DEFAULT 24,
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- jobs
CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code            text NOT NULL UNIQUE,
  title               text NOT NULL,
  department_id       uuid REFERENCES departments(id) ON DELETE SET NULL,
  location            text NOT NULL DEFAULT '',
  employment_type     text NOT NULL DEFAULT 'Full-time',
  description         text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('requested','draft','open','closed','filled','rejected')),
  requirements        jsonb NOT NULL,       -- see JobRequirements in src/common/types.ts
  scoring_profile_id  uuid REFERENCES scoring_profiles(id),
  weights_override    jsonb,                -- per-vacancy weights, optional
  hiring_manager_id   uuid REFERENCES users(id),
  requested_by        uuid REFERENCES users(id),
  approved_by         uuid REFERENCES users(id),
  created_by          uuid REFERENCES users(id),
  closes_on           date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status_idx ON jobs (status);

CREATE TABLE job_assignments (
  job_id   uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     text NOT NULL DEFAULT 'recruiter' CHECK (kind IN ('recruiter','hiring_manager','viewer')),
  PRIMARY KEY (job_id, user_id, kind)
);

-- ---------------------------------------------------------------- candidates
-- Contact details and CV text are encrypted at application level (AES-256-GCM).
CREATE TABLE candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  email_enc     text,
  phone_enc     text,
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','screening','shortlisted','interview','offer','hired','rejected','withdrawn')),
  source        text NOT NULL DEFAULT 'upload',
  file_key      text,                 -- object storage key (encrypted object)
  file_name     text,
  file_mime     text,
  file_sha256   text,
  cv_text_enc   text,
  profile       jsonb,                -- structured, non-contact profile extracted from the CV
  search_text   text NOT NULL DEFAULT '',   -- name + skills + titles, for search
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  erased_at     timestamptz           -- set when personal data is erased on request
);
CREATE INDEX candidates_job_idx ON candidates (job_id);
CREATE UNIQUE INDEX candidates_job_file_uq ON candidates (job_id, file_sha256) WHERE file_sha256 IS NOT NULL AND erased_at IS NULL;
CREATE INDEX candidates_search_trgm ON candidates USING gin (search_text gin_trgm_ops);

-- ---------------------------------------------------------------- evaluations
CREATE TABLE evaluations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id         uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id               uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version              int NOT NULL,
  is_current           boolean NOT NULL DEFAULT true,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  engine               text NOT NULL DEFAULT 'rules',
  model                text,
  overall_score        int,
  recommendation       text CHECK (recommendation IN ('Shortlist','Consider','Hold','Reject')),
  component_scores     jsonb,
  weights              jsonb,
  thresholds           jsonb,
  total_years          numeric(5,1),
  relevant_years       numeric(5,1),
  qualification_match  int,
  skills_match         int,
  requirement_checks   jsonb,   -- every requirement with met/evidence/source
  strengths            jsonb,
  gaps                 jsonb,
  hard_rule_failures   jsonb,
  justification        text,
  narrative            text,
  error                text,
  requested_by         uuid REFERENCES users(id),
  batch_id             uuid,
  llm_discarded        jsonb,   -- model claims rejected because the quote was not in the CV
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  UNIQUE (candidate_id, version)
);
CREATE UNIQUE INDEX evaluations_one_current ON evaluations (candidate_id) WHERE is_current;
CREATE INDEX evaluations_job_idx ON evaluations (job_id) WHERE is_current;

CREATE TABLE recommendation_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id   uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  evaluation_id  uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  from_rec       text NOT NULL,
  to_rec         text NOT NULL CHECK (to_rec IN ('Shortlist','Consider','Hold','Reject')),
  reason         text NOT NULL CHECK (length(trim(reason)) >= 10),
  is_active      boolean NOT NULL DEFAULT true,
  user_id        uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX overrides_one_active ON recommendation_overrides (candidate_id) WHERE is_active;

-- ---------------------------------------------------------------- interviews
CREATE TABLE interviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id  uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scheduled_at  timestamptz NOT NULL,
  duration_min  int NOT NULL DEFAULT 45,
  mode          text NOT NULL DEFAULT 'Microsoft Teams',
  location      text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interview_panelists (
  interview_id  uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (interview_id, user_id)
);

CREATE TABLE interview_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id  uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  panelist_id   uuid NOT NULL REFERENCES users(id),
  scores        jsonb NOT NULL,   -- {technical, problemSolving, communication, teamFit} 1..5
  total         int NOT NULL,
  comments      text NOT NULL DEFAULT '',
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interview_id, panelist_id)
);

CREATE TABLE hiring_recommendations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id   uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id),
  decision       text NOT NULL CHECK (decision IN ('hire','hold','no_hire')),
  justification  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- notifications
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid,
  actor_email  text,
  actor_role   text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  user_agent   text,
  prev_hash    text,
  hash         text NOT NULL
);
CREATE INDEX audit_at_idx ON audit_logs (at DESC);
CREATE INDEX audit_entity_idx ON audit_logs (entity_type, entity_id);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
