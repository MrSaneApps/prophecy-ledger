PRAGMA foreign_keys = ON;

-- A malformed model suggestion must not roll back valid siblings from the
-- same private transcript section. Keep only content-free persistence facts;
-- candidate text remains in the existing private artifact and AI response.
CREATE TABLE IF NOT EXISTS extraction_candidate_persistence_rejections (
  rejection_id TEXT PRIMARY KEY,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(extraction_run_id),
  candidate_ordinal INTEGER NOT NULL CHECK (candidate_ordinal BETWEEN 0 AND 24),
  candidate_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  error_code TEXT NOT NULL CHECK (error_code IN (
    'candidate_not_persisted','assessment_not_persisted'
  )),
  created_at TEXT NOT NULL,
  UNIQUE(extraction_run_id,candidate_ordinal)
);

CREATE INDEX IF NOT EXISTS extraction_candidate_persistence_rejections_run
  ON extraction_candidate_persistence_rejections(extraction_run_id,candidate_ordinal);

CREATE TRIGGER IF NOT EXISTS extraction_candidate_persistence_rejections_no_update
BEFORE UPDATE ON extraction_candidate_persistence_rejections
BEGIN SELECT RAISE(ABORT, 'candidate persistence rejections are append-only'); END;

CREATE TRIGGER IF NOT EXISTS extraction_candidate_persistence_rejections_no_delete
BEFORE DELETE ON extraction_candidate_persistence_rejections
BEGIN SELECT RAISE(ABORT, 'candidate persistence rejections are append-only'); END;
