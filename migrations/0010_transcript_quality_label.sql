PRAGMA foreign_keys = ON;

ALTER TABLE extraction_runs ADD COLUMN transcript_quality TEXT NOT NULL DEFAULT 'not_applicable'
  CHECK (transcript_quality IN ('not_applicable','gemini_generated_needs_human_check','human_verified'));
