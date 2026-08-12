PRAGMA foreign_keys = ON;

-- Operational runners write their item finals first inside one transaction,
-- then insert the immutable run summary. Deferred foreign keys allow the run
-- insert trigger to prove that every discovered item has exactly one final.
CREATE TABLE analysis_reconciliation_runs (
  run_id TEXT PRIMARY KEY,
  idempotency_sha256 TEXT NOT NULL UNIQUE CHECK (length(idempotency_sha256) = 64),
  limit_count INTEGER NOT NULL CHECK (limit_count BETWEEN 1 AND 25),
  discovered_count INTEGER NOT NULL CHECK (discovered_count >= 0),
  completed_count INTEGER NOT NULL CHECK (completed_count >= 0),
  manual_required_count INTEGER NOT NULL CHECK (manual_required_count >= 0),
  failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  CHECK (completed_count + manual_required_count + failed_count = discovered_count),
  CHECK ((status = 'completed' AND failed_count = 0) OR status = 'failed')
);

CREATE TABLE analysis_reconciliation_item_receipts (
  item_receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_reconciliation_runs(run_id)
    DEFERRABLE INITIALLY DEFERRED,
  analysis_section_id TEXT NOT NULL REFERENCES transcript_analysis_sections(analysis_section_id),
  job_id TEXT REFERENCES ingestion_jobs(job_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','manual_required','failed')),
  safe_reason_code TEXT NOT NULL CHECK (length(safe_reason_code) BETWEEN 1 AND 120),
  before_status TEXT NOT NULL CHECK (before_status = 'failed'),
  after_status TEXT CHECK (after_status IS NULL OR after_status IN (
    'queued','processing','completed','failed'
  )),
  readback_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, analysis_section_id)
);

CREATE TRIGGER analysis_reconciliation_run_count_guard
BEFORE INSERT ON analysis_reconciliation_runs
WHEN NEW.discovered_count <> (
    SELECT COUNT(*) FROM analysis_reconciliation_item_receipts item WHERE item.run_id = NEW.run_id
  )
  OR NEW.completed_count <> (
    SELECT COUNT(*) FROM analysis_reconciliation_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.outcome = 'completed'
  )
  OR NEW.manual_required_count <> (
    SELECT COUNT(*) FROM analysis_reconciliation_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.outcome = 'manual_required'
  )
  OR NEW.failed_count <> (
    SELECT COUNT(*) FROM analysis_reconciliation_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.outcome = 'failed'
  )
BEGIN
  SELECT RAISE(ABORT, 'analysis reconciliation run item counts disagree');
END;

CREATE TABLE machine_conveyor_runs (
  run_id TEXT PRIMARY KEY,
  idempotency_sha256 TEXT NOT NULL UNIQUE CHECK (length(idempotency_sha256) = 64),
  limit_count INTEGER NOT NULL CHECK (limit_count BETWEEN 1 AND 25),
  considered_count INTEGER NOT NULL CHECK (considered_count >= 0),
  verified_count INTEGER NOT NULL CHECK (verified_count >= 0),
  classified_count INTEGER NOT NULL CHECK (classified_count >= 0),
  promoted_count INTEGER NOT NULL CHECK (promoted_count >= 0),
  reused_count INTEGER NOT NULL CHECK (reused_count >= 0),
  failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
  pending_promotions_count INTEGER NOT NULL CHECK (pending_promotions_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  CHECK (classified_count + failed_count = considered_count),
  CHECK (promoted_count + reused_count <= verified_count AND verified_count <= considered_count),
  CHECK (pending_promotions_count = verified_count - promoted_count - reused_count),
  CHECK ((status = 'completed' AND failed_count = 0 AND pending_promotions_count = 0)
    OR status = 'failed')
);

CREATE TABLE machine_conveyor_item_receipts (
  item_receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES machine_conveyor_runs(run_id)
    DEFERRABLE INITIALLY DEFERRED,
  candidate_id TEXT NOT NULL REFERENCES claim_candidates(candidate_id),
  readiness_id TEXT REFERENCES candidate_atomic_readiness(readiness_id),
  work_item_id TEXT,
  verified INTEGER NOT NULL CHECK (verified IN (0,1)),
  classification TEXT NOT NULL CHECK (classification IN (
    'review_ready','review_ready_reused','binding_changed','already_promoted',
    'work_item_conflict','readback_mismatch','insert_receipt_mismatch','runner_error'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('promoted','reused','skipped','failed')),
  safe_reason_code TEXT NOT NULL CHECK (length(safe_reason_code) BETWEEN 1 AND 120),
  readback_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, candidate_id),
  CHECK ((outcome IN ('promoted','reused') AND verified = 1 AND work_item_id IS NOT NULL)
    OR outcome NOT IN ('promoted','reused'))
);

CREATE TRIGGER machine_conveyor_run_count_guard
BEFORE INSERT ON machine_conveyor_runs
WHEN NEW.considered_count <> (
    SELECT COUNT(*) FROM machine_conveyor_item_receipts item WHERE item.run_id = NEW.run_id
  )
  OR NEW.verified_count <> (
    SELECT COUNT(*) FROM machine_conveyor_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.verified = 1
  )
  OR NEW.classified_count <> (
    SELECT COUNT(*) FROM machine_conveyor_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.outcome <> 'failed'
  )
  OR NEW.promoted_count <> (
    SELECT COUNT(*) FROM machine_conveyor_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.outcome = 'promoted'
  )
  OR NEW.reused_count <> (
    SELECT COUNT(*) FROM machine_conveyor_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.outcome = 'reused'
  )
  OR NEW.failed_count <> (
    SELECT COUNT(*) FROM machine_conveyor_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.outcome = 'failed'
  )
  OR NEW.pending_promotions_count <> (
    SELECT COUNT(*) FROM machine_conveyor_item_receipts item
    WHERE item.run_id = NEW.run_id AND item.verified = 1
      AND item.outcome NOT IN ('promoted','reused')
  )
BEGIN
  SELECT RAISE(ABORT, 'machine conveyor run item counts disagree');
END;

CREATE TABLE queue_observation_receipts (
  observation_id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL CHECK (queue_name IN (
    'prophecy-ledger-ingestion','prophecy-ledger-analysis',
    'prophecy-ledger-ingestion-dlq','prophecy-ledger-analysis-dlq'
  )),
  status TEXT NOT NULL CHECK (status IN ('observed','unavailable')),
  backlog_count INTEGER CHECK (backlog_count IS NULL OR backlog_count >= 0),
  backlog_bytes INTEGER CHECK (backlog_bytes IS NULL OR backlog_bytes >= 0),
  oldest_message_at TEXT,
  safe_reason_code TEXT,
  observed_at TEXT NOT NULL,
  CHECK ((status = 'observed' AND backlog_count IS NOT NULL AND backlog_bytes IS NOT NULL
      AND safe_reason_code IS NULL)
    OR (status = 'unavailable' AND backlog_count IS NULL AND backlog_bytes IS NULL
      AND safe_reason_code IS NOT NULL))
);

CREATE TABLE runtime_deployment_receipts (
  deployment_receipt_id TEXT PRIMARY KEY,
  source_fingerprint_sha256 TEXT NOT NULL CHECK (length(source_fingerprint_sha256) = 64),
  migration_manifest_sha256 TEXT NOT NULL CHECK (length(migration_manifest_sha256) = 64),
  test_receipt_sha256 TEXT NOT NULL CHECK (length(test_receipt_sha256) = 64),
  scanner_bundle_sha256 TEXT NOT NULL CHECK (length(scanner_bundle_sha256) = 64),
  pages_bundle_sha256 TEXT CHECK (pages_bundle_sha256 IS NULL OR length(pages_bundle_sha256) = 64),
  worker_version_id TEXT,
  worker_deployment_id TEXT,
  pages_deployment_id TEXT,
  post_deploy_readback_sha256 TEXT CHECK (
    post_deploy_readback_sha256 IS NULL OR length(post_deploy_readback_sha256) = 64
  ),
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  created_at TEXT NOT NULL,
  CHECK (status = 'failed' OR (
    worker_version_id IS NOT NULL AND worker_deployment_id IS NOT NULL
    AND post_deploy_readback_sha256 IS NOT NULL
  ))
);

CREATE INDEX idx_analysis_reconciliation_items_run
  ON analysis_reconciliation_item_receipts(run_id, outcome, analysis_section_id);
CREATE INDEX idx_machine_conveyor_items_run
  ON machine_conveyor_item_receipts(run_id, outcome, candidate_id);
CREATE INDEX idx_queue_observations_queue
  ON queue_observation_receipts(queue_name, observed_at);
CREATE INDEX idx_runtime_deployments_created
  ON runtime_deployment_receipts(created_at, deployment_receipt_id);

CREATE TRIGGER analysis_reconciliation_runs_no_update BEFORE UPDATE ON analysis_reconciliation_runs
BEGIN SELECT RAISE(ABORT, 'analysis reconciliation runs are append-only'); END;
CREATE TRIGGER analysis_reconciliation_runs_no_delete BEFORE DELETE ON analysis_reconciliation_runs
BEGIN SELECT RAISE(ABORT, 'analysis reconciliation runs are append-only'); END;
CREATE TRIGGER analysis_reconciliation_items_no_update BEFORE UPDATE ON analysis_reconciliation_item_receipts
BEGIN SELECT RAISE(ABORT, 'analysis reconciliation item receipts are append-only'); END;
CREATE TRIGGER analysis_reconciliation_items_no_delete BEFORE DELETE ON analysis_reconciliation_item_receipts
BEGIN SELECT RAISE(ABORT, 'analysis reconciliation item receipts are append-only'); END;
CREATE TRIGGER machine_conveyor_runs_no_update BEFORE UPDATE ON machine_conveyor_runs
BEGIN SELECT RAISE(ABORT, 'machine conveyor runs are append-only'); END;
CREATE TRIGGER machine_conveyor_runs_no_delete BEFORE DELETE ON machine_conveyor_runs
BEGIN SELECT RAISE(ABORT, 'machine conveyor runs are append-only'); END;
CREATE TRIGGER machine_conveyor_items_no_update BEFORE UPDATE ON machine_conveyor_item_receipts
BEGIN SELECT RAISE(ABORT, 'machine conveyor item receipts are append-only'); END;
CREATE TRIGGER machine_conveyor_items_no_delete BEFORE DELETE ON machine_conveyor_item_receipts
BEGIN SELECT RAISE(ABORT, 'machine conveyor item receipts are append-only'); END;
CREATE TRIGGER queue_observation_receipts_no_update BEFORE UPDATE ON queue_observation_receipts
BEGIN SELECT RAISE(ABORT, 'queue observation receipts are append-only'); END;
CREATE TRIGGER queue_observation_receipts_no_delete BEFORE DELETE ON queue_observation_receipts
BEGIN SELECT RAISE(ABORT, 'queue observation receipts are append-only'); END;
CREATE TRIGGER runtime_deployment_receipts_no_update BEFORE UPDATE ON runtime_deployment_receipts
BEGIN SELECT RAISE(ABORT, 'runtime deployment receipts are append-only'); END;
CREATE TRIGGER runtime_deployment_receipts_no_delete BEFORE DELETE ON runtime_deployment_receipts
BEGIN SELECT RAISE(ABORT, 'runtime deployment receipts are append-only'); END;
