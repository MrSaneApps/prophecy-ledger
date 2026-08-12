-- Generation 11 changes the model transport contract, not historical content.
-- Existing v10 failures remain immutable predecessors; the dynamic lineage view
-- exposes exact sparse v11 successors through the existing guarded workflow.
INSERT INTO analysis_prompt_versions (prompt_version,generation,registered_at) VALUES
  ('transcript-claims-v11-gemini-gateway-abortable',11,'2026-08-04T04:40:00.000Z');
