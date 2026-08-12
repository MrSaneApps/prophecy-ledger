PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS archive_post_match_checks (
  post_match_check_id TEXT PRIMARY KEY,
  archive_revision_id TEXT NOT NULL REFERENCES first_party_archive_lead_revisions(archive_revision_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  post_revision_id TEXT NOT NULL REFERENCES source_item_revisions(revision_id),
  prophecy_sha256 TEXT NOT NULL CHECK (length(prophecy_sha256)=64),
  post_sha256 TEXT NOT NULL CHECK (length(post_sha256)=64),
  matcher_version TEXT NOT NULL,
  match_status TEXT NOT NULL CHECK (match_status IN (
    'matched_exact','matched_strict_normalized','ambiguous'
  )),
  match_method TEXT CHECK (match_method IS NULL OR match_method IN (
    'exact_text_v1','strict_normalized_words_v1'
  )),
  exact_quote TEXT,
  quote_start INTEGER,
  quote_end INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(archive_revision_id,source_item_id,matcher_version)
);

CREATE INDEX IF NOT EXISTS archive_post_matches_revision
  ON archive_post_match_checks(archive_revision_id,match_status);
CREATE TRIGGER IF NOT EXISTS archive_post_match_checks_no_update
BEFORE UPDATE ON archive_post_match_checks
BEGIN SELECT RAISE(ABORT, 'archive post match checks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_post_match_checks_no_delete
BEFORE DELETE ON archive_post_match_checks
BEGIN SELECT RAISE(ABORT, 'archive post match checks are append-only'); END;
