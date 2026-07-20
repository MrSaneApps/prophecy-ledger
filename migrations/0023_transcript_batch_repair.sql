PRAGMA foreign_keys = ON;

-- Frozen batch membership is append-only. Manual archive synchronization may
-- add new items at ordinals above the existing maximum, but no repair may
-- rewrite the identity, source binding, or original ordinal of an old item.
CREATE TRIGGER IF NOT EXISTS transcript_batch_items_identity_guard
BEFORE UPDATE ON transcript_batch_items
WHEN NEW.batch_item_id<>OLD.batch_item_id
  OR NEW.batch_id<>OLD.batch_id
  OR NEW.source_item_id<>OLD.source_item_id
  OR NEW.youtube_id<>OLD.youtube_id
  OR NEW.source_publication_date IS NOT OLD.source_publication_date
  OR NEW.ordinal<>OLD.ordinal
BEGIN SELECT RAISE(ABORT, 'transcript batch item identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS transcript_batch_items_no_delete
BEFORE DELETE ON transcript_batch_items
BEGIN SELECT RAISE(ABORT, 'transcript batch items cannot be deleted'); END;

-- A completed legacy repair has one immutable receipt for one frozen item.
-- Archive syncs may have several receipts as new archive revisions introduce
-- genuinely new videos; their deterministic receipt IDs remain the idempotency
-- boundary.
CREATE UNIQUE INDEX IF NOT EXISTS transcript_batch_one_legacy_repair
  ON transcript_batch_repair_events(batch_id,batch_item_id,event_type)
  WHERE event_type='legacy_stitch_repaired';
