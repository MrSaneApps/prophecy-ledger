PRAGMA foreign_keys = ON;

-- Reviewer feedback and public issue reports: the capture layer of the
-- self-improvement loop. Append-only; read by maintainers; never auto-acted.

CREATE TABLE IF NOT EXISTS reviewer_feedback (
  feedback_id TEXT PRIMARY KEY,
  reviewer_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'ai_extraction_quality','ui_friction','evidence_gap','feature_request','other'
  )),
  claim_id TEXT REFERENCES claims(claim_id),
  candidate_id TEXT REFERENCES claim_candidates(candidate_id),
  assignment_id TEXT,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 5 AND 4000),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviewer_feedback_category
  ON reviewer_feedback(category, created_at);
CREATE TRIGGER IF NOT EXISTS reviewer_feedback_no_update
BEFORE UPDATE ON reviewer_feedback BEGIN
  SELECT RAISE(ABORT, 'reviewer feedback is append-only');
END;
CREATE TRIGGER IF NOT EXISTS reviewer_feedback_no_delete
BEFORE DELETE ON reviewer_feedback BEGIN
  SELECT RAISE(ABORT, 'reviewer feedback is append-only');
END;

CREATE TABLE IF NOT EXISTS public_issue_reports (
  report_id TEXT PRIMARY KEY,
  page_path TEXT NOT NULL CHECK (length(page_path) <= 300),
  claim_id TEXT REFERENCES claims(claim_id),
  category TEXT NOT NULL CHECK (category IN (
    'wrong_or_missing_information','source_problem','broken_page','other'
  )),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 5 AND 2000),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS public_issue_reports_created
  ON public_issue_reports(created_at);
CREATE TRIGGER IF NOT EXISTS public_issue_reports_no_update
BEFORE UPDATE ON public_issue_reports BEGIN
  SELECT RAISE(ABORT, 'issue reports are append-only');
END;
CREATE TRIGGER IF NOT EXISTS public_issue_reports_no_delete
BEFORE DELETE ON public_issue_reports BEGIN
  SELECT RAISE(ABORT, 'issue reports are append-only');
END;
