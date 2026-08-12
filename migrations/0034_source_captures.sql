PRAGMA foreign_keys = ON;

-- Evidence is captured when it is found: the original bytes in private R2
-- (content-addressed), a rendered screenshot for pages, an independent
-- Wayback Machine snapshot for public citation, and a machine-checked
-- receipt that the quoted excerpt is an exact substring of the capture.
-- Private copies are preservation-only and never served publicly.
CREATE TABLE IF NOT EXISTS source_captures (
  capture_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  evidence_id TEXT REFERENCES evidence(evidence_id),
  reference_id TEXT REFERENCES public_research_references(reference_id),
  r2_key TEXT,
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256)=64),
  mime TEXT,
  byte_count INTEGER CHECK (byte_count IS NULL OR byte_count >= 0),
  screenshot_r2_key TEXT,
  wayback_url TEXT,
  excerpt_verified INTEGER NOT NULL DEFAULT 0 CHECK (excerpt_verified IN (0,1)),
  http_status INTEGER,
  capture_method TEXT NOT NULL CHECK (capture_method IN (
    'live_fetch','wayback_recovery','manual'
  )),
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_captures_url ON source_captures(url, captured_at);
CREATE TRIGGER IF NOT EXISTS source_captures_no_update
BEFORE UPDATE ON source_captures BEGIN
  SELECT RAISE(ABORT, 'source captures are append-only');
END;
CREATE TRIGGER IF NOT EXISTS source_captures_no_delete
BEFORE DELETE ON source_captures BEGIN
  SELECT RAISE(ABORT, 'source captures are append-only');
END;
