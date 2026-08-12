PRAGMA foreign_keys = ON;

-- A real Gemini Interactions schema rejection can expose only a generic HTTP
-- 400 body with no provider status/code. Preserve every v12 attempt and manual
-- receipt, then expose exact sparse successors for the mode-bounded fallback.
INSERT INTO analysis_prompt_versions (prompt_version,generation,registered_at) VALUES
  ('transcript-claims-v13-gemini-schema-http400-fallback',13,'2026-08-04T05:40:00.000Z');
