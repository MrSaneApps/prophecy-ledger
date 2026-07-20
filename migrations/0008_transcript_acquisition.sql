PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gemini_media_reservations (
  reservation_id TEXT PRIMARY KEY,
  media_day TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  job_attempt INTEGER NOT NULL CHECK (job_attempt >= 1),
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds INTEGER NOT NULL CHECK (end_seconds > start_seconds),
  reserved_seconds INTEGER NOT NULL CHECK (reserved_seconds = end_seconds - start_seconds),
  budget_limit_seconds INTEGER NOT NULL CHECK (budget_limit_seconds BETWEEN 1 AND 28800),
  created_at TEXT NOT NULL,
  UNIQUE(job_id, job_attempt, chunk_index)
);

CREATE TRIGGER IF NOT EXISTS gemini_media_daily_budget_guard
BEFORE INSERT ON gemini_media_reservations
WHEN COALESCE((SELECT SUM(reserved_seconds) FROM gemini_media_reservations
               WHERE media_day=NEW.media_day),0) + NEW.reserved_seconds > NEW.budget_limit_seconds
BEGIN SELECT RAISE(ABORT, 'gemini media budget exhausted'); END;

CREATE TABLE IF NOT EXISTS transcript_chunk_attempts (
  chunk_attempt_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES gemini_media_reservations(reservation_id),
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds INTEGER NOT NULL CHECK (end_seconds > start_seconds),
  overlap_seconds INTEGER NOT NULL CHECK (overlap_seconds BETWEEN 0 AND 60),
  provider TEXT NOT NULL CHECK (provider='google_gemini'),
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_id TEXT,
  finish_reason TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  r2_key TEXT UNIQUE,
  content_sha256 TEXT,
  byte_count INTEGER CHECK (byte_count IS NULL OR byte_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  CHECK ((status='completed' AND finish_reason='STOP' AND r2_key IS NOT NULL AND
          content_sha256 IS NOT NULL AND byte_count IS NOT NULL AND error_code IS NULL)
      OR (status='failed' AND error_code IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS transcript_stitch_receipts (
  stitch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  transcript_id TEXT NOT NULL REFERENCES transcript_artifacts(transcript_id),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 43200),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
  overlap_seconds INTEGER NOT NULL CHECK (overlap_seconds BETWEEN 0 AND 60),
  cue_count INTEGER NOT NULL CHECK (cue_count >= 0),
  input_manifest_sha256 TEXT NOT NULL,
  stitch_algorithm TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, transcript_id)
);

CREATE INDEX IF NOT EXISTS gemini_media_reservations_day ON gemini_media_reservations(media_day);
CREATE INDEX IF NOT EXISTS transcript_chunks_job ON transcript_chunk_attempts(run_id,source_item_id,chunk_index,status);
CREATE INDEX IF NOT EXISTS transcript_stitches_source ON transcript_stitch_receipts(source_item_id,created_at DESC);

CREATE TRIGGER IF NOT EXISTS gemini_media_reservations_no_update
BEFORE UPDATE ON gemini_media_reservations BEGIN SELECT RAISE(ABORT, 'gemini media reservations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS gemini_media_reservations_no_delete
BEFORE DELETE ON gemini_media_reservations BEGIN SELECT RAISE(ABORT, 'gemini media reservations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_chunk_attempts_no_update
BEFORE UPDATE ON transcript_chunk_attempts BEGIN SELECT RAISE(ABORT, 'transcript chunk attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_chunk_attempts_no_delete
BEFORE DELETE ON transcript_chunk_attempts BEGIN SELECT RAISE(ABORT, 'transcript chunk attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_stitch_receipts_no_update
BEFORE UPDATE ON transcript_stitch_receipts BEGIN SELECT RAISE(ABORT, 'transcript stitch receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_stitch_receipts_no_delete
BEFORE DELETE ON transcript_stitch_receipts BEGIN SELECT RAISE(ABORT, 'transcript stitch receipts are append-only'); END;
