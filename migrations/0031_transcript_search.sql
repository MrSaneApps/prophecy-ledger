-- Full-text search index over the private transcript archive. This is
-- DERIVED data: the R2 artifacts and their hashes remain the canonical
-- record. The index is rebuilt idempotently per transcript and is only
-- reachable through authenticated reviewer routes; transcript bodies stay
-- off every public API.
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5(
  chunk_text,
  transcript_id UNINDEXED,
  source_item_id UNINDEXED,
  video_url UNINDEXED,
  video_title UNINDEXED,
  published_at UNINDEXED,
  clip_start_seconds UNINDEXED,
  clip_end_seconds UNINDEXED,
  content_sha256 UNINDEXED
);
