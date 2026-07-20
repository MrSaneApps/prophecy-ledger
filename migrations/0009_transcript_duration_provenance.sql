PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_media_metadata (
  metadata_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 43200),
  method TEXT NOT NULL CHECK (method='youtube_public_html_length_seconds'),
  response_sha256 TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(source_item_id, duration_seconds, response_sha256)
);

CREATE INDEX IF NOT EXISTS source_media_metadata_source ON source_media_metadata(source_item_id,observed_at DESC);
CREATE TRIGGER IF NOT EXISTS source_media_metadata_no_update
BEFORE UPDATE ON source_media_metadata BEGIN SELECT RAISE(ABORT, 'source media metadata is append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_media_metadata_no_delete
BEFORE DELETE ON source_media_metadata BEGIN SELECT RAISE(ABORT, 'source media metadata is append-only'); END;
