-- Two free-text fields carried by real ECEWS vacancy adverts (see batch import):
-- the level of effort (time commitment) and the minimum recruitment standard.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS level_of_effort text NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS minimum_recruitment_standard text NOT NULL DEFAULT '';
