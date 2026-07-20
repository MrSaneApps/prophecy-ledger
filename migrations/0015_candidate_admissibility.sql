PRAGMA foreign_keys = ON;

-- Every extraction suggestion receives an immutable admission assessment. A
-- candidate may enter the private reviewer queue only when its latest
-- assessment passed the source-grounded v4 rubric.
CREATE TABLE IF NOT EXISTS candidate_admissibility_assessments (
  assessment_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES claim_candidates(candidate_id),
  gate_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('eligible','rejected','quarantined')),
  who_text TEXT,
  what_text TEXT,
  why_text TEXT,
  where_text TEXT,
  when_text TEXT,
  how_text TEXT,
  how_specificity TEXT NOT NULL CHECK (how_specificity IN ('stated','not_stated')),
  public_evidence_text TEXT,
  pass_condition_text TEXT,
  fail_condition_text TEXT,
  grounding_json TEXT NOT NULL CHECK (json_valid(grounding_json)),
  rejection_codes_json TEXT NOT NULL CHECK (json_valid(rejection_codes_json)),
  assessed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(candidate_id, gate_version),
  CHECK (decision <> 'eligible' OR (
    length(trim(who_text)) > 0 AND lower(trim(who_text)) <> 'not stated'
    AND length(trim(what_text)) > 0 AND lower(trim(what_text)) <> 'not stated'
    AND length(trim(why_text)) > 0 AND lower(trim(why_text)) <> 'not stated'
    AND length(trim(where_text)) > 0 AND lower(trim(where_text)) <> 'not stated'
    AND length(trim(when_text)) > 0 AND lower(trim(when_text)) <> 'not stated'
    AND length(trim(how_text)) > 0
    AND ((lower(trim(how_text))='not stated' AND how_specificity='not_stated')
      OR (lower(trim(how_text))<>'not stated' AND how_specificity='stated'))
    AND length(trim(public_evidence_text)) > 0
    AND length(trim(pass_condition_text)) > 0
    AND length(trim(fail_condition_text)) > 0
    AND rejection_codes_json='[]'
  ))
);

CREATE INDEX IF NOT EXISTS candidate_admissibility_latest
  ON candidate_admissibility_assessments(candidate_id,created_at DESC,assessment_id DESC);

CREATE VIEW IF NOT EXISTS eligible_claim_candidates AS
SELECT candidate.*
FROM claim_candidates candidate
JOIN candidate_admissibility_assessments assessment
  ON assessment.candidate_id=candidate.candidate_id
WHERE assessment.decision='eligible'
  AND NOT EXISTS (
    SELECT 1 FROM candidate_admissibility_assessments newer
    WHERE newer.candidate_id=assessment.candidate_id
      AND (newer.created_at>assessment.created_at OR
        (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id))
  );

CREATE TRIGGER IF NOT EXISTS candidate_admissibility_assessments_no_update
BEFORE UPDATE ON candidate_admissibility_assessments
BEGIN SELECT RAISE(ABORT, 'candidate admissibility assessments are append-only'); END;
CREATE TRIGGER IF NOT EXISTS candidate_admissibility_assessments_no_delete
BEFORE DELETE ON candidate_admissibility_assessments
BEGIN SELECT RAISE(ABORT, 'candidate admissibility assessments are append-only'); END;

-- The thirteen v3 transcript suggestions predate the grounded rubric. Preserve
-- them as private provenance, but quarantine them and withdraw any queue work.
INSERT OR IGNORE INTO candidate_admissibility_assessments
  (assessment_id,candidate_id,gate_version,decision,who_text,what_text,why_text,
   where_text,when_text,how_text,how_specificity,public_evidence_text,pass_condition_text,
   fail_condition_text,grounding_json,rejection_codes_json,assessed_by,created_at)
SELECT 'assessment_legacy_quarantine_' || candidate.candidate_id,
  candidate.candidate_id,'legacy-v3-quarantine','quarantined',
  NULL,NULL,NULL,NULL,NULL,'Not stated','not_stated',NULL,NULL,NULL,'{}',
  '["legacy_candidate_requires_v4_reassessment"]','system:migration-0015',
  '2026-07-20T18:00:00.000Z'
FROM claim_candidates candidate
WHERE candidate.candidate_kind='exact_transcript_claim';

-- Record the system quarantine before releasing leases so the audit detail
-- preserves whether this migration actually displaced an active reviewer.
-- The deterministic ID makes migration reruns idempotent.
INSERT OR IGNORE INTO review_audit_events
  (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
   assignment_id,detail_json,created_at)
SELECT 'audit_m0015_quarantine_' || work.work_item_id,NULL,
  'evaluation_reconciled',work.work_item_id,NULL,work.candidate_id,NULL,
  json_object(
    'action','candidate_quarantined',
    'gateVersion','legacy-v3-quarantine',
    'assignmentReleased',CASE WHEN EXISTS (
      SELECT 1 FROM review_assignments assignment
      WHERE assignment.work_item_id=work.work_item_id
        AND assignment.status='leased'
    ) THEN json('true') ELSE json('false') END
  ),
  '2026-07-20T18:00:00.000Z'
FROM review_work_items work
JOIN candidate_admissibility_assessments assessment
  ON assessment.candidate_id=work.candidate_id
WHERE assessment.gate_version='legacy-v3-quarantine';

UPDATE review_assignments
SET status='released',submitted_at=NULL
WHERE status='leased' AND work_item_id IN (
  SELECT work.work_item_id FROM review_work_items work
  JOIN candidate_admissibility_assessments assessment
    ON assessment.candidate_id=work.candidate_id
  WHERE assessment.gate_version='legacy-v3-quarantine'
);

UPDATE review_work_items
SET status='withdrawn',completed_at=COALESCE(completed_at,'2026-07-20T18:00:00.000Z')
WHERE status='ready' AND candidate_id IN (
  SELECT candidate_id FROM candidate_admissibility_assessments
  WHERE gate_version='legacy-v3-quarantine'
);

-- Promotion is also fail-closed at the database boundary.
DROP TRIGGER IF EXISTS candidate_claim_promotions_exact_candidate;
CREATE TRIGGER candidate_claim_promotions_exact_candidate
BEFORE INSERT ON candidate_claim_promotions
WHEN NOT EXISTS (
  SELECT 1 FROM claim_candidates candidate
  JOIN candidate_admissibility_assessments assessment
    ON assessment.candidate_id=candidate.candidate_id
  WHERE candidate.candidate_id=NEW.candidate_id
    AND candidate.candidate_kind='exact_transcript_claim'
    AND candidate.requires_human_review=1
    AND assessment.decision='eligible'
    AND NOT EXISTS (
      SELECT 1 FROM candidate_admissibility_assessments newer
      WHERE newer.candidate_id=assessment.candidate_id
        AND (newer.created_at>assessment.created_at OR
          (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id))
    )
)
BEGIN SELECT RAISE(ABORT, 'only an eligible exact private candidate can be explicitly promoted'); END;
