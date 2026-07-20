PRAGMA foreign_keys = ON;

-- A human archive observation records only what one assigned original source
-- supports. It is not a claim, promotion, outcome rating, or independent
-- evidence record and has no database path into those publication tables.
CREATE TABLE IF NOT EXISTS archive_review_observations (
  archive_observation_id TEXT PRIMARY KEY,
  archive_decision_id TEXT NOT NULL UNIQUE REFERENCES archive_review_decisions(archive_decision_id),
  source_available_confirmed INTEGER NOT NULL CHECK (source_available_confirmed IN (0,1)),
  context_confirmed INTEGER NOT NULL CHECK (context_confirmed IN (0,1)),
  exact_source_confirmed INTEGER NOT NULL CHECK (exact_source_confirmed IN (0,1)),
  exact_source_quote TEXT,
  source_timestamp_seconds INTEGER CHECK (source_timestamp_seconds IS NULL OR source_timestamp_seconds >= 0),
  who_text TEXT,
  who_source_basis TEXT,
  what_text TEXT,
  what_source_basis TEXT,
  why_text TEXT,
  why_source_basis TEXT,
  where_text TEXT,
  where_source_basis TEXT,
  when_text TEXT,
  when_source_basis TEXT,
  how_text TEXT,
  how_source_basis TEXT,
  public_evidence_note TEXT,
  pass_condition_note TEXT,
  fail_condition_note TEXT,
  created_at TEXT NOT NULL,
  CHECK ((how_text IS NULL AND how_source_basis IS NULL)
    OR (length(trim(how_text))>0 AND length(trim(how_source_basis))>0))
);

CREATE INDEX IF NOT EXISTS archive_observations_decision
  ON archive_review_observations(archive_decision_id,created_at);

CREATE TRIGGER IF NOT EXISTS archive_observations_supported_complete
BEFORE INSERT ON archive_review_observations
WHEN EXISTS (SELECT 1 FROM archive_review_decisions decision
  WHERE decision.archive_decision_id=NEW.archive_decision_id
    AND decision.decision='source_supported')
  AND (NEW.source_available_confirmed<>1 OR NEW.context_confirmed<>1
    OR NEW.exact_source_confirmed<>1 OR length(trim(COALESCE(NEW.exact_source_quote,'')))<3
    OR length(trim(COALESCE(NEW.who_text,'')))=0
    OR length(trim(COALESCE(NEW.who_source_basis,'')))=0
    OR length(trim(COALESCE(NEW.what_text,'')))=0
    OR length(trim(COALESCE(NEW.what_source_basis,'')))=0
    OR length(trim(COALESCE(NEW.why_text,'')))=0
    OR length(trim(COALESCE(NEW.why_source_basis,'')))=0
    OR length(trim(COALESCE(NEW.where_text,'')))=0
    OR length(trim(COALESCE(NEW.where_source_basis,'')))=0
    OR length(trim(COALESCE(NEW.when_text,'')))=0
    OR length(trim(COALESCE(NEW.when_source_basis,'')))=0
    OR length(trim(COALESCE(NEW.public_evidence_note,'')))=0
    OR length(trim(COALESCE(NEW.pass_condition_note,'')))=0
    OR length(trim(COALESCE(NEW.fail_condition_note,'')))=0
    OR trim(NEW.pass_condition_note)=trim(NEW.fail_condition_note))
BEGIN SELECT RAISE(ABORT, 'supported archive observations require complete exact-source grounding'); END;

CREATE TRIGGER IF NOT EXISTS archive_observations_negative_not_supported
BEFORE INSERT ON archive_review_observations
WHEN EXISTS (SELECT 1 FROM archive_review_decisions decision
  WHERE decision.archive_decision_id=NEW.archive_decision_id
    AND decision.decision<>'source_supported')
  AND (NEW.who_text IS NOT NULL OR NEW.who_source_basis IS NOT NULL
    OR NEW.what_text IS NOT NULL OR NEW.what_source_basis IS NOT NULL
    OR NEW.why_text IS NOT NULL OR NEW.why_source_basis IS NOT NULL
    OR NEW.where_text IS NOT NULL OR NEW.where_source_basis IS NOT NULL
    OR NEW.when_text IS NOT NULL OR NEW.when_source_basis IS NOT NULL
    OR NEW.how_text IS NOT NULL OR NEW.how_source_basis IS NOT NULL
    OR NEW.public_evidence_note IS NOT NULL OR NEW.pass_condition_note IS NOT NULL
    OR NEW.fail_condition_note IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'negative archive decisions cannot store supported claim framing'); END;

CREATE TRIGGER IF NOT EXISTS archive_observations_outcome_checks
BEFORE INSERT ON archive_review_observations
WHEN EXISTS (SELECT 1 FROM archive_review_decisions decision
  WHERE decision.archive_decision_id=NEW.archive_decision_id
    AND ((decision.decision='archive_mismatch'
      AND (NEW.source_available_confirmed<>1 OR NEW.context_confirmed<>1
        OR NEW.exact_source_confirmed<>0))
    OR (decision.decision='not_testable'
      AND (NEW.source_available_confirmed<>1 OR NEW.context_confirmed<>1
        OR NEW.exact_source_confirmed<>1 OR length(trim(COALESCE(NEW.exact_source_quote,'')))<3))
    OR (decision.decision='source_unavailable'
      AND (NEW.source_available_confirmed<>0 OR NEW.context_confirmed<>0
        OR NEW.exact_source_confirmed<>0 OR NEW.exact_source_quote IS NOT NULL
        OR NEW.source_timestamp_seconds IS NOT NULL))))
BEGIN SELECT RAISE(ABORT, 'archive observation source checks do not match the decision'); END;

CREATE TRIGGER IF NOT EXISTS archive_observations_no_update
BEFORE UPDATE ON archive_review_observations
BEGIN SELECT RAISE(ABORT, 'archive observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_observations_no_delete
BEFORE DELETE ON archive_review_observations
BEGIN SELECT RAISE(ABORT, 'archive observations are append-only'); END;
