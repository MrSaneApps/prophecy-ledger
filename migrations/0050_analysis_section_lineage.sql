PRAGMA foreign_keys = ON;

-- Prompt identities are immutable generations. Never compare version strings
-- lexically: v10 sorts before v9 even though it is the newer contract.
CREATE TABLE analysis_prompt_versions (
  prompt_version TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1),
  registered_at TEXT NOT NULL
);

INSERT INTO analysis_prompt_versions (prompt_version,generation,registered_at) VALUES
  ('transcript-claims-v4-grounded-5w1h',4,'2026-08-04T00:00:00.000Z'),
  ('transcript-claims-v5-grounded-5w1h-offset-repair',5,'2026-08-04T00:00:00.000Z'),
  ('transcript-claims-v6-atomic-routing',6,'2026-08-04T00:00:00.000Z'),
  ('transcript-claims-v7-exact-span-routing',7,'2026-08-04T00:00:00.000Z'),
  ('transcript-claims-v8-archive-checklist',8,'2026-08-04T00:00:00.000Z'),
  ('transcript-claims-v9-archive-quoted-checklist',9,'2026-08-04T00:00:00.000Z'),
  ('transcript-claims-v10-receipted-successor-routing',10,'2026-08-04T00:00:00.000Z');

CREATE TRIGGER analysis_prompt_versions_no_update
BEFORE UPDATE ON analysis_prompt_versions
BEGIN SELECT RAISE(ABORT, 'analysis prompt versions are append-only'); END;
CREATE TRIGGER analysis_prompt_versions_no_delete
BEFORE DELETE ON analysis_prompt_versions
BEGIN SELECT RAISE(ABORT, 'analysis prompt versions are append-only'); END;

-- A link says which exact current-generation section can replace one historical
-- failed section. It does not itself resolve or hide the failure.
CREATE TABLE analysis_section_successor_links (
  link_id TEXT PRIMARY KEY,
  predecessor_section_id TEXT NOT NULL
    REFERENCES transcript_analysis_sections(analysis_section_id),
  successor_section_id TEXT NOT NULL
    REFERENCES transcript_analysis_sections(analysis_section_id),
  predecessor_prompt_version TEXT NOT NULL
    REFERENCES analysis_prompt_versions(prompt_version),
  successor_prompt_version TEXT NOT NULL
    REFERENCES analysis_prompt_versions(prompt_version),
  action_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (predecessor_section_id,successor_prompt_version),
  CHECK (predecessor_section_id <> successor_section_id)
);

CREATE TRIGGER analysis_section_successor_links_binding_guard
BEFORE INSERT ON analysis_section_successor_links
WHEN NOT EXISTS (
  SELECT 1
  FROM transcript_analysis_sections predecessor
  JOIN transcript_analysis_runs predecessor_run
    ON predecessor_run.analysis_run_id=predecessor.analysis_run_id
  JOIN analysis_prompt_versions predecessor_version
    ON predecessor_version.prompt_version=predecessor_run.prompt_version
  JOIN transcript_analysis_sections successor
    ON successor.analysis_section_id=NEW.successor_section_id
  JOIN transcript_analysis_runs successor_run
    ON successor_run.analysis_run_id=successor.analysis_run_id
  JOIN analysis_prompt_versions successor_version
    ON successor_version.prompt_version=successor_run.prompt_version
  WHERE predecessor.analysis_section_id=NEW.predecessor_section_id
    AND predecessor.status='failed'
    AND predecessor_run.prompt_version=NEW.predecessor_prompt_version
    AND successor_run.prompt_version=NEW.successor_prompt_version
    AND successor_version.generation > predecessor_version.generation
    AND successor_version.generation=(SELECT MAX(generation) FROM analysis_prompt_versions)
    AND successor_run.transcript_id=predecessor_run.transcript_id
    AND successor_run.source_item_id=predecessor_run.source_item_id
    AND successor_run.transcript_sha256=predecessor_run.transcript_sha256
    AND successor.section_index=predecessor.section_index
    AND successor.input_sha256=predecessor.input_sha256
    AND successor.base_offset=predecessor.base_offset
    AND successor.approximate_timestamp_seconds=predecessor.approximate_timestamp_seconds
)
BEGIN SELECT RAISE(ABORT, 'analysis successor link binding mismatch'); END;

CREATE TRIGGER analysis_section_successor_links_no_update
BEFORE UPDATE ON analysis_section_successor_links
BEGIN SELECT RAISE(ABORT, 'analysis successor links are append-only'); END;
CREATE TRIGGER analysis_section_successor_links_no_delete
BEFORE DELETE ON analysis_section_successor_links
BEGIN SELECT RAISE(ABORT, 'analysis successor links are append-only'); END;

-- Only this completed-successor receipt removes a historical failed section
-- from active debt. The old section, job, run, extraction, and candidates remain.
CREATE TABLE analysis_section_dispositions (
  disposition_id TEXT PRIMARY KEY,
  predecessor_section_id TEXT NOT NULL UNIQUE
    REFERENCES transcript_analysis_sections(analysis_section_id),
  successor_section_id TEXT NOT NULL
    REFERENCES transcript_analysis_sections(analysis_section_id),
  link_id TEXT NOT NULL UNIQUE REFERENCES analysis_section_successor_links(link_id),
  disposition TEXT NOT NULL CHECK (disposition='superseded_by_completed_successor'),
  action_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER analysis_section_dispositions_binding_guard
BEFORE INSERT ON analysis_section_dispositions
WHEN NOT EXISTS (
  SELECT 1
  FROM analysis_section_successor_links link
  JOIN transcript_analysis_sections successor
    ON successor.analysis_section_id=link.successor_section_id
  JOIN transcript_analysis_runs successor_run
    ON successor_run.analysis_run_id=successor.analysis_run_id
  JOIN ingestion_jobs successor_job
    ON successor_job.run_id=successor_run.ingestion_run_id
    AND successor_job.job_type='transcript_extract'
    AND json_extract(successor_job.payload_json,'$.phase')='analyze'
    AND json_extract(successor_job.payload_json,'$.analysisSectionId')=successor.analysis_section_id
  JOIN extraction_runs extraction ON extraction.extraction_run_id=successor.extraction_run_id
  WHERE link.link_id=NEW.link_id
    AND link.predecessor_section_id=NEW.predecessor_section_id
    AND link.successor_section_id=NEW.successor_section_id
    AND link.action_id=NEW.action_id
    AND successor.status='completed'
    AND successor.extraction_run_id IS NOT NULL
    AND successor_job.status='completed'
    AND extraction.status='completed'
    AND extraction.source_item_id=successor_run.source_item_id
    AND extraction.transcript_id=successor_run.transcript_id
    AND extraction.input_sha256=successor.input_sha256
    AND extraction.prompt_version=successor_run.prompt_version
)
BEGIN SELECT RAISE(ABORT, 'analysis section disposition binding mismatch'); END;

CREATE TRIGGER analysis_section_dispositions_no_update
BEFORE UPDATE ON analysis_section_dispositions
BEGIN SELECT RAISE(ABORT, 'analysis section dispositions are append-only'); END;
CREATE TRIGGER analysis_section_dispositions_no_delete
BEFORE DELETE ON analysis_section_dispositions
BEGIN SELECT RAISE(ABORT, 'analysis section dispositions are append-only'); END;

ALTER TABLE analysis_reconciliation_item_receipts
  ADD COLUMN source_prompt_version TEXT;
ALTER TABLE analysis_reconciliation_item_receipts
  ADD COLUMN target_prompt_version TEXT;
ALTER TABLE analysis_reconciliation_item_receipts
  ADD COLUMN successor_analysis_run_id TEXT REFERENCES transcript_analysis_runs(analysis_run_id);
ALTER TABLE analysis_reconciliation_item_receipts
  ADD COLUMN successor_analysis_section_id TEXT REFERENCES transcript_analysis_sections(analysis_section_id);
ALTER TABLE analysis_reconciliation_item_receipts
  ADD COLUMN successor_job_id TEXT REFERENCES ingestion_jobs(job_id);
ALTER TABLE analysis_reconciliation_item_receipts
  ADD COLUMN disposition_id TEXT REFERENCES analysis_section_dispositions(disposition_id);

CREATE TRIGGER analysis_reconciliation_successor_receipt_guard
BEFORE INSERT ON analysis_reconciliation_item_receipts
WHEN NEW.outcome='completed' AND NEW.safe_reason_code='historical_section_superseded'
  AND NOT EXISTS (
    SELECT 1
    FROM analysis_section_dispositions disposition
    JOIN analysis_section_successor_links link ON link.link_id=disposition.link_id
    JOIN transcript_analysis_sections successor
      ON successor.analysis_section_id=disposition.successor_section_id
    JOIN transcript_analysis_runs successor_run
      ON successor_run.analysis_run_id=successor.analysis_run_id
    JOIN ingestion_jobs successor_job
      ON successor_job.job_id=NEW.successor_job_id
      AND successor_job.run_id=successor_run.ingestion_run_id
      AND json_extract(successor_job.payload_json,'$.analysisSectionId')=successor.analysis_section_id
    WHERE disposition.disposition_id=NEW.disposition_id
      AND disposition.predecessor_section_id=NEW.analysis_section_id
      AND disposition.successor_section_id=NEW.successor_analysis_section_id
      AND successor.analysis_run_id=NEW.successor_analysis_run_id
      AND link.predecessor_prompt_version=NEW.source_prompt_version
      AND link.successor_prompt_version=NEW.target_prompt_version
      AND successor.status='completed' AND successor_job.status='completed'
  )
BEGIN SELECT RAISE(ABORT, 'analysis reconciliation successor receipt mismatch'); END;

CREATE INDEX analysis_successor_links_predecessor
  ON analysis_section_successor_links(predecessor_section_id,successor_prompt_version);
CREATE INDEX analysis_dispositions_successor
  ON analysis_section_dispositions(successor_section_id,predecessor_section_id);

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
    WHEN EXISTS (
      SELECT 1 FROM analysis_reconciliation_item_receipts receipt
      WHERE receipt.analysis_section_id=source.analysis_section_id
        AND receipt.outcome='manual_required'
        AND (source.source_prompt_generation=current.generation
          OR receipt.target_prompt_version=current.prompt_version)
    ) THEN 'manual_required'
    WHEN source.source_prompt_generation IS NULL
      OR source.source_prompt_generation < current.generation
    THEN CASE
      WHEN successor.successor_analysis_section_id IS NULL THEN 'successor_required'
      WHEN successor.successor_status='completed'
        AND successor.successor_job_status='completed' THEN 'finalization_pending'
      WHEN successor.successor_status IN ('queued','processing')
        OR successor.successor_job_status IN ('queued','processing') THEN 'successor_pending'
      WHEN successor.successor_status='failed'
        OR successor.successor_job_status='failed' THEN 'successor_retryable'
      ELSE 'successor_required'
    END
    ELSE 'current_retryable'
  END debt_state
FROM failed_sources source CROSS JOIN current_prompt current
LEFT JOIN exact_successors successor
  ON successor.predecessor_section_id=source.analysis_section_id
LEFT JOIN analysis_section_dispositions disposition
  ON disposition.predecessor_section_id=source.analysis_section_id;
