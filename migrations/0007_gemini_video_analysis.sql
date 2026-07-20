PRAGMA foreign_keys = ON;

ALTER TABLE ingestion_jobs RENAME TO ingestion_jobs_0007_old;

CREATE TABLE ingestion_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_type TEXT NOT NULL CHECK (job_type IN (
    'archive_page','post_detail','video_metadata','description_triage','transcript_extract','run_reconcile',
    'video_analysis_primary','video_analysis_verify','video_analysis_tiebreak'
  )),
  stable_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_at TEXT,
  lease_token TEXT,
  completed_at TEXT,
  error_code TEXT,
  successor_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (successor_enqueued IN (0,1)),
  UNIQUE(run_id, job_type, stable_key)
);

INSERT INTO ingestion_jobs
  (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,claimed_at,
   lease_token,completed_at,error_code,successor_enqueued)
SELECT job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,claimed_at,
  lease_token,completed_at,error_code,successor_enqueued
FROM ingestion_jobs_0007_old;

DROP TABLE ingestion_jobs_0007_old;

CREATE INDEX IF NOT EXISTS ingestion_jobs_run_status ON ingestion_jobs(run_id, status, job_type);
CREATE INDEX IF NOT EXISTS ingestion_jobs_lease ON ingestion_jobs(status, claimed_at);

CREATE TABLE IF NOT EXISTS video_analysis_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  stage TEXT NOT NULL CHECK (stage IN ('primary','verifier','tiebreaker')),
  parent_attempt_id TEXT REFERENCES video_analysis_attempts(attempt_id),
  supersedes_attempt_id TEXT REFERENCES video_analysis_attempts(attempt_id),
  provider TEXT NOT NULL CHECK (provider = 'google_gemini'),
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  video_url TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  interaction_id TEXT,
  transport TEXT NOT NULL CHECK (transport = 'cloudflare_ai_gateway'),
  gateway_id TEXT NOT NULL,
  gateway_log_id TEXT,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  raw_output_json TEXT CHECK (raw_output_json IS NULL OR json_valid(raw_output_json)),
  structured_output_json TEXT CHECK (structured_output_json IS NULL OR json_valid(structured_output_json)),
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  CHECK (
    (status='completed' AND raw_output_json IS NOT NULL AND structured_output_json IS NOT NULL AND error_code IS NULL)
    OR (status='failed' AND error_code IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS video_claim_candidates (
  candidate_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  primary_attempt_id TEXT NOT NULL REFERENCES video_analysis_attempts(attempt_id),
  supersedes_candidate_id TEXT REFERENCES video_claim_candidates(candidate_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 25),
  exact_quote TEXT NOT NULL,
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds INTEGER NOT NULL CHECK (end_seconds > start_seconds),
  statement_type TEXT NOT NULL CHECK (statement_type IN (
    'testable_prediction','present_or_past_factual_claim','conditional_prediction',
    'symbolic_statement','general_encouragement','theological_claim','personal_interpretation'
  )),
  atomic_proposition TEXT NOT NULL,
  explicit_deadline_text TEXT,
  context_before TEXT NOT NULL,
  context_after TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  verification_state TEXT NOT NULL DEFAULT 'ai_extracted' CHECK (verification_state='ai_extracted'),
  created_at TEXT NOT NULL,
  UNIQUE(primary_attempt_id, ordinal)
);

CREATE TABLE IF NOT EXISTS video_cross_checks (
  check_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES video_claim_candidates(candidate_id),
  analysis_attempt_id TEXT NOT NULL REFERENCES video_analysis_attempts(attempt_id),
  supersedes_check_id TEXT REFERENCES video_cross_checks(check_id),
  check_role TEXT NOT NULL CHECK (check_role IN ('verifier','tiebreaker')),
  exact_quote TEXT NOT NULL,
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds INTEGER NOT NULL CHECK (end_seconds > start_seconds),
  statement_type TEXT NOT NULL CHECK (statement_type IN (
    'testable_prediction','present_or_past_factual_claim','conditional_prediction',
    'symbolic_statement','general_encouragement','theological_claim','personal_interpretation'
  )),
  atomic_proposition TEXT NOT NULL,
  explicit_deadline_text TEXT,
  context_before TEXT NOT NULL,
  context_after TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  supports TEXT CHECK (supports IS NULL OR supports IN ('primary','verifier','both','neither')),
  created_at TEXT NOT NULL,
  UNIQUE(analysis_attempt_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS video_agreement_results (
  agreement_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES video_claim_candidates(candidate_id),
  compared_check_id TEXT NOT NULL REFERENCES video_cross_checks(check_id),
  supersedes_agreement_id TEXT REFERENCES video_agreement_results(agreement_id),
  comparison_basis TEXT NOT NULL CHECK (comparison_basis IN ('primary','verifier')),
  quote_similarity REAL NOT NULL CHECK (quote_similarity BETWEEN 0 AND 1),
  timestamp_overlap REAL NOT NULL CHECK (timestamp_overlap BETWEEN 0 AND 1),
  deadline_agreement INTEGER NOT NULL CHECK (deadline_agreement IN (0,1)),
  statement_type_agreement INTEGER NOT NULL CHECK (statement_type_agreement IN (0,1)),
  meaning_similarity REAL NOT NULL CHECK (meaning_similarity BETWEEN 0 AND 1),
  agrees INTEGER NOT NULL CHECK (agrees IN (0,1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('ai_cross_verified','tiebreaker_required','human_review_required','rejected')),
  disagreement_reasons_json TEXT NOT NULL CHECK (json_valid(disagreement_reasons_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS video_escalation_events (
  event_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES video_claim_candidates(candidate_id),
  agreement_id TEXT NOT NULL REFERENCES video_agreement_results(agreement_id),
  prior_event_id TEXT REFERENCES video_escalation_events(event_id),
  state TEXT NOT NULL CHECK (state IN ('open','resolved_by_human','rejected')),
  reason TEXT NOT NULL,
  actor_principal TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS video_attempts_source_stage ON video_analysis_attempts(source_item_id,stage,completed_at DESC);
CREATE INDEX IF NOT EXISTS video_candidates_source ON video_claim_candidates(source_item_id,created_at DESC);
CREATE INDEX IF NOT EXISTS video_checks_candidate ON video_cross_checks(candidate_id,check_role,created_at DESC);
CREATE INDEX IF NOT EXISTS video_agreements_candidate ON video_agreement_results(candidate_id,created_at DESC);
CREATE INDEX IF NOT EXISTS video_escalations_candidate ON video_escalation_events(candidate_id,created_at DESC);

CREATE TRIGGER IF NOT EXISTS video_analysis_attempts_no_update
BEFORE UPDATE ON video_analysis_attempts BEGIN SELECT RAISE(ABORT, 'video analysis attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_analysis_attempts_no_delete
BEFORE DELETE ON video_analysis_attempts BEGIN SELECT RAISE(ABORT, 'video analysis attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_claim_candidates_no_update
BEFORE UPDATE ON video_claim_candidates BEGIN SELECT RAISE(ABORT, 'video claim candidates are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_claim_candidates_no_delete
BEFORE DELETE ON video_claim_candidates BEGIN SELECT RAISE(ABORT, 'video claim candidates are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_cross_checks_no_update
BEFORE UPDATE ON video_cross_checks BEGIN SELECT RAISE(ABORT, 'video cross checks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_cross_checks_no_delete
BEFORE DELETE ON video_cross_checks BEGIN SELECT RAISE(ABORT, 'video cross checks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_agreement_results_no_update
BEFORE UPDATE ON video_agreement_results BEGIN SELECT RAISE(ABORT, 'video agreement results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_agreement_results_no_delete
BEFORE DELETE ON video_agreement_results BEGIN SELECT RAISE(ABORT, 'video agreement results are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_escalation_events_no_update
BEFORE UPDATE ON video_escalation_events BEGIN SELECT RAISE(ABORT, 'video escalation events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS video_escalation_events_no_delete
BEFORE DELETE ON video_escalation_events BEGIN SELECT RAISE(ABORT, 'video escalation events are append-only'); END;
