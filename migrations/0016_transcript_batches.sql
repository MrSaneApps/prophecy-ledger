PRAGMA foreign_keys = ON;

-- Transcript batches are durable operator-created worklists. They are separate
-- from discovery and hold at most one active video across every batch.
CREATE TABLE IF NOT EXISTS transcript_batches (
  batch_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  status TEXT NOT NULL CHECK (status IN ('running','paused','completed')),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  completed_item_count INTEGER NOT NULL DEFAULT 0 CHECK (
    completed_item_count >= 0 AND completed_item_count <= item_count
  ),
  pause_reason TEXT,
  resume_after TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  completed_at TEXT,
  CHECK ((status='running' AND pause_reason IS NULL AND resume_after IS NULL)
      OR (status='paused' AND pause_reason IS NOT NULL AND resume_after IS NOT NULL AND paused_at IS NOT NULL)
      OR (status='completed' AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS transcript_batch_items (
  batch_item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  youtube_id TEXT NOT NULL,
  source_publication_date TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed')),
  run_id TEXT UNIQUE REFERENCES ingestion_runs(run_id),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 43200),
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(batch_id,source_item_id),
  UNIQUE(batch_id,ordinal),
  CHECK ((status='pending' AND run_id IS NULL AND duration_seconds IS NULL
        AND started_at IS NULL AND completed_at IS NULL)
      OR (status='active' AND run_id IS NOT NULL AND duration_seconds IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (status='completed' AND run_id IS NOT NULL AND duration_seconds IS NOT NULL
        AND started_at IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS transcript_batch_events (
  event_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id),
  batch_item_id TEXT REFERENCES transcript_batch_items(batch_item_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'batch_started','item_started','batch_paused','batch_resumed',
    'item_completed','batch_completed'
  )),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

-- A constant-expression partial index serializes all unfinished batches. The
-- item index is a second database boundary against Queue concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS transcript_batches_one_open
  ON transcript_batches((1)) WHERE status IN ('running','paused');
CREATE UNIQUE INDEX IF NOT EXISTS transcript_batch_items_one_active
  ON transcript_batch_items((1)) WHERE status='active';
CREATE INDEX IF NOT EXISTS transcript_batch_items_order
  ON transcript_batch_items(batch_id,status,ordinal,batch_item_id);
CREATE INDEX IF NOT EXISTS transcript_batch_events_batch
  ON transcript_batch_events(batch_id,created_at,event_id);

CREATE TRIGGER IF NOT EXISTS transcript_batches_no_parallel_transcript_run
BEFORE INSERT ON transcript_batches
WHEN NEW.status IN ('running','paused') AND EXISTS (
  SELECT 1 FROM ingestion_runs
  WHERE status IN ('queued','running') AND scope LIKE 'transcript:%'
)
BEGIN SELECT RAISE(ABORT, 'active transcript run exists'); END;

CREATE TRIGGER IF NOT EXISTS ingestion_runs_no_parallel_transcript_batch
BEFORE INSERT ON ingestion_runs
WHEN NEW.status IN ('queued','running') AND NEW.scope LIKE 'transcript:%'
  AND EXISTS (SELECT 1 FROM transcript_batches batch
    WHERE batch.status IN ('running','paused')
      AND instr(NEW.scope, ':batch:' || batch.batch_id)=0)
BEGIN SELECT RAISE(ABORT, 'active transcript batch exists'); END;

CREATE TRIGGER IF NOT EXISTS transcript_batch_events_no_update
BEFORE UPDATE ON transcript_batch_events
BEGIN SELECT RAISE(ABORT, 'transcript batch events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_batch_events_no_delete
BEFORE DELETE ON transcript_batch_events
BEGIN SELECT RAISE(ABORT, 'transcript batch events are append-only'); END;
