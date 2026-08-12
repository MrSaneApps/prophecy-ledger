PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO public_research_briefs (
  brief_id,claim_id,revision_number,supersedes_brief_id,quotation_source_url,
  headline,evidence_strength,test_framing,evidence_summary,prior_information_summary,
  corpus_warning,missing_gates_json,research_status,as_of_date,created_at
) VALUES (
  'brief_oil_r3','southeast-asia-oil-2021',3,'brief_oil_r2',
  'https://www.youtube.com/watch?v=ZidiIdg3U4M&t=607s',
  'Source found; the archive says the timing was wrong','material_provisional',
  'The source says only that an "oil boom" would occur in Southeast Asia in 2021. It does not name an actor or cause, define which countries count, or define boom as production, discoveries, investment, or prices. Under the current Who, What, Why, Where, and When gate, this should not be promoted as a fully testable atomic claim as written. Keep the source record and every later interpretation.',
  'Two independent automated passes located the statement in the original public video at approximately 10:07-10:14 and 10:08-10:13, and the saved private transcript contains the same passage. The speaker''s archive says the event did not happen in the stated year and says Troy believes he got the timing wrong. Independent Rystad data reported that Southeast Asian oil and gas output fell from 5.06 million barrels of oil equivalent per day in 2020 to 4.86 million in 2021. Discoveries rose from a weak 2020 base, but 78 percent were gas or gas condensate and 22 percent were oil. The claim cannot be counted as a hit as written; if boom is narrowed after the fact to oil production, the available evidence points to a miss.',
  'Before the statement, public reports already described years of falling regional oil production, growing import dependence, and known energy projects. The subject was public, but the undefined word boom prevents a fair novelty score.',
  'This claim was found on a page called "All Fulfilled Prophecies." Because that page selects claims described as fulfilled, it cannot by itself show the speaker''s complete track record.',
  '["Have a verified human check the original video segment and surrounding context.","If the claim is resubmitted for a rating, freeze a source-supported definition of oil boom without adding meaning after the deadline.","Preserve the independent 2021 production and discovery evidence.","Get matching decisions from two independent, verified reviewers before any final public rating."]',
  'provisional_research','2026-07-20','2026-07-21T02:36:00.000Z'
);

INSERT OR IGNORE INTO public_research_references (
  reference_id,brief_id,reference_role,title,url,published_at,note,display_order,created_at
) VALUES
('oil_r3_plain_research_oil_original','brief_oil_r3','original_statement','God Just Showed Me This About November - Troy Black','https://www.youtube.com/watch?v=ZidiIdg3U4M&t=607s','2020-09-10','The original public video. Two automated passes located the statement at approximately 10:07-10:14 and 10:08-10:13; human source confirmation is still required.',1,'2026-07-21T02:36:00.000Z'),
('oil_r3_plain_research_oil_archive','brief_oil_r3','speaker_archive','All Fulfilled Prophecies - Troy Black Videos','https://troyblackvideos.com/prophecy-archive-all/',NULL,'A page written by the speaker and used to find this claim. Because it lists claims described as fulfilled, it cannot show a complete track record.',2,'2026-07-21T02:36:00.000Z'),
('oil_r3_plain_research_oil_rystad_2021','brief_oil_r3','independent_outcome','Southeast Asia oil and gas output unlikely to exceed 5 million boepd','https://www.offshore-energy.biz/southeast-asias-oil-gas-output-unlikely-to-exceed-5-million-boepd-rystad-says/','2021-12-29','Reports Rystad data showing that 2021 output fell to 4.86 million barrels of oil equivalent per day from 5.06 million in 2020. Discoveries increased, mostly in gas and gas condensate.',3,'2026-07-21T02:36:00.000Z'),
('oil_r3_plain_research_oil_pre_cutoff_2017','brief_oil_r3','prior_public_information','Southeast Asia Energy Outlook 2017','https://www.oecd.org/content/dam/oecd/en/publications/reports/2017/10/southeast-asia-energy-outlook-2017_g1g83ee1/9789264285576-en.pdf','2017-10-24','Published before the claim. It describes falling production in important regional producers and energy projects that were already known.',4,'2026-07-21T02:36:00.000Z'),
('oil_r3_plain_research_oil_pre_cutoff_2020','brief_oil_r3','prior_public_information','Insatiable demand - Southeast Asia Infrastructure','https://southeastasiainfra.com/insatiable-demand/','2020-01-31','Published before the claim. It reports that regional crude production had been falling since 2016 as fields matured and import dependence grew.',5,'2026-07-21T02:36:00.000Z'),
('oil_r3_plain_research_oil_asean_2024','brief_oil_r3','context','ASEAN Oil and Gas Updates 2024','https://aseanenergy.org/wp-content/uploads/2024/12/ASEAN-Oil-and-Gas-Updates-2024.pdf','2024-12-01','Later background from the ASEAN Centre for Energy reporting that oil production had fallen about 7.51 percent per year since 2016.',6,'2026-07-21T02:36:00.000Z');
