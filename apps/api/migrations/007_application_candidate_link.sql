-- Link a portal application to the internal candidate/evaluation record created
-- for it, so applied CVs flow through the scoring → recommendation → shortlist pipeline.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL;
