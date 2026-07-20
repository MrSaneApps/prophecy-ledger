PRAGMA foreign_keys = ON;

-- Transcript acquisition is complete once the stitched private artifact and
-- receipt exist. Claim extraction is separately retryable, one section at a
-- time, and cannot hold or pause the acquisition batch.
CREATE TABLE IF NOT EXISTS transcript_analysis_runs (
  analysis_run_id TEXT PRIMARY KEY,
  ingestion_run_id TEXT NOT NULL UNIQUE REFERENCES ingestion_runs(run_id),
  transcript_id TEXT NOT NULL REFERENCES transcript_artifacts(transcript_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  transcript_sha256 TEXT NOT NULL CHECK (length(transcript_sha256)=64),
  prompt_version TEXT NOT NULL,
  section_count INTEGER NOT NULL CHECK (section_count >= 1),
  completed_section_count INTEGER NOT NULL DEFAULT 0 CHECK (
    completed_section_count >= 0 AND completed_section_count <= section_count
  ),
  failed_section_count INTEGER NOT NULL DEFAULT 0 CHECK (
    failed_section_count >= 0 AND failed_section_count <= section_count
  ),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','running','partial','completed','failed'
  )),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(transcript_id,prompt_version),
  CHECK ((status='completed' AND completed_at IS NOT NULL
          AND completed_section_count=section_count AND failed_section_count=0)
      OR (status<>'completed'))
);

CREATE TABLE IF NOT EXISTS transcript_analysis_sections (
  analysis_section_id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL REFERENCES transcript_analysis_runs(analysis_run_id),
  section_index INTEGER NOT NULL CHECK (section_index >= 0),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256)=64),
  base_offset INTEGER NOT NULL CHECK (base_offset >= 0),
  approximate_timestamp_seconds INTEGER NOT NULL CHECK (approximate_timestamp_seconds >= 0),
  extraction_run_id TEXT REFERENCES extraction_runs(extraction_run_id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','processing','completed','failed'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(analysis_run_id,section_index),
  CHECK ((status='completed' AND extraction_run_id IS NOT NULL
          AND completed_at IS NOT NULL AND error_code IS NULL)
      OR (status='processing' AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (status='queued' AND completed_at IS NULL)
      OR (status='failed' AND error_code IS NOT NULL AND completed_at IS NOT NULL))
);

-- Repairs and append operations are explicit immutable facts. The existing
-- batch event CHECK is intentionally not rebuilt or weakened.
CREATE TABLE IF NOT EXISTS transcript_batch_repair_events (
  repair_event_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id),
  batch_item_id TEXT REFERENCES transcript_batch_items(batch_item_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'legacy_stitch_repaired','archive_items_appended'
  )),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transcript_analysis_runs_status
  ON transcript_analysis_runs(status,created_at,analysis_run_id);
CREATE INDEX IF NOT EXISTS transcript_analysis_sections_status
  ON transcript_analysis_sections(analysis_run_id,status,section_index);
CREATE INDEX IF NOT EXISTS transcript_batch_repair_events_batch
  ON transcript_batch_repair_events(batch_id,created_at,repair_event_id);

CREATE TRIGGER IF NOT EXISTS transcript_analysis_runs_identity_guard
BEFORE UPDATE ON transcript_analysis_runs
WHEN NEW.analysis_run_id<>OLD.analysis_run_id
  OR NEW.ingestion_run_id<>OLD.ingestion_run_id
  OR NEW.transcript_id<>OLD.transcript_id
  OR NEW.source_item_id<>OLD.source_item_id
  OR NEW.transcript_sha256<>OLD.transcript_sha256
  OR NEW.prompt_version<>OLD.prompt_version
  OR NEW.section_count<>OLD.section_count
  OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT, 'transcript analysis run identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS transcript_analysis_runs_no_delete
BEFORE DELETE ON transcript_analysis_runs
BEGIN SELECT RAISE(ABORT, 'transcript analysis runs cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS transcript_analysis_sections_identity_guard
BEFORE UPDATE ON transcript_analysis_sections
WHEN NEW.analysis_section_id<>OLD.analysis_section_id
  OR NEW.analysis_run_id<>OLD.analysis_run_id
  OR NEW.section_index<>OLD.section_index
  OR NEW.input_sha256<>OLD.input_sha256
  OR NEW.base_offset<>OLD.base_offset
  OR NEW.approximate_timestamp_seconds<>OLD.approximate_timestamp_seconds
  OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT, 'transcript analysis section identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS transcript_analysis_sections_no_delete
BEFORE DELETE ON transcript_analysis_sections
BEGIN SELECT RAISE(ABORT, 'transcript analysis sections cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS transcript_batch_repair_events_no_update
BEFORE UPDATE ON transcript_batch_repair_events
BEGIN SELECT RAISE(ABORT, 'transcript batch repair events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_batch_repair_events_no_delete
BEFORE DELETE ON transcript_batch_repair_events
BEGIN SELECT RAISE(ABORT, 'transcript batch repair events are append-only'); END;
