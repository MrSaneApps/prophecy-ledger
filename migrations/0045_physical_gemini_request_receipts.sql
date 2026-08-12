PRAGMA foreign_keys = ON;

CREATE TABLE gemini_physical_day_debits (
  debit_id TEXT PRIMARY KEY,
  media_day TEXT NOT NULL CHECK (length(media_day) = 10),
  reserved_seconds INTEGER NOT NULL CHECK (reserved_seconds BETWEEN 1 AND 86400),
  reason TEXT NOT NULL CHECK (reason IN ('legacy_cutover_fail_closed','operator_correction')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_gemini_physical_day_debits_day
  ON gemini_physical_day_debits(media_day, created_at);

CREATE TABLE gemini_physical_request_reservations (
  physical_request_id TEXT PRIMARY KEY,
  logical_reservation_id TEXT NOT NULL REFERENCES gemini_media_reservations(reservation_id),
  media_day TEXT NOT NULL CHECK (length(media_day) = 10),
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  job_attempt INTEGER NOT NULL CHECK (job_attempt >= 1),
  split_path TEXT NOT NULL CHECK (
    split_path = 'root' OR
    (length(split_path) BETWEEN 1 AND 4 AND split_path NOT GLOB '*[^LR]*')
  ),
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds INTEGER NOT NULL CHECK (end_seconds > start_seconds),
  reserved_seconds INTEGER NOT NULL CHECK (
    reserved_seconds = end_seconds - start_seconds AND reserved_seconds BETWEEN 1 AND 86400
  ),
  budget_limit_seconds INTEGER NOT NULL CHECK (budget_limit_seconds BETWEEN 1 AND 86400),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, job_attempt, chunk_index, split_path, start_seconds, end_seconds)
);

CREATE INDEX idx_gemini_physical_reservations_day
  ON gemini_physical_request_reservations(media_day, created_at);
CREATE INDEX idx_gemini_physical_reservations_logical
  ON gemini_physical_request_reservations(logical_reservation_id, split_path);

CREATE TRIGGER gemini_physical_reservation_binding_guard
BEFORE INSERT ON gemini_physical_request_reservations
WHEN NOT EXISTS (
  SELECT 1 FROM gemini_media_reservations logical
  WHERE logical.reservation_id = NEW.logical_reservation_id
    AND logical.run_id = NEW.run_id
    AND logical.job_id = NEW.job_id
    AND logical.source_item_id = NEW.source_item_id
    AND logical.chunk_index = NEW.chunk_index
    AND logical.job_attempt = NEW.job_attempt
    AND NEW.start_seconds >= logical.start_seconds
    AND NEW.end_seconds <= logical.end_seconds
)
BEGIN
  SELECT RAISE(ABORT, 'gemini physical request binding mismatch');
END;

CREATE TRIGGER gemini_physical_media_budget_guard
BEFORE INSERT ON gemini_physical_request_reservations
WHEN (
  COALESCE((SELECT SUM(reserved_seconds) FROM gemini_physical_day_debits
    WHERE media_day = NEW.media_day), 0)
  + COALESCE((SELECT SUM(reserved_seconds) FROM gemini_physical_request_reservations
    WHERE media_day = NEW.media_day), 0)
  + NEW.reserved_seconds
) > MIN(86400, NEW.budget_limit_seconds)
BEGIN
  SELECT RAISE(ABORT, 'gemini physical media budget exhausted');
END;

CREATE TABLE gemini_physical_request_results (
  result_id TEXT PRIMARY KEY,
  physical_request_id TEXT NOT NULL UNIQUE
    REFERENCES gemini_physical_request_reservations(physical_request_id),
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  safe_cause_code TEXT CHECK (safe_cause_code IS NULL OR safe_cause_code IN (
    'gemini_timeout','gemini_network_error','gemini_http_4xx','gemini_http_429',
    'gemini_http_5xx','gemini_output_truncated','gemini_incomplete_response',
    'transcript_empty_output','transcript_chunk_too_large','physical_result_unknown'
  )),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  response_id TEXT,
  finish_reason TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  completed_at TEXT NOT NULL,
  CHECK ((status = 'completed' AND safe_cause_code IS NULL) OR
         (status = 'failed' AND safe_cause_code IS NOT NULL))
);

CREATE INDEX idx_gemini_physical_results_status
  ON gemini_physical_request_results(status, safe_cause_code, completed_at);

CREATE TRIGGER gemini_physical_day_debits_no_update
BEFORE UPDATE ON gemini_physical_day_debits BEGIN
  SELECT RAISE(ABORT, 'gemini physical day debits are append-only');
END;
CREATE TRIGGER gemini_physical_day_debits_no_delete
BEFORE DELETE ON gemini_physical_day_debits BEGIN
  SELECT RAISE(ABORT, 'gemini physical day debits are append-only');
END;
CREATE TRIGGER gemini_physical_reservations_no_update
BEFORE UPDATE ON gemini_physical_request_reservations BEGIN
  SELECT RAISE(ABORT, 'gemini physical request reservations are append-only');
END;
CREATE TRIGGER gemini_physical_reservations_no_delete
BEFORE DELETE ON gemini_physical_request_reservations BEGIN
  SELECT RAISE(ABORT, 'gemini physical request reservations are append-only');
END;
CREATE TRIGGER gemini_physical_results_no_update
BEFORE UPDATE ON gemini_physical_request_results BEGIN
  SELECT RAISE(ABORT, 'gemini physical request results are append-only');
END;
CREATE TRIGGER gemini_physical_results_no_delete
BEFORE DELETE ON gemini_physical_request_results BEGIN
  SELECT RAISE(ABORT, 'gemini physical request results are append-only');
END;
