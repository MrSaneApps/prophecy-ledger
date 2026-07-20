PRAGMA foreign_keys = ON;

ALTER TABLE extraction_runs ADD COLUMN rejected_candidate_count INTEGER NOT NULL DEFAULT 0
  CHECK (rejected_candidate_count BETWEEN 0 AND 25);
ALTER TABLE extraction_runs ADD COLUMN rejection_codes_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(rejection_codes_json));
