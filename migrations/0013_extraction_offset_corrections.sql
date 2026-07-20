PRAGMA foreign_keys = ON;

ALTER TABLE extraction_runs ADD COLUMN corrected_offset_count INTEGER NOT NULL DEFAULT 0
  CHECK (corrected_offset_count BETWEEN 0 AND 25);
