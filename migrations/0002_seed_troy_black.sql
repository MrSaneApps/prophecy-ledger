INSERT OR IGNORE INTO people (
  person_id, slug, display_name, corpus_label, discovered_videos, reviewed_videos, created_at
) VALUES (
  'person_troy_black', 'troy-black', 'Troy Black',
  'Provisional pilot — selected records, not a complete catalogue', 2, 0,
  '2026-07-19T00:00:00.000Z'
);

INSERT OR IGNORE INTO sources (
  source_id, person_id, source_type, url, identity_status, source_role,
  availability, note, accessed_at
) VALUES
  (
    'source_troy_site', 'person_troy_black', 'website', 'https://troyblackvideos.com/',
    'candidate', 'first_party_candidate', 'available',
    'Appears to be a first-party site; identity still requires moderator confirmation.',
    '2026-07-19T00:00:00.000Z'
  ),
  (
    'source_troy_archive', 'person_troy_black', 'archive',
    'https://troyblackvideos.com/prophecy-archive-all/', 'candidate',
    'retrospective_fulfillment', 'available',
    'Speaker-authored retrospective archive; useful for discovery, not independent proof.',
    '2026-07-19T00:00:00.000Z'
  );

INSERT OR IGNORE INTO videos (
  video_id, person_id, youtube_id, canonical_url, shared_at, transcript_status,
  availability, created_at
) VALUES
  (
    'video_oil_2020', 'person_troy_black', 'ZidiIdg3U4M',
    'https://www.youtube.com/watch?v=ZidiIdg3U4M', '2020-09-10', 'missing',
    'unknown', '2026-07-19T00:00:00.000Z'
  ),
  (
    'video_russia_2021', 'person_troy_black', 'iyijrK-MvQo',
    'https://www.youtube.com/watch?v=iyijrK-MvQo', '2021-12-07', 'missing',
    'unknown', '2026-07-19T00:00:00.000Z'
  );

INSERT OR IGNORE INTO claims (
  claim_id, person_id, video_id, cluster_id, title, exact_quote, source_url,
  source_date, transcript_warning, statement_type, atomic_proposition, criteria,
  deadline, as_of_date, lifecycle_status, proposed_outcome, outcome_status,
  novelty_status, score_eligible, visibility, created_at
) VALUES
  (
    'southeast-asia-oil-2021', 'person_troy_black', 'video_oil_2020',
    'cluster_southeast_asia_oil_2021', 'Southeast Asia oil boom in 2021',
    'I heard this second phrase... It said, ''But there''s going to be an oil boom in Southeast Asia next year.''',
    'https://www.youtube.com/watch?v=ZidiIdg3U4M', '2020-09-10',
    'Original-video timestamp and full transcript context have not been verified.',
    'testable_prediction',
    'A material oil production or discovery boom would occur in Southeast Asia during calendar 2021.',
    'Material regional oil production or discovery growth, defined before adjudication using independent data.',
    '2021-12-31', '2026-07-19', 'deadline_passed_awaiting_review', NULL,
    'undetermined', 'not_assessed', 1, 'draft', '2026-07-19T00:00:00.000Z'
  ),
  (
    'russia-spring-2022', 'person_troy_black', 'video_russia_2021',
    'cluster_russia_spring_2022', 'Russia war statement for spring 2022',
    'I heard Russia is going to declare war in the springtime. And I heard in full shift by July.',
    'https://www.youtube.com/watch?v=iyijrK-MvQo', '2021-12-07',
    'Original-video timestamp and full transcript context are unverified; the phrase must be split into atomic propositions.',
    'testable_prediction',
    'Draft only: identify separate propositions for a declaration of war and the phrase “in full shift by July.”',
    'Criteria are not frozen until original context and the meaning of “full shift” are reviewed.',
    '2022-07-31', '2026-07-19', 'in_review', NULL, 'undetermined',
    'strong_signals', 0, 'draft', '2026-07-19T00:00:00.000Z'
  );

INSERT OR IGNORE INTO evidence (
  evidence_id, claim_id, evidence_role, url, title, published_at, accessed_at,
  source_role, note, cutoff_date, created_at
) VALUES
  (
    'evidence_oil_archive', 'southeast-asia-oil-2021', 'retrospective_fulfillment',
    'https://troyblackvideos.com/prophecy-archive-all/',
    'Troy Black prophecy archive', NULL, '2026-07-19T00:00:00.000Z',
    'speaker_authored',
    'Quotes the statement and says the stated 2021 timing was wrong. This is not independent outcome evidence.',
    '2020-09-10', '2026-07-19T00:00:00.000Z'
  ),
  (
    'evidence_russia_archive', 'russia-spring-2022', 'retrospective_fulfillment',
    'https://troyblackvideos.com/prophecy-archive-all/',
    'Troy Black prophecy archive', NULL, '2026-07-19T00:00:00.000Z',
    'speaker_authored',
    'Discovery source only. Independent outcome and prior-information evidence remain incomplete.',
    '2021-12-07', '2026-07-19T00:00:00.000Z'
  );

INSERT OR IGNORE INTO claim_events (
  event_id, claim_id, event_type, actor_id, detail_json, created_at
) VALUES
  (
    'event_oil_created', 'southeast-asia-oil-2021', 'created', 'seed',
    '{"state":"draft","provisional":true}', '2026-07-19T00:00:00.000Z'
  ),
  (
    'event_russia_created', 'russia-spring-2022', 'created', 'seed',
    '{"state":"draft","provisional":true}', '2026-07-19T00:00:00.000Z'
  );
