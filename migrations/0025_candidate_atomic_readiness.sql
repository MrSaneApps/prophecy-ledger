PRAGMA foreign_keys = ON;

-- Atomic readiness is a separate immutable gate between private extraction
-- and human review. A review-ready row binds the candidate to the exact
-- transcript, analysis section, source identity, offsets, and gate version.
CREATE TABLE IF NOT EXISTS candidate_atomic_readiness (
  readiness_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES claim_candidates(candidate_id),
  analysis_section_id TEXT REFERENCES transcript_analysis_sections(analysis_section_id),
  transcript_id TEXT REFERENCES transcript_artifacts(transcript_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  gate_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'review_ready','general','under_specified','mixed_split_required','quarantined'
  )),
  material_proposition_count INTEGER NOT NULL CHECK (material_proposition_count BETWEEN 0 AND 25),
  transcript_sha256 TEXT CHECK (transcript_sha256 IS NULL OR length(transcript_sha256)=64),
  section_sha256 TEXT CHECK (section_sha256 IS NULL OR length(section_sha256)=64),
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR length(source_sha256)=64),
  source_identity_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_identity_json)),
  quote_start INTEGER,
  quote_end INTEGER,
  context_start INTEGER,
  context_end INTEGER,
  section_start INTEGER,
  section_end INTEGER,
  clip_start_seconds INTEGER,
  clip_end_seconds INTEGER,
  support_offsets_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(support_offsets_json)),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
  assessed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(candidate_id,gate_version),
  CHECK (state<>'review_ready' OR (
    material_proposition_count=1
    AND analysis_section_id IS NOT NULL AND transcript_id IS NOT NULL
    AND transcript_sha256 IS NOT NULL AND section_sha256 IS NOT NULL AND source_sha256 IS NOT NULL
    AND quote_start>=0 AND quote_end>quote_start
    AND context_start>=0 AND context_end>context_start AND context_end-context_start<=1200
    AND quote_start>=context_start AND quote_end<=context_end
    AND section_start>=0 AND section_end>section_start
    AND context_start>=section_start AND context_end<=section_end
    AND clip_start_seconds>=0 AND clip_end_seconds>clip_start_seconds
    AND clip_end_seconds-clip_start_seconds<=300
    AND json_type(support_offsets_json)='object' AND reason_codes_json='[]'
  ))
);

CREATE INDEX IF NOT EXISTS candidate_atomic_readiness_latest
  ON candidate_atomic_readiness(candidate_id,created_at DESC,readiness_id DESC);
CREATE TRIGGER IF NOT EXISTS candidate_atomic_readiness_no_update
BEFORE UPDATE ON candidate_atomic_readiness
BEGIN SELECT RAISE(ABORT, 'candidate atomic readiness is append-only'); END;
CREATE TRIGGER IF NOT EXISTS candidate_atomic_readiness_no_delete
BEFORE DELETE ON candidate_atomic_readiness
BEGIN SELECT RAISE(ABORT, 'candidate atomic readiness is append-only'); END;

CREATE TRIGGER IF NOT EXISTS candidate_atomic_readiness_ready_binding_guard
BEFORE INSERT ON candidate_atomic_readiness
WHEN NEW.state='review_ready' AND NOT EXISTS (
  SELECT 1 FROM claim_candidates candidate
  JOIN extraction_runs extraction ON extraction.extraction_run_id=candidate.extraction_run_id
  JOIN transcript_artifacts artifact ON artifact.transcript_id=NEW.transcript_id
    AND artifact.source_item_id=candidate.source_item_id
  JOIN transcript_analysis_sections section ON section.analysis_section_id=NEW.analysis_section_id
  JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
  JOIN source_items source ON source.source_item_id=candidate.source_item_id
  JOIN candidate_admissibility_assessments assessment ON assessment.candidate_id=candidate.candidate_id
  WHERE candidate.candidate_id=NEW.candidate_id
    AND candidate.candidate_kind='exact_transcript_claim' AND candidate.requires_human_review=1
    AND candidate.source_item_id=NEW.source_item_id
    AND candidate.quote_start=NEW.quote_start AND candidate.quote_end=NEW.quote_end
    AND extraction.transcript_id=NEW.transcript_id
    AND extraction.prompt_version=NEW.gate_version AND extraction.input_sha256=NEW.section_sha256
    AND artifact.content_sha256=NEW.transcript_sha256
    AND analysis.transcript_id=NEW.transcript_id AND analysis.source_item_id=NEW.source_item_id
    AND analysis.transcript_sha256=NEW.transcript_sha256 AND analysis.prompt_version=NEW.gate_version
    AND section.input_sha256=NEW.section_sha256 AND section.base_offset=NEW.section_start
    AND section.approximate_timestamp_seconds=NEW.clip_start_seconds
    AND assessment.gate_version=NEW.gate_version AND assessment.decision='eligible'
    AND NOT EXISTS (SELECT 1 FROM candidate_admissibility_assessments newer
      WHERE newer.candidate_id=assessment.candidate_id AND
        (newer.created_at>assessment.created_at OR
          (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id)))
    AND json_extract(NEW.source_identity_json,'$.personId')=source.person_id
    AND json_extract(NEW.source_identity_json,'$.platform')=source.platform
    AND json_extract(NEW.source_identity_json,'$.platformItemId')=source.platform_item_id
    AND json_extract(NEW.source_identity_json,'$.canonicalUrl')=source.canonical_url
)
BEGIN SELECT RAISE(ABORT, 'review-ready candidate requires exact atomic source binding'); END;

INSERT OR IGNORE INTO candidate_atomic_readiness (
  readiness_id,candidate_id,source_item_id,gate_version,state,
  material_proposition_count,reason_codes_json,assessed_by,created_at
)
SELECT 'atomic_legacy_quarantine_' || candidate_id,candidate_id,source_item_id,
  'legacy-pre-v6-quarantine','quarantined',0,
  '["legacy_candidate_requires_v6_reassessment"]','system:migration-0025',
  '2026-07-20T22:00:00.000Z'
FROM claim_candidates;

CREATE VIEW IF NOT EXISTS review_ready_claim_candidates AS
SELECT candidate.*,readiness.readiness_id,readiness.analysis_section_id,
  readiness.transcript_id AS readiness_transcript_id,
  readiness.gate_version AS readiness_gate_version,readiness.state AS readiness_state,
  readiness.material_proposition_count,readiness.transcript_sha256,readiness.section_sha256,
  readiness.source_sha256,readiness.source_identity_json,readiness.context_start,
  readiness.context_end,readiness.section_start,readiness.section_end,
  readiness.clip_start_seconds,readiness.clip_end_seconds,readiness.support_offsets_json,
  readiness.created_at AS readiness_created_at
FROM claim_candidates candidate
JOIN candidate_atomic_readiness readiness ON readiness.candidate_id=candidate.candidate_id
JOIN candidate_admissibility_assessments assessment ON assessment.candidate_id=candidate.candidate_id
JOIN extraction_runs extraction ON extraction.extraction_run_id=candidate.extraction_run_id
JOIN transcript_artifacts artifact ON artifact.transcript_id=readiness.transcript_id
  AND artifact.source_item_id=candidate.source_item_id
JOIN transcript_analysis_sections section ON section.analysis_section_id=readiness.analysis_section_id
JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
WHERE readiness.state='review_ready' AND readiness.material_proposition_count=1
  AND assessment.decision='eligible' AND assessment.gate_version=readiness.gate_version
  AND extraction.prompt_version=readiness.gate_version
  AND extraction.transcript_id=readiness.transcript_id AND extraction.input_sha256=readiness.section_sha256
  AND artifact.content_sha256=readiness.transcript_sha256
  AND section.extraction_run_id=candidate.extraction_run_id AND section.status='completed'
  AND section.input_sha256=readiness.section_sha256
  AND analysis.transcript_id=readiness.transcript_id AND analysis.source_item_id=readiness.source_item_id
  AND analysis.transcript_sha256=readiness.transcript_sha256 AND analysis.prompt_version=readiness.gate_version
  AND NOT EXISTS (SELECT 1 FROM candidate_atomic_readiness newer
    WHERE newer.candidate_id=readiness.candidate_id AND
      (newer.created_at>readiness.created_at OR
        (newer.created_at=readiness.created_at AND newer.readiness_id>readiness.readiness_id)))
  AND NOT EXISTS (SELECT 1 FROM candidate_admissibility_assessments newer
    WHERE newer.candidate_id=assessment.candidate_id AND
      (newer.created_at>assessment.created_at OR
        (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id)));

DROP TRIGGER IF EXISTS candidate_claim_promotions_exact_candidate;
DROP TRIGGER IF EXISTS candidate_review_decisions_require_live_assignment;

CREATE TRIGGER review_work_items_atomic_candidate_guard
BEFORE INSERT ON review_work_items
WHEN NEW.work_type='candidate_verification' AND NOT EXISTS (
  SELECT 1 FROM review_ready_claim_candidates ready WHERE ready.candidate_id=NEW.candidate_id)
BEGIN SELECT RAISE(ABORT, 'candidate review work requires latest atomic readiness'); END;
CREATE TRIGGER review_assignments_atomic_candidate_guard
BEFORE INSERT ON review_assignments
WHEN EXISTS (SELECT 1 FROM review_work_items work WHERE work.work_item_id=NEW.work_item_id
  AND work.work_type='candidate_verification') AND NOT EXISTS (
    SELECT 1 FROM review_work_items work
    JOIN review_ready_claim_candidates ready ON ready.candidate_id=work.candidate_id
    WHERE work.work_item_id=NEW.work_item_id AND work.status='ready')
BEGIN SELECT RAISE(ABORT, 'candidate assignment requires latest atomic readiness'); END;
CREATE TRIGGER candidate_claim_promotions_exact_candidate
BEFORE INSERT ON candidate_claim_promotions
WHEN NOT EXISTS (SELECT 1 FROM review_ready_claim_candidates ready
  WHERE ready.candidate_id=NEW.candidate_id)
BEGIN SELECT RAISE(ABORT, 'only a review-ready atomic candidate can be promoted'); END;
CREATE TRIGGER candidate_review_decisions_require_live_assignment
BEFORE INSERT ON candidate_review_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM review_assignments assignment
  JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
  JOIN review_ready_claim_candidates ready ON ready.candidate_id=work.candidate_id
  WHERE work.work_item_id=NEW.work_item_id AND work.candidate_id=NEW.candidate_id
    AND work.work_type='candidate_verification' AND work.status='ready'
    AND assignment.reviewer_id=NEW.reviewer_id AND assignment.status='leased'
    AND assignment.lease_expires_at>NEW.created_at)
BEGIN SELECT RAISE(ABORT, 'a live atomic candidate assignment is required'); END;
