PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ingestion_runs (
  run_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('initial','scheduled','manual','intake','canary')),
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','complete','complete_with_errors','failed')),
  started_at TEXT,
  discovery_finished_at TEXT,
  completed_at TEXT,
  archive_last_page INTEGER CHECK (archive_last_page IS NULL OR archive_last_page >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  job_type TEXT NOT NULL CHECK (job_type IN ('archive_page','post_detail','video_metadata','description_triage','transcript_extract','run_reconcile')),
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

CREATE TABLE IF NOT EXISTS source_items (
  source_item_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  source_id TEXT REFERENCES sources(source_id),
  platform TEXT NOT NULL CHECK (platform IN ('official_site','youtube','rumble','facebook','instagram','x','other')),
  platform_item_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  first_discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('available','unavailable','blocked','unknown')),
  UNIQUE(person_id, platform, platform_item_id),
  UNIQUE(person_id, canonical_url)
);

CREATE TABLE IF NOT EXISTS source_item_revisions (
  revision_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  content_sha256 TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  public_title TEXT NOT NULL,
  first_party_description TEXT,
  publication_date TEXT,
  embedded_platform TEXT CHECK (embedded_platform IS NULL OR embedded_platform IN ('youtube','rumble','facebook','instagram','x','other')),
  embedded_item_id TEXT,
  embedded_url TEXT,
  fetched_at TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  UNIQUE(source_item_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS source_item_links (
  link_id TEXT PRIMARY KEY,
  source_item_id_a TEXT NOT NULL REFERENCES source_items(source_item_id),
  source_item_id_b TEXT NOT NULL REFERENCES source_items(source_item_id),
  link_type TEXT NOT NULL CHECK (link_type IN ('embedded_video','same_canonical_source','possible_duplicate')),
  method TEXT NOT NULL CHECK (method IN ('exact_platform_id','exact_canonical_url','human_review','title_similarity_proposal')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at TEXT NOT NULL,
  CHECK (source_item_id_a < source_item_id_b),
  UNIQUE(source_item_id_a, source_item_id_b, link_type)
);

CREATE TABLE IF NOT EXISTS source_availability_events (
  event_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  availability TEXT NOT NULL CHECK (availability IN ('available','unavailable','blocked','unknown')),
  result_code TEXT,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_scan_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  source_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete','partial','blocked','client_rendered','failed')),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  last_page_or_cursor TEXT,
  public_explanation TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(run_id, source_name)
);

CREATE TABLE IF NOT EXISTS transcript_attempts (
  attempt_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  method TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_available','authorization_required','provided','verified','failed','needs_human_check')),
  language TEXT,
  attempted_at TEXT NOT NULL,
  public_error_code TEXT
);

CREATE TABLE IF NOT EXISTS transcript_artifacts (
  transcript_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  r2_key TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  language TEXT,
  has_timing INTEGER NOT NULL DEFAULT 0 CHECK (has_timing IN (0,1)),
  provenance TEXT NOT NULL,
  verifier_principal TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source_item_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS extraction_runs (
  extraction_run_id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  transcript_id TEXT REFERENCES transcript_artifacts(transcript_id),
  input_kind TEXT NOT NULL CHECK (input_kind IN ('first_party_description','verified_transcript')),
  input_sha256 TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_family TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','completed','failed','needs_human_check')),
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS claim_candidates (
  candidate_id TEXT PRIMARY KEY,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(extraction_run_id),
  source_item_id TEXT NOT NULL REFERENCES source_items(source_item_id),
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('description_lead','exact_transcript_claim')),
  neutral_paraphrase TEXT,
  exact_quote TEXT,
  quote_start INTEGER,
  quote_end INTEGER,
  source_timestamp_seconds INTEGER,
  proposed_statement_type TEXT CHECK (proposed_statement_type IS NULL OR proposed_statement_type IN ('testable_prediction','present_or_past_factual_claim','conditional_prediction','symbolic_statement','general_encouragement','theological_claim','personal_interpretation')),
  atomic_proposition_draft TEXT,
  explicit_deadline_text TEXT,
  requires_transcript INTEGER NOT NULL CHECK (requires_transcript IN (0,1)),
  requires_human_review INTEGER NOT NULL DEFAULT 1 CHECK (requires_human_review = 1),
  created_at TEXT NOT NULL,
  CHECK (
    (candidate_kind = 'description_lead' AND exact_quote IS NULL AND quote_start IS NULL AND quote_end IS NULL AND requires_transcript = 1)
    OR
    (candidate_kind = 'exact_transcript_claim' AND exact_quote IS NOT NULL AND quote_start >= 0 AND quote_end > quote_start AND requires_transcript = 0)
  )
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_run_status ON ingestion_jobs(run_id, status, job_type);
CREATE INDEX IF NOT EXISTS ingestion_jobs_lease ON ingestion_jobs(status, claimed_at);
CREATE INDEX IF NOT EXISTS source_items_catalogue ON source_items(person_id, last_seen_at DESC, source_item_id DESC);
CREATE INDEX IF NOT EXISTS source_items_platform ON source_items(person_id, platform, platform_item_id);
CREATE INDEX IF NOT EXISTS source_revisions_current ON source_item_revisions(source_item_id, fetched_at DESC, revision_id DESC);
CREATE INDEX IF NOT EXISTS transcript_attempts_source ON transcript_attempts(source_item_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS claim_candidates_source ON claim_candidates(source_item_id, candidate_kind, created_at DESC);

CREATE TRIGGER IF NOT EXISTS source_items_content_guard
BEFORE UPDATE ON source_items
WHEN NEW.source_item_id <> OLD.source_item_id
  OR NEW.person_id <> OLD.person_id
  OR COALESCE(NEW.source_id,'') <> COALESCE(OLD.source_id,'')
  OR NEW.platform <> OLD.platform
  OR NEW.platform_item_id <> OLD.platform_item_id
  OR NEW.canonical_url <> OLD.canonical_url
  OR NEW.first_discovered_at <> OLD.first_discovered_at
BEGIN SELECT RAISE(ABORT, 'source item identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS source_items_no_delete
BEFORE DELETE ON source_items BEGIN SELECT RAISE(ABORT, 'source items cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS source_item_revisions_no_update
BEFORE UPDATE ON source_item_revisions BEGIN SELECT RAISE(ABORT, 'source item revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_item_revisions_no_delete
BEFORE DELETE ON source_item_revisions BEGIN SELECT RAISE(ABORT, 'source item revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_item_links_no_update
BEFORE UPDATE ON source_item_links BEGIN SELECT RAISE(ABORT, 'source item links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_item_links_no_delete
BEFORE DELETE ON source_item_links BEGIN SELECT RAISE(ABORT, 'source item links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_availability_events_no_update
BEFORE UPDATE ON source_availability_events BEGIN SELECT RAISE(ABORT, 'source availability events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_availability_events_no_delete
BEFORE DELETE ON source_availability_events BEGIN SELECT RAISE(ABORT, 'source availability events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_scan_receipts_no_update
BEFORE UPDATE ON source_scan_receipts BEGIN SELECT RAISE(ABORT, 'source scan receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS source_scan_receipts_no_delete
BEFORE DELETE ON source_scan_receipts BEGIN SELECT RAISE(ABORT, 'source scan receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_attempts_no_update
BEFORE UPDATE ON transcript_attempts BEGIN SELECT RAISE(ABORT, 'transcript attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_attempts_no_delete
BEFORE DELETE ON transcript_attempts BEGIN SELECT RAISE(ABORT, 'transcript attempts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_artifacts_no_update
BEFORE UPDATE ON transcript_artifacts BEGIN SELECT RAISE(ABORT, 'transcript artifacts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transcript_artifacts_no_delete
BEFORE DELETE ON transcript_artifacts BEGIN SELECT RAISE(ABORT, 'transcript artifacts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS extraction_runs_no_update
BEFORE UPDATE ON extraction_runs BEGIN SELECT RAISE(ABORT, 'extraction runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS extraction_runs_no_delete
BEFORE DELETE ON extraction_runs BEGIN SELECT RAISE(ABORT, 'extraction runs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS claim_candidates_no_update
BEFORE UPDATE ON claim_candidates BEGIN SELECT RAISE(ABORT, 'claim candidates are append-only'); END;
CREATE TRIGGER IF NOT EXISTS claim_candidates_no_delete
BEFORE DELETE ON claim_candidates BEGIN SELECT RAISE(ABORT, 'claim candidates are append-only'); END;
