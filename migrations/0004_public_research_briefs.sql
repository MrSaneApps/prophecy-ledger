CREATE TABLE IF NOT EXISTS public_research_briefs (
  brief_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  supersedes_brief_id TEXT REFERENCES public_research_briefs(brief_id),
  quotation_source_url TEXT NOT NULL,
  headline TEXT NOT NULL,
  evidence_strength TEXT NOT NULL CHECK (evidence_strength IN (
    'insufficient','preliminary_signal','material_provisional'
  )),
  test_framing TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  prior_information_summary TEXT NOT NULL,
  corpus_warning TEXT NOT NULL,
  missing_gates_json TEXT NOT NULL,
  research_status TEXT NOT NULL DEFAULT 'provisional_research' CHECK (
    research_status = 'provisional_research'
  ),
  as_of_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, revision_number)
);

CREATE TABLE IF NOT EXISTS public_research_references (
  reference_id TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL REFERENCES public_research_briefs(brief_id),
  reference_role TEXT NOT NULL CHECK (reference_role IN (
    'original_statement','speaker_archive','independent_outcome',
    'prior_public_information','context'
  )),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  note TEXT NOT NULL,
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(brief_id, url)
);

CREATE INDEX IF NOT EXISTS public_research_briefs_claim
  ON public_research_briefs(claim_id, revision_number);
CREATE INDEX IF NOT EXISTS public_research_references_brief
  ON public_research_references(brief_id, display_order, reference_id);

CREATE TRIGGER IF NOT EXISTS public_research_briefs_no_update
BEFORE UPDATE ON public_research_briefs BEGIN
  SELECT RAISE(ABORT, 'public research briefs are append-only');
END;
CREATE TRIGGER IF NOT EXISTS public_research_briefs_no_delete
BEFORE DELETE ON public_research_briefs BEGIN
  SELECT RAISE(ABORT, 'public research briefs are append-only');
END;
CREATE TRIGGER IF NOT EXISTS public_research_references_no_update
BEFORE UPDATE ON public_research_references BEGIN
  SELECT RAISE(ABORT, 'public research references are append-only');
END;
CREATE TRIGGER IF NOT EXISTS public_research_references_no_delete
BEFORE DELETE ON public_research_references BEGIN
  SELECT RAISE(ABORT, 'public research references are append-only');
END;

INSERT OR IGNORE INTO public_research_briefs (
  brief_id, claim_id, revision_number, supersedes_brief_id,
  quotation_source_url, headline, evidence_strength, test_framing,
  evidence_summary, prior_information_summary, corpus_warning,
  missing_gates_json, research_status, as_of_date, created_at
) VALUES
  (
    'brief_oil_r1', 'southeast-asia-oil-2021', 1, NULL,
    'https://troyblackvideos.com/prophecy-archive-all/',
    'Speaker''s archive acknowledges wrong timing; 2021 production contracted',
    'material_provisional',
    'Test whether a material regional oil-production or oil-discovery boom occurred during calendar 2021. The meaning of "oil boom," the geographic scope, and whether gas or gas condensate count must be frozen before a final adjudication.',
    'The speaker-authored archive says the oil boom "did occur, but not in the timeline given," reports that regional production continued declining during 2021, and says Troy believes he got the timeline wrong. Independent Rystad data reported in December 2021 put combined Southeast Asian oil-and-gas output at 4.86 million boe per day, down from 5.06 million in 2020 and below 5 million for the first time since 1998. Discoveries did rise from a low 2020 base, but 78 percent were gas or gas condensate and 22 percent oil. This is material provisional evidence against a 2021 production-boom reading, not a final adjudication of the undefined word "boom."',
    'Public sources before September 10, 2020 described a long-running regional production decline, import dependence, and known projects. That context makes the subject public but does not settle the novelty of an undefined "boom" prediction. Novelty remains provisional until the original context fixes the intended measure and a reproducible cutoff-bound search is reviewed.',
    'The discovery page is titled "All Fulfilled Prophecies." Because it is a speaker-authored, outcome-selected archive, it cannot establish a complete channel corpus or track record.',
    '["Verify the original-video timestamp and full context or obtain an authorized transcript.","Freeze a measurable definition of an oil boom, geographic scope, and whether gas counts.","Preserve independent 2021 production and discovery evidence.","Complete a reproducible prior-information receipt with a September 10, 2020 cutoff.","Obtain two authenticated human reviews matching on the full evidence set."]',
    'provisional_research', '2026-07-19', '2026-07-19T00:00:00.000Z'
  ),
  (
    'brief_russia_r1', 'russia-spring-2022', 1, NULL,
    'https://troyblackvideos.com/prophecy-archive-all/',
    'Broad invasion aligned; warnings were public and literal wording remains unresolved',
    'material_provisional',
    'Split the quotation into at least two propositions: whether Russia formally declared war in spring, and what "in full shift by July" meant. Each proposition needs a frozen definition and date window before final adjudication.',
    'The United Nations dates Russia''s full-scale invasion of Ukraine to February 24, 2022, which is before meteorological and astronomical spring. The speaker-authored archive connects the invasion to the quotation and characterizes March 22, 2024 as an official declaration of war. On that same date, TASS quoted Dmitry Peskov saying there was no de jure change and the situation legally remained a special military operation. No verified formal declaration is in the present evidence. The broad war outcome corresponds, but the literal declaration, spring timing, and undefined phrase "in full shift by July" do not yet support a clean hit.',
    'Before the December 7, 2021 statement, NATO described a second unusual concentration of Russian forces that year. Axios reported on December 4 that preparations could support an invasion in early 2022 and that much was already known from public sources and satellite imagery. These are strong public precursor signals; novelty remains provisional until a reproducible cutoff-bound search receipt is complete.',
    'The discovery page is titled "All Fulfilled Prophecies." Because it is a speaker-authored, outcome-selected archive, it cannot establish a complete channel corpus or track record.',
    '["Verify the original-video timestamp and full context or obtain an authorized transcript.","Split the quotation into atomic propositions and freeze the meaning of full shift.","Define whether declaration means a formal legal act, public characterization, or armed invasion.","Freeze the intended year and the definition of spring without hindsight.","Complete and preserve a reproducible prior-information receipt with a December 7, 2021 cutoff.","Obtain two authenticated human reviews matching on the full evidence set."]',
    'provisional_research', '2026-07-19', '2026-07-19T00:00:00.000Z'
  );

INSERT OR IGNORE INTO public_research_references (
  reference_id, brief_id, reference_role, title, url, published_at, note,
  display_order, created_at
) VALUES
  (
    'research_oil_original', 'brief_oil_r1', 'original_statement',
    'God Just Showed Me This About November - Troy Black',
    'https://www.youtube.com/watch?v=ZidiIdg3U4M', '2020-09-10',
    'Original video attributed by live YouTube metadata to Troy Black. Full transcript context and exact timestamp remain unverified.',
    1, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_oil_archive', 'brief_oil_r1', 'speaker_archive',
    'All Fulfilled Prophecies - Troy Black Videos',
    'https://troyblackvideos.com/prophecy-archive-all/', NULL,
    'Speaker-authored retrospective and quotation-discovery source. It is outcome-selected and is not independent outcome proof.',
    2, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_oil_rystad_2021', 'brief_oil_r1', 'independent_outcome',
    'Southeast Asia oil and gas output unlikely to exceed 5 million boepd',
    'https://www.offshore-energy.biz/southeast-asias-oil-gas-output-unlikely-to-exceed-5-million-boepd-rystad-says/',
    '2021-12-29',
    'Reports Rystad data: 2021 output fell to 4.86 million boe per day from 5.06 million in 2020; discoveries increased, mostly in gas and gas condensate.',
    3, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_oil_pre_cutoff_2017', 'brief_oil_r1', 'prior_public_information',
    'Southeast Asia Energy Outlook 2017',
    'https://www.oecd.org/content/dam/oecd/en/publications/reports/2017/10/southeast-asia-energy-outlook-2017_g1g83ee1/9789264285576-en.pdf',
    '2017-10-24',
    'Pre-cutoff regional outlook describing declining production in important producers and identifiable refinery projects.',
    4, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_oil_pre_cutoff_2020', 'brief_oil_r1', 'prior_public_information',
    'Insatiable demand - Southeast Asia Infrastructure',
    'https://southeastasiainfra.com/insatiable-demand/', '2020-01-31',
    'Pre-cutoff reporting on continuous regional crude-production decline since 2016, mature fields, and import dependence.',
    5, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_oil_asean_2024', 'brief_oil_r1', 'context',
    'ASEAN Oil and Gas Updates 2024',
    'https://aseanenergy.org/wp-content/uploads/2024/12/ASEAN-Oil-and-Gas-Updates-2024.pdf',
    '2024-12-01',
    'Later regional context reporting that oil production had fallen about 7.51 percent annually since 2016.',
    6, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_russia_original', 'brief_russia_r1', 'original_statement',
    'God Told Me Russia Is Going to Declare War - Prophecy | Troy Black',
    'https://www.youtube.com/watch?v=iyijrK-MvQo', '2021-12-07',
    'Original video attributed by live YouTube metadata to Troy Black. Full transcript context and exact timestamp remain unverified.',
    1, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_russia_archive', 'brief_russia_r1', 'speaker_archive',
    'All Fulfilled Prophecies - Troy Black Videos',
    'https://troyblackvideos.com/prophecy-archive-all/', NULL,
    'Speaker-authored retrospective and quotation-discovery source. Its fulfillment characterizations require independent checks.',
    2, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_russia_un_2022', 'brief_russia_r1', 'independent_outcome',
    'Statement by the United Nations Crisis Coordinator for Ukraine',
    'https://ukraine.un.org/en/184851-statement-amin-awad-assistant-secretary-general-and-united-nations-crisis-coordinator',
    '2022-06-03',
    'Independent date reference stating that the full-scale invasion began on February 24, 2022.',
    3, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_russia_tass_2024', 'brief_russia_r1', 'independent_outcome',
    'Russia in state of war, Peskov says',
    'https://tass.com/politics/1763755/amp', '2024-03-22',
    'Quotes Peskov saying the situation remained a special military operation de jure and involved no legal change.',
    4, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_russia_nato_2021', 'brief_russia_r1', 'prior_public_information',
    'NATO Secretary General keynote interview',
    'https://www.nato.int/en/news-and-events/events/transcripts/2021/12/01/keynote-interview',
    '2021-12-01',
    'Pre-cutoff primary source describing the second unusual concentration of Russian forces that year.',
    5, '2026-07-19T00:00:00.000Z'
  ),
  (
    'research_russia_axios_2021', 'brief_russia_r1', 'prior_public_information',
    'U.S. intel: Russia preparing to invade Ukraine',
    'https://www.axios.com/2021/12/04/us-ukraine-russia-invasion',
    '2021-12-04',
    'Pre-cutoff reporting that preparations could support an early-2022 invasion and that much was visible in public sources and satellite imagery.',
    6, '2026-07-19T00:00:00.000Z'
  );
