-- Keyword-level match summary (industry benchmark, skill-gap analysis and
-- recommendations) computed alongside each evaluation.
ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS match_summary jsonb;
