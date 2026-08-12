PRAGMA foreign_keys = OFF;

-- Releasing an expired or explicitly returned assignment is a first-class
-- audit event. Rebuild the CHECK-constrained table while preserving history.
CREATE TABLE review_audit_events_new (
  audit_event_id TEXT PRIMARY KEY,
  reviewer_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'auth_succeeded','auth_failed','access_granted','access_denied',
    'assignment_leased','assignment_released','submission_accepted','submission_rejected',
    'evaluation_reconciled'
  )),
  work_item_id TEXT REFERENCES review_work_items(work_item_id),
  claim_id TEXT REFERENCES claims(claim_id),
  candidate_id TEXT REFERENCES claim_candidates(candidate_id),
  assignment_id TEXT REFERENCES review_assignments(assignment_id),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

INSERT INTO review_audit_events_new
SELECT * FROM review_audit_events;
DROP TABLE review_audit_events;
ALTER TABLE review_audit_events_new RENAME TO review_audit_events;

CREATE INDEX review_audit_events_created
  ON review_audit_events(created_at,audit_event_id);
CREATE TRIGGER review_audit_events_no_update
BEFORE UPDATE ON review_audit_events
BEGIN SELECT RAISE(ABORT, 'review audit events are append-only'); END;
CREATE TRIGGER review_audit_events_no_delete
BEFORE DELETE ON review_audit_events
BEGIN SELECT RAISE(ABORT, 'review audit events are append-only'); END;

PRAGMA foreign_keys = ON;
