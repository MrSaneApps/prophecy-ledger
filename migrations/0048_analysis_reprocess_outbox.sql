PRAGMA foreign_keys = ON;

CREATE TABLE analysis_reprocess_dispatch_outbox (
  action_id TEXT PRIMARY KEY,
  idempotency_key_sha256 TEXT NOT NULL CHECK (length(idempotency_key_sha256) = 64),
  analysis_section_id TEXT NOT NULL REFERENCES transcript_analysis_sections(analysis_section_id),
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(job_id),
  expected_attempt_count INTEGER NOT NULL CHECK (expected_attempt_count BETWEEN 1 AND 7),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','dispatching','sent')),
  claim_token TEXT,
  claimed_at TEXT,
  dispatch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempt_count >= 0),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  CHECK ((status = 'pending' AND claim_token IS NULL AND claimed_at IS NULL AND sent_at IS NULL) OR
         (status = 'dispatching' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND sent_at IS NULL) OR
         (status = 'sent' AND claim_token IS NULL AND claimed_at IS NULL AND sent_at IS NOT NULL)),
  UNIQUE (analysis_section_id, expected_attempt_count)
);

CREATE INDEX idx_analysis_reprocess_outbox_pending
  ON analysis_reprocess_dispatch_outbox(status, claimed_at, created_at);

CREATE TRIGGER analysis_reprocess_outbox_binding_guard
BEFORE INSERT ON analysis_reprocess_dispatch_outbox
WHEN NOT EXISTS (SELECT 1 FROM analysis_reprocess_dispatch_outbox WHERE action_id=NEW.action_id)
  AND NOT EXISTS (
  SELECT 1 FROM transcript_analysis_sections section
  JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
  JOIN ingestion_jobs job ON job.job_id=NEW.job_id
  WHERE section.analysis_section_id=NEW.analysis_section_id
    AND section.analysis_run_id=analysis.analysis_run_id
    AND section.status='failed'
    AND section.attempt_count=NEW.expected_attempt_count
    AND job.status='failed'
    AND job.attempt_count<8
    AND job.job_type='transcript_extract'
    AND json_extract(job.payload_json,'$.phase')='analyze'
    AND json_extract(job.payload_json,'$.analysisSectionId')=NEW.analysis_section_id
    AND json_extract(NEW.envelope_json,'$.jobId')=NEW.job_id
    AND json_extract(NEW.envelope_json,'$.payload.analysisSectionId')=NEW.analysis_section_id
)
BEGIN
  SELECT RAISE(ABORT, 'analysis reprocess outbox binding mismatch');
END;

CREATE TRIGGER analysis_reprocess_outbox_queue_state
AFTER INSERT ON analysis_reprocess_dispatch_outbox
BEGIN
  UPDATE ingestion_jobs SET status='queued',claimed_at=NULL,lease_token=NULL,
    completed_at=NULL,error_code='analysis_reprocess_outbox_pending:' || NEW.action_id
  WHERE job_id=NEW.job_id AND status='failed';
  UPDATE transcript_analysis_sections SET status='queued',completed_at=NULL,
    error_code='analysis_reprocess_outbox_pending:' || NEW.action_id
  WHERE analysis_section_id=NEW.analysis_section_id AND status='failed'
    AND attempt_count=NEW.expected_attempt_count;
END;

CREATE TRIGGER analysis_reprocess_outbox_identity_guard
BEFORE UPDATE ON analysis_reprocess_dispatch_outbox
WHEN NEW.action_id <> OLD.action_id OR
     NEW.idempotency_key_sha256 <> OLD.idempotency_key_sha256 OR
     NEW.analysis_section_id <> OLD.analysis_section_id OR
     NEW.job_id <> OLD.job_id OR
     NEW.expected_attempt_count <> OLD.expected_attempt_count OR
     NEW.envelope_json <> OLD.envelope_json OR
     NEW.created_at <> OLD.created_at OR
     NEW.dispatch_attempt_count < OLD.dispatch_attempt_count OR
     OLD.status = 'sent'
BEGIN
  SELECT RAISE(ABORT, 'analysis reprocess outbox identity is immutable');
END;

CREATE TRIGGER analysis_reprocess_outbox_no_delete
BEFORE DELETE ON analysis_reprocess_dispatch_outbox BEGIN
  SELECT RAISE(ABORT, 'analysis reprocess outbox is append-preserving');
END;
