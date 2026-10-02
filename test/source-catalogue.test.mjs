import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as sourceGet } from "../functions/api/people/[slug]/sources.js";
import { onRequestGet as personGet } from "../functions/api/people/[slug].js";
import { onRequestGet as peopleGet } from "../functions/api/people.js";
import { context, jsonBody, makeEnv } from "./helpers/d1.mjs";

function seedInventory(env) {
  const db = env.DB.db;
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,archive_last_page,error_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("run_test", "person_troy_black", "canary", "official_site", "complete",
      "2026-07-19T10:00:00Z", "2026-07-19T10:05:00Z", 1, 0, "2026-07-19T10:00:00Z");
  const item = db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const revision = db.prepare(`INSERT INTO source_item_revisions
    (revision_id,source_item_id,content_sha256,canonical_url,public_title,first_party_description,
     publication_date,embedded_platform,embedded_item_id,embedded_url,fetched_at,parser_version,source_run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rows = [
    ["source_a", "wp-a", "https://troyblackvideos.com/a/", "available", "2024-01-01", "100% Prophecy", null],
    ["source_b", "wp-b", "https://troyblackvideos.com/b/", "available", "2023-01-01", "Another public word", null],
    ["source_c", "wp-c", "https://troyblackvideos.com/c/", "unavailable", "2022-01-01", "Removed public post", null],
    ["source_d", "wp-d", "https://troyblackvideos.com/d/", "available", "2021-01-01", "Video-linked post", "https://www.youtube.com/watch?v=ZidiIdg3U4M"],
  ];
  for (const [id, platformId, url, availability, date, title, videoUrl] of rows) {
    item.run(id, "person_troy_black", "source_troy_site", "official_site", platformId, url,
      "2026-07-19T10:00:00Z", "2026-07-19T10:00:00Z", availability);
    revision.run(`rev_${id}`, id, id.padEnd(64, "0"), url, title, `Private description for ${id}`,
      date, videoUrl ? "youtube" : null, videoUrl ? "ZidiIdg3U4M" : null, videoUrl,
      "2026-07-19T10:01:00Z", "test-v1", "run_test");
  }
  item.run("source_e", "person_troy_black", null, "youtube", "iyijrK-MvQo",
    "https://www.youtube.com/watch?v=iyijrK-MvQo", "2026-07-19T10:02:00Z", "2026-07-19T10:02:00Z", "unknown");
  db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,provenance,verifier_principal,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("transcript_b", "source_b", "private/transcript-b.json", "b".repeat(64),
      100, "en", 1, "authorized", "private-reviewer", "2026-07-19T10:02:00Z");
  db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,input_kind,input_sha256,prompt_version,model_family,status,started_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("extract_a", "source_a", "first_party_description", "a".repeat(64),
      "test-v1", "test-model", "completed", "2026-07-19T10:03:00Z", "2026-07-19T10:04:00Z");
  db.prepare(`INSERT INTO claim_candidates
    (candidate_id,extraction_run_id,source_item_id,candidate_kind,neutral_paraphrase,requires_transcript,requires_human_review,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run("candidate_a", "extract_a", "source_a", "description_lead",
      "Private draft lead", 1, 1, "2026-07-19T10:04:00Z");
  db.prepare(`INSERT INTO source_scan_receipts
    (receipt_id,run_id,person_id,source_name,status,item_count,last_page_or_cursor,public_explanation,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("receipt_site", "run_test", "person_troy_black", "Official website",
      "complete", 4, "1", "One-page test scan completed.", "2026-07-19T10:05:00Z");
}

function seedArchiveCoverage(env) {
  const db = env.DB.db;
  db.prepare(`INSERT INTO first_party_archive_receipts
    (receipt_id,run_id,source_id,person_id,adapter,source_url,response_sha256,row_count,parser_version,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("archive_receipt_test", "run_test", "source_troy_archive",
      "person_troy_black", "wptb_fulfilled_prophecy_v1",
      "https://troyblackvideos.com/prophecy-archive-all/", "9".repeat(64), 1, "test-v1",
      "2026-07-19T10:04:00Z");
  db.prepare(`INSERT INTO first_party_archive_leads
    (archive_lead_id,source_id,person_id,publisher_element_id,created_at)
    VALUES (?,?,?,?,?)`).run("archive_lead_test", "source_troy_archive", "person_troy_black",
      "wptb-element-text-test", "2026-07-19T10:04:00Z");
  db.prepare(`INSERT INTO first_party_archive_lead_revisions
    (archive_revision_id,archive_lead_id,receipt_id,content_sha256,source_locator_y_index,
     description_text,date_shared_text,prophecy_text,claimed_result_text,claimed_evidence_text,
     parser_version,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("archive_revision_test", "archive_lead_test",
      "archive_receipt_test", "8".repeat(64), 1, "Test archive row", "2026-01-01",
      "A specific testable statement.", "Publisher says fulfilled.", "Publisher evidence.",
      "test-v1", "2026-07-19T10:04:00Z");
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
    VALUES (?,?,?,?,?,?,?,?)`).run("archive_video_test", "person_troy_black", "youtube",
      "abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk", "2026-07-19T10:04:00Z",
      "2026-07-19T10:04:00Z", "unknown");
  db.prepare(`INSERT INTO first_party_archive_revision_links
    (archive_link_id,archive_revision_id,link_role,ordinal,label,url,youtube_id,source_item_id,provenance)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("archive_link_test", "archive_revision_test", "original_video", 1,
      "Original Prophecy", "https://www.youtube.com/watch?v=abcdefghijk", "abcdefghijk",
      "archive_video_test", "first_party_claimed_original");
  db.prepare(`INSERT INTO archive_verification_work_items
    (archive_work_item_id,archive_revision_id,archive_video_link_id,status,created_at,completed_at)
    VALUES (?,?,?,?,?,?)`).run("archive_work_test", "archive_revision_test", "archive_link_test",
      "complete", "2026-07-19T10:04:00Z", "2026-07-19T10:05:00Z");
}

function sourceContext(env, search = "") {
  return context({ env, url: `https://example.test/api/people/troy-black/sources${search}`,
    params: { slug: "troy-black" } });
}

function eligibleGrounding(values, contextEnd) {
  return JSON.stringify({ contextStart: 0, contextEnd, dimensions: Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, value === "Not stated" ? {
      value, supportQuote: null, supportStart: null, supportEnd: null,
    } : { value, supportQuote: value, supportStart: 0, supportEnd: value.length }]),
  ) });
}

function seedExactCandidateAssessment(env, decision, createdAt, suffix) {
  const db = env.DB.db; const quote = "A fully specified public event happened.";
  if (!db.prepare("SELECT 1 ok FROM claim_candidates WHERE candidate_id='candidate_exact_a'").get()) {
    db.prepare(`INSERT INTO claim_candidates
      (candidate_id,extraction_run_id,source_item_id,candidate_kind,exact_quote,quote_start,quote_end,
       source_timestamp_seconds,proposed_statement_type,atomic_proposition_draft,requires_transcript,
       requires_human_review,created_at)
      VALUES ('candidate_exact_a','extract_a','source_a','exact_transcript_claim',?,0,?,0,
        'present_or_past_factual_claim','A fully specified public event happened.',0,1,'2026-07-20')`).run(quote, quote.length);
  }
  const eligible = decision === "eligible";
  const grounding = eligible ? eligibleGrounding({ who: "who", what: "what", why: "why",
    where: "where", when: "when", how: "Not stated" }, quote.length) : "{}";
  db.prepare(`INSERT INTO candidate_admissibility_assessments
    (assessment_id,candidate_id,gate_version,decision,who_text,what_text,why_text,where_text,
     when_text,how_text,how_specificity,public_evidence_text,pass_condition_text,fail_condition_text,
     grounding_json,rejection_codes_json,assessed_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`assessment_${suffix}`, "candidate_exact_a", `gate_${suffix}`,
      decision, ...(eligible ? ["who", "what", "why", "where", "when", "Not stated", "not_stated", "public evidence", "pass", "fail"] :
        [null, null, null, null, null, "Not stated", "not_stated", null, null, null]), grounding,
      eligible ? "[]" : "[\"quarantined\"]", "system:test", createdAt);
}

test("profile coverage keeps source, transcript, candidate, review, and rating counts separate", async () => {
  const env = makeEnv();
  seedInventory(env);
  const response = await personGet(context({ env, url: "https://example.test/api/people/troy-black",
    params: { slug: "troy-black" } }));
  const { corpusCoverage: coverage } = await jsonBody(response);
  assert.deepEqual(coverage, {
    postsFound: 4, videosLinked: 1, transcriptsAvailable: 1, possibleClaimPosts: 1, specificClaimCandidates: 0, ledgerClaimsTotal: 152,
    archiveClaimsCatalogued: 0, archiveOriginalVideos: 0, archiveSourceChecksCompleted: 0,
    claimsCheckedByPeople: 0, finalRatings: 0, lastScanAt: "2026-07-19T10:05:00Z",
    scanStatus: "complete", sources: [{ name: "Official website", status: "complete", itemsFound: 4,
      explanation: "One-page test scan completed.", checkedAt: "2026-07-19T10:05:00Z" }],
  });
});

test("profile coverage exposes archive leads, original videos, and completed source checks separately", async () => {
  const env = makeEnv();
  seedInventory(env);
  seedArchiveCoverage(env);
  const profile = await jsonBody(await personGet(context({ env,
    url: "https://example.test/api/people/troy-black", params: { slug: "troy-black" },
  })));
  assert.equal(profile.corpusCoverage.archiveClaimsCatalogued, 1);
  assert.equal(profile.corpusCoverage.archiveOriginalVideos, 1);
  assert.equal(profile.corpusCoverage.archiveSourceChecksCompleted, 1);
  const directory = await jsonBody(await peopleGet(context({ env, url: "https://example.test/api/people" })));
  assert.equal(directory.people[0].corpusCoverage.archiveClaimsCatalogued, 1);
  assert.equal(directory.people[0].corpusCoverage.archiveOriginalVideos, 1);
  assert.equal(directory.people[0].corpusCoverage.archiveSourceChecksCompleted, 1);
});

test("public counts eligible candidates without inventing human-review readiness", async () => {
  const env = makeEnv(); seedInventory(env);
  seedExactCandidateAssessment(env, "eligible", "2026-07-20T10:00:00Z", "eligible");
  let profile = await jsonBody(await personGet(context({ env, url: "https://example.test/api/people/troy-black",
    params: { slug: "troy-black" } })));
  let directory = await jsonBody(await peopleGet(context({ env, url: "https://example.test/api/people" })));
  let catalogue = await jsonBody(await sourceGet(sourceContext(env, "?q=100%25")));
  assert.equal(profile.corpusCoverage.specificClaimCandidates, 1);
  assert.equal(directory.people[0].corpusCoverage.specificClaimCandidates, 1);
  assert.equal(catalogue.sources[0].status, "possible_claim");
  assert.equal(catalogue.sources[0].humanReviewStatus, "not_ready");

  seedExactCandidateAssessment(env, "quarantined", "2026-07-20T11:00:00Z", "quarantined");
  profile = await jsonBody(await personGet(context({ env, url: "https://example.test/api/people/troy-black",
    params: { slug: "troy-black" } })));
  directory = await jsonBody(await peopleGet(context({ env, url: "https://example.test/api/people" })));
  catalogue = await jsonBody(await sourceGet(sourceContext(env, "?q=100%25")));
  assert.equal(profile.corpusCoverage.specificClaimCandidates, 0);
  assert.equal(directory.people[0].corpusCoverage.specificClaimCandidates, 0);
  assert.equal(catalogue.sources[0].status, "possible_claim");
});

test("profile stays available before ingestion tables are installed", async () => {
  const env = makeEnv();
  env.DB.exec("DROP TABLE source_scan_receipts");
  const response = await personGet(context({ env, url: "https://example.test/api/people/troy-black",
    params: { slug: "troy-black" } }));
  assert.equal(response.status, 200);
  assert.equal((await jsonBody(response)).corpusCoverage.scanStatus, "not_started");
});

test("source catalogue is public-safe, keyset paged, filter-bound, and capped at 50", async () => {
  const env = makeEnv();
  seedInventory(env);
  const firstResponse = await sourceGet(sourceContext(env, "?limit=2"));
  assert.equal(firstResponse.status, 200);
  const first = await jsonBody(firstResponse);
  assert.deepEqual(first.sources.map((source) => source.id), ["source_a", "source_b"]);
  assert.equal(first.sources[0].status, "possible_claim");
  assert.deepEqual({
    acquisition: first.sources[1].acquisitionStatus,
    analysis: first.sources[1].analysisStatus,
    humanReview: first.sources[1].humanReviewStatus,
    publication: first.sources[1].publicStatus,
    compatibility: first.sources[1].status,
  }, {
    acquisition: "acquired", analysis: "not_started", humanReview: "not_ready",
    publication: "not_published", compatibility: "analysis_pending",
  });
  assert.ok(first.nextCursor);
  assert.doesNotMatch(JSON.stringify(first),
    /Private description|Private draft|private-reviewer|r2_key|exact_quote|error_code|model_family/);

  const second = await jsonBody(await sourceGet(sourceContext(env, `?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)));
  assert.deepEqual(second.sources.map((source) => source.id), ["source_c", "source_d"]);
  assert.equal(second.sources[0].status, "source_unavailable");
  assert.equal(second.sources[1].status, "ready_for_human_check");
  assert.equal(second.sources[1].humanReviewStatus, "ready");
  assert.ok(second.nextCursor);

  const third = await jsonBody(await sourceGet(sourceContext(env,
    `?limit=2&cursor=${encodeURIComponent(second.nextCursor)}`)));
  assert.deepEqual(third.sources.map((source) => source.id), ["source_e"]);
  assert.equal(third.sources[0].status, "ready_for_human_check");
  assert.equal(third.sources[0].humanReviewStatus, "ready");
  assert.equal(third.sources[0].availability, "unknown");
  assert.equal(third.sources[0].title, "Linked YouTube video");
  assert.equal(third.nextCursor, null);

  const mismatch = await sourceGet(sourceContext(env,
    `?limit=2&status=possible_claim&cursor=${encodeURIComponent(first.nextCursor)}`));
  assert.equal(mismatch.status, 400);
  assert.equal((await jsonBody(mismatch)).code, "cursor_mismatch");
  const staleCursor = Buffer.from(JSON.stringify({
    version: 1, personId: "person_troy_black", status: "all", platform: "all", sort: "newest",
    query: "", date: "2023-01-01", group: 0, id: "source_b",
  })).toString("base64url");
  const stale = await sourceGet(sourceContext(env, `?limit=2&cursor=${staleCursor}`));
  assert.equal(stale.status, 400);
  assert.equal((await jsonBody(stale)).code, "cursor_mismatch");
  assert.equal((await sourceGet(sourceContext(env, "?limit=51"))).status, 400);
});

test("analysis failures stay separate from acquisition and never create review readiness", async () => {
  const env = makeEnv(); seedInventory(env);
  const db = env.DB.db;
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("run_analysis_b", "person_troy_black", "manual", "analysis:test",
      "complete_with_errors", "2026-07-20", "2026-07-20", 1, "2026-07-20");
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,prompt_version,
     section_count,completed_section_count,failed_section_count,status,created_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("analysis_b", "run_analysis_b", "transcript_b", "source_b",
      "b".repeat(64), "test-v1", 1, 0, 1, "failed", "2026-07-20", "2026-07-20");

  const source = (await jsonBody(await sourceGet(sourceContext(env, "?q=Another")))).sources[0];
  assert.equal(source.acquisitionStatus, "acquired");
  assert.equal(source.analysisStatus, "needs_attention");
  assert.equal(source.humanReviewStatus, "not_ready");
  assert.equal(source.status, "analysis_pending");
});

test("a disposition reports unavailable acquisition without leaking its internal reason", async () => {
  const env = makeEnv(); const db = env.DB.db;
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
    VALUES (?,?,?,?,?,?,?,?)`).run("source_quarantine", "person_troy_black", "youtube", "Unavailable1",
      "https://www.youtube.com/watch?v=Unavailable1", "2026-07-20", "2026-07-20", "unknown");
  db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,completed_item_count,pause_reason,resume_after,
     created_at,started_at,paused_at,transition_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("batch_quarantine", "idem_quarantine", "person_troy_black",
      "paused", 1, 0, "youtube_data_api_video_not_found", "2026-07-21", "2026-07-20",
      "2026-07-20", "2026-07-20", 0);
  db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,ordinal,status)
    VALUES (?,?,?,?,?,?)`).run("batch_item_quarantine", "batch_quarantine", "source_quarantine",
      "Unavailable1", 1, "pending");
  db.prepare(`INSERT INTO transcript_batch_item_dispositions
    (disposition_id,batch_id,batch_item_id,source_item_id,disposition,link_availability,reason_code,
     observed_error_code,expected_transition_count,applied_transition_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("disposition_quarantine", "batch_quarantine",
      "batch_item_quarantine", "source_quarantine", "source_unavailable", "unavailable",
      "youtube_video_not_found", "youtube_data_api_video_not_found", 0, 1, "2026-07-20");

  const source = (await jsonBody(await sourceGet(sourceContext(env, "?platform=youtube")))).sources[0];
  assert.deepEqual({ acquisition: source.acquisitionStatus, analysis: source.analysisStatus,
    humanReview: source.humanReviewStatus, publication: source.publicStatus, status: source.status }, {
    acquisition: "quarantined_source_unavailable", analysis: "not_started",
    humanReview: "not_ready", publication: "not_published", status: "source_unavailable",
  });
  assert.doesNotMatch(JSON.stringify(source), /youtube_data_api|reason|disposition|batch_item|idempotency/i);
});

test("source filters and search treat wildcard characters literally", async () => {
  const env = makeEnv();
  seedInventory(env);
  const possible = await jsonBody(await sourceGet(sourceContext(env, "?status=possible_claim")));
  assert.deepEqual(possible.sources.map((source) => source.id), ["source_a"]);
  const pendingAnalysis = await jsonBody(await sourceGet(sourceContext(env, "?status=analysis_pending")));
  assert.deepEqual(pendingAnalysis.sources.map((source) => source.id), ["source_b"]);
  const percent = await jsonBody(await sourceGet(sourceContext(env, "?q=%25")));
  assert.deepEqual(percent.sources.map((source) => source.id), ["source_a"]);
  const badCursor = await sourceGet(sourceContext(env, "?cursor=not-json"));
  assert.equal(badCursor.status, 400);
  assert.equal((await jsonBody(badCursor)).code, "invalid_cursor");
});
