PRAGMA foreign_keys = ON;

-- Migration 0069: public research brief for the Charles succession claim.
-- claim_51cbcb17013caa85fd2f059e was decided true by two matching reviews but
-- has no brief, so it is the only published Troy Black claim missing from the
-- profile list. Content below restates the two matching reviews and the filed
-- evidence; nothing new is decided here.
-- Without a Joshua attribution (tests), every statement below is a zero-row
-- no-op; that attribution is the established production marker.

INSERT OR IGNORE INTO public_research_briefs
  (brief_id,claim_id,revision_number,supersedes_brief_id,quotation_source_url,
   headline,evidence_strength,test_framing,evidence_summary,
   prior_information_summary,corpus_warning,missing_gates_json,research_status,
   as_of_date,created_at)
SELECT 'brief_charles_2022_r1','claim_51cbcb17013caa85fd2f059e',1,NULL,
  'https://www.youtube.com/watch?v=Lu3sWY0SsxU&t=0s',
  'Happened: Charles took the throne ten days after the word, as widely expected.',
  'material_provisional',
  'Whether Prince Charles would take over after Queen Elizabeth II.',
  'Queen Elizabeth II died on September 8, 2022 and Charles acceded the same day, ten days after the August 29, 2022 word (AP; PBS). Both matching reviews note the outcome was widely expected: the Queen was in her mid-90s and her illness had been in the news for months, and Charles was next in line.',
  'The matching reviews record that succession was public and predictable before the word. No reproducible prior-information search with a cutoff is on file.',
  'These selected claims are not a complete review of the channel or its track record.',
  '[]','provisional_research','2026-09-21','2026-09-21T16:45:00.000Z'
WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM claims WHERE claim_id='claim_51cbcb17013caa85fd2f059e');

INSERT OR IGNORE INTO public_research_references
  (reference_id,brief_id,reference_role,title,url,published_at,note,
   display_order,created_at)
SELECT * FROM (VALUES
  ('ref_charles_orig','brief_charles_2022_r1','original_statement',
   'Troy Black: Succession of Prince Charles (August 29, 2022)',
   'https://www.youtube.com/watch?v=Lu3sWY0SsxU&t=0s','2022-08-29',
   'He is next, he is going to take over for her.',0,'2026-09-21T16:45:00.000Z'),
  ('ref_charles_ap','brief_charles_2022_r1','independent_outcome',
   'AP: The formal rules around Charles accession',
   'https://apnews.com/article/queen-elizabeth-ii-king-charles-iii-london-b86fe14af9ba609411a1a1df232d1eb9',
   NULL,'Accession rules as Elizabeth II died September 8, 2022.',1,
   '2026-09-21T16:45:00.000Z'),
  ('ref_charles_pbs','brief_charles_2022_r1','independent_outcome',
   'PBS: King Charles III will succeed Queen Elizabeth II',
   'https://www.pbs.org/newshour/world/king-charles-iii-will-succeed-queen-elizabeth-ii-who-is-next-in-line-to-take-the-throne',
   NULL,'Succession and line explained.',2,'2026-09-21T16:45:00.000Z')
) WHERE EXISTS (SELECT 1 FROM reviewer_public_attributions WHERE display_name='Joshua')
  AND EXISTS (SELECT 1 FROM public_research_briefs WHERE brief_id='brief_charles_2022_r1');
