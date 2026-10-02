PRAGMA foreign_keys = ON;

-- Decision amendments: append-only corrections to published outcomes.
-- Nothing is rewritten: the original review, revision, and claim row stay
-- untouched, and readers always see the current outcome beside its history.
-- reviewer_id is the deciding reviewer (their verdict stands); corrected_by
-- names the operator who found and filed the correction.
CREATE TABLE IF NOT EXISTS claim_decision_amendments (
  amendment_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  amendment_number INTEGER NOT NULL CHECK (amendment_number >= 1),
  supersedes_revision_id TEXT NOT NULL REFERENCES claim_revisions(revision_id),
  reviewer_id TEXT NOT NULL,
  corrected_by TEXT NOT NULL,
  outcome_status TEXT NOT NULL CHECK (outcome_status IN (
    'true','false','partial','pending','undetermined','not_falsifiable'
  )),
  novelty_status TEXT NOT NULL CHECK (novelty_status IN (
    'already_public','widely_expected','strong_signals','emerging_signals',
    'no_precursor_found','not_assessed'
  )),
  baseline_probability REAL CHECK (
    baseline_probability IS NULL OR (baseline_probability >= 0 AND baseline_probability <= 1)
  ),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (claim_id, amendment_number)
);

CREATE INDEX IF NOT EXISTS claim_amendments_claim
  ON claim_decision_amendments(claim_id, amendment_number);

CREATE TRIGGER IF NOT EXISTS claim_amendments_no_update
BEFORE UPDATE ON claim_decision_amendments
BEGIN SELECT RAISE(ABORT, 'decision amendments are append-only'); END;

CREATE TRIGGER IF NOT EXISTS claim_amendments_no_delete
BEFORE DELETE ON claim_decision_amendments
BEGIN SELECT RAISE(ABORT, 'decision amendments are append-only'); END;
