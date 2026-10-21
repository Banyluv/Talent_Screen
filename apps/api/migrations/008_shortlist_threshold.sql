-- Recommendation policy: any weighted score at or above the shortlist
-- threshold is shortlisted. Hard rules only knock out candidates below that
-- bar, so the default shortlist threshold becomes the 70-point benchmark.
UPDATE scoring_profiles
   SET thresholds = jsonb_set(thresholds, '{shortlist}', '70'::jsonb),
       updated_at = now()
 WHERE COALESCE((thresholds->>'shortlist')::int, 0) > 70
   AND COALESCE((thresholds->>'consider')::int, 0) < 70;
