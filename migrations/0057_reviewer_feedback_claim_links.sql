PRAGMA foreign_keys = ON;

-- Preserve append-only reviewer feedback while allowing a separately audited
-- claim binding when a legacy client saved the note without its active ref.
CREATE TABLE IF NOT EXISTS reviewer_feedback_claim_links (
  feedback_id TEXT PRIMARY KEY REFERENCES reviewer_feedback(feedback_id),
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  assignment_id TEXT,
  link_reason TEXT NOT NULL CHECK (link_reason IN (
    'audit_event_correlation','live_qa_correlation'
  )),
  linked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviewer_feedback_claim_links_claim
  ON reviewer_feedback_claim_links(claim_id, linked_at);
CREATE TRIGGER IF NOT EXISTS reviewer_feedback_claim_links_no_update
BEFORE UPDATE ON reviewer_feedback_claim_links BEGIN
  SELECT RAISE(ABORT, 'reviewer feedback claim links are append-only');
END;
CREATE TRIGGER IF NOT EXISTS reviewer_feedback_claim_links_no_delete
BEFORE DELETE ON reviewer_feedback_claim_links BEGIN
  SELECT RAISE(ABORT, 'reviewer feedback claim links are append-only');
END;

CREATE VIEW IF NOT EXISTS reviewer_feedback_effective AS
SELECT feedback.feedback_id, feedback.reviewer_id, feedback.category,
  COALESCE(link.claim_id, feedback.claim_id) claim_id,
  feedback.candidate_id,
  COALESCE(link.assignment_id, feedback.assignment_id) assignment_id,
  feedback.message, feedback.created_at, link.link_reason, link.linked_at
FROM reviewer_feedback feedback
LEFT JOIN reviewer_feedback_claim_links link ON link.feedback_id=feedback.feedback_id;

-- Both rows are synthetic live E2E receipts. Their surrounding authenticated
-- access events bind them to this exact assignment and claim (47s before and
-- 4s after respectively). INSERT...SELECT keeps fresh non-production replays
-- valid when those production-only feedback ids do not exist.
INSERT OR IGNORE INTO reviewer_feedback_claim_links
  (feedback_id,claim_id,assignment_id,link_reason,linked_at)
SELECT feedback_id,'southeast-asia-oil-2021',
  'assignment_07d1cfa8-2079-4e7a-b5be-10cba82c2e6e',
  'live_qa_correlation','2026-08-11T02:36:00.000Z'
FROM reviewer_feedback
WHERE feedback_id IN (
  'feedback_8c3b5a70-517d-4233-8693-b2e0b699f799',
  'feedback_72d1131c-166e-46cd-b806-9c7b3f33f35c'
);
