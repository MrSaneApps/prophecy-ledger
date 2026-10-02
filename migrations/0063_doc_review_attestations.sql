PRAGMA foreign_keys = ON;

-- Doc-lane attestations: a named human reviewer's verdicts delivered as an
-- authored document (not an interactive review session) and verified by the
-- site owner. The attestation carries the reviewer's verbatim verdict plus the
-- rubric version used to map it onto a ledger outcome.
-- The lane never invents research: novelty stays not_assessed and no baseline
-- or prior-information receipt may accompany a doc-lane review (enforced by
-- the publication evaluator, not just by convention).
CREATE TABLE IF NOT EXISTS doc_review_attestations (
  attestation_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL UNIQUE REFERENCES moderator_reviews(review_id),
  doc_ref TEXT NOT NULL,
  doc_title TEXT NOT NULL,
  verbatim_verdict TEXT NOT NULL CHECK (length(trim(verbatim_verdict)) > 0),
  rubric_version TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS doc_attestations_review
  ON doc_review_attestations(review_id);

CREATE TRIGGER IF NOT EXISTS doc_attestations_no_update
BEFORE UPDATE ON doc_review_attestations
BEGIN SELECT RAISE(ABORT, 'doc attestations are append-only'); END;

CREATE TRIGGER IF NOT EXISTS doc_attestations_no_delete
BEFORE DELETE ON doc_review_attestations
BEGIN SELECT RAISE(ABORT, 'doc attestations are append-only'); END;
