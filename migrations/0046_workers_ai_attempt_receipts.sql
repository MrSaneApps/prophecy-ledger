PRAGMA foreign_keys = ON;

CREATE TABLE workers_ai_attempt_receipts (
  receipt_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  work_kind TEXT NOT NULL CHECK (work_kind IN ('description_triage','transcript_analysis')),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  job_attempt INTEGER NOT NULL CHECK (job_attempt >= 1),
  analysis_run_id TEXT REFERENCES transcript_analysis_runs(analysis_run_id),
  analysis_section_id TEXT REFERENCES transcript_analysis_sections(analysis_section_id),
  model_name TEXT NOT NULL CHECK (length(model_name) BETWEEN 1 AND 160),
  mode TEXT NOT NULL CHECK (mode IN ('json_schema','plain_json')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  status TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
  safe_cause_code TEXT CHECK (safe_cause_code IS NULL OR safe_cause_code IN (
    'ai_timeout_unconfirmed','provider_429','provider_5xx','model_unavailable',
    'json_schema_unsupported','invalid_json','invalid_payload','unknown_provider_error'
  )),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  fallback_eligible INTEGER NOT NULL CHECK (fallback_eligible IN (0,1)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  UNIQUE (attempt_id, status),
  CHECK ((work_kind = 'description_triage' AND analysis_run_id IS NULL AND analysis_section_id IS NULL) OR
         (work_kind = 'transcript_analysis' AND analysis_run_id IS NOT NULL AND analysis_section_id IS NOT NULL)),
  CHECK ((status = 'started' AND safe_cause_code IS NULL AND http_status IS NULL AND
           fallback_eligible = 0 AND completed_at IS NULL AND latency_ms IS NULL) OR
         (status = 'completed' AND safe_cause_code IS NULL AND fallback_eligible = 0 AND
           completed_at IS NOT NULL AND latency_ms IS NOT NULL) OR
         (status = 'failed' AND safe_cause_code IS NOT NULL AND
           completed_at IS NOT NULL AND latency_ms IS NOT NULL))
);

CREATE INDEX idx_workers_ai_attempts_analysis
  ON workers_ai_attempt_receipts(analysis_run_id, analysis_section_id, job_attempt, ordinal);
CREATE INDEX idx_workers_ai_attempts_cause
  ON workers_ai_attempt_receipts(status, safe_cause_code, completed_at);
CREATE UNIQUE INDEX idx_workers_ai_attempt_terminal_once
  ON workers_ai_attempt_receipts(attempt_id)
  WHERE status IN ('completed','failed');

CREATE TRIGGER workers_ai_attempt_binding_guard
BEFORE INSERT ON workers_ai_attempt_receipts
WHEN NOT (
  (NEW.work_kind = 'description_triage' AND EXISTS (
    SELECT 1 FROM ingestion_jobs job
    WHERE job.job_id = NEW.job_id
      AND job.job_type = 'description_triage'
      AND job.attempt_count = NEW.job_attempt
  )) OR
  (NEW.work_kind = 'transcript_analysis' AND EXISTS (
  SELECT 1
  FROM ingestion_jobs job
  JOIN transcript_analysis_sections section
    ON section.analysis_section_id = NEW.analysis_section_id
  WHERE job.job_id = NEW.job_id
    AND job.job_type = 'transcript_extract'
    AND json_extract(job.payload_json, '$.phase') = 'analyze'
    AND json_extract(job.payload_json, '$.analysisRunId') = NEW.analysis_run_id
    AND json_extract(job.payload_json, '$.analysisSectionId') = NEW.analysis_section_id
    AND section.analysis_run_id = NEW.analysis_run_id
    AND job.attempt_count = NEW.job_attempt
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'workers ai attempt binding mismatch');
END;

CREATE TRIGGER workers_ai_attempt_terminal_guard
BEFORE INSERT ON workers_ai_attempt_receipts
WHEN NEW.status IN ('completed','failed') AND NOT EXISTS (
  SELECT 1 FROM workers_ai_attempt_receipts started
  WHERE started.attempt_id = NEW.attempt_id
    AND started.status = 'started'
    AND started.work_kind = NEW.work_kind
    AND started.job_id = NEW.job_id
    AND started.job_attempt = NEW.job_attempt
    AND started.analysis_run_id IS NEW.analysis_run_id
    AND started.analysis_section_id IS NEW.analysis_section_id
    AND started.model_name = NEW.model_name
    AND started.mode = NEW.mode
    AND started.ordinal = NEW.ordinal
    AND started.started_at = NEW.started_at
)
BEGIN
  SELECT RAISE(ABORT, 'workers ai attempt terminal missing started receipt');
END;

CREATE TRIGGER workers_ai_attempts_no_update
BEFORE UPDATE ON workers_ai_attempt_receipts BEGIN
  SELECT RAISE(ABORT, 'workers ai attempt receipts are append-only');
END;
CREATE TRIGGER workers_ai_attempts_no_delete
BEFORE DELETE ON workers_ai_attempt_receipts BEGIN
  SELECT RAISE(ABORT, 'workers ai attempt receipts are append-only');
END;
