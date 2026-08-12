PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS archive_falsifiability_findings (
  finding_id TEXT PRIMARY KEY,
  archive_revision_id TEXT NOT NULL REFERENCES first_party_archive_lead_revisions(archive_revision_id),
  candidate_id TEXT REFERENCES claim_candidates(candidate_id),
  category TEXT NOT NULL CHECK (category IN (
    'checkable_as_predicted','checkable_as_claimed_fulfilled','unfalsifiable_as_stated'
  )),
  exact_quote TEXT NOT NULL,
  missing_elements_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(missing_elements_json)),
  house_rule_note TEXT,
  machine_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(archive_revision_id,machine_version)
);

CREATE INDEX IF NOT EXISTS falsifiability_findings_category
  ON archive_falsifiability_findings(category,created_at);
CREATE TRIGGER IF NOT EXISTS archive_falsifiability_findings_no_update
BEFORE UPDATE ON archive_falsifiability_findings
BEGIN SELECT RAISE(ABORT, 'falsifiability findings are append-only'); END;
CREATE TRIGGER IF NOT EXISTS archive_falsifiability_findings_no_delete
BEFORE DELETE ON archive_falsifiability_findings
BEGIN SELECT RAISE(ABORT, 'falsifiability findings are append-only'); END;
