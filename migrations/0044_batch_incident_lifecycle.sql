PRAGMA foreign_keys = ON;

CREATE TABLE batch_incidents (
  incident_id TEXT PRIMARY KEY,
  fingerprint_sha256 TEXT NOT NULL UNIQUE CHECK (length(fingerprint_sha256) = 64),
  fingerprint_version TEXT NOT NULL CHECK (fingerprint_version = 'batch-incident-v1'),
  batch_id TEXT REFERENCES transcript_batches(batch_id),
  batch_item_id TEXT REFERENCES transcript_batch_items(batch_item_id),
  incident_class TEXT NOT NULL CHECK (incident_class IN (
    'batch_paused','batch_no_progress','queue_backlog','queue_dlq',
    'analysis_reconciliation_blocked','action_receipt_mismatch'
  )),
  safe_reason_code TEXT NOT NULL CHECK (length(safe_reason_code) BETWEEN 1 AND 120),
  causal_id TEXT,
  batch_transition_count INTEGER CHECK (batch_transition_count IS NULL OR batch_transition_count >= 0),
  safe_count INTEGER CHECK (safe_count IS NULL OR safe_count >= 0),
  opened_at TEXT NOT NULL,
  CHECK (batch_id IS NOT NULL OR incident_class IN (
    'queue_backlog','queue_dlq','analysis_reconciliation_blocked','action_receipt_mismatch'
  ))
);

CREATE TABLE batch_incident_events (
  incident_event_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES batch_incidents(incident_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'opened','opening_notice_accepted','opening_notice_delivered','opening_notice_failed','recovered',
    'recovery_notice_accepted','recovery_notice_delivered','recovery_notice_failed'
  )),
  safe_reason_code TEXT,
  safe_count INTEGER CHECK (safe_count IS NULL OR safe_count >= 0),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  created_at TEXT NOT NULL,
  UNIQUE (incident_id, event_type)
);

CREATE INDEX idx_batch_incidents_batch
  ON batch_incidents(batch_id, incident_class, opened_at);
CREATE INDEX idx_batch_incident_events_incident
  ON batch_incident_events(incident_id, created_at, incident_event_id);

CREATE TRIGGER batch_incidents_no_update
BEFORE UPDATE ON batch_incidents BEGIN
  SELECT RAISE(ABORT, 'batch incidents are append-only');
END;
CREATE TRIGGER batch_incidents_no_delete
BEFORE DELETE ON batch_incidents BEGIN
  SELECT RAISE(ABORT, 'batch incidents are append-only');
END;
CREATE TRIGGER batch_incident_events_no_update
BEFORE UPDATE ON batch_incident_events BEGIN
  SELECT RAISE(ABORT, 'batch incident events are append-only');
END;
CREATE TRIGGER batch_incident_events_no_delete
BEFORE DELETE ON batch_incident_events BEGIN
  SELECT RAISE(ABORT, 'batch incident events are append-only');
END;

CREATE VIEW current_batch_incidents AS
SELECT incident.*,
  EXISTS (SELECT 1 FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='opening_notice_accepted')
    AS opening_notice_accepted,
  (SELECT event.provider_message_id FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='opening_notice_accepted'
    LIMIT 1) AS opening_provider_message_id,
  EXISTS (SELECT 1 FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='opening_notice_delivered')
    AS opening_notice_delivered,
  EXISTS (SELECT 1 FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='opening_notice_failed')
    AS opening_notice_failed,
  EXISTS (SELECT 1 FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='recovered')
    AS recovered,
  EXISTS (SELECT 1 FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='recovery_notice_accepted')
    AS recovery_notice_accepted,
  (SELECT event.provider_message_id FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='recovery_notice_accepted'
    LIMIT 1) AS recovery_provider_message_id,
  EXISTS (SELECT 1 FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='recovery_notice_delivered')
    AS recovery_notice_delivered,
  EXISTS (SELECT 1 FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id AND event.event_type='recovery_notice_failed')
    AS recovery_notice_failed,
  (SELECT event.created_at FROM batch_incident_events event
    WHERE event.incident_id=incident.incident_id
    ORDER BY event.created_at DESC,event.incident_event_id DESC LIMIT 1) AS last_event_at
FROM batch_incidents incident;
