PRAGMA foreign_keys = ON;

-- Public names are accepted only from an authenticated reviewer session and
-- bound to the stable credential-derived reviewer id. No credentials are kept.
CREATE TABLE IF NOT EXISTS reviewer_public_attributions (
  attribution_id TEXT PRIMARY KEY,
  reviewer_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 80),
  created_at TEXT NOT NULL,
  UNIQUE(reviewer_id, display_name)
);

CREATE INDEX IF NOT EXISTS reviewer_public_attributions_reviewer
  ON reviewer_public_attributions(reviewer_id, created_at, attribution_id);

CREATE TRIGGER IF NOT EXISTS reviewer_public_attributions_no_update
BEFORE UPDATE ON reviewer_public_attributions BEGIN
  SELECT RAISE(ABORT, 'reviewer public attributions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS reviewer_public_attributions_no_delete
BEFORE DELETE ON reviewer_public_attributions BEGIN
  SELECT RAISE(ABORT, 'reviewer public attributions are append-only');
END;

-- The latest production oil review is Joshua's existing reviewer principal.
-- This keeps the private stable identifier out of source while preserving his
-- already-saved decisions under the new public ownership model.
INSERT OR IGNORE INTO reviewer_public_attributions
  (attribution_id, reviewer_id, display_name, created_at)
SELECT 'reviewer_attribution_joshua_v1', reviewer_id, 'Joshua',
  '2026-08-16T00:00:00.000Z'
FROM moderator_reviews
WHERE claim_id='southeast-asia-oil-2021'
ORDER BY created_at DESC, review_id DESC
LIMIT 1;
