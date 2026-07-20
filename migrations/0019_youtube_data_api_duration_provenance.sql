PRAGMA foreign_keys = ON;

-- Preserve append-only duration receipts while admitting the official YouTube
-- Data API v3 contentDetails source as a distinct provenance method.
DROP TRIGGER IF EXISTS source_media_metadata_no_update;
DROP TRIGGER IF EXISTS source_media_metadata_no_delete;
DROP INDEX IF EXISTS source_media_metadata_source;

CREATE TABLE source_media_metadata_0019_next (
  metadata_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 43200),
  method TEXT NOT NULL CHECK (method IN (
    'youtube_public_html_length_seconds',
    'operator_supplied_authenticated',
    'youtube_data_api_v3_content_details'
  )),
  response_sha256 TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(source_item_id, duration_seconds, method, response_sha256)
);

INSERT INTO source_media_metadata_0019_next
  (metadata_id,source_item_id,duration_seconds,method,response_sha256,observed_at)
SELECT metadata_id,source_item_id,duration_seconds,method,response_sha256,observed_at
FROM source_media_metadata;

DROP TABLE source_media_metadata;
ALTER TABLE source_media_metadata_0019_next RENAME TO source_media_metadata;

CREATE INDEX source_media_metadata_source ON source_media_metadata(source_item_id,observed_at DESC);
CREATE TRIGGER source_media_metadata_no_update
BEFORE UPDATE ON source_media_metadata BEGIN SELECT RAISE(ABORT, 'source media metadata is append-only'); END;
CREATE TRIGGER source_media_metadata_no_delete
BEFORE DELETE ON source_media_metadata BEGIN SELECT RAISE(ABORT, 'source media metadata is append-only'); END;
