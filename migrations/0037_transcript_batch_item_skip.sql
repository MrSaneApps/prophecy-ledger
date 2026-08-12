PRAGMA foreign_keys = OFF;

-- A terminally failed item may be explicitly skipped so the frozen batch can
-- continue. Rebuild the item and its two child tables so every foreign key
-- continues to name the canonical table after the SQLite table replacement.
ALTER TABLE transcript_batch_items RENAME TO transcript_batch_items_old;
ALTER TABLE transcript_batch_events RENAME TO transcript_batch_events_old;
ALTER TABLE transcript_batch_repair_events RENAME TO transcript_batch_repair_events_old;

CREATE TABLE transcript_batch_items (
  batch_item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  youtube_id TEXT NOT NULL,
  source_publication_date TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','skipped')),
  run_id TEXT UNIQUE REFERENCES ingestion_runs(run_id),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 1 AND 43200),
  started_at TEXT,
  completed_at TEXT,
  dispatch_state TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending','dispatching','sent')),
  dispatch_claimed_at TEXT,
  first_job_dispatched_at TEXT,
  last_job_dispatched_at TEXT,
  UNIQUE(batch_id,source_item_id),
  UNIQUE(batch_id,ordinal),
  CHECK ((status='pending' AND run_id IS NULL AND duration_seconds IS NULL
        AND started_at IS NULL AND completed_at IS NULL)
      OR (status='active' AND run_id IS NOT NULL AND duration_seconds IS NOT NULL
        AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (status='completed' AND run_id IS NOT NULL AND duration_seconds IS NOT NULL
        AND started_at IS NOT NULL AND completed_at IS NOT NULL)
      OR (status='skipped' AND run_id IS NOT NULL AND duration_seconds IS NOT NULL
        AND started_at IS NOT NULL AND completed_at IS NULL))
);

INSERT INTO transcript_batch_items (
  batch_item_id,batch_id,source_item_id,youtube_id,source_publication_date,
  ordinal,status,run_id,duration_seconds,started_at,completed_at,
  dispatch_state,dispatch_claimed_at,first_job_dispatched_at,last_job_dispatched_at
)
SELECT batch_item_id,batch_id,source_item_id,youtube_id,source_publication_date,
  ordinal,status,run_id,duration_seconds,started_at,completed_at,
  dispatch_state,dispatch_claimed_at,first_job_dispatched_at,last_job_dispatched_at
FROM transcript_batch_items_old;

CREATE TABLE transcript_batch_events (
  event_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id),
  batch_item_id TEXT REFERENCES transcript_batch_items(batch_item_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'batch_started','item_started','batch_paused','batch_resumed',
    'item_completed','item_skipped','batch_completed'
  )),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);
INSERT INTO transcript_batch_events
SELECT * FROM transcript_batch_events_old;

CREATE TABLE transcript_batch_repair_events (
  repair_event_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id),
  batch_item_id TEXT REFERENCES transcript_batch_items(batch_item_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'legacy_stitch_repaired','archive_items_appended'
  )),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);
INSERT INTO transcript_batch_repair_events
SELECT * FROM transcript_batch_repair_events_old;

DROP TABLE transcript_batch_events_old;
DROP TABLE transcript_batch_repair_events_old;
DROP TABLE transcript_batch_items_old;

CREATE UNIQUE INDEX transcript_batch_items_one_active
  ON transcript_batch_items((1)) WHERE status='active';
CREATE INDEX transcript_batch_items_order
  ON transcript_batch_items(batch_id,status,ordinal,batch_item_id);
CREATE INDEX transcript_batch_events_batch
  ON transcript_batch_events(batch_id,created_at,event_id);
CREATE INDEX transcript_batch_repair_events_batch
  ON transcript_batch_repair_events(batch_id,created_at,repair_event_id);
CREATE UNIQUE INDEX transcript_batch_one_legacy_repair
  ON transcript_batch_repair_events(batch_id,batch_item_id,event_type)
  WHERE event_type='legacy_stitch_repaired';

CREATE TRIGGER transcript_batch_events_no_update
BEFORE UPDATE ON transcript_batch_events
BEGIN SELECT RAISE(ABORT, 'transcript batch events are append-only'); END;
CREATE TRIGGER transcript_batch_events_no_delete
BEFORE DELETE ON transcript_batch_events
BEGIN SELECT RAISE(ABORT, 'transcript batch events are append-only'); END;
CREATE TRIGGER transcript_batch_repair_events_no_update
BEFORE UPDATE ON transcript_batch_repair_events
BEGIN SELECT RAISE(ABORT, 'transcript batch repair events are append-only'); END;
CREATE TRIGGER transcript_batch_repair_events_no_delete
BEFORE DELETE ON transcript_batch_repair_events
BEGIN SELECT RAISE(ABORT, 'transcript batch repair events are append-only'); END;

CREATE TRIGGER transcript_batch_items_dispatch_lifecycle_insert
BEFORE INSERT ON transcript_batch_items
WHEN NOT (
  (NEW.status='pending' AND NEW.run_id IS NULL AND NEW.duration_seconds IS NULL
    AND NEW.dispatch_state='pending' AND NEW.dispatch_claimed_at IS NULL
    AND NEW.first_job_dispatched_at IS NULL AND NEW.last_job_dispatched_at IS NULL
    AND NEW.started_at IS NULL AND NEW.completed_at IS NULL)
  OR (NEW.status='active' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
  OR (NEW.status='completed' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.dispatch_state='sent' AND NEW.first_job_dispatched_at IS NOT NULL
    AND NEW.last_job_dispatched_at IS NOT NULL AND NEW.started_at IS NOT NULL
    AND NEW.completed_at IS NOT NULL)
  OR (NEW.status='skipped' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'invalid transcript batch item dispatch lifecycle'); END;

CREATE TRIGGER transcript_batch_items_dispatch_lifecycle_update
BEFORE UPDATE ON transcript_batch_items
WHEN NOT (
  (NEW.status='pending' AND NEW.run_id IS NULL AND NEW.duration_seconds IS NULL
    AND NEW.dispatch_state='pending' AND NEW.dispatch_claimed_at IS NULL
    AND NEW.first_job_dispatched_at IS NULL AND NEW.last_job_dispatched_at IS NULL
    AND NEW.started_at IS NULL AND NEW.completed_at IS NULL)
  OR (NEW.status='active' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
  OR (NEW.status='completed' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.dispatch_state='sent' AND NEW.first_job_dispatched_at IS NOT NULL
    AND NEW.last_job_dispatched_at IS NOT NULL AND NEW.started_at IS NOT NULL
    AND NEW.completed_at IS NOT NULL)
  OR (NEW.status='skipped' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'invalid transcript batch item dispatch lifecycle'); END;

CREATE TRIGGER transcript_batch_items_identity_guard
BEFORE UPDATE ON transcript_batch_items
WHEN NEW.batch_item_id<>OLD.batch_item_id OR NEW.batch_id<>OLD.batch_id
  OR NEW.source_item_id<>OLD.source_item_id OR NEW.youtube_id<>OLD.youtube_id
  OR NEW.source_publication_date IS NOT OLD.source_publication_date OR NEW.ordinal<>OLD.ordinal
BEGIN SELECT RAISE(ABORT, 'transcript batch item identity is immutable'); END;
CREATE TRIGGER transcript_batch_items_no_delete
BEFORE DELETE ON transcript_batch_items
BEGIN SELECT RAISE(ABORT, 'transcript batch items cannot be deleted'); END;

PRAGMA foreign_keys = ON;
