PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS people (
  person_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  corpus_label TEXT NOT NULL,
  corpus_start TEXT,
  corpus_end TEXT,
  discovered_videos INTEGER NOT NULL DEFAULT 0 CHECK (discovered_videos >= 0),
  reviewed_videos INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_videos >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'website','youtube','social','podcast','newsletter','video_platform','archive'
  )),
  url TEXT NOT NULL,
  identity_status TEXT NOT NULL DEFAULT 'candidate' CHECK (identity_status IN (
    'candidate','confirmed','rejected'
  )),
  source_role TEXT NOT NULL DEFAULT 'first_party_candidate' CHECK (source_role IN (
    'first_party_candidate','first_party','retrospective_fulfillment','independent'
  )),
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN (
    'available','unavailable','unknown'
  )),
  note TEXT NOT NULL DEFAULT '',
  accessed_at TEXT NOT NULL,
  UNIQUE(person_id, url)
);

CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(person_id),
  youtube_id TEXT NOT NULL UNIQUE,
  canonical_url TEXT NOT NULL,
  shared_at TEXT,
  title TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'missing' CHECK (transcript_status IN (
    'missing','provided','verified','unavailable'
  )),
  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN (
    'available','unavailable','unknown'
  )),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  video_id TEXT REFERENCES videos(video_id),
  cluster_id TEXT NOT NULL,
  title TEXT NOT NULL,
  exact_quote TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_date TEXT NOT NULL,
  source_timestamp_seconds INTEGER,
  transcript_warning TEXT,
  statement_type TEXT NOT NULL CHECK (statement_type IN (
    'testable_prediction','present_or_past_factual_claim','conditional_prediction',
    'symbolic_statement','general_encouragement','theological_claim','personal_interpretation'
  )),
  atomic_proposition TEXT NOT NULL,
  criteria TEXT NOT NULL,
  deadline TEXT,
  as_of_date TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN (
    'pending','due_soon','deadline_passed_awaiting_review','resolved','in_review'
  )),
  proposed_outcome TEXT CHECK (proposed_outcome IN (
    'true','false','partial','pending','undetermined','not_falsifiable'
  )),
  outcome_status TEXT NOT NULL DEFAULT 'undetermined' CHECK (outcome_status IN (
    'true','false','partial','pending','undetermined','not_falsifiable'
  )),
  novelty_status TEXT NOT NULL DEFAULT 'not_assessed' CHECK (novelty_status IN (
    'already_public','widely_expected','strong_signals','emerging_signals',
    'no_precursor_found','not_assessed'
  )),
  baseline_probability REAL CHECK (
    baseline_probability IS NULL OR baseline_probability BETWEEN 0 AND 1
  ),
  score_eligible INTEGER NOT NULL DEFAULT 0 CHECK (score_eligible IN (0,1)),
  visibility TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft','published')),
  publication_summary TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS claims_person_visibility
  ON claims(person_id, visibility, source_date);
CREATE INDEX IF NOT EXISTS claims_cluster ON claims(cluster_id);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  evidence_role TEXT NOT NULL CHECK (evidence_role IN (
    'original_statement','contemporaneous_followup','retrospective_fulfillment',
    'independent_outcome','contemporaneous_public_information'
  )),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  accessed_at TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('speaker_authored','independent','platform')),
  note TEXT NOT NULL DEFAULT '',
  search_query TEXT,
  cutoff_date TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evidence_claim ON evidence(claim_id, evidence_role);

CREATE TABLE IF NOT EXISTS moderator_reviews (
  review_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  reviewer_id TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  outcome_status TEXT NOT NULL CHECK (outcome_status IN (
    'true','false','partial','pending','undetermined','not_falsifiable'
  )),
  novelty_status TEXT NOT NULL CHECK (novelty_status IN (
    'already_public','widely_expected','strong_signals','emerging_signals',
    'no_precursor_found','not_assessed'
  )),
  baseline_probability REAL CHECK (
    baseline_probability IS NULL OR baseline_probability BETWEEN 0 AND 1
  ),
  evidence_ids_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS claim_events (
  event_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created','review_submitted','published','disagreement','correction','appeal',
    'source_unavailable'
  )),
  actor_id TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS claim_events_claim ON claim_events(claim_id, created_at);

CREATE TABLE IF NOT EXISTS ingest_requests (
  request_id TEXT PRIMARY KEY,
  canonical_video_id TEXT NOT NULL UNIQUE,
  normalized_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending_identity','pending_transcript','ready_for_review','failed'
  )),
  candidate_sources_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS evidence_no_update
BEFORE UPDATE ON evidence BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete
BEFORE DELETE ON evidence BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;
CREATE TRIGGER IF NOT EXISTS moderator_reviews_no_update
BEFORE UPDATE ON moderator_reviews BEGIN
  SELECT RAISE(ABORT, 'moderator reviews are append-only');
END;
CREATE TRIGGER IF NOT EXISTS moderator_reviews_no_delete
BEFORE DELETE ON moderator_reviews BEGIN
  SELECT RAISE(ABORT, 'moderator reviews are append-only');
END;
CREATE TRIGGER IF NOT EXISTS claim_events_no_update
BEFORE UPDATE ON claim_events BEGIN
  SELECT RAISE(ABORT, 'claim events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS claim_events_no_delete
BEFORE DELETE ON claim_events BEGIN
  SELECT RAISE(ABORT, 'claim events are append-only');
END;
