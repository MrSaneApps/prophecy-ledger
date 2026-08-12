PRAGMA foreign_keys = ON;

-- Pending AI draft decisions. The AI proposes one complete structured decision
-- per claim revision; humans agree or disagree. A draft carries no weight until
-- two independent authenticated humans decide. Append-only.

CREATE TABLE IF NOT EXISTS ai_draft_decisions (
  draft_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  claim_type TEXT NOT NULL CHECK (claim_type IN (
    'testable_prediction','present_or_past_factual_claim','conditional_prediction'
  )),
  outcome_status TEXT NOT NULL CHECK (outcome_status IN (
    'true','false','partial','pending','undetermined','not_falsifiable'
  )),
  novelty_status TEXT NOT NULL CHECK (novelty_status IN (
    'already_public','widely_expected','strong_signals','emerging_signals',
    'no_precursor_found','not_assessed'
  )),
  baseline_probability REAL CHECK (
    baseline_probability IS NULL OR (baseline_probability >= 0 AND baseline_probability <= 1)
  ),
  evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
  prior_receipt_id TEXT,
  reasoning TEXT NOT NULL CHECK (length(reasoning) BETWEEN 20 AND 4000),
  provenance TEXT NOT NULL DEFAULT 'ai_generated_needs_human_check',
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, revision)
);
CREATE TRIGGER IF NOT EXISTS ai_draft_decisions_no_update
BEFORE UPDATE ON ai_draft_decisions BEGIN
  SELECT RAISE(ABORT, 'ai draft decisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS ai_draft_decisions_no_delete
BEFORE DELETE ON ai_draft_decisions BEGIN
  SELECT RAISE(ABORT, 'ai draft decisions are append-only');
END;

INSERT OR IGNORE INTO ai_draft_decisions
  (draft_id, claim_id, revision, claim_type, outcome_status, novelty_status,
   baseline_probability, evidence_ids_json, prior_receipt_id, reasoning,
   provenance, created_at)
VALUES
('aidraft_oil_r1','southeast-asia-oil-2021',1,'testable_prediction','false',
 'no_precursor_found',0.2,
 '["evidence_oil_original_video","evidence_oil_rystad_2021","evidence_oil_prior_iea2017","evidence_oil_prior_seainfra2020","evidence_oil_archive"]',
 'receipt_oil_20200910',
 'Under the frozen criteria, independent Rystad data shows Southeast Asian oil and gas output fell from 5.06 million barrels of oil equivalent per day in 2020 to 4.86 million in 2021, and 2021 discoveries were 78 percent gas or condensate. No reading of the independent data shows a material oil boom in the stated window. The speaker''s own archive describes the stated timing as wrong; that first-party note is context, not independent proof. Pre-statement public information described declining regional production, so no public precursor pointed to a boom; 0.2 is a generous chance baseline.',
 'ai_generated_needs_human_check',
 strftime('%Y-%m-%dT%H:%M:%fZ','now'));
