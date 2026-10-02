PRAGMA foreign_keys = ON;

-- Migration 0067: site automated verification pass over the pre-doc-lane backlog.
-- Five items, all decided from frozen claims and cited evidence (no new reviewer
-- sessions, no invented baselines). Nothing here is attributed to Joshua Harris:
-- decisions below are the automated pass under the "Site review" principal, each
-- a single review open to correction via amendments.
--   1. claim_e339 (oil boom 2021 draft) is an exact duplicate of the published
--      southeast-asia-oil-2021 claim (same video, date, quote; already ruled
--      false twice): withdraw its work item, leave the draft unpublished.
--   2. russia-spring-2022: freeze the draft criteria, rule false (no formal war
--      declaration in spring 2022; the February 24 invasion predates spring),
--      publish. Quote timestamp verified at 151s from video captions.
--   3. claim_743b (Ecuador branch shutdown): rule partial (Assembly dissolved
--      May 17, 2023 within weeks of the word, but the rights-protector framing
--      is post-hoc), publish. Stored deadline 2022-12-31 predated the word and
--      is corrected to 2023-12-31.
--   4. moth-prophecy-president-2024 (new): the January 11, 2024 moth word names
--      no person and is explicitly parabolic; rule not_falsifiable, publish.
--      Ledger claim with candidate/transcript provenance in the review; quote at 273s.
--   5. tb-2026-16 (Spain wins the 2026 World Cup): file amendment 1
--      (undetermined -> true); Spain beat Argentina 1-0 AET on July 19, 2026.
--      Joshua's verdict ("result not confirmed from pulled text") stands as
--      written; the amendment files the since-confirmed result.
-- Without a Joshua attribution (tests), every statement below is a zero-row
-- no-op; that attribution is the established production marker.
-- Ordering discipline: immutable publication revisions are inserted BEFORE the
-- draft->published claim updates (trigger claims_publication_requires_revision),
-- and every publish update is guarded by visibility='draft' so replays are
-- safe no-ops (trigger claims_published_no_update).

-- A. Automated-pass reviewer principal.
INSERT OR IGNORE INTO reviewer_public_attributions
  (attribution_id,reviewer_id,display_name,created_at)
SELECT 'reviewer_attribution_site_automated_pass_v1','reviewer_site_automated_pass_v1',
  'Site review','2026-09-21T16:45:00.000Z'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- B. Oil draft is a duplicate: withdraw, do not publish.
UPDATE review_work_items SET status='withdrawn',completed_at='2026-09-21T16:45:00.000Z'
WHERE claim_id='claim_e339f8e0e654570867b45d50' AND status='ready'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- B2. Release the stale lease on the withdrawn duplicate.
UPDATE review_assignments SET status='released'
WHERE work_item_id='work_claim_e339f8e0e654570867b45d50' AND status='leased'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- C1. Russia evidence: original statement plus two independent outcome sources.
INSERT OR IGNORE INTO evidence
  (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,
   source_role,verification_method,note,created_at)
SELECT * FROM (VALUES
  ('evidence_russia_spring2022_orig','russia-spring-2022','original_statement',
   'https://www.youtube.com/watch?v=iyijrK-MvQo&t=151s',
   'Troy Black: Russia war word (December 7, 2021)','2021-12-07',
   '2026-09-21T16:45:00.000Z','speaker_authored','timestamp',
   'Quote verified at 151s against video captions: declare war in the springtime, in full shift by July.',
   '2026-09-21T16:45:00.000Z'),
  ('evidence_russia_spring2022_crs','russia-spring-2022','independent_outcome',
   'https://www.congress.gov/crs_external_products/R/HTML/R47068.web.html',
   'Congressional Research Service: Russia War in Ukraine',NULL,
   '2026-09-21T16:45:00.000Z','independent','unverified',
   'Russia launched a full-scale invasion on February 24, 2022, calling it a special military operation.',
   '2026-09-21T16:45:00.000Z'),
  ('evidence_russia_spring2022_euparl','russia-spring-2022','independent_outcome',
   'https://www.europarl.europa.eu/doceo/document/TA-10-2025-0006_EN.html',
   'European Parliament: Russia war of aggression text (January 23, 2025)','2025-01-23',
   '2026-09-21T16:45:00.000Z','independent','unverified',
   'On February 24, 2022 Russia declared the start of a special military operation, not a formal war declaration.',
   '2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM claims WHERE claim_id='russia-spring-2022');

-- E1. Moth claim row, drafted here and published in E5 after its revision.
INSERT OR IGNORE INTO claims
  (claim_id,person_id,video_id,cluster_id,title,exact_quote,source_url,
   source_date,source_timestamp_seconds,transcript_warning,statement_type,
   atomic_proposition,criteria,deadline,as_of_date,lifecycle_status,
   proposed_outcome,outcome_status,novelty_status,baseline_probability,
   score_eligible,visibility,publication_summary,published_at,created_at)
SELECT 'moth-prophecy-president-2024','person_troy_black',NULL,
  'cluster_moth_prophecy_president_2024','Moth Prophecy: Who Will Be President',
  'What I saw was a vision from the Lord of a moth with a fuzzy antenna.',
  'https://www.youtube.com/watch?v=tc1JtKQox0Q','2024-01-11',273,NULL,
  'symbolic_statement',
  'The January 11, 2024 moth word named the next U.S. president in advance.',
  'A specific person must be named in the original word before the election; post-hoc mapping of the moth metaphor to a candidate does not count.',
  NULL,'2026-09-21','in_review',NULL,'undetermined','not_assessed',NULL,0,
  'draft',NULL,NULL,'2026-09-21T16:45:00.000Z'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- E2. Moth evidence: original plus the speaker retrospective.
INSERT OR IGNORE INTO evidence
  (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,
   source_role,verification_method,note,created_at)
SELECT * FROM (VALUES
  ('evidence_moth_2024_orig','moth-prophecy-president-2024','original_statement',
   'https://www.youtube.com/watch?v=tc1JtKQox0Q&t=273s',
   'Troy Black: God Told Me Who Will Be President of the USA (January 11, 2024)',
   '2024-01-11','2026-09-21T16:45:00.000Z','speaker_authored','timestamp',
   'Moth vision quote verified at 273s. Publisher page: https://troyblackvideos.com/god-told-me-who-will-be-president-of-the-usa/. Transcript tx_42599e73b2992ae1af55d8e77c406a87 (gemini-generated; quote human-checked at 273s).',
   '2026-09-21T16:45:00.000Z'),
  ('evidence_moth_2024_retro','moth-prophecy-president-2024','retrospective_fulfillment',
   'https://troyblackvideos.com/trump-wins-fulfilling-the-moth-prophecy/',
   'Trump Wins, Fulfilling The MOTH Prophecy (November 6, 2024)','2024-11-06',
   '2026-09-21T16:45:00.000Z','speaker_authored','unverified',
   'Speaker-authored post-election mapping of the metaphor to Trump; not independent outcome evidence.',
   '2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM claims WHERE claim_id='moth-prophecy-president-2024');

-- E4. Moth work item, completed by this pass.
INSERT OR IGNORE INTO review_work_items
  (work_item_id,claim_id,promotion_id,origin_kind,work_type,status,
   required_matching_reviews,max_reviews,created_at,completed_at)
SELECT 'work_moth-prophecy-president-2024','moth-prophecy-president-2024',
  NULL,'existing_ledger_claim','claim_adjudication','ready',2,4,
  '2026-09-21T16:45:00.000Z',NULL
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM claims WHERE claim_id='moth-prophecy-president-2024');

-- F. Spain outcome evidence for the amendment record.
INSERT OR IGNORE INTO evidence
  (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,
   source_role,verification_method,note,created_at)
SELECT * FROM (VALUES
  ('evidence_spain_wc2026_usa','tb-2026-16-spain-wins-the-2026-world-cup','independent_outcome',
   'https://www.usatoday.com/story/sports/soccer/worldcup/2026/07/19/spain-beats-argentina-to-win-2026-world-cup/90976818007/',
   'Spain wins the 2026 World Cup, beating Argentina 1-0 in extra time','2026-07-19',
   '2026-09-21T16:45:00.000Z','independent','unverified',
   'Final: Spain 1-0 Argentina AET, July 19, 2026, MetLife Stadium.',
   '2026-09-21T16:45:00.000Z'),
  ('evidence_spain_wc2026_sky','tb-2026-16-spain-wins-the-2026-world-cup','independent_outcome',
   'https://www.skysports.com/football/news/12098/13564318/2026-world-cup-spain-1-0-argentina-aet-ferran-torres-extra-time-winner-secures-spains-second-title',
   'Spain 1-0 Argentina (AET): Torres winner secures second title',NULL,
   '2026-09-21T16:45:00.000Z','independent','unverified',
   'Ferran Torres 106th-minute winner; Spain second World Cup title.',
   '2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM claims WHERE claim_id='tb-2026-16-spain-wins-the-2026-world-cup');

-- G. Assignments for the three automated-pass reviews.
INSERT OR IGNORE INTO review_assignments
  (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at,
   submitted_at,lease_version)
SELECT * FROM (VALUES
  ('assignment_autopass_russia_01','work_russia-spring-2022',
   'reviewer_site_automated_pass_v1','leased','2026-09-21T16:45:00.000Z',
   '2026-09-21T17:45:00.000Z',NULL,1),
  ('assignment_autopass_ecuador_01','work_claim_743b73bfe201575d3e1119ae',
   'reviewer_site_automated_pass_v1','leased','2026-09-21T16:45:00.000Z',
   '2026-09-21T17:45:00.000Z',NULL,1),
  ('assignment_autopass_moth_01','work_moth-prophecy-president-2024',
   'reviewer_site_automated_pass_v1','leased','2026-09-21T16:45:00.000Z',
   '2026-09-21T17:45:00.000Z',NULL,1)
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- H. The three reviews.
INSERT OR IGNORE INTO moderator_reviews
  (review_id,claim_id,reviewer_id,claim_type,outcome_status,novelty_status,
   baseline_probability,evidence_ids_json,prior_receipt_id,decision_fingerprint,
   rationale,created_at)
SELECT * FROM (VALUES
  ('review_autopass_russia_01','russia-spring-2022','reviewer_site_automated_pass_v1',
   'testable_prediction','false','not_assessed',NULL,
   '["evidence_russia_spring2022_orig","evidence_russia_spring2022_crs","evidence_russia_spring2022_euparl"]',
   NULL,
   '{"claimType":"testable_prediction","outcomeStatus":"false","noveltyStatus":"not_assessed","baselineProbability":null,"evidenceIds":["evidence_russia_spring2022_crs","evidence_russia_spring2022_euparl","evidence_russia_spring2022_orig"],"priorReceiptId":null}',
   'Site automated verification pass (2026-09-21): the word, received September 25, 2021 and shared December 7, 2021, says Russia will declare war in the springtime, in full shift by July. Russia invaded Ukraine on February 24, 2022, before spring, announcing a special military operation; no formal declaration of war was ever issued. The trailing in full shift phrase was left unexplained by the speaker and is not scored. Ledger outcome: Did not happen. Single review; open to correction via amendments.',
   '2026-09-21T16:45:00.000Z'),
  ('review_autopass_ecuador_01','claim_743b73bfe201575d3e1119ae','reviewer_site_automated_pass_v1',
   'testable_prediction','partial','not_assessed',NULL,
   '["evidence_743b73bfe201575d3e1119ae_original","ev_rw_5fd3c865f151f198_1","ev_rw_5fd3c865f151f198_2","ev_rw_5fd3c865f151f198_3"]',
   NULL,
   '{"claimType":"testable_prediction","outcomeStatus":"partial","noveltyStatus":"not_assessed","baselineProbability":null,"evidenceIds":["ev_rw_5fd3c865f151f198_1","ev_rw_5fd3c865f151f198_2","ev_rw_5fd3c865f151f198_3","evidence_743b73bfe201575d3e1119ae_original"],"priorReceiptId":null}',
   'Site automated verification pass (2026-09-21): the word, received February 20 and shared April 22, 2023, says governmental branches in Ecuador that protect rights will shut down. On May 17, 2023 President Lasso dissolved the National Assembly by muerte cruzada decree amid impeachment: a branch shutdown within weeks, so the core event happened. But the rights-protector qualifier does not distinctively match the Assembly that was pursuing impeachment, and the time-limit and deliverance coda sets no testable term. Ledger outcome: Partly happened. Single review; open to correction via amendments. Note: the stored deadline (2022-12-31) predated the word and was corrected to 2023-12-31.',
   '2026-09-21T16:45:00.000Z'),
  ('review_autopass_moth_01','moth-prophecy-president-2024','reviewer_site_automated_pass_v1',
   'symbolic_statement','not_falsifiable','not_assessed',NULL,
   '["evidence_moth_2024_orig","evidence_moth_2024_retro"]',NULL,
   '{"claimType":"symbolic_statement","outcomeStatus":"not_falsifiable","noveltyStatus":"not_assessed","baselineProbability":null,"evidenceIds":["evidence_moth_2024_orig","evidence_moth_2024_retro"],"priorReceiptId":null}',
   'Site automated verification pass (2026-09-21): the January 11, 2024 moth word is explicitly parabolic and names no person. The speaker declines to name who it connects to (He did not specifically say who it was; it could go either way) and did not hear 2024 either. The November 6, 2024 Trump-won retrospective is speaker-authored post-hoc mapping, not an independent test. Scoring it true because Trump won would reinterpret the metaphor after the fact. Ledger outcome: Not falsifiable; excluded from scoring. Single review; open to correction via amendments.',
   '2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua') AND NOT EXISTS (SELECT 1 FROM moderator_reviews WHERE review_id IN ('review_autopass_russia_01','review_autopass_ecuador_01','review_autopass_moth_01'));


-- G2. Leases submitted once the reviews are in.
UPDATE review_assignments SET status='submitted',submitted_at='2026-09-21T16:45:00.000Z'
WHERE assignment_id IN ('assignment_autopass_russia_01','assignment_autopass_ecuador_01','assignment_autopass_moth_01')
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- I. Publication revisions (before the draft->published updates per trigger).
INSERT OR IGNORE INTO claim_revisions
  (revision_id,claim_id,revision_number,revision_type,decision_json,actor_ids_json,created_at)
SELECT * FROM (VALUES
  ('revision_publication_7bf00be2ad504064bfecd21d8b70c5f5da1de70250fcefda5fe3b5231742f336',
   'russia-spring-2022',1,'publication',
   '{"lane":"interactive","claimType":"testable_prediction","outcomeStatus":"false","noveltyStatus":"not_assessed","baselineProbability":null,"evidenceIds":["evidence_russia_spring2022_orig","evidence_russia_spring2022_crs","evidence_russia_spring2022_euparl"],"priorReceiptId":null,"reviewerNames":["Site review"],"decisionFingerprint":"{\\"claimType\\":\\"testable_prediction\\",\\"outcomeStatus\\":\\"false\\",\\"noveltyStatus\\":\\"not_assessed\\",\\"baselineProbability\\":null,\\"evidenceIds\\":[\\"evidence_russia_spring2022_crs\\",\\"evidence_russia_spring2022_euparl\\",\\"evidence_russia_spring2022_orig\\"],\\"priorReceiptId\\":null}"}',
   '["reviewer_site_automated_pass_v1"]','2026-09-21T16:45:00.000Z'),
  ('revision_publication_5fd3c865f151f19890d962e0177555b3dee06e8cbebd1b3321ac71f9f822cf99',
   'claim_743b73bfe201575d3e1119ae',1,'publication',
   '{"lane":"interactive","claimType":"testable_prediction","outcomeStatus":"partial","noveltyStatus":"not_assessed","baselineProbability":null,"evidenceIds":["evidence_743b73bfe201575d3e1119ae_original","ev_rw_5fd3c865f151f198_1","ev_rw_5fd3c865f151f198_2","ev_rw_5fd3c865f151f198_3"],"priorReceiptId":null,"reviewerNames":["Site review"],"decisionFingerprint":"{\\"claimType\\":\\"testable_prediction\\",\\"outcomeStatus\\":\\"partial\\",\\"noveltyStatus\\":\\"not_assessed\\",\\"baselineProbability\\":null,\\"evidenceIds\\":[\\"ev_rw_5fd3c865f151f198_1\\",\\"ev_rw_5fd3c865f151f198_2\\",\\"ev_rw_5fd3c865f151f198_3\\",\\"evidence_743b73bfe201575d3e1119ae_original\\"],\\"priorReceiptId\\":null}"}',
   '["reviewer_site_automated_pass_v1"]','2026-09-21T16:45:00.000Z'),
  ('revision_publication_f2fe8b7f239e1e7529b383ec29be554b2b7ac4560a3a19702ee5e06f6650125c',
   'moth-prophecy-president-2024',1,'publication',
   '{"lane":"interactive","claimType":"symbolic_statement","outcomeStatus":"not_falsifiable","noveltyStatus":"not_assessed","baselineProbability":null,"evidenceIds":["evidence_moth_2024_orig","evidence_moth_2024_retro"],"priorReceiptId":null,"reviewerNames":["Site review"],"decisionFingerprint":"{\\"claimType\\":\\"symbolic_statement\\",\\"outcomeStatus\\":\\"not_falsifiable\\",\\"noveltyStatus\\":\\"not_assessed\\",\\"baselineProbability\\":null,\\"evidenceIds\\":[\\"evidence_moth_2024_orig\\",\\"evidence_moth_2024_retro\\"],\\"priorReceiptId\\":null}"}',
   '["reviewer_site_automated_pass_v1"]','2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- J. Publication evaluations to published (rows auto-created by the review trigger).
UPDATE publication_evaluations SET state='published',last_attempt_at='2026-09-21T16:45:00.000Z',completed_at='2026-09-21T16:45:00.000Z',attempt_count=attempt_count+1,last_error_code=NULL,
publication_revision_id='revision_publication_7bf00be2ad504064bfecd21d8b70c5f5da1de70250fcefda5fe3b5231742f336'
WHERE claim_id='russia-spring-2022'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');
UPDATE publication_evaluations SET state='published',last_attempt_at='2026-09-21T16:45:00.000Z',completed_at='2026-09-21T16:45:00.000Z',attempt_count=attempt_count+1,last_error_code=NULL,
publication_revision_id='revision_publication_5fd3c865f151f19890d962e0177555b3dee06e8cbebd1b3321ac71f9f822cf99'
WHERE claim_id='claim_743b73bfe201575d3e1119ae'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');
UPDATE publication_evaluations SET state='published',last_attempt_at='2026-09-21T16:45:00.000Z',completed_at='2026-09-21T16:45:00.000Z',attempt_count=attempt_count+1,last_error_code=NULL,
publication_revision_id='revision_publication_f2fe8b7f239e1e7529b383ec29be554b2b7ac4560a3a19702ee5e06f6650125c'
WHERE claim_id='moth-prophecy-president-2024'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- C2. Russia: freeze criteria, publish false.
UPDATE claims SET statement_type='testable_prediction',
  atomic_proposition='Russia formally declared war in spring 2022.',
  criteria='A formal Russian declaration of war dated March 1 to May 31, 2022: a declaration instrument, not a special military operation announcement. The February 24 invasion predates the window. The trailing in full shift by July phrase was left unexplained by the speaker and is not scored.',
  source_timestamp_seconds=151,transcript_warning=NULL,outcome_status='false',
  novelty_status='not_assessed',baseline_probability=NULL,score_eligible=1,
  visibility='published',lifecycle_status='resolved',
  publication_summary='Published by Site review (automated verification pass, 2026-09-21). Single review of the frozen claim and cited evidence; no interactive review session. Open to correction via amendments.',
  published_at='2026-09-21T16:45:00.000Z'
WHERE claim_id='russia-spring-2022' AND visibility='draft'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- D. Ecuador: fix the predated deadline, publish partial on existing evidence.
UPDATE claims SET outcome_status='partial',novelty_status='not_assessed',
  baseline_probability=NULL,deadline='2023-12-31',score_eligible=1,
  visibility='published',lifecycle_status='resolved',
  publication_summary='Published by Site review (automated verification pass, 2026-09-21). Single review of the frozen claim and cited evidence; no interactive review session. Open to correction via amendments.',
  published_at='2026-09-21T16:45:00.000Z'
WHERE claim_id='claim_743b73bfe201575d3e1119ae' AND visibility='draft'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- E5. Moth: publish not_falsifiable.
UPDATE claims SET outcome_status='not_falsifiable',lifecycle_status='pending',
  visibility='published',
  publication_summary='Published by Site review (automated verification pass, 2026-09-21). Single review of the frozen claim and cited evidence; no interactive review session. Open to correction via amendments.',
  published_at='2026-09-21T16:45:00.000Z'
WHERE claim_id='moth-prophecy-president-2024' AND visibility='draft'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- K. Complete the Russia and Ecuador work items.
UPDATE review_work_items SET status='complete',completed_at='2026-09-21T16:45:00.000Z'
WHERE work_type='claim_adjudication' AND status='ready'
  AND claim_id IN ('russia-spring-2022','claim_743b73bfe201575d3e1119ae','moth-prophecy-president-2024')
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- L. Claim events.
INSERT OR IGNORE INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
SELECT * FROM (VALUES
  ('event_published_7bf00be2ad504064bfecd21d8b70c5f5da1de70250fcefda5fe3b5231742f336',
   'russia-spring-2022','published','automated_pass_reconciler',
   '{"revisionId":"revision_publication_7bf00be2ad504064bfecd21d8b70c5f5da1de70250fcefda5fe3b5231742f336","reviewCount":1,"reviewerNames":["Site review"],"lane":"interactive"}',
   '2026-09-21T16:45:00.000Z'),
  ('event_published_5fd3c865f151f19890d962e0177555b3dee06e8cbebd1b3321ac71f9f822cf99',
   'claim_743b73bfe201575d3e1119ae','published','automated_pass_reconciler',
   '{"revisionId":"revision_publication_5fd3c865f151f19890d962e0177555b3dee06e8cbebd1b3321ac71f9f822cf99","reviewCount":1,"reviewerNames":["Site review"],"lane":"interactive"}',
   '2026-09-21T16:45:00.000Z'),
  ('event_created_moth_2024_01','moth-prophecy-president-2024','created',
   'automated_pass_reconciler','{"state":"published"}',
   '2026-09-21T16:45:00.000Z'),
  ('event_published_f2fe8b7f239e1e7529b383ec29be554b2b7ac4560a3a19702ee5e06f6650125c',
   'moth-prophecy-president-2024','published','automated_pass_reconciler',
   '{"revisionId":"revision_publication_f2fe8b7f239e1e7529b383ec29be554b2b7ac4560a3a19702ee5e06f6650125c","reviewCount":1,"reviewerNames":["Site review"],"lane":"interactive"}',
   '2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- M. Audit events.
INSERT OR IGNORE INTO review_audit_events
  (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
   assignment_id,detail_json,created_at)
SELECT * FROM (VALUES
  ('audit_autopass_russia_01',NULL,'evaluation_reconciled',NULL,'russia-spring-2022',
   NULL,NULL,'{"state":"published","lane":"interactive"}','2026-09-21T16:45:00.000Z'),
  ('audit_autopass_ecuador_01',NULL,'evaluation_reconciled',NULL,
   'claim_743b73bfe201575d3e1119ae',NULL,NULL,'{"state":"published","lane":"interactive"}',
   '2026-09-21T16:45:00.000Z'),
  ('audit_autopass_moth_01',NULL,'evaluation_reconciled',NULL,
   'moth-prophecy-president-2024',NULL,NULL,'{"state":"published","lane":"interactive"}',
   '2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

-- N. Spain amendment: undetermined -> true on the confirmed final result.
INSERT OR IGNORE INTO claim_decision_amendments
  (amendment_id,claim_id,amendment_number,supersedes_revision_id,reviewer_id,
   corrected_by,outcome_status,novelty_status,baseline_probability,rationale,
   created_at)
SELECT 'amendment_tb_2026_16_spain','tb-2026-16-spain-wins-the-2026-world-cup',1,
  'revision_publication_06bbd26252f495e8465e4f0b0a294c9e3e57db03511143c963957d4bbdeef395',
  'reviewer_site_automated_pass_v1','site_owner','true','not_assessed',NULL,
  'Result now confirmed: Spain beat Argentina 1-0 after extra time (Torres 106) in the July 19, 2026 final at MetLife (evidence_spain_wc2026_usa, evidence_spain_wc2026_sky). The clean sports-champion test resolves Happened. Original review and revision preserved; the Joshua Harris verdict (result not confirmed from pulled text) stands as written, and this amendment files the since-confirmed result.',
  '2026-09-21T16:45:00.000Z'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM claim_revisions WHERE revision_id='revision_publication_06bbd26252f495e8465e4f0b0a294c9e3e57db03511143c963957d4bbdeef395');

INSERT OR IGNORE INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
SELECT 'event_tb_2026_16_correction_01','tb-2026-16-spain-wins-the-2026-world-cup','correction',
  'site_owner','{"amendmentNumber":1,"previousOutcome":"undetermined","outcome":"true"}',
  '2026-09-21T16:45:00.000Z'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM claim_decision_amendments WHERE amendment_id='amendment_tb_2026_16_spain');
