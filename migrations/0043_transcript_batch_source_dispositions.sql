PRAGMA foreign_keys = ON;

-- A source that cannot be opened must not be rewritten as completed or skipped.
-- Preserve the frozen pending item and append one explicit disposition receipt;
-- scheduling derives quarantine from this table.
CREATE TABLE IF NOT EXISTS transcript_batch_item_dispositions (
  disposition_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES transcript_batches(batch_id),
  batch_item_id TEXT NOT NULL REFERENCES transcript_batch_items(batch_item_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  successor_batch_item_id TEXT REFERENCES transcript_batch_items(batch_item_id),
  disposition TEXT NOT NULL CHECK (disposition='source_unavailable'),
  link_availability TEXT NOT NULL CHECK (link_availability='unavailable'),
  reason_code TEXT NOT NULL CHECK (reason_code='youtube_video_not_found'),
  observed_error_code TEXT NOT NULL CHECK (
    observed_error_code='youtube_data_api_video_not_found'
  ),
  expected_transition_count INTEGER NOT NULL CHECK (expected_transition_count >= 0),
  applied_transition_count INTEGER NOT NULL CHECK (
    applied_transition_count=expected_transition_count+1
  ),
  created_at TEXT NOT NULL,
  UNIQUE(batch_item_id,disposition),
  UNIQUE(batch_id,applied_transition_count)
);

CREATE INDEX IF NOT EXISTS transcript_batch_item_dispositions_batch
  ON transcript_batch_item_dispositions(batch_id,batch_item_id);

CREATE VIEW IF NOT EXISTS effective_transcript_batch_item_dispositions AS
SELECT disposition_id,batch_id,batch_item_id,source_item_id,successor_batch_item_id,disposition,
  link_availability,reason_code,observed_error_code,expected_transition_count,
  applied_transition_count,created_at
FROM transcript_batch_item_dispositions;

CREATE TRIGGER IF NOT EXISTS transcript_batch_item_dispositions_binding_guard
BEFORE INSERT ON transcript_batch_item_dispositions
WHEN NOT EXISTS (
  SELECT 1 FROM transcript_batch_items item
  WHERE item.batch_item_id=NEW.batch_item_id
    AND item.batch_id=NEW.batch_id
    AND item.source_item_id=NEW.source_item_id
)
OR (NEW.successor_batch_item_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM transcript_batch_items successor
  WHERE successor.batch_item_id=NEW.successor_batch_item_id
    AND successor.batch_id=NEW.batch_id
    AND successor.batch_item_id<>NEW.batch_item_id
))
BEGIN SELECT RAISE(ABORT, 'invalid transcript batch disposition binding'); END;

CREATE TRIGGER IF NOT EXISTS transcript_batch_item_dispositions_no_update
BEFORE UPDATE ON transcript_batch_item_dispositions
BEGIN SELECT RAISE(ABORT, 'transcript batch item dispositions are append-only'); END;

CREATE TRIGGER IF NOT EXISTS transcript_batch_item_dispositions_no_delete
BEFORE DELETE ON transcript_batch_item_dispositions
BEGIN SELECT RAISE(ABORT, 'transcript batch item dispositions are append-only'); END;
