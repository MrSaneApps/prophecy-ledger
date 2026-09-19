PRAGMA foreign_keys = ON;

-- The preserved oil assignment belongs to Joshua's original reviewer principal.
-- Append the public attribution without rewriting immutable review history.
INSERT OR IGNORE INTO reviewer_public_attributions
  (attribution_id, reviewer_id, display_name, created_at)
SELECT 'reviewer_attribution_joshua_preserved_assignment_v1', reviewer_id, 'Joshua',
  '2026-08-16T01:35:00.000Z'
FROM review_assignments
WHERE assignment_id='assignment_07d1cfa8-2079-4e7a-b5be-10cba82c2e6e';
