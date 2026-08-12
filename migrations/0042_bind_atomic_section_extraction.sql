PRAGMA foreign_keys = ON;

-- Review-ready admission must prove the analysis section belongs to the same
-- extraction run as the candidate. The queue view already required this; move
-- the invariant to the insert boundary so no row can claim readiness while
-- remaining invisible to reviewers.
DROP TRIGGER IF EXISTS candidate_atomic_readiness_ready_binding_guard;
CREATE TRIGGER candidate_atomic_readiness_ready_binding_guard
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
    AND section.extraction_run_id=candidate.extraction_run_id AND section.status='completed'
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
