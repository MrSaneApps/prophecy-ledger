PRAGMA foreign_keys = ON;

-- Migration 0068: public research briefs for the three automated-pass claims.
-- The profile list and claim pages render from public_research_briefs, so the
-- Russia, Ecuador, and moth decisions published in 0067 need brief rows to be
-- visible at all. Content below restates the 0067 evidence and rationales in
-- the brief shape; nothing new is decided here.
-- Without a Joshua attribution (tests), every statement below is a zero-row
-- no-op; that attribution is the established production marker.

INSERT OR IGNORE INTO public_research_briefs
  (brief_id,claim_id,revision_number,supersedes_brief_id,quotation_source_url,
   headline,evidence_strength,test_framing,evidence_summary,
   prior_information_summary,corpus_warning,missing_gates_json,research_status,
   as_of_date,created_at)
SELECT * FROM (VALUES
  ('brief_russia_r3','russia-spring-2022',3,'brief_russia_r2',
   'https://www.youtube.com/watch?v=iyijrK-MvQo&t=151s',
   'Did not happen: Russia never formally declared war, and invaded before spring.',
   'material_provisional',
   'Whether Russia formally declared war between March 1 and May 31, 2022. A declaration instrument counts; a special military operation announcement does not. The trailing in full shift by July phrase was left unexplained by the speaker and is not scored.',
   'Russia invaded Ukraine on February 24, 2022, before spring, announcing a special military operation (Congressional Research Service; European Parliament). No formal declaration of war was ever issued. The word was received September 25, 2021 and shared December 7, 2021; the quote is verified at 151s.',
   'Whether Russian action was already public or predictable before December 7, 2021 is not yet assessed. A reproducible prior-information search with a 2021-12-07 cutoff is still required.',
   'These selected claims are not a complete review of the channel or its track record.',
   '[]','provisional_research','2026-09-21','2026-09-21T16:45:00.000Z'),
  ('brief_ecuador_2023_r1','claim_743b73bfe201575d3e1119ae',1,NULL,
   'https://www.youtube.com/watch?v=QtPaJ0MlFng',
   'Partly happened: a branch shut down within weeks, but the details do not distinctively match.',
   'material_provisional',
   'Whether a governmental branch in Ecuador that protects rights shut down. The cited event is President Lasso dissolving the National Assembly on May 17, 2023; it must match the stated words per independent sources.',
   'On May 17, 2023 President Guillermo Lasso dissolved the National Assembly by muerte cruzada decree amid impeachment proceedings (El Pais, VOA, PBS): a branch shutdown about four weeks after the April 22, 2023 sharing, so the core event happened. But the rights-protector qualifier does not distinctively match the Assembly that was pursuing impeachment, and the time-limit and deliverance coda sets no testable term.',
   'Whether the dissolution was already public or predictable before April 22, 2023 is not yet assessed. A reproducible prior-information search with a 2023-04-22 cutoff is still required.',
   'These selected claims are not a complete review of the channel or its track record.',
   '[]','provisional_research','2026-09-21','2026-09-21T16:45:00.000Z'),
  ('brief_moth_2024_r1','moth-prophecy-president-2024',1,NULL,
   'https://www.youtube.com/watch?v=tc1JtKQox0Q&t=273s',
   'Cannot be tested: the parabolic word names no person.',
   'material_provisional',
   'Whether the January 11, 2024 moth word named the next U.S. president in advance. A specific person must be named before the election; post-hoc mapping of the metaphor to a candidate does not count.',
   'The word is explicitly parabolic and names no person: the speaker declines to name who it connects to (He did not specifically say who it was; it could go either way) and did not hear 2024 either. The November 6, 2024 Trump-won retrospective is the speaker''s own post-election mapping, not an independent test. Scoring it true because Trump won would reinterpret the metaphor after the fact.',
   'Prior-information assessment does not apply: the word names no person to check against earlier reporting.',
   'These selected claims are not a complete review of the channel or its track record.',
   '[]','provisional_research','2026-09-21','2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');

INSERT OR IGNORE INTO public_research_references
  (reference_id,brief_id,reference_role,title,url,published_at,note,
   display_order,created_at)
SELECT * FROM (VALUES
  ('ref_russia_orig','brief_russia_r3','original_statement',
   'Troy Black: Russia war word (December 7, 2021)',
   'https://www.youtube.com/watch?v=iyijrK-MvQo&t=151s','2021-12-07',
   'Quote verified at 151s against video captions.',0,'2026-09-21T16:45:00.000Z'),
  ('ref_russia_crs','brief_russia_r3','independent_outcome',
   'Congressional Research Service: Russia War in Ukraine',
   'https://www.congress.gov/crs_external_products/R/HTML/R47068.web.html',NULL,
   'Full-scale invasion on February 24, 2022, called a special military operation.',1,
   '2026-09-21T16:45:00.000Z'),
  ('ref_russia_euparl','brief_russia_r3','independent_outcome',
   'European Parliament: Russia war of aggression text',
   'https://www.europarl.europa.eu/doceo/document/TA-10-2025-0006_EN.html','2025-01-23',
   'February 24, 2022 brought a special military operation, not a formal war declaration.',2,
   '2026-09-21T16:45:00.000Z'),
  ('ref_ecuador_orig','brief_ecuador_2023_r1','original_statement',
   'Troy Black: Ecuador branch word (April 22, 2023)',
   'https://www.youtube.com/watch?v=QtPaJ0MlFng','2023-04-22',
   'Shutting down the governmental branches which protect rights, in Ecuador.',0,
   '2026-09-21T16:45:00.000Z'),
  ('ref_ecuador_elpais','brief_ecuador_2023_r1','independent_outcome',
   'El Pais: Ecuador president dissolves National Assembly',
   'https://english.elpais.com/international/2023-05-17/ecuadors-president-dissolves-national-assembly-amid-impeachment-proceedings-against-him.html',
   '2023-05-17','Lasso dissolved the Assembly by muerte cruzada decree amid impeachment.',1,
   '2026-09-21T16:45:00.000Z'),
  ('ref_ecuador_voa','brief_ecuador_2023_r1','independent_outcome',
   'VOA: Ecuador president dissolves legislature',
   'https://www.voanews.com/a/ecuador-president-dissolves-legislature-bringing-elections-forward/7097059.html',
   '2023-05-17','Dissolution brought elections forward.',2,'2026-09-21T16:45:00.000Z'),
  ('ref_ecuador_pbs','brief_ecuador_2023_r1','independent_outcome',
   'PBS: Ecuador president dismisses legislature',
   'https://www.pbs.org/newshour/world/ecuadors-president-dismisses-legislature-as-it-tries-to-impeach-him',
   '2023-05-17','Legislature dismissed while trying to impeach.',3,'2026-09-21T16:45:00.000Z'),
  ('ref_moth_orig','brief_moth_2024_r1','original_statement',
   'Troy Black: God Told Me Who Will Be President of the USA',
   'https://www.youtube.com/watch?v=tc1JtKQox0Q&t=273s','2024-01-11',
   'Moth vision quote verified at 273s; no person is named.',0,'2026-09-21T16:45:00.000Z'),
  ('ref_moth_retro','brief_moth_2024_r1','speaker_archive',
   'Trump Wins, Fulfilling The MOTH Prophecy',
   'https://troyblackvideos.com/trump-wins-fulfilling-the-moth-prophecy/','2024-11-06',
   'Speaker-authored post-election mapping; not independent outcome evidence.',1,
   '2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua');
