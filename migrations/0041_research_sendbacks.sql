-- Reviewer send-backs become durable research lessons.
-- Append-only: every rejection teaches the next draft pass.

CREATE TABLE IF NOT EXISTS research_sendbacks (
  sendback_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  review_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  rejected_outcome TEXT NOT NULL,
  disagreed_outcome TEXT NOT NULL,
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) >= 10),
  lesson TEXT NOT NULL CHECK (length(trim(lesson)) >= 10),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS research_sendbacks_claim_created
  ON research_sendbacks(claim_id, created_at);
CREATE INDEX IF NOT EXISTS research_sendbacks_created
  ON research_sendbacks(created_at);

CREATE TRIGGER IF NOT EXISTS research_sendbacks_no_update
BEFORE UPDATE ON research_sendbacks BEGIN
  SELECT RAISE(ABORT, 'research sendbacks are append-only');
END;
CREATE TRIGGER IF NOT EXISTS research_sendbacks_no_delete
BEFORE DELETE ON research_sendbacks BEGIN
  SELECT RAISE(ABORT, 'research sendbacks are append-only');
END;
