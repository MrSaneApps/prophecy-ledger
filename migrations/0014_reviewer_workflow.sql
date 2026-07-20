PRAGMA foreign_keys = ON;

-- Extraction candidates are private AI-assisted leads. They become adjudicable
-- only through an explicit human promotion into an existing ledger claim.
CREATE TABLE IF NOT EXISTS candidate_claim_promotions (
  promotion_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES claim_candidates(candidate_id),
  claim_id TEXT NOT NULL UNIQUE REFERENCES claims(claim_id),
  promoted_by_reviewer_id TEXT NOT NULL,
  verification_basis_json TEXT NOT NULL CHECK (json_valid(verification_basis_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_work_items (
  work_item_id TEXT PRIMARY KEY,
  claim_id TEXT UNIQUE REFERENCES claims(claim_id),
  candidate_id TEXT UNIQUE REFERENCES claim_candidates(candidate_id),
  promotion_id TEXT UNIQUE REFERENCES candidate_claim_promotions(promotion_id),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN (
    'existing_ledger_claim','private_extraction_candidate','promoted_candidate'
  )),
  work_type TEXT NOT NULL CHECK (work_type IN ('candidate_verification','claim_adjudication')),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','complete','withdrawn')),
  required_matching_reviews INTEGER NOT NULL DEFAULT 2 CHECK (required_matching_reviews=2),
  max_reviews INTEGER NOT NULL DEFAULT 4 CHECK (max_reviews BETWEEN 2 AND 8),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((work_type='candidate_verification' AND origin_kind='private_extraction_candidate'
          AND candidate_id IS NOT NULL AND claim_id IS NULL AND promotion_id IS NULL)
      OR (work_type='claim_adjudication' AND origin_kind='existing_ledger_claim'
          AND claim_id IS NOT NULL AND candidate_id IS NULL AND promotion_id IS NULL)
      OR (work_type='claim_adjudication' AND origin_kind='promoted_candidate'
          AND claim_id IS NOT NULL AND candidate_id IS NULL AND promotion_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS candidate_review_decisions (
  candidate_decision_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES claim_candidates(candidate_id),
  work_item_id TEXT NOT NULL REFERENCES review_work_items(work_item_id),
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('promote','reject')),
  rationale TEXT NOT NULL,
  promoted_claim_id TEXT REFERENCES claims(claim_id),
  decision_fields_json TEXT NOT NULL CHECK (json_valid(decision_fields_json)),
  created_at TEXT NOT NULL,
  UNIQUE(candidate_id, reviewer_id),
  CHECK ((decision='promote' AND promoted_claim_id IS NOT NULL)
      OR (decision='reject' AND promoted_claim_id IS NULL))
);

CREATE TABLE IF NOT EXISTS review_assignments (
  assignment_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES review_work_items(work_item_id),
  reviewer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('leased','submitted','released')),
  assigned_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  submitted_at TEXT,
  lease_version INTEGER NOT NULL DEFAULT 1 CHECK (lease_version >= 1),
  UNIQUE(work_item_id, reviewer_id),
  CHECK ((status='submitted' AND submitted_at IS NOT NULL)
      OR (status<>'submitted' AND submitted_at IS NULL))
);

CREATE TABLE IF NOT EXISTS publication_evaluations (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  state TEXT NOT NULL CHECK (state IN (
    'needed','awaiting_second_review','disagreement','blocked','published'
  )),
  requested_at TEXT NOT NULL,
  last_attempt_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  publication_revision_id TEXT REFERENCES claim_revisions(revision_id)
);

CREATE TABLE IF NOT EXISTS review_audit_events (
  audit_event_id TEXT PRIMARY KEY,
  reviewer_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'auth_succeeded','auth_failed','access_granted','access_denied',
    'assignment_leased','submission_accepted','submission_rejected',
    'evaluation_reconciled'
  )),
  work_item_id TEXT REFERENCES review_work_items(work_item_id),
  claim_id TEXT REFERENCES claims(claim_id),
  candidate_id TEXT REFERENCES claim_candidates(candidate_id),
  assignment_id TEXT REFERENCES review_assignments(assignment_id),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS review_work_items_status ON review_work_items(status,created_at,work_item_id);
CREATE INDEX IF NOT EXISTS review_assignments_reviewer ON review_assignments(reviewer_id,status,lease_expires_at);
CREATE INDEX IF NOT EXISTS review_assignments_work ON review_assignments(work_item_id,status,lease_expires_at);
CREATE INDEX IF NOT EXISTS publication_evaluations_state ON publication_evaluations(state,requested_at);
CREATE INDEX IF NOT EXISTS review_audit_events_created ON review_audit_events(created_at,audit_event_id);

CREATE TRIGGER IF NOT EXISTS candidate_claim_promotions_exact_candidate
BEFORE INSERT ON candidate_claim_promotions
WHEN NOT EXISTS (
  SELECT 1 FROM claim_candidates candidate
  WHERE candidate.candidate_id=NEW.candidate_id
    AND candidate.candidate_kind='exact_transcript_claim'
    AND candidate.requires_human_review=1
)
BEGIN SELECT RAISE(ABORT, 'only exact private candidates can be explicitly promoted'); END;

CREATE TRIGGER IF NOT EXISTS candidate_claim_promotions_no_update
BEFORE UPDATE ON candidate_claim_promotions BEGIN SELECT RAISE(ABORT, 'candidate promotions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS candidate_claim_promotions_no_delete
BEFORE DELETE ON candidate_claim_promotions BEGIN SELECT RAISE(ABORT, 'candidate promotions are append-only'); END;

CREATE TRIGGER IF NOT EXISTS review_work_items_identity_guard
BEFORE UPDATE ON review_work_items
WHEN NEW.work_item_id<>OLD.work_item_id OR NEW.claim_id<>OLD.claim_id
  OR COALESCE(NEW.candidate_id,'')<>COALESCE(OLD.candidate_id,'')
  OR COALESCE(NEW.promotion_id,'')<>COALESCE(OLD.promotion_id,'')
  OR NEW.origin_kind<>OLD.origin_kind OR NEW.work_type<>OLD.work_type
  OR NEW.required_matching_reviews<>OLD.required_matching_reviews OR NEW.max_reviews<>OLD.max_reviews
  OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT, 'review work item identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_work_items_no_delete
BEFORE DELETE ON review_work_items BEGIN SELECT RAISE(ABORT, 'review work items cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS review_assignments_identity_guard
BEFORE UPDATE ON review_assignments
WHEN NEW.assignment_id<>OLD.assignment_id OR NEW.work_item_id<>OLD.work_item_id
  OR NEW.reviewer_id<>OLD.reviewer_id OR NEW.assigned_at<>OLD.assigned_at
BEGIN SELECT RAISE(ABORT, 'review assignment identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_assignments_no_delete
BEFORE DELETE ON review_assignments BEGIN SELECT RAISE(ABORT, 'review assignments cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS review_assignments_capacity_guard
BEFORE INSERT ON review_assignments
WHEN (SELECT COUNT(*) FROM review_assignments existing
      WHERE existing.work_item_id=NEW.work_item_id
        AND (existing.status='submitted' OR
          (existing.status='leased' AND existing.lease_expires_at>NEW.assigned_at))) >=
  (SELECT CASE WHEN work.work_type='candidate_verification' THEN 1
      WHEN (SELECT COUNT(*) FROM moderator_reviews review WHERE review.claim_id=work.claim_id)<2 THEN 2
      ELSE work.max_reviews END
   FROM review_work_items work WHERE work.work_item_id=NEW.work_item_id)
BEGIN SELECT RAISE(ABORT, 'no reviewer assignment slot is available'); END;

CREATE TRIGGER IF NOT EXISTS moderator_reviews_require_live_assignment
BEFORE INSERT ON moderator_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM review_assignments assignment
  JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
  WHERE work.claim_id=NEW.claim_id AND work.status='ready'
    AND assignment.reviewer_id=NEW.reviewer_id AND assignment.status='leased'
    AND assignment.lease_expires_at>NEW.created_at
)
BEGIN SELECT RAISE(ABORT, 'a live reviewer assignment is required'); END;

CREATE TRIGGER IF NOT EXISTS moderator_reviews_request_evaluation
AFTER INSERT ON moderator_reviews
BEGIN
  INSERT INTO publication_evaluations
    (claim_id,state,requested_at,last_attempt_at,completed_at,attempt_count,last_error_code,publication_revision_id)
  VALUES (NEW.claim_id,'needed',NEW.created_at,NULL,NULL,0,NULL,NULL)
  ON CONFLICT(claim_id) DO UPDATE SET
    state='needed',requested_at=excluded.requested_at,completed_at=NULL,last_error_code=NULL;
END;

CREATE TRIGGER IF NOT EXISTS candidate_review_decisions_require_live_assignment
BEFORE INSERT ON candidate_review_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM review_assignments assignment
  JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
  WHERE work.work_item_id=NEW.work_item_id AND work.candidate_id=NEW.candidate_id
    AND work.work_type='candidate_verification' AND work.status='ready'
    AND assignment.reviewer_id=NEW.reviewer_id AND assignment.status='leased'
    AND assignment.lease_expires_at>NEW.created_at
)
BEGIN SELECT RAISE(ABORT, 'a live candidate assignment is required'); END;

CREATE TRIGGER IF NOT EXISTS candidate_review_decisions_no_update
BEFORE UPDATE ON candidate_review_decisions BEGIN SELECT RAISE(ABORT, 'candidate decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS candidate_review_decisions_no_delete
BEFORE DELETE ON candidate_review_decisions BEGIN SELECT RAISE(ABORT, 'candidate decisions are append-only'); END;

CREATE TRIGGER IF NOT EXISTS review_audit_events_no_update
BEFORE UPDATE ON review_audit_events BEGIN SELECT RAISE(ABORT, 'review audit events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS review_audit_events_no_delete
BEFORE DELETE ON review_audit_events BEGIN SELECT RAISE(ABORT, 'review audit events are append-only'); END;

-- The two researched records are already ledger claims. The 13 extraction
-- candidates are intentionally not promoted or enqueued by this migration.
INSERT OR IGNORE INTO review_work_items
  (work_item_id,claim_id,candidate_id,promotion_id,origin_kind,work_type,status,
   required_matching_reviews,max_reviews,created_at)
SELECT 'work_' || claim.claim_id,claim.claim_id,NULL,NULL,'existing_ledger_claim',
  'claim_adjudication','ready',2,4,'2026-07-20T00:00:00.000Z'
FROM claims claim
WHERE claim.visibility='draft'
  AND EXISTS (SELECT 1 FROM public_research_briefs brief WHERE brief.claim_id=claim.claim_id);

INSERT OR IGNORE INTO review_work_items
  (work_item_id,claim_id,candidate_id,promotion_id,origin_kind,work_type,status,
   required_matching_reviews,max_reviews,created_at)
SELECT 'work_candidate_' || candidate.candidate_id,NULL,candidate.candidate_id,NULL,
  'private_extraction_candidate','candidate_verification','ready',2,2,candidate.created_at
FROM claim_candidates candidate
WHERE candidate.candidate_kind='exact_transcript_claim'
  AND candidate.requires_human_review=1;
