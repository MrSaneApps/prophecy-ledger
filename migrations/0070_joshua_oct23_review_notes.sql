PRAGMA foreign_keys = ON;

-- Migration 0070: add Joshua Harris's October 23, 2026 review beside the record.
-- Additive only. No claim, review, revision, amendment, outcome or score row is
-- changed. The September review and every existing decision stay exactly as
-- published; the October review is shown as a labelled note next to them.
--   * reviewer_notes: append-only public notes (per-claim assessments, date
--     corrections checked against the public YouTube upload date, and one
--     person-level overall view), all attributed to the reviewer by name.
--   * draft_review_entries: entries from the October review that are not in the
--     Ledger yet. They have no exact quotation, so they are saved as drafts and
--     are never read by any public projection.
-- Joshua's private reviewer id is resolved inside the DB, never in source.
-- Without a Joshua attribution (tests), every insert is a zero-row no-op.

CREATE TABLE IF NOT EXISTS reviewer_notes (
  note_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  claim_id TEXT REFERENCES claims(claim_id),
  note_kind TEXT NOT NULL CHECK (note_kind IN ('assessment','date_correction','overall_view')),
  reviewer_id TEXT NOT NULL,
  review_label TEXT NOT NULL CHECK (length(trim(review_label)) > 0),
  rating_label TEXT,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  previous_date TEXT,
  corrected_date TEXT,
  verification_url TEXT,
  created_at TEXT NOT NULL,
  CHECK ((note_kind = 'overall_view' AND claim_id IS NULL)
      OR (note_kind <> 'overall_view' AND claim_id IS NOT NULL)),
  CHECK (note_kind <> 'date_correction'
      OR (previous_date IS NOT NULL AND corrected_date IS NOT NULL AND verification_url IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS reviewer_notes_unique
  ON reviewer_notes(person_id, COALESCE(claim_id, ''), note_kind, review_label);
CREATE INDEX IF NOT EXISTS reviewer_notes_claim ON reviewer_notes(claim_id, note_kind);

CREATE TRIGGER IF NOT EXISTS reviewer_notes_no_update
BEFORE UPDATE ON reviewer_notes
BEGIN SELECT RAISE(ABORT, 'reviewer notes are append-only'); END;

CREATE TRIGGER IF NOT EXISTS reviewer_notes_no_delete
BEFORE DELETE ON reviewer_notes
BEGIN SELECT RAISE(ABORT, 'reviewer notes are append-only'); END;

CREATE TABLE IF NOT EXISTS draft_review_entries (
  draft_entry_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  video_url TEXT NOT NULL,
  reported_date TEXT NOT NULL,
  youtube_upload_date TEXT,
  date_check TEXT NOT NULL CHECK (date_check IN ('matches_youtube','video_not_available')),
  reviewer_id TEXT NOT NULL,
  review_label TEXT NOT NULL,
  rating_label TEXT NOT NULL,
  body TEXT NOT NULL,
  draft_status TEXT NOT NULL CHECK (draft_status = 'draft_needs_exact_quote'),
  created_at TEXT NOT NULL,
  UNIQUE (person_id, video_url, title, review_label)
);

CREATE TRIGGER IF NOT EXISTS draft_review_entries_no_update
BEFORE UPDATE ON draft_review_entries
BEGIN SELECT RAISE(ABORT, 'draft review entries are append-only'); END;

CREATE TRIGGER IF NOT EXISTS draft_review_entries_no_delete
BEFORE DELETE ON draft_review_entries
BEGIN SELECT RAISE(ABORT, 'draft review entries are append-only'); END;


-- Per-claim assessments: 148 claims of the 152 entries in the October review
-- matched an existing live claim. Wording is plain-language and attributed.
WITH n(claim_id,rating_label,body) AS (VALUES
  ('tb-2020-22-01-abortion-and-the-2020-election','Weak','The word named an election issue that was already well known. The Supreme Court vacancy and the Roe decision were linked to it after the event.'),
  ('tb-2020-22-02-russian-oil-price-spike','Moderate','The country and the month matched a real price movement, in a market that was already very volatile.'),
  ('southeast-asia-oil-2021','Did not hold up','The word said the boom would come "next year", and that did not happen. The entry was kept and later articles were used, so the timing was moved later.'),
  ('tb-2020-22-04-egypt-and-ethiopia-water-war','Weak','An ongoing public dispute was counted as the fulfillment.'),
  ('tb-2020-22-05-january-6th-big-tech-censorship-and','Did not hold up','Later U.S. events were linked to a word about Venezuela. Several unrelated events were combined, and the details were added after the event.'),
  ('tb-2020-22-06-tanzanian-president-s-big-lie','Weak to moderate','A death did occur. Calling it a "big lie" is an interpretation.'),
  ('tb-2020-22-07-meltdown-in-spain','Weak','This kind of event happens often, and it was counted as the fulfillment.'),
  ('tb-2020-22-08-floods-in-australia','Weak to moderate','Flooding did occur. Australia has a high chance of flooding in any year.'),
  ('tb-2020-22-09-alaska-earthquake-and-traffic-mistake','Did not hold up','The word said storm, and an earthquake was counted instead.'),
  ('tb-2020-22-10-lesotho-political-crisis','Moderate','The country and a short window matched a movement the next day, in a system where such movements are common. Joshua calls this one of the stronger early entries.'),
  ('tb-2020-22-11-prediction-of-scientific-discovery','Weak','The category was broad, and a specific discovery was linked to it after the fact.'),
  ('tb-2020-22-12-vision-of-the-statue-of-liberty','Weak to moderate','The symbol matched in a loose way. A small replica of the Statue of Liberty was counted.'),
  ('tb-2020-22-13-russian-invasion-of-ukraine','Moderate','The country and the season matched, but the specific action in the word did not. Public warnings about this already existed. Joshua calls it incomplete.'),
  ('tb-2020-22-14-israel-hamas-war','Did not hold up','The word came in 2021 and was tied to events in October 2023, so the timing was stretched over several years. Joshua calls it only partly matched.'),
  ('tb-2020-22-15-baseball-and-covid-19','Weak','Broad wording was later linked to streaming and to later COVID commentary, and the match was stretched.'),
  ('tb-2020-22-16-monkeypox-outbreak','Weak to moderate','Broad wording about a plague was later linked to monkeypox.'),
  ('tb-2020-22-17-england-s-king','Weak','The change was already widely expected when it was said, because the monarch was elderly. The crown imagery did match the funeral.'),
  ('tb-2020-22-18-sign-of-war-in-january-2022','Weak','The unrest matched public reports that were already circulating, so it was already widely expected when it was said.'),
  ('tb-2020-22-19-attack-on-new-york-city-police','Weak','The attacks did occur, but the context was already public.'),
  ('tb-2020-22-20-government-branch-shutdown-in-ecuador','Weak to moderate','The dissolution happened more than a year later, so the timing was moved later.'),
  ('tb-2020-22-21-lawfare-banana-republic','Weak','Broad political wording was later linked to a raid and to other later events.'),
  ('tb-2020-22-22-ai-released-to-the-public-spring','Weak to moderate','Early public AI releases did occur. The exact spring window was only approximate.'),
  ('tb-2020-22-23-gamestop-s-second-stock-burst','Moderate','A short-term price spike occurred the same day or the next day, in a stock that moves sharply often.'),
  ('tb-2020-22-24-disney-s-downfall','Weak','Political conflict and business pressures followed, but that context was already public.'),
  ('tb-2020-22-25-mount-rushmore-cancelled','Did not hold up','A social media post was counted as a cancellation, so the word was reread to fit.'),
  ('tb-2020-22-26-trump-s-war-on-cartels','Weak','The designation happened years later, so the timing was moved later.'),
  ('tb-2020-22-27-biden-family-scheme-exposed-on-flag','Weak','A document release occurred near Flag Day, within an ongoing investigation that was already public.'),
  ('tb-2020-22-28-hunter-biden-laptop-comes-to-nothing','Weak','The political outcome was described as "nothing", but convictions did occur.'),
  ('tb-2020-22-29-market-crash','Weak','Ordinary market declines were linked to the word.'),
  ('tb-2020-22-30-queen-elizabeth-s-passing-foretold','Weak','This was already widely expected when it was said, because the monarch was elderly.'),
  ('tb-2020-22-31-ukraine-mineral-deal','Weak','Negotiations occurred years later, so the timing was moved later.'),
  ('tb-2020-22-32-surprise-volcano-eruption-in-south-east','Weak','Eruptions occurred in a region where eruptions are common.'),
  ('tb-2020-22-33-israel-palestine-volcano','Weak','A long-running conflict was later linked to the October 7 attack, and the timing was moved later.'),
  ('tb-2023-01-gateway-church-scandal','Weak','A later public controversy involving the church was linked to broad wording.'),
  ('tb-2023-02-ufo-crash-in-nevada','Weak to moderate','An unexplained report was counted as the fulfillment.'),
  ('tb-2023-03-president-reagan-and-the-2024-election','Weak','Ordinary political talk was counted as the fulfillment.'),
  ('tb-2023-04-france-fire-and-government-collapse','Weak to moderate','Riots did occur. The government collapse in the word was stretched, and the timing was moved later.'),
  ('tb-2023-05-russian-spaceship-crash-luna-25','Moderate','A spacecraft crash involving the named country did occur.'),
  ('tb-2023-06-elon-musk-car-industry-disruption','Weak','A strike against companies other than Tesla was linked to wording about Musk.'),
  ('tb-2023-07-elon-musk-tech-development','Weak','Ordinary technical announcements were linked to the word.'),
  ('tb-2023-08-the-british-museum-robbery','Moderate','The named institution matched a real scandal.'),
  ('tb-2023-09-u-s-gun-restrictions','Weak','Ongoing political activity was counted as the fulfillment.'),
  ('tb-2023-10-russian-pilots-defecting','Did not hold up','Defections were linked to broader wording, and details were added after the event.'),
  ('tb-2023-11-rocket-attack-on-israel-october-7','Weak to moderate','A major attack did occur, on a scale larger than the usual rocket exchanges.'),
  ('tb-2023-12-giant-sighting','Did not hold up','Unverified social media claims were counted as the fulfillment. Joshua marks this as not fulfilled.'),
  ('tb-2023-13-southern-winter-fires','Weak to moderate','A large winter fire occurred. The region has fires often.'),
  ('tb-2023-14-sunken-ship-discovery','Moderate','The named region and the age of the find matched.'),
  ('tb-2023-15-swing-states','Weak','The election result matched broad political wording.'),
  ('tb-2023-16-florida-revival','Weak','A local baptism event was linked to the word.'),
  ('tb-2023-17-bluegrass-legend-s-death','Weak to moderate','The named category and a short window matched, but the person''s health condition was already known.'),
  ('tb-2023-18-speaker-of-the-house-drama','Weak','A resignation occurred near Christmas.'),
  ('tb-2023-19-christmas-massacre','Weak to moderate','Attacks occurred during the Christmas period.'),
  ('tb-2023-20-cheese-contamination','Moderate','The specific product category matched a real outbreak.'),
  ('tb-2024-01-california-farming-problems','Weak','Flooding occurred in a region where flooding is common.'),
  ('moth-prophecy-president-2024','Weak','Joshua''s October 23 review lists this word as entry 2024-2 and reads it as language about a Trump win. In his view this was already widely expected in January 2024, because Trump was the clear frontrunner. This note sits beside the Ledger''s own reading of the word, which has not changed.'),
  ('tb-2024-03-nikki-haley-s-loss','Weak','Haley''s loss was already widely expected by the date of the video.'),
  ('tb-2024-04-oklahoma-earthquake-from-january-31st-2024','Moderate','The state and a short window matched a real event, in a place where such events are more likely.'),
  ('tb-2024-05-trump-stock','Weak','A merger path that was already known was linked to the word.'),
  ('tb-2024-06-5-day-reversal-january-6th-lies','Weak to moderate','A document release matched a short window, within a political setting that was already public.'),
  ('tb-2024-07-the-death-of-a-wrestling-legend','Weak to moderate','The named category matched, over a long time span, so the timing was moved later.'),
  ('tb-2024-08-ihopkc-closing-and-cover-up','Weak to moderate','The organization matched, and the controversy around it was already known at the time.'),
  ('tb-2024-09-10-day-prophecy-election-interference','Weak to moderate','A court action on the same day matched a short window.'),
  ('tb-2024-10-arctic-circle-discovery','Weak','A scientific explanation of an earlier event was linked to the word.'),
  ('tb-2024-11-closing-chocolate-factory-and-taiwan-earthquake','Moderate','The word had two parts, and each matched within a short window.'),
  ('tb-2024-12-dam-breaks-corruption-exposed-two-week','Weak to moderate','A dam event within a short window matched.'),
  ('tb-2024-13-rosie-the-riveter-ultra-feminism-and','Weak','A political outcome and a ceremonial award were linked to the word.'),
  ('tb-2024-14-obama-the-puppet-master-and-biden','Weak','The political outcome was already widely expected.'),
  ('tb-2024-15-italy-s-ten-day-prophecy','Weak to moderate','Protests within a short window matched.'),
  ('tb-2024-16-marco-rubio-gets-promoted','Weak to moderate','The named person matched a later appointment, but the timing was moved later.'),
  ('tb-2024-17-nations-shaking-july-august-2024','Weak','A broad window was linked to several different events.'),
  ('tb-2024-18-trump-s-felony-conviction','Weak','A conviction within a short window matched an ongoing trial, so it was already widely expected when it was said.'),
  ('tb-2024-19-tucson-fire-and-trump-assassination-connection','Weak','Unrelated events were linked only by timing, and details were added after the event.'),
  ('claim_70ba20387fca8f2f4e34f3e0','Weak to moderate','A specific defensive measure matched within a short window.'),
  ('tb-2024-22-biden-s-battle-to-stay-in','Weak','The political outcome was already widely expected after a scheduled debate.'),
  ('tb-2024-23-turkey-and-u-s-corruption-june','Weak to moderate','The named country and the corruption wording matched.'),
  ('tb-2024-24-trump-assassination-attempt-july-2024-prophecy','Moderate','The named person and a short window matched.'),
  ('tb-2024-25-biden-s-debate-failure-troy-black','Weak','Public concerns already existed and the debate was the next day, so this was already widely expected when it was said.'),
  ('tb-2024-26-second-assassination-attempt-against-trump-and','Weak to moderate','The named person and a later attempt matched. Many people already expected the election outcome.'),
  ('tb-2024-27-mark-cuban-s-mistake-july-29','Weak','A later trade was linked to an earlier sale, and the timing was moved later.'),
  ('tb-2024-28-one-violent-night-august-7-2024','Weak to moderate','Events within a short window matched.'),
  ('tb-2024-29-voice-of-star-wars-august-12','Moderate','The named category and a short window matched.'),
  ('tb-2024-33-kamala-harris-two-weeks-september-9','Weak','Ordinary campaign activity was linked to the word.'),
  ('tb-2024-34-rioter-setting-fire-to-himself-september','Moderate','The specific act matched a real incident.'),
  ('tb-2024-35-three-important-dates-israel-s-conflicts','Weak to moderate','The pager attack matched within a short window.'),
  ('tb-2024-36-daystar-drama-september-27-2024','Weak to moderate','The named organization matched a later controversy.'),
  ('tb-2024-37-major-dinosaur-fossil-discovery-october-4','Weak','A scientific finding was linked to the word, and the timing was moved later.'),
  ('tb-2024-38-border-wall-construction-october-16-2024','Weak','This was the expected result of the election, so it was already widely expected when it was said.'),
  ('tb-2024-39-witches-can-t-curse-trump-october','Did not hold up','A forum post that already existed was counted, so details were added after the event.'),
  ('tb-2024-40-political-bomb-war-november-16-2024','Weak','Several later events were linked to the word, and the match was stretched.'),
  ('tb-2024-41-tulsi-gabbard-november-20-2024','Weak to moderate','The named person matched a later appointment.'),
  ('tb-2024-42-laser-weapon-technology-november-11th-2024','Weak','Ongoing technology development was linked to the word.'),
  ('tb-2024-43-disney-christmas-2024-november-25-2024','Weak to moderate','Corporate events within a short window matched.'),
  ('tb-2024-44-both-real-and-political-earthquakes-november','Weak to moderate','The named month matched a real earthquake.'),
  ('tb-2024-45-football-field-brawls-november-28-2024','Weak to moderate','Matches within short windows.'),
  ('tb-2024-46-china-wants-war-december-4-2024','Weak','Ongoing tension between countries was linked to the word.'),
  ('tb-2024-47-biden-s-christmas-commutations-december-11','Moderate','The specific timing and action matched.'),
  ('tb-2024-48-la-fires-prophesied-2025-december-28','Weak','This kind of event happens often in that place.'),
  ('tb-2024-49-china-hacks-u-s-treasury-and','Weak to moderate','A report on the same day matched.'),
  ('tb-2025-01-u-k-and-u-s-february','Weak','Broad political activity was linked to the word.'),
  ('tb-2025-02-year-and-a-half-malaysia-prophecy','Weak','Regional events were linked to a broad window, and the match was stretched.'),
  ('tb-2025-03-two-tech-companies-combining','Moderate','The named type of event matched.'),
  ('tb-2025-04-sesame-street','Weak to moderate','The specific program matched a news story.'),
  ('tb-2025-05-one-week-prophecy-government-rats-exposed','Weak to moderate','Firings within a short window matched.'),
  ('tb-2025-06-myanmar-earthquake-march-may-2025-prophecy','Moderate','The named country and the window matched a major earthquake.'),
  ('tb-2025-07-2020-election-raked-back-up-april','Weak','A political action within a short window matched.'),
  ('tb-2025-08-another-attempt-on-trump','Weak to moderate','The arrest in a plot within a short window matched.'),
  ('tb-2025-09-may-2025-word-conspiracy-uncovered-in','Weak to moderate','The named month matched official reports.'),
  ('tb-2025-10-10-day-revival-word','Weak','Local baptism events were linked to the word.'),
  ('tb-2025-11-crisis-in-holland','Moderate','The named country and a short window matched a real collapse.'),
  ('tb-2025-12-one-last-warning-for-kathryn-krick','Weak','Later criticism was linked to the word, and the timing was moved later.'),
  ('tb-2025-14-texas-flooding-and-weather-manipulation','Weak','This kind of flooding happens often in that place.'),
  ('tb-2025-13-a-move-to-haiti','Weak to moderate','A policy within a short window matched.'),
  ('tb-2025-15-july-2025-word-reveal-of-a','Weak to moderate','A revelation within a short window matched.'),
  ('tb-2025-16-five-day-prophecy-2025','Weak to moderate','Political events within a short window matched.'),
  ('tb-2025-17-seven-day-prophecy-2025','Weak to moderate','Reports within a short window matched.'),
  ('tb-2025-19-japan-yen-crisis-affecting-the-u','Weak','A later currency intervention was linked to the word, and the timing was moved later.'),
  ('tb-2025-18-a-financial-rumbling-august-october-2025','Weak','Ongoing trade activity was linked to the word.'),
  ('tb-2025-20-2025-two-week-word-russia-hoax','Weak to moderate','Document releases within a short window matched.'),
  ('tb-2025-21-august-2025-pandemic','Weak','Outbreak measures were linked to wording about a pandemic.'),
  ('tb-2025-22-out-of-the-blue-attack-on','Weak','Ongoing sanctions activity was linked to the word.'),
  ('tb-2025-23-the-death-of-your-president','Did not hold up','The assassination of a person who was not a president was linked to the word, and details were added after the event. Joshua marks this as a miss.'),
  ('tb-2025-24-mushroom-cloud-rise-of-robot-soldiers','Did not hold up','No clear match was listed on the archive page. Joshua marks this as not fulfilled for now.'),
  ('tb-2025-25-solana-drops-below-100','Moderate','The specific price level matched.'),
  ('tb-2025-26-xrp-and-xlm-prophecies','Weak to moderate','The named assets matched a later divergence.'),
  ('tb-2025-27-national-parks-in-america-change-by','Weak to moderate','Policy changes matched.'),
  ('tb-2025-28-george-w-bush-on-call','Weak to moderate','Reports within a short window matched.'),
  ('tb-2025-29-christmas-explosion-2025-foiled-terrorist-attack','Weak to moderate','A foiled plot within a short window matched.'),
  ('tb-2025-30-one-week-political-health-factor-prophecy','Weak','A policy discussion within a short window matched.'),
  ('tb-2025-31-next-24-hours','Weak to moderate','A match on the same day.'),
  ('tb-2025-32-90-day-word-blackrock-disaster','Moderate','The named company and the window matched.'),
  ('tb-2026-01-february-2026-a-people-group-celebrating','Weak to moderate','The named month matched celebrations after a major event.'),
  ('tb-2026-02-national-security-breach','Moderate','A real leak within a short window matched.'),
  ('tb-2026-03-market-plunge-quarter-1-2026','Weak','An ordinary market decline was linked to the word.'),
  ('tb-2026-04-a-mentalist-trick-on-the-national','Weak to moderate','A performance matched.'),
  ('tb-2026-05-trump-s-war-with-iran-prophesied','Weak to moderate','Military action within a short window matched.'),
  ('tb-2026-06-fall-of-a-ministry-daystar','Weak','An ongoing controversy was linked to the word.'),
  ('tb-2026-07-third-major-trump-assassination-attempt','Weak to moderate','A foiled attempt within a short window matched.'),
  ('tb-2026-08-east-coast-disaster-west-coast-mixup','Did not hold up','No clear fulfillment was found. The archive page itself notes a mix-up. Joshua marks this as not fulfilled.'),
  ('tb-2026-09-irish-beheading-attempt-and-riots','Moderate','The specific act matched.'),
  ('tb-2026-10-reform-and-restore-winning-u-k','Moderate','The named parties matched the election results.'),
  ('tb-2026-11-trump-and-bibi-loss-of-friendship','Weak to moderate','Tension within a short window matched.'),
  ('tb-2026-12-assassination-attempt-disclosure-butler-pa','Weak to moderate','A document release within a short window matched.'),
  ('tb-2026-13-three-week-prophecy-june-2026','Moderate','The named window matched a major earthquake event.'),
  ('tb-2026-14-four-week-prophecy-kathryn-krick-reckoning','Weak to moderate','The named window matched public criticism.'),
  ('tb-2026-15-trump-auctioning-off-public-land','Weak to moderate','A policy action within a short window matched.'),
  ('tb-2026-16-spain-wins-the-2026-world-cup','Moderate','The named outcome matched.'),
  ('tb-2026-17-three-week-word-indonesia-2026','Weak to moderate','The named window and country matched real events.'),
  ('tb-2026-18-trump-and-a-mismanagement-of-funds','Weak','Political accusations were linked to the word.')
)
INSERT OR IGNORE INTO reviewer_notes
  (note_id,person_id,claim_id,note_kind,reviewer_id,review_label,rating_label,body,created_at)
SELECT 'note_oct23_assessment_' || n.claim_id, c.person_id, c.claim_id, 'assessment',
  (SELECT reviewer_id FROM reviewer_public_attributions WHERE display_name='Joshua' LIMIT 1),
  'Joshua Harris, review compiled October 23, 2026', n.rating_label, n.body, '2026-10-25T23:00:00.000Z'
FROM n JOIN claims c ON c.claim_id=n.claim_id
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');


-- Date corrections (9): each was checked against the public YouTube upload
-- date on 2026-10-25. The claim row keeps its original date; readers see the
-- corrected date with the previous one. One more entry whose date differs
-- (Market Plunge: Quarter 1 2026) was NOT changed: YouTube shows 2025-12-24, which
-- matches the site, not the October review.
WITH d(claim_id,previous_date,corrected_date,verification_url,body) AS (VALUES
  ('tb-2020-22-13-russian-invasion-of-ukraine','2021-07-05','2021-12-07','https://www.youtube.com/watch?v=iyijrK-MvQo','The date shown for this word was corrected from 2021-07-05 to 2021-12-07. 2021-12-07 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2023-02-ufo-crash-in-nevada','2023-06-12','2023-04-24','https://www.youtube.com/watch?v=xVihNgoqYNM','The date shown for this word was corrected from 2023-06-12 to 2023-04-24. 2023-04-24 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2023-03-president-reagan-and-the-2024-election','2023-06-15','2023-05-21','https://www.youtube.com/watch?v=FEciFSCMRGM','The date shown for this word was corrected from 2023-06-15 to 2023-05-21. 2023-05-21 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2023-07-elon-musk-tech-development','2023-07-14','2023-07-03','https://www.youtube.com/watch?v=tLzeVlhb438','The date shown for this word was corrected from 2023-07-14 to 2023-07-03. 2023-07-03 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2023-15-swing-states','2023-08-13','2023-10-05','https://www.youtube.com/watch?v=XeNciDIuhoQ','The date shown for this word was corrected from 2023-08-13 to 2023-10-05. 2023-10-05 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2024-22-biden-s-battle-to-stay-in','2024-06-26','2024-06-17','https://www.youtube.com/watch?v=LyfjUp20CMk','The date shown for this word was corrected from 2024-06-26 to 2024-06-17. 2024-06-17 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2024-42-laser-weapon-technology-november-11th-2024','2024-11-11','2024-11-21','https://www.youtube.com/watch?v=oIDN3DoHpmU','The date shown for this word was corrected from 2024-11-11 to 2024-11-21. 2024-11-21 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2025-22-out-of-the-blue-attack-on','2025-08-02','2025-07-23','https://www.youtube.com/watch?v=cwsDz26mE2Y','The date shown for this word was corrected from 2025-08-02 to 2025-07-23. 2025-07-23 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.'),
  ('tb-2025-24-mushroom-cloud-rise-of-robot-soldiers','2025-08-23','2025-09-03','https://www.youtube.com/watch?v=o2AkqMUBIZA','The date shown for this word was corrected from 2025-08-23 to 2025-09-03. 2025-09-03 is the upload date on the original video''s public YouTube page, and it matches the date in Joshua''s October 23 review. The earlier date is kept in the record history.')
)
INSERT OR IGNORE INTO reviewer_notes
  (note_id,person_id,claim_id,note_kind,reviewer_id,review_label,rating_label,body,
   previous_date,corrected_date,verification_url,created_at)
SELECT 'note_oct23_date_' || d.claim_id, c.person_id, c.claim_id, 'date_correction',
  (SELECT reviewer_id FROM reviewer_public_attributions WHERE display_name='Joshua' LIMIT 1),
  'Joshua Harris, review compiled October 23, 2026', NULL, d.body, d.previous_date, d.corrected_date, d.verification_url, '2026-10-25T23:00:00.000Z'
FROM d JOIN claims c ON c.claim_id=d.claim_id
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND c.source_date = d.previous_date;


-- Person-level overall view, labelled as Joshua's. It speaks only about the
-- predictions in the archive, in line with the product boundary.
INSERT OR IGNORE INTO reviewer_notes
  (note_id,person_id,claim_id,note_kind,reviewer_id,review_label,rating_label,body,created_at)
SELECT 'note_oct23_overall_troy_black', p.person_id, NULL, 'overall_view',
  (SELECT reviewer_id FROM reviewer_public_attributions WHERE display_name='Joshua' LIMIT 1),
  'Joshua Harris, review compiled October 23, 2026', 'Low', 'Joshua reviewed 152 entries from the speaker''s fulfilled archive and rates the archive''s reliability for specific, non-obvious predictions as low. In his view, most entries were broad enough to be linked to later events, were already widely expected when they were said, had details added after the event, or were not fulfilled on the terms later claimed. His highest rating was Moderate. This is Joshua''s view of the predictions in this archive. It is not a Ledger decision, and the Ledger does not judge anyone''s faith, motives, character, or calling.', '2026-10-25T23:00:00.000Z'
FROM people p
WHERE p.slug='troy-black'
  AND EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');


-- Draft entries (not public): no exact quotation is on file for these four, so
-- they cannot be claims yet. Each waits for a quote found in the video itself.
WITH e(title,video_url,reported_date,youtube_upload_date,date_check,rating_label,body) AS (VALUES
  ('Elon Musk 2022 Prophecy','https://www.youtube.com/watch?v=MQpZw92iR10','2022-01-12','2022-01-12','matches_youtube','Weak','Mixed launch results and a known solar risk were linked to the word. The archive''s own claimed result is that 38 of 49 Starlink satellites were lost on February 3 and 4, 2022; that has not been independently checked.'),
  ('Fire in the Skies: November 2025','https://www.youtube.com/watch?v=hAxgohCuFJw','2025-10-15','2025-10-15','matches_youtube','Weak to moderate','The named month matched a major fire. The archive''s own claimed result is the Hong Kong high-rise fire on November 26, 2025; that has not been independently checked.'),
  ('Bar Exam Prophecy','https://www.youtube.com/watch?v=L_3wuHk1dSI','2026-08-12',NULL,'video_not_available','Weak','The change was already public before the word. The video was not publicly available when its date was checked, so the date is as reported by Joshua.'),
  ('Four-Week Economy Word: Japan','https://www.youtube.com/watch?v=KU3PTBfakyQ','2026-08-21','2026-08-21','matches_youtube','Weak','Broad economic activity was linked to the word.')
)
INSERT OR IGNORE INTO draft_review_entries
  (draft_entry_id,person_id,title,video_url,reported_date,youtube_upload_date,date_check,
   reviewer_id,review_label,rating_label,body,draft_status,created_at)
SELECT 'draft_oct23_' || substr(e.video_url, instr(e.video_url,'v=')+2), p.person_id, e.title,
  e.video_url, e.reported_date, e.youtube_upload_date, e.date_check,
  (SELECT reviewer_id FROM reviewer_public_attributions WHERE display_name='Joshua' LIMIT 1),
  'Joshua Harris, review compiled October 23, 2026', e.rating_label, e.body, 'draft_needs_exact_quote', '2026-10-25T23:00:00.000Z'
FROM e JOIN people p ON p.slug='troy-black'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');
