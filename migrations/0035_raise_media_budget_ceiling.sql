PRAGMA foreign_keys = OFF;

-- Raise the operator-configurable daily ceiling from eight to twenty-four
-- hours without rewriting the historical reservation rows.
CREATE TABLE gemini_media_reservations_new (
  reservation_id TEXT PRIMARY KEY,
  media_day TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  job_attempt INTEGER NOT NULL CHECK (job_attempt >= 1),
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds INTEGER NOT NULL CHECK (end_seconds > start_seconds),
  reserved_seconds INTEGER NOT NULL CHECK (reserved_seconds = end_seconds - start_seconds),
  budget_limit_seconds INTEGER NOT NULL CHECK (budget_limit_seconds BETWEEN 1 AND 86400),
  created_at TEXT NOT NULL,
  UNIQUE(job_id,job_attempt,chunk_index)
);

INSERT INTO gemini_media_reservations_new
SELECT * FROM gemini_media_reservations;
DROP TABLE gemini_media_reservations;
ALTER TABLE gemini_media_reservations_new RENAME TO gemini_media_reservations;

CREATE INDEX gemini_media_reservations_day
  ON gemini_media_reservations(media_day);
CREATE TRIGGER gemini_media_daily_budget_guard
BEFORE INSERT ON gemini_media_reservations
WHEN COALESCE((SELECT SUM(reserved_seconds) FROM gemini_media_reservations
               WHERE media_day=NEW.media_day),0) + NEW.reserved_seconds > NEW.budget_limit_seconds
BEGIN SELECT RAISE(ABORT, 'gemini media budget exhausted'); END;
CREATE TRIGGER gemini_media_reservations_no_update
BEFORE UPDATE ON gemini_media_reservations
BEGIN SELECT RAISE(ABORT, 'gemini media reservations are append-only'); END;
CREATE TRIGGER gemini_media_reservations_no_delete
BEFORE DELETE ON gemini_media_reservations
BEGIN SELECT RAISE(ABORT, 'gemini media reservations are append-only'); END;

PRAGMA foreign_keys = ON;
