PRAGMA foreign_keys = ON;

-- Migration 0066: amend the Haley outcome (false -> true).
-- The doc-lane verdict was always "a correct prediction"; rubric v1 had no
-- explicit rule for that phrasing and defaulted to Did not happen. Rubric v1.1
-- adds the rule. Nothing is rewritten: the original review, revision, and claim
-- row stay untouched; readers see the current outcome beside its history.
-- Joshua's private reviewer id is resolved inside the DB, never in source.
-- Without a Joshua attribution (tests), every statement is a zero-row no-op.

INSERT OR IGNORE INTO claim_decision_amendments (amendment_id,claim_id,amendment_number,supersedes_revision_id,reviewer_id,corrected_by,outcome_status,novelty_status,baseline_probability,rationale,created_at)
SELECT 'amendment_tb_2024_03_01','tb-2024-03-nikki-haley-s-loss',1,'revision_publication_3b8939fc850335e06980d4149a3a9ed7315e999c60cbacf293d400b4fcb623f5',(SELECT reviewer_id FROM reviewer_public_attributions WHERE display_name='Joshua' LIMIT 1),'site_owner','true','not_assessed',NULL,'Correction: the published doc-lane verdict states "This one lands as a correct prediction" (Haley lost the nomination as predicted; human predictability high). Doc-review rubric v1 mapped it Did not happen. Amended to Happened per rubric v1.1 explicit correct-prediction rule. Original review and revision preserved below.','2026-09-21T15:00:00.000Z'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

INSERT OR IGNORE INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
SELECT 'event_tb_2024_03_correction_01','tb-2024-03-nikki-haley-s-loss','correction','site_owner','{"amendmentNumber":1,"previousOutcome":"false","outcome":"true"}','2026-09-21T15:00:00.000Z'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');
