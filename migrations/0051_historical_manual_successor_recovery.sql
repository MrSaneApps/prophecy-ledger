PRAGMA foreign_keys = ON;

-- A historical manual receipt describes the successor state observed at that
-- time; it must not permanently mask later queued or completed successor work.
-- Replace only the derived view. All source, receipt, link, disposition,
-- extraction, candidate, and reviewer rows remain append-only and untouched.
DROP VIEW analysis_section_lineage_v2;

CREATE VIEW analysis_section_lineage_v2 AS
WITH current_prompt AS (
  SELECT prompt_version,generation FROM analysis_prompt_versions
  ORDER BY generation DESC LIMIT 1
), failed_sources AS (
  SELECT section.analysis_section_id,section.analysis_run_id,section.section_index,
    section.input_sha256,section.base_offset,section.approximate_timestamp_seconds,
    section.status source_status,section.attempt_count source_attempt_count,
    section.error_code source_error_code,run.transcript_id,run.source_item_id,
    run.transcript_sha256,run.prompt_version source_prompt_version,
    version.generation source_prompt_generation,job.job_id source_job_id,
    job.status source_job_status,job.attempt_count source_job_attempt_count,
    job.error_code source_job_error_code
  FROM transcript_analysis_sections section
  JOIN transcript_analysis_runs run ON run.analysis_run_id=section.analysis_run_id
  LEFT JOIN analysis_prompt_versions version ON version.prompt_version=run.prompt_version
  JOIN ingestion_jobs job ON job.run_id=run.ingestion_run_id
    AND job.job_type='transcript_extract'
    AND json_extract(job.payload_json,'$.phase')='analyze'
    AND json_extract(job.payload_json,'$.analysisSectionId')=section.analysis_section_id
  WHERE section.status='failed'
), exact_successors AS (
  SELECT source.analysis_section_id predecessor_section_id,
    successor.analysis_section_id successor_analysis_section_id,
    successor.analysis_run_id successor_analysis_run_id,
    successor.status successor_status,successor.attempt_count successor_attempt_count,
    successor.error_code successor_error_code,successor_job.job_id successor_job_id,
    successor_job.status successor_job_status,
    successor_job.attempt_count successor_job_attempt_count,
    successor_job.error_code successor_job_error_code
  FROM failed_sources source CROSS JOIN current_prompt current
  JOIN transcript_analysis_runs successor_run
    ON successor_run.transcript_id=source.transcript_id
    AND successor_run.source_item_id=source.source_item_id
    AND successor_run.transcript_sha256=source.transcript_sha256
    AND successor_run.prompt_version=current.prompt_version
  JOIN transcript_analysis_sections successor
    ON successor.analysis_run_id=successor_run.analysis_run_id
    AND successor.section_index=source.section_index
    AND successor.input_sha256=source.input_sha256
    AND successor.base_offset=source.base_offset
    AND successor.approximate_timestamp_seconds=source.approximate_timestamp_seconds
  LEFT JOIN ingestion_jobs successor_job ON successor_job.run_id=successor_run.ingestion_run_id
    AND successor_job.job_type='transcript_extract'
    AND json_extract(successor_job.payload_json,'$.phase')='analyze'
    AND json_extract(successor_job.payload_json,'$.analysisSectionId')=successor.analysis_section_id
)
SELECT source.*,current.prompt_version target_prompt_version,
  current.generation target_prompt_generation,
  successor.successor_analysis_run_id,successor.successor_analysis_section_id,
  successor.successor_job_id,successor.successor_status,
  successor.successor_attempt_count,successor.successor_error_code,
  successor.successor_job_status,successor.successor_job_attempt_count,
  successor.successor_job_error_code,disposition.disposition_id,
  CASE
    WHEN disposition.disposition_id IS NOT NULL THEN 'superseded'
    WHEN source.source_prompt_generation IS NULL
      OR source.source_prompt_generation < current.generation
    THEN CASE
      WHEN successor.successor_status='completed'
        AND successor.successor_job_status='completed' THEN 'finalization_pending'
      WHEN successor.successor_status IN ('queued','processing')
        OR successor.successor_job_status IN ('queued','processing') THEN 'successor_pending'
      WHEN successor.successor_status='failed'
        OR successor.successor_job_status='failed'
      THEN CASE WHEN EXISTS (
        SELECT 1 FROM analysis_reconciliation_item_receipts receipt
        WHERE receipt.analysis_section_id=source.analysis_section_id
          AND receipt.outcome='manual_required'
          AND receipt.source_prompt_version=source.source_prompt_version
          AND receipt.target_prompt_version=current.prompt_version
      ) THEN 'manual_required' ELSE 'successor_retryable' END
      ELSE 'successor_required'
    END
    WHEN EXISTS (
      SELECT 1 FROM analysis_reconciliation_item_receipts receipt
      WHERE receipt.analysis_section_id=source.analysis_section_id
        AND receipt.outcome='manual_required'
    ) THEN 'manual_required'
    ELSE 'current_retryable'
  END debt_state
FROM failed_sources source CROSS JOIN current_prompt current
LEFT JOIN exact_successors successor
  ON successor.predecessor_section_id=source.analysis_section_id
LEFT JOIN analysis_section_dispositions disposition
  ON disposition.predecessor_section_id=source.analysis_section_id;
