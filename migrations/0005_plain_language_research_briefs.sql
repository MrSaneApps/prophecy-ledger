-- Plain-language revisions. The original research remains preserved in revision 1.
INSERT OR IGNORE INTO public_research_briefs (
  brief_id, claim_id, revision_number, supersedes_brief_id,
  quotation_source_url, headline, evidence_strength, test_framing,
  evidence_summary, prior_information_summary, corpus_warning,
  missing_gates_json, research_status, as_of_date, created_at
) VALUES
  (
    'brief_oil_r2', 'southeast-asia-oil-2021', 2, 'brief_oil_r1',
    'https://troyblackvideos.com/prophecy-archive-all/',
    'His own archive says the timing was wrong; 2021 oil and gas output fell',
    'material_provisional',
    'Did Southeast Asia have an oil boom in 2021? To answer fairly, we still need to define what counts as a boom, which countries count, and whether gas is included.',
    'His archive says the boom happened, but not in the year given, and says Troy believes he got the timing wrong. Independent Rystad data reported that Southeast Asian oil and gas output fell from 5.06 million barrels of oil equivalent per day in 2020 to 4.86 million in 2021. Discoveries rose from a low 2020 level, but 78 percent were gas or gas condensate and 22 percent were oil. This weighs against calling 2021 an oil-production boom, but no final rating has been made.',
    'Before he said this, public reports already described years of falling regional oil production, growing import dependence, and known energy projects. The subject was public, but the phrase "oil boom" is too vague to decide how surprising the claim was until its intended meaning is clear.',
    'These claims were found on a page called "All Fulfilled Prophecies." Because that page selects claims described as fulfilled, it cannot by itself show the speaker''s complete track record.',
    '["Check the exact timestamp and full context in the original video.","Define what counts as an oil boom, which countries count, and whether gas is included.","Preserve the independent 2021 production and discovery sources.","Preserve the searches showing what was public before September 10, 2020.","Get matching decisions from two independent, verified reviewers."]',
    'provisional_research', '2026-07-19', '2026-07-19T23:50:00.000Z'
  ),
  (
    'brief_russia_r2', 'russia-spring-2022', 2, 'brief_russia_r1',
    'https://troyblackvideos.com/prophecy-archive-all/',
    'Russia invaded, but warnings were already public and key wording is unresolved',
    'material_provisional',
    'This quote contains more than one claim: that Russia would declare war in spring, and that something would be "in full shift by July." Each part needs a clear meaning and date range before it can be rated.',
    'The United Nations says Russia''s full-scale invasion of Ukraine began on February 24, 2022, before spring. Troy''s archive connects the invasion to the quote and later describes March 22, 2024 as an official declaration of war. On that date, TASS quoted Dmitry Peskov saying there had been no legal change and it was still legally called a special military operation. The broad prediction of war matched later events, but the words "declare war in the springtime" and "in full shift by July" do not yet support a clear final rating.',
    'Before the December 7, 2021 video, NATO had publicly described an unusual concentration of Russian forces. Axios reported on December 4 that Russia could be preparing for an invasion in early 2022 and that much of the activity was already visible through public sources and satellite images. The risk of invasion was therefore already public before the claim.',
    'These claims were found on a page called "All Fulfilled Prophecies." Because that page selects claims described as fulfilled, it cannot by itself show the speaker''s complete track record.',
    '["Check the exact timestamp and full context in the original video.","Decide what the phrase full shift was meant to mean.","Decide whether declare war means a formal legal declaration or the start of an invasion.","Confirm the intended year and what dates count as spring.","Preserve the searches showing what was public before December 7, 2021.","Get matching decisions from two independent, verified reviewers."]',
    'provisional_research', '2026-07-19', '2026-07-19T23:50:00.000Z'
  );

INSERT OR IGNORE INTO public_research_references (
  reference_id, brief_id, reference_role, title, url, published_at, note,
  display_order, created_at
)
SELECT
  'plain_' || reference_id,
  CASE brief_id WHEN 'brief_oil_r1' THEN 'brief_oil_r2' ELSE 'brief_russia_r2' END,
  reference_role, title, url, published_at,
  CASE reference_id
    WHEN 'research_oil_original' THEN 'The original YouTube video. The exact timestamp and full surrounding context still need checking.'
    WHEN 'research_oil_archive' THEN 'A page written by the speaker and used to find this claim. Because it lists claims described as fulfilled, it cannot show a complete track record.'
    WHEN 'research_oil_rystad_2021' THEN 'Reports Rystad data showing that 2021 output fell to 4.86 million barrels of oil equivalent per day from 5.06 million in 2020. Discoveries increased, mostly in gas and gas condensate.'
    WHEN 'research_oil_pre_cutoff_2017' THEN 'Published before the claim. It describes falling production in important regional producers and energy projects that were already known.'
    WHEN 'research_oil_pre_cutoff_2020' THEN 'Published before the claim. It reports that regional crude production had been falling since 2016 as fields matured and import dependence grew.'
    WHEN 'research_oil_asean_2024' THEN 'Later background from the ASEAN Centre for Energy reporting that oil production had fallen about 7.51 percent per year since 2016.'
    WHEN 'research_russia_original' THEN 'The original YouTube video. The exact timestamp and full surrounding context still need checking.'
    WHEN 'research_russia_archive' THEN 'A page written by the speaker and used to find this claim. Its descriptions of fulfillment still need independent checking.'
    WHEN 'research_russia_un_2022' THEN 'An independent date source stating that the full-scale invasion began on February 24, 2022.'
    WHEN 'research_russia_tass_2024' THEN 'Quotes Peskov saying there was no legal change and the situation was still legally called a special military operation.'
    WHEN 'research_russia_nato_2021' THEN 'Published before the claim. NATO describes the second unusual concentration of Russian forces that year.'
    WHEN 'research_russia_axios_2021' THEN 'Published three days before the claim. It reports that Russia could be preparing for an early-2022 invasion and that much was visible through public sources and satellite images.'
  END,
  display_order, '2026-07-19T23:50:00.000Z'
FROM public_research_references
WHERE brief_id IN ('brief_oil_r1', 'brief_russia_r1');
