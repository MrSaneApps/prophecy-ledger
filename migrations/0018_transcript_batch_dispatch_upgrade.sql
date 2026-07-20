PRAGMA foreign_keys = ON;

-- Migration 0016 was applied before dispatch recovery and transition sequencing
-- were added. The live batch tables were confirmed empty before this additive
-- upgrade, so no historical row backfill or rewrite is required.
ALTER TABLE transcript_batches ADD COLUMN transition_count INTEGER NOT NULL DEFAULT 0
  CHECK (transition_count >= 0);

ALTER TABLE transcript_batch_items ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (dispatch_state IN ('pending','dispatching','sent'));
ALTER TABLE transcript_batch_items ADD COLUMN dispatch_claimed_at TEXT;
ALTER TABLE transcript_batch_items ADD COLUMN first_job_dispatched_at TEXT;
ALTER TABLE transcript_batch_items ADD COLUMN last_job_dispatched_at TEXT;

-- SQLite cannot add a table CHECK constraint after creation. These triggers
-- impose the strengthened lifecycle invariant on the upgraded table.
CREATE TRIGGER IF NOT EXISTS transcript_batch_items_dispatch_lifecycle_insert
BEFORE INSERT ON transcript_batch_items
WHEN NOT (
  (NEW.status='pending' AND NEW.run_id IS NULL AND NEW.duration_seconds IS NULL
    AND NEW.dispatch_state='pending' AND NEW.dispatch_claimed_at IS NULL
    AND NEW.first_job_dispatched_at IS NULL AND NEW.last_job_dispatched_at IS NULL
    AND NEW.started_at IS NULL AND NEW.completed_at IS NULL)
  OR
  (NEW.status='active' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
  OR
  (NEW.status='completed' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.dispatch_state='sent' AND NEW.first_job_dispatched_at IS NOT NULL
    AND NEW.last_job_dispatched_at IS NOT NULL AND NEW.started_at IS NOT NULL
    AND NEW.completed_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'invalid transcript batch item dispatch lifecycle'); END;

CREATE TRIGGER IF NOT EXISTS transcript_batch_items_dispatch_lifecycle_update
BEFORE UPDATE ON transcript_batch_items
WHEN NOT (
  (NEW.status='pending' AND NEW.run_id IS NULL AND NEW.duration_seconds IS NULL
    AND NEW.dispatch_state='pending' AND NEW.dispatch_claimed_at IS NULL
    AND NEW.first_job_dispatched_at IS NULL AND NEW.last_job_dispatched_at IS NULL
    AND NEW.started_at IS NULL AND NEW.completed_at IS NULL)
  OR
  (NEW.status='active' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL)
  OR
  (NEW.status='completed' AND NEW.run_id IS NOT NULL AND NEW.duration_seconds IS NOT NULL
    AND NEW.dispatch_state='sent' AND NEW.first_job_dispatched_at IS NOT NULL
    AND NEW.last_job_dispatched_at IS NOT NULL AND NEW.started_at IS NOT NULL
    AND NEW.completed_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'invalid transcript batch item dispatch lifecycle'); END;
