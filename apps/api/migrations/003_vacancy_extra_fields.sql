-- Vacancy metadata carried by real ECEWS vacancy adverts (see batch import):
-- the funding project, the headcount and the reporting line.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project text NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS number_of_positions integer NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reports_to text NOT NULL DEFAULT '';
