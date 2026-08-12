PRAGMA foreign_keys = ON;

-- v11 preserved every failed schema-only Gateway attempt. Register a new
-- generation for the corrected schema-to-plain-JSON fallback; the dynamic
-- lineage view exposes exact sparse successors without resetting v11 work.
INSERT INTO analysis_prompt_versions (prompt_version,generation,registered_at) VALUES
  ('transcript-claims-v12-gemini-gateway-plain-fallback',12,'2026-08-04T05:10:00.000Z');
