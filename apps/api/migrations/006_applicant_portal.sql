-- External applicant (job-seeker) portal.
-- Applicants are a distinct population from internal users: they self-register,
-- build a profile, upload a CV, browse open vacancies and apply.

CREATE TABLE applicants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  phone          text NOT NULL DEFAULT '',
  headline       text NOT NULL DEFAULT '',
  summary        text NOT NULL DEFAULT '',
  location       text NOT NULL DEFAULT '',
  skills         jsonb NOT NULL DEFAULT '[]'::jsonb,
  cv_file_key    text,
  cv_file_name   text,
  cv_file_mime   text,
  cv_file_sha256 text,
  is_active      boolean NOT NULL DEFAULT true,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX applicants_email_uq ON applicants (lower(email));

CREATE TABLE applicant_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  user_agent    text,
  ip            text
);

CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  uuid NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted','under_review','shortlisted','interview','offer','hired','rejected','withdrawn')),
  cover_letter  text NOT NULL DEFAULT '',
  cv_file_key   text,                 -- the CV used for this application (profile CV unless a new one was attached)
  cv_file_name  text,
  cv_file_mime  text,
  notes         text NOT NULL DEFAULT '',   -- internal notes
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, job_id)
);
CREATE INDEX applications_job_idx ON applications (job_id);
