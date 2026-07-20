PRAGMA foreign_keys = ON;

-- This one narrowly scoped source confirmation is allowed only when every
-- immutable identity field still matches the known publisher archive.
CREATE TABLE IF NOT EXISTS first_party_archive_source_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE REFERENCES sources(source_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  source_url TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role='retrospective_fulfillment'),
  confirmed_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS archive_confirmation_exact_source
BEFORE INSERT ON first_party_archive_source_confirmations
WHEN NOT EXISTS (
  SELECT 1 FROM sources WHERE source_id=NEW.source_id AND person_id=NEW.person_id
    AND source_type='archive' AND url=NEW.source_url
    AND source_role=NEW.source_role AND availability='available'
)
BEGIN SELECT RAISE(ABORT, 'archive source identity does not match'); END;
INSERT OR IGNORE INTO first_party_archive_source_confirmations
  (confirmation_id,source_id,person_id,source_url,source_role,confirmed_at)
VALUES ('archive_confirmation_troy_20260720','source_troy_archive','person_troy_black',
  'https://troyblackvideos.com/prophecy-archive-all/','retrospective_fulfillment',
  '2026-07-20T00:00:00.000Z');
UPDATE sources SET identity_status='confirmed'
WHERE source_id='source_troy_archive' AND person_id='person_troy_black'
  AND source_type='archive' AND url='https://troyblackvideos.com/prophecy-archive-all/'
  AND source_role='retrospective_fulfillment' AND availability='available';
CREATE TRIGGER IF NOT EXISTS archive_confirmations_no_update
BEFORE UPDATE ON first_party_archive_source_confirmations
BEGIN SELECT RAISE(ABORT, 'archive confirmations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_confirmations_no_delete
BEFORE DELETE ON first_party_archive_source_confirmations
BEGIN SELECT RAISE(ABORT, 'archive confirmations are append-only'); END;

-- A first-party retrospective archive is a discovery index. Its wording and
-- claimed results are never claims, exact quotations, or independent outcome
-- evidence. Each fetched representation and human check remains append-only.
CREATE TABLE IF NOT EXISTS first_party_archive_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  adapter TEXT NOT NULL CHECK (adapter='wptb_fulfilled_prophecy_v1'),
  source_url TEXT NOT NULL,
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256)=64),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  parser_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(run_id,source_id)
);

CREATE TABLE IF NOT EXISTS first_party_archive_leads (
  archive_lead_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  publisher_element_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_id,publisher_element_id)
);

CREATE TABLE IF NOT EXISTS first_party_archive_lead_revisions (
  archive_revision_id TEXT PRIMARY KEY,
  archive_lead_id TEXT NOT NULL REFERENCES first_party_archive_leads(archive_lead_id),
  receipt_id TEXT NOT NULL REFERENCES first_party_archive_receipts(receipt_id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
  source_locator_y_index INTEGER NOT NULL CHECK (source_locator_y_index >= 1),
  description_text TEXT NOT NULL,
  date_shared_text TEXT,
  prophecy_text TEXT NOT NULL,
  claimed_result_text TEXT,
  claimed_evidence_text TEXT,
  prophecy_provenance TEXT NOT NULL DEFAULT 'first_party_claimed_original'
    CHECK (prophecy_provenance='first_party_claimed_original'),
  result_provenance TEXT NOT NULL DEFAULT 'first_party_claimed_result'
    CHECK (result_provenance='first_party_claimed_result'),
  evidence_provenance TEXT NOT NULL DEFAULT 'first_party_claimed_evidence'
    CHECK (evidence_provenance='first_party_claimed_evidence'),
  parser_version TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(archive_lead_id,content_sha256)
);

CREATE TABLE IF NOT EXISTS first_party_archive_revision_links (
  archive_link_id TEXT PRIMARY KEY,
  archive_revision_id TEXT NOT NULL REFERENCES first_party_archive_lead_revisions(archive_revision_id),
  link_role TEXT NOT NULL CHECK (link_role IN (
    'original_video','claimed_follow_up','claimed_evidence'
  )),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  youtube_id TEXT,
  source_item_id TEXT REFERENCES source_items(source_item_id),
  provenance TEXT NOT NULL CHECK (provenance IN (
    'first_party_claimed_original','first_party_claimed_follow_up',
    'first_party_claimed_evidence'
  )),
  CHECK ((link_role='original_video' AND provenance='first_party_claimed_original'
          AND ((youtube_id IS NOT NULL AND source_item_id IS NOT NULL)
            OR (youtube_id IS NULL AND source_item_id IS NULL)))
      OR (link_role='claimed_follow_up' AND provenance='first_party_claimed_follow_up'
          AND source_item_id IS NULL)
      OR (link_role='claimed_evidence' AND provenance='first_party_claimed_evidence'
          AND source_item_id IS NULL)),
  UNIQUE(archive_revision_id,link_role,ordinal),
  UNIQUE(archive_revision_id,link_role,url),
  UNIQUE(archive_revision_id,archive_link_id)
);

-- A later receipt that observes identical content still gets its own immutable
-- observation without duplicating the content-addressed revision.
CREATE TABLE IF NOT EXISTS first_party_archive_revision_observations (
  archive_observation_id TEXT PRIMARY KEY,
  archive_revision_id TEXT NOT NULL REFERENCES first_party_archive_lead_revisions(archive_revision_id),
  receipt_id TEXT NOT NULL REFERENCES first_party_archive_receipts(receipt_id),
  source_locator_y_index INTEGER NOT NULL CHECK (source_locator_y_index >= 1),
  observed_at TEXT NOT NULL,
  UNIQUE(receipt_id,archive_revision_id)
);

-- This verification lane is deliberately separate from review_work_items so
-- archive wording can never satisfy the existing claim-promotion constraints.
CREATE TABLE IF NOT EXISTS archive_verification_work_items (
  archive_work_item_id TEXT PRIMARY KEY,
  archive_revision_id TEXT NOT NULL REFERENCES first_party_archive_lead_revisions(archive_revision_id),
  archive_video_link_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','complete','withdrawn')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(archive_revision_id,archive_video_link_id),
  FOREIGN KEY (archive_revision_id,archive_video_link_id)
    REFERENCES first_party_archive_revision_links(archive_revision_id,archive_link_id)
);

CREATE TABLE IF NOT EXISTS archive_review_assignments (
  archive_assignment_id TEXT PRIMARY KEY,
  archive_work_item_id TEXT NOT NULL REFERENCES archive_verification_work_items(archive_work_item_id),
  reviewer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('leased','submitted','released')),
  assigned_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  submitted_at TEXT,
  lease_version INTEGER NOT NULL DEFAULT 1 CHECK (lease_version >= 1),
  UNIQUE(archive_work_item_id,reviewer_id),
  CHECK ((status='submitted' AND submitted_at IS NOT NULL)
      OR (status<>'submitted' AND submitted_at IS NULL))
);

CREATE TABLE IF NOT EXISTS archive_review_decisions (
  archive_decision_id TEXT PRIMARY KEY,
  archive_work_item_id TEXT NOT NULL REFERENCES archive_verification_work_items(archive_work_item_id),
  archive_assignment_id TEXT NOT NULL UNIQUE REFERENCES archive_review_assignments(archive_assignment_id),
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN (
    'source_supported','archive_mismatch','not_testable','source_unavailable'
  )),
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(archive_work_item_id,reviewer_id)
);

CREATE TABLE IF NOT EXISTS archive_review_source_checks (
  archive_source_check_id TEXT PRIMARY KEY,
  archive_decision_id TEXT NOT NULL REFERENCES archive_review_decisions(archive_decision_id),
  check_name TEXT NOT NULL CHECK (check_name IN (
    'source_available','testable','exact_source','who','what','why','where','when','how'
  )),
  check_status TEXT NOT NULL CHECK (check_status IN (
    'supported','not_supported','not_stated','not_checked'
  )),
  source_note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(archive_decision_id,check_name),
  CHECK (check_name<>'how' OR check_status IN ('supported','not_stated','not_checked'))
);

CREATE INDEX IF NOT EXISTS archive_leads_person
  ON first_party_archive_leads(person_id,source_id,publisher_element_id);
CREATE INDEX IF NOT EXISTS archive_revisions_lead
  ON first_party_archive_lead_revisions(archive_lead_id,fetched_at,archive_revision_id);
CREATE INDEX IF NOT EXISTS archive_links_video
  ON first_party_archive_revision_links(link_role,youtube_id,archive_revision_id,ordinal);
CREATE INDEX IF NOT EXISTS archive_observations_revision
  ON first_party_archive_revision_observations(archive_revision_id,observed_at,receipt_id);
CREATE INDEX IF NOT EXISTS archive_work_ready
  ON archive_verification_work_items(status,created_at,archive_work_item_id);
CREATE INDEX IF NOT EXISTS archive_assignments_reviewer
  ON archive_review_assignments(reviewer_id,status,lease_expires_at);

CREATE VIEW IF NOT EXISTS archive_linked_video_selector AS
SELECT work.archive_work_item_id,lead.person_id,link.source_item_id,link.youtube_id,
  link.url,revision.date_shared_text,revision.fetched_at,work.status,
  CASE work.status WHEN 'ready' THEN 0 WHEN 'complete' THEN 1 ELSE 2 END priority
FROM archive_verification_work_items work
JOIN first_party_archive_revision_links link
  ON link.archive_link_id=work.archive_video_link_id AND link.link_role='original_video'
JOIN first_party_archive_lead_revisions revision
  ON revision.archive_revision_id=work.archive_revision_id
JOIN first_party_archive_leads lead ON lead.archive_lead_id=revision.archive_lead_id;

CREATE TRIGGER IF NOT EXISTS first_party_archive_receipts_no_update
BEFORE UPDATE ON first_party_archive_receipts BEGIN SELECT RAISE(ABORT, 'archive receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_receipts_no_delete
BEFORE DELETE ON first_party_archive_receipts BEGIN SELECT RAISE(ABORT, 'archive receipts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_leads_identity_guard
BEFORE UPDATE ON first_party_archive_leads BEGIN SELECT RAISE(ABORT, 'archive lead identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_leads_no_delete
BEFORE DELETE ON first_party_archive_leads BEGIN SELECT RAISE(ABORT, 'archive leads cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_revisions_no_update
BEFORE UPDATE ON first_party_archive_lead_revisions BEGIN SELECT RAISE(ABORT, 'archive revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_revisions_no_delete
BEFORE DELETE ON first_party_archive_lead_revisions BEGIN SELECT RAISE(ABORT, 'archive revisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_links_no_update
BEFORE UPDATE ON first_party_archive_revision_links BEGIN SELECT RAISE(ABORT, 'archive links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_links_no_delete
BEFORE DELETE ON first_party_archive_revision_links BEGIN SELECT RAISE(ABORT, 'archive links are append-only'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_observations_no_update
BEFORE UPDATE ON first_party_archive_revision_observations BEGIN SELECT RAISE(ABORT, 'archive observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS first_party_archive_observations_no_delete
BEFORE DELETE ON first_party_archive_revision_observations BEGIN SELECT RAISE(ABORT, 'archive observations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_work_identity_guard
BEFORE UPDATE ON archive_verification_work_items
WHEN NEW.archive_work_item_id<>OLD.archive_work_item_id
  OR NEW.archive_revision_id<>OLD.archive_revision_id
  OR NEW.archive_video_link_id<>OLD.archive_video_link_id
  OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT, 'archive work identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS archive_work_no_delete
BEFORE DELETE ON archive_verification_work_items BEGIN SELECT RAISE(ABORT, 'archive work cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS archive_assignments_identity_guard
BEFORE UPDATE ON archive_review_assignments
WHEN NEW.archive_assignment_id<>OLD.archive_assignment_id
  OR NEW.archive_work_item_id<>OLD.archive_work_item_id
  OR NEW.reviewer_id<>OLD.reviewer_id OR NEW.assigned_at<>OLD.assigned_at
BEGIN SELECT RAISE(ABORT, 'archive assignment identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS archive_assignments_no_delete
BEFORE DELETE ON archive_review_assignments BEGIN SELECT RAISE(ABORT, 'archive assignments cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS archive_decisions_live_assignment
BEFORE INSERT ON archive_review_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM archive_review_assignments assignment
  JOIN archive_verification_work_items work
    ON work.archive_work_item_id=assignment.archive_work_item_id
  WHERE assignment.archive_assignment_id=NEW.archive_assignment_id
    AND assignment.archive_work_item_id=NEW.archive_work_item_id
    AND assignment.reviewer_id=NEW.reviewer_id AND assignment.status='leased'
    AND assignment.lease_expires_at>NEW.created_at AND work.status='ready'
)
BEGIN SELECT RAISE(ABORT, 'a live archive assignment is required'); END;
CREATE TRIGGER IF NOT EXISTS archive_decisions_no_update
BEFORE UPDATE ON archive_review_decisions BEGIN SELECT RAISE(ABORT, 'archive decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_decisions_no_delete
BEFORE DELETE ON archive_review_decisions BEGIN SELECT RAISE(ABORT, 'archive decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_checks_no_update
BEFORE UPDATE ON archive_review_source_checks BEGIN SELECT RAISE(ABORT, 'archive source checks are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_checks_no_delete
BEFORE DELETE ON archive_review_source_checks BEGIN SELECT RAISE(ABORT, 'archive source checks are append-only'); END;
