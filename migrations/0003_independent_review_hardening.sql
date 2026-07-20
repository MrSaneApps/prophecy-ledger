ALTER TABLE people ADD COLUMN corpus_frozen_at TEXT;
ALTER TABLE people ADD COLUMN rubric_version TEXT;
ALTER TABLE people ADD COLUMN rubric_frozen_at TEXT;

ALTER TABLE evidence ADD COLUMN verification_method TEXT NOT NULL DEFAULT 'unverified'
  CHECK (verification_method IN ('unverified','timestamp','authorized_transcript'));

ALTER TABLE moderator_reviews ADD COLUMN prior_receipt_id TEXT;
ALTER TABLE moderator_reviews ADD COLUMN decision_fingerprint TEXT;

CREATE TABLE IF NOT EXISTS prior_information_receipts (
  receipt_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  cutoff_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','completed')),
  search_queries_json TEXT NOT NULL,
  sources_checked_json TEXT NOT NULL,
  method_note TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_revisions (
  revision_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  revision_type TEXT NOT NULL CHECK (revision_type IN ('publication')),
  decision_json TEXT NOT NULL,
  actor_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, revision_number)
);

CREATE TRIGGER IF NOT EXISTS people_coverage_insert
BEFORE INSERT ON people WHEN NEW.reviewed_videos > NEW.discovered_videos BEGIN
  SELECT RAISE(ABORT, 'reviewed videos cannot exceed discovered videos');
END;
CREATE TRIGGER IF NOT EXISTS people_coverage_update
BEFORE UPDATE OF discovered_videos, reviewed_videos ON people
WHEN NEW.reviewed_videos > NEW.discovered_videos BEGIN
  SELECT RAISE(ABORT, 'reviewed videos cannot exceed discovered videos');
END;

CREATE TRIGGER IF NOT EXISTS prior_information_receipts_no_update
BEFORE UPDATE ON prior_information_receipts BEGIN
  SELECT RAISE(ABORT, 'prior-information receipts are append-only');
END;
CREATE TRIGGER IF NOT EXISTS prior_information_receipts_no_delete
BEFORE DELETE ON prior_information_receipts BEGIN
  SELECT RAISE(ABORT, 'prior-information receipts are append-only');
END;
CREATE TRIGGER IF NOT EXISTS claim_revisions_no_update
BEFORE UPDATE ON claim_revisions BEGIN
  SELECT RAISE(ABORT, 'claim revisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS claim_revisions_no_delete
BEFORE DELETE ON claim_revisions BEGIN
  SELECT RAISE(ABORT, 'claim revisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS claims_publication_requires_revision
BEFORE UPDATE OF visibility ON claims
WHEN OLD.visibility = 'draft' AND NEW.visibility = 'published'
AND NOT EXISTS (SELECT 1 FROM claim_revisions WHERE claim_id = OLD.claim_id) BEGIN
  SELECT RAISE(ABORT, 'publication requires an immutable claim revision');
END;
CREATE TRIGGER IF NOT EXISTS claims_published_no_update
BEFORE UPDATE ON claims WHEN OLD.visibility = 'published' BEGIN
  SELECT RAISE(ABORT, 'published claims require a new immutable revision');
END;
CREATE TRIGGER IF NOT EXISTS claims_no_delete
BEFORE DELETE ON claims BEGIN
  SELECT RAISE(ABORT, 'claims cannot be deleted');
END;
