PRAGMA foreign_keys = OFF;

-- Versioned matchers bind the exact archive target used by every successful
-- match. Historical whole-cell checks keep their original NULL target fields.
ALTER TABLE archive_transcript_match_checks RENAME TO archive_transcript_match_checks_old;

CREATE TABLE archive_transcript_match_checks (
  archive_match_check_id TEXT PRIMARY KEY,
  archive_revision_id TEXT NOT NULL REFERENCES first_party_archive_lead_revisions(archive_revision_id),
  archive_video_link_id TEXT NOT NULL,
  transcript_id TEXT NOT NULL REFERENCES transcript_artifacts(transcript_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  prophecy_sha256 TEXT NOT NULL CHECK (length(prophecy_sha256)=64),
  matcher_version TEXT NOT NULL,
  archive_target_text TEXT,
  archive_target_sha256 TEXT CHECK (
    archive_target_sha256 IS NULL OR length(archive_target_sha256)=64
  ),
  transcript_sha256 TEXT NOT NULL CHECK (length(transcript_sha256)=64),
  match_status TEXT NOT NULL CHECK (match_status IN (
    'matched_exact','matched_strict_normalized','ambiguous','not_found'
  )),
  match_method TEXT CHECK (match_method IS NULL OR match_method IN (
    'exact_text_v1','strict_normalized_words_v1'
  )),
  exact_quote TEXT,
  quote_start INTEGER,
  quote_end INTEGER,
  approximate_clip_start_seconds INTEGER CHECK (
    approximate_clip_start_seconds IS NULL OR approximate_clip_start_seconds>=0
  ),
  created_at TEXT NOT NULL,
  UNIQUE(archive_revision_id,archive_video_link_id,transcript_id,matcher_version),
  FOREIGN KEY (archive_revision_id,archive_video_link_id)
    REFERENCES first_party_archive_revision_links(archive_revision_id,archive_link_id),
  CHECK ((match_status IN ('matched_exact','matched_strict_normalized')
      AND match_method IS NOT NULL AND exact_quote IS NOT NULL
      AND quote_start IS NOT NULL AND quote_end IS NOT NULL
      AND quote_start>=0 AND quote_end>quote_start
      AND ((matcher_version='whole_cell_v1'
          AND archive_target_text IS NULL AND archive_target_sha256 IS NULL)
        OR (matcher_version<>'whole_cell_v1'
          AND archive_target_text IS NOT NULL AND archive_target_sha256 IS NOT NULL)))
    OR (match_status IN ('ambiguous','not_found')
      AND match_method IS NULL AND archive_target_text IS NULL
      AND archive_target_sha256 IS NULL AND exact_quote IS NULL
      AND quote_start IS NULL AND quote_end IS NULL
      AND approximate_clip_start_seconds IS NULL))
);

INSERT INTO archive_transcript_match_checks (
  archive_match_check_id,archive_revision_id,archive_video_link_id,transcript_id,
  source_item_id,prophecy_sha256,matcher_version,transcript_sha256,match_status,
  match_method,exact_quote,quote_start,quote_end,approximate_clip_start_seconds,created_at
)
SELECT archive_match_check_id,archive_revision_id,archive_video_link_id,transcript_id,
  source_item_id,prophecy_sha256,matcher_version,transcript_sha256,match_status,
  match_method,exact_quote,quote_start,quote_end,approximate_clip_start_seconds,created_at
FROM archive_transcript_match_checks_old;

DROP TABLE archive_transcript_match_checks_old;

CREATE INDEX archive_transcript_checks_source
  ON archive_transcript_match_checks(source_item_id,transcript_id,match_status);
CREATE INDEX archive_transcript_checks_revision
  ON archive_transcript_match_checks(
    archive_revision_id,archive_video_link_id,matcher_version,created_at
  );
CREATE TRIGGER archive_transcript_checks_binding_guard
BEFORE INSERT ON archive_transcript_match_checks
WHEN NOT EXISTS (
  SELECT 1 FROM first_party_archive_revision_links link
  JOIN transcript_artifacts artifact ON artifact.transcript_id=NEW.transcript_id
  WHERE link.archive_revision_id=NEW.archive_revision_id
    AND link.archive_link_id=NEW.archive_video_link_id
    AND link.link_role='original_video'
    AND link.source_item_id=NEW.source_item_id
    AND artifact.source_item_id=NEW.source_item_id
    AND artifact.content_sha256=NEW.transcript_sha256
)
BEGIN SELECT RAISE(ABORT, 'archive transcript check binding is invalid'); END;
CREATE TRIGGER archive_transcript_checks_no_update
BEFORE UPDATE ON archive_transcript_match_checks
BEGIN SELECT RAISE(ABORT, 'archive transcript checks are append-only'); END;
CREATE TRIGGER archive_transcript_checks_no_delete
BEFORE DELETE ON archive_transcript_match_checks
BEGIN SELECT RAISE(ABORT, 'archive transcript checks are append-only'); END;

PRAGMA foreign_keys = ON;
