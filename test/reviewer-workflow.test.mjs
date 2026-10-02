import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReview } from "../functions/lib/claims.js";
import { normalizeArchiveDecision } from "../functions/lib/archive-review-workflow.js";
import { bridgeSupportedObservation } from "../functions/lib/archive-conveyor.js";
import { onRequestGet as personGet } from "../functions/api/people/[slug].js";
import { onRequestGet as queueGet } from "../functions/api/review/queue.js";
import {
  onRequestGet as archiveQueueGet, onRequestPost as archiveQueuePost,
} from "../functions/api/review/archive/queue.js";
import { onRequestPost as archiveReviewPost } from "../functions/api/review/archive/[id].js";
import { onRequestGet as reviewGet, onRequestPost as reviewPost } from "../functions/api/review/[id].js";
import {
  leaseReviewWork, reconcileNeededPublications, reconcilePublication, submitAssignedClaimReview,
  switchLease,
} from "../functions/lib/review-workflow.js";
import { context, jsonBody, makeEnv } from "./helpers/d1.mjs";

const CLAIM_ID = "southeast-asia-oil-2021";
const headers = (token) => ({ "x-demo-reviewer-token": token });

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function groundingJson(values, contextStart, contextEnd) {
  return JSON.stringify({ contextStart, contextEnd, dimensions: Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, value === "Not stated" ? {
      value, supportQuote: null, supportStart: null, supportEnd: null,
    } : { value, supportQuote: value, supportStart: contextStart, supportEnd: contextStart + value.length }]),
  ) });
}

function seedCandidate(env) {
  const db = env.DB.db;
  const gateVersion = "transcript-claims-v4-grounded-5w1h";
  const transcriptSha = "c".repeat(64);
  const sectionSha = "b".repeat(64);
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("run_candidate", "person_troy_black", "canary", "candidate-test",
      "complete", "2026-07-20T10:00:00Z", "2026-07-20T10:05:00Z", 0, "2026-07-20T10:00:00Z");
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,
     first_discovered_at,last_seen_at,availability) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("source_candidate", "person_troy_black", null, "youtube", "ZidiIdg3U4M",
    "https://www.youtube.com/watch?v=ZidiIdg3U4M", "2026-07-20T10:00:00Z",
    "2026-07-20T10:00:00Z", "available");
  db.prepare(`INSERT INTO source_item_revisions
    (revision_id,source_item_id,content_sha256,canonical_url,public_title,first_party_description,
     publication_date,embedded_platform,embedded_item_id,embedded_url,fetched_at,parser_version,source_run_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("revision_candidate", "source_candidate", "a".repeat(64),
      "https://www.youtube.com/watch?v=ZidiIdg3U4M", "Candidate source title", null,
      "2020-09-10", null, null, null, "2026-07-20T10:01:00Z", "test-v1", "run_candidate");
  db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run("transcript_candidate", "source_candidate", "test/transcript-candidate.json",
    transcriptSha, 300, "en", 1, "test_verified_transcript", "test:reviewer-workflow",
    "2026-07-20T10:01:30Z");
  db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,transcript_id,input_kind,input_sha256,prompt_version,
     model_family,status,started_at,completed_at,transcript_quality)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("extract_candidate", "source_candidate", "transcript_candidate",
      "verified_transcript", sectionSha, gateVersion, "workers-ai", "completed",
      "2026-07-20T10:02:00Z", "2026-07-20T10:03:00Z", "gemini_generated_needs_human_check");
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,completed_section_count,failed_section_count,status,
     created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run("analysis_candidate", "run_candidate", "transcript_candidate", "source_candidate",
    transcriptSha, gateVersion, 1, 1, 0, "completed",
    "2026-07-20T10:01:45Z", "2026-07-20T10:03:00Z");
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,extraction_run_id,status,attempt_count,completed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("analysis_section_candidate", "analysis_candidate", 0,
      sectionSha, 0, 120, "extract_candidate", "completed", 1,
      "2026-07-20T10:03:00Z", "2026-07-20T10:01:45Z");
  const quote = "A measurable event will happen by Friday.";
  db.prepare(`INSERT INTO claim_candidates
    (candidate_id,extraction_run_id,source_item_id,candidate_kind,neutral_paraphrase,
     exact_quote,quote_start,quote_end,source_timestamp_seconds,proposed_statement_type,
     atomic_proposition_draft,explicit_deadline_text,requires_transcript,requires_human_review,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("candidate_exact", "extract_candidate",
      "source_candidate", "exact_transcript_claim", "A bounded event was predicted.", quote,
      100, 100 + quote.length, 125, "testable_prediction", "A measurable event will happen.",
      "by Friday", 0, 1, "2026-07-20T10:03:00Z");
  db.prepare(`INSERT INTO candidate_admissibility_assessments
    (assessment_id,candidate_id,gate_version,decision,who_text,what_text,why_text,
     where_text,when_text,how_text,how_specificity,public_evidence_text,pass_condition_text,
     fail_condition_text,grounding_json,rejection_codes_json,assessed_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("assessment_candidate", "candidate_exact",
      gateVersion, "eligible", "The speaker", "a measurable event",
      "the stated reason", "the stated place", "by Friday", "the stated method", "stated",
      "Public records for the event", "Records show the event by Friday",
      "Records show no event by Friday", groundingJson({ who: "The speaker", what: "a measurable event",
        why: "the stated reason", where: "the stated place", when: "by Friday", how: "the stated method" }, 100, 200),
      "[]", "workers-ai:test", "2026-07-20T10:03:01Z");
  db.prepare(`INSERT INTO candidate_atomic_readiness
    (readiness_id,candidate_id,analysis_section_id,transcript_id,source_item_id,gate_version,
     state,material_proposition_count,transcript_sha256,section_sha256,source_sha256,
     source_identity_json,quote_start,quote_end,context_start,context_end,section_start,
     section_end,clip_start_seconds,clip_end_seconds,support_offsets_json,reason_codes_json,
     assessed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run("readiness_candidate", "candidate_exact", "analysis_section_candidate", "transcript_candidate",
    "source_candidate", gateVersion, "review_ready", 1, transcriptSha, sectionSha, "a".repeat(64),
    JSON.stringify({ personId: "person_troy_black", platform: "youtube", platformItemId: "ZidiIdg3U4M",
      canonicalUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M" }),
    100, 100 + quote.length, 90, 200, 0, 300, 120, 180, "{}", "[]",
    "test:reviewer-workflow", "2026-07-20T10:03:02Z");
}

function seedArchiveWork(env, suffix = "one") {
  const db = env.DB.db;
  const now = `2026-07-20T11:0${suffix === "one" ? "0" : "1"}:00Z`;
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(`run_archive_${suffix}`, "person_troy_black", "manual",
      `archive-test-${suffix}`, "complete", now, now, 0, now);
  for (const [ordinal, youtubeId] of [[1, `archiveVideo${suffix}A`], [2, `archiveVideo${suffix}B`]]) {
    db.prepare(`INSERT INTO source_items
      (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,
       first_discovered_at,last_seen_at,availability) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(`source_archive_${suffix}_${ordinal}`, "person_troy_black", "source_troy_archive",
      "youtube", youtubeId, `https://www.youtube.com/watch?v=${youtubeId}`, now, now, "available");
  }
  db.prepare(`INSERT INTO first_party_archive_receipts
    (receipt_id,run_id,source_id,person_id,adapter,source_url,response_sha256,
     row_count,parser_version,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(`archive_receipt_${suffix}`, `run_archive_${suffix}`, "source_troy_archive",
    "person_troy_black", "wptb_fulfilled_prophecy_v1",
    "https://troyblackvideos.com/prophecy-archive-all/", "a".repeat(64), 1,
    "archive-test-v1", now);
  db.prepare(`INSERT INTO first_party_archive_leads
    (archive_lead_id,source_id,person_id,publisher_element_id,created_at) VALUES (?,?,?,?,?)`
  ).run(`archive_lead_${suffix}`, "source_troy_archive", "person_troy_black",
    `wptb-row-${suffix}`, now);
  for (const [revision, hash] of [["old", "b"], ["current", "c"]]) {
    db.prepare(`INSERT INTO first_party_archive_lead_revisions
      (archive_revision_id,archive_lead_id,receipt_id,content_sha256,source_locator_y_index,
       description_text,date_shared_text,prophecy_text,claimed_result_text,
       claimed_evidence_text,parser_version,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(`archive_revision_${suffix}_${revision}`, `archive_lead_${suffix}`,
      `archive_receipt_${suffix}`, hash.repeat(64), 7,
      revision === "current" ? "Specific regional event" : "Earlier archive wording",
      "January 2020", revision === "current" ? "A named event will occur in the region this year."
        : "An earlier wording remains preserved.", "The archive says the event occurred.",
      "The archive links a follow-up article.", "archive-test-v1",
      revision === "current" ? "2026-07-20T11:05:00Z" : now);
  }
  for (const ordinal of [1, 2]) {
    db.prepare(`INSERT INTO first_party_archive_revision_links
      (archive_link_id,archive_revision_id,link_role,ordinal,label,url,youtube_id,
       source_item_id,provenance) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(`archive_link_${suffix}_${ordinal}`, `archive_revision_${suffix}_current`,
      "original_video", ordinal, `Original video ${ordinal}`,
      `https://www.youtube.com/watch?v=archiveVideo${suffix}${ordinal === 1 ? "A" : "B"}`,
      `archiveVideo${suffix}${ordinal === 1 ? "A" : "B"}`, `source_archive_${suffix}_${ordinal}`,
      "first_party_claimed_original");
  }
  db.prepare(`INSERT INTO first_party_archive_revision_links
    (archive_link_id,archive_revision_id,link_role,ordinal,label,url,youtube_id,
     source_item_id,provenance) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(`archive_follow_up_${suffix}`, `archive_revision_${suffix}_current`,
    "claimed_follow_up", 1, "Speaker follow-up video",
    "https://www.youtube.com/watch?v=followUpVideo1", "followUpVideo1", null,
    "first_party_claimed_follow_up");
  db.prepare(`INSERT INTO first_party_archive_revision_links
    (archive_link_id,archive_revision_id,link_role,ordinal,label,url,youtube_id,
     source_item_id,provenance) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(`archive_evidence_${suffix}`, `archive_revision_${suffix}_current`,
    "claimed_evidence", 1, "Speaker-linked follow-up", "https://example.test/follow-up",
    null, null, "first_party_claimed_evidence");
  db.prepare(`INSERT INTO archive_verification_work_items
    (archive_work_item_id,archive_revision_id,archive_video_link_id,status,created_at)
    VALUES (?,?,?,?,?)`).run(`archive_work_${suffix}`, `archive_revision_${suffix}_current`,
    `archive_link_${suffix}_1`, "ready", now);
}

function supportedArchiveBody(overrides = {}) {
  return {
    workType: "archive_lead_verification", decision: "source_supported",
    rationale: "The selected source and surrounding context explicitly support this bounded statement.",
    sourceAvailable: true, contextVerified: true, exactSourceVerified: true, testable: true,
    exactSourceQuote: "A named event will occur in the region this year.",
    sourceTimestampSeconds: 83,
    who: "The named institution", whoSourceBasis: "the named institution",
    what: "will complete the event", whatSourceBasis: "will complete the event",
    why: "because the stated condition occurs", whySourceBasis: "because the stated condition occurs",
    where: "in the named region", whereSourceBasis: "in the named region",
    when: "during this year", whenSourceBasis: "during this year",
    how: "", howSourceBasis: "",
    publicEvidenceNote: "A dated independent public record of the named event.",
    passConditionNote: "The independent record shows the event during the stated year.",
    failConditionNote: "The independent record shows no event by the end of the stated year.",
    ...overrides,
  };
}

function groundedPromotion() {
  const values = { who: "The speaker", what: "a measurable event", why: "the stated reason",
    where: "the stated place", when: "by Friday", how: "Not stated" };
  return {
    ...values,
    claimElements: Object.fromEntries(Object.entries(values).map(([name, value]) =>
      [name, { value, sourceBasis: name === "how" ? "" : `Verified source wording for ${name}: ${value}` }])),
    publicEvidence: "Public records for the event",
    passCondition: "Records show the event happened by Friday",
    failCondition: "Records show the event did not happen by Friday",
    publicEvidenceSourceBasis: "The source identifies an externally observable event.",
    passConditionSourceBasis: "The quote supplies the event and bounded Friday deadline.",
    failConditionSourceBasis: "Failure is the absence of that event by the same deadline.",
  };
}

function seedPublicationEvidence(env) {
  const insert = env.DB.db.prepare(`INSERT INTO evidence
    (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,source_role,
     note,search_query,cutoff_date,created_at,verification_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("original_verified", CLAIM_ID, "original_statement", "https://example.test/transcript",
    "Authorized transcript", "2020-09-10", "2026-07-20", "platform", "Verified fixture.",
    null, null, "2026-07-20", "authorized_transcript");
  insert.run("outcome_independent", CLAIM_ID, "independent_outcome", "https://example.test/outcome",
    "Independent outcome", "2022-01-01", "2026-07-20", "independent", "Outcome fixture.",
    null, null, "2026-07-20", "unverified");
}

const claimReview = () => ({
  claimType: "testable_prediction", outcomeStatus: "false", noveltyStatus: "not_assessed",
  baselineProbability: "", priorReceiptId: "", evidenceIds: ["original_verified", "outcome_independent"],
  rationale: "The verified source and independent outcome satisfy the frozen criteria.",
});

async function queue(env, token) {
  const response = await queueGet(context({ env, url: "http://localhost/api/review/queue", headers: headers(token) }));
  assert.equal(response.status, 200);
  return jsonBody(response);
}

async function archiveQueue(env, token) {
  const response = await archiveQueueGet(context({
    env, url: "http://localhost/api/review/archive/queue", headers: headers(token),
  }));
  assert.equal(response.status, 200);
  return jsonBody(response);
}

async function openArchiveWork(env, token, workItemId) {
  const response = await archiveQueuePost(context({
    env, url: "http://localhost/api/review/archive/queue", method: "POST",
    headers: headers(token), body: { leaseArchiveWorkItemId: workItemId },
  }));
  assert.equal(response.status, 201, await response.clone().text());
  return (await jsonBody(response)).assignment;
}

test("claim and candidate work stays prioritized while archive source versions remain explicitly openable", async () => {
  const env = makeEnv({ demo: true });
  seedCandidate(env);
  seedArchiveWork(env);
  const queued = await queue(env, "alpha-token");
  assert.equal(queued.assignments[0].workType, "candidate_verification");
  const archiveAssignment = await openArchiveWork(env, "alpha-token", "archive_work_one");
  assert.equal(archiveAssignment.workType, "archive_lead_verification");
  assert.equal(archiveAssignment.archiveRevisionId, "archive_revision_one_current");
  assert.doesNotMatch(JSON.stringify(queued), /prophecy_text|claimed_result_text|reviewer_alpha/);

  const assignmentId = archiveAssignment.assignmentId;
  const detailResponse = await reviewGet(context({
    env, url: `http://localhost/api/review/${assignmentId}`, params: { id: assignmentId },
    headers: headers("alpha-token"),
  }));
  const detail = await jsonBody(detailResponse);
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.workType, "archive_lead_verification");
  assert.equal(detail.assignedSourceVersion.archiveLinkId, "archive_link_one_1");
  assert.equal(detail.originalVideoLinks.length, 2);
  assert.equal(detail.originalVideoLinks.filter((link) => link.assigned).length, 1);
  assert.equal(detail.originalVideoLinks[0].linkRole, "original_video");
  assert.equal(detail.claimedFollowUpLinks.length, 1);
  assert.equal(detail.claimedFollowUpLinks[0].linkRole, "claimed_follow_up");
  assert.equal(detail.claimedEvidenceLinks.length, 1);
  assert.equal(detail.claimedEvidenceLinks[0].linkRole, "claimed_evidence");
  assert.equal(detail.archiveVersions.length, 2);
  assert.deepEqual(detail.boundary, {
    firstPartyRetrospectiveOnly: true, claimedEvidenceIsIndependent: false,
    oneOriginalSourceVersionOnly: true, canCreateClaimOrRating: false,
    crossVideoSynthesisAllowed: false,
  });
  assert.match(detail.subject.claimed_result_text, /archive says/i);
  assert.doesNotMatch(JSON.stringify(detail), /transcript_body|r2_key|raw_ai|reviewer_alpha/);

  const stolen = await reviewGet(context({
    env, url: `http://localhost/api/review/${assignmentId}`, params: { id: assignmentId },
    headers: headers("beta-token"),
  }));
  assert.equal(stolen.status, 404);
});

test("explicit archive switching returns the requested item and revives released identity immutably", async () => {
  const env = makeEnv({ demo: true });
  seedArchiveWork(env, "one");
  seedArchiveWork(env, "two");
  const initialQueue = await archiveQueue(env, "alpha-token");
  assert.equal((initialQueue.assignments || []).filter((item) => item.status === "leased").length, 0);
  const first = initialQueue.available.find((item) => !item.taken);
  const requested = initialQueue.available.find((item) => !item.taken && item.workItemId !== first?.workItemId);
  assert.ok(first?.workItemId);
  assert.ok(requested?.workItemId);
  const initial = await openArchiveWork(env, "alpha-token", first.workItemId);
  const before = env.DB.db.prepare(
    `SELECT archive_assignment_id,assigned_at,lease_version
     FROM archive_review_assignments WHERE archive_work_item_id=? AND reviewer_id='reviewer_alpha'`,
  ).get(initial.workItemId);

  const switched = await openArchiveWork(env, "alpha-token", requested.workItemId);
  assert.equal(switched.workItemId, requested.workItemId);
  assert.notEqual(switched.assignmentId, initial.assignmentId);
  assert.equal(env.DB.db.prepare(
    "SELECT status FROM archive_review_assignments WHERE archive_assignment_id=?",
  ).get(initial.assignmentId).status, "released");

  const revived = await openArchiveWork(env, "alpha-token", initial.workItemId);
  assert.equal(revived.workItemId, initial.workItemId);
  assert.equal(revived.assignmentId, before.archive_assignment_id);
  const after = env.DB.db.prepare(
    `SELECT assigned_at,lease_version,status FROM archive_review_assignments
     WHERE archive_assignment_id=?`,
  ).get(before.archive_assignment_id);
  assert.equal(after.assigned_at, before.assigned_at);
  assert.ok(after.lease_version > before.lease_version);
  assert.equal(after.status, "leased");

  const missing = await archiveQueuePost(context({
    env, url: "http://localhost/api/review/archive/queue", method: "POST",
    headers: headers("alpha-token"),
    body: { leaseArchiveWorkItemId: "archive_work_missing" },
  }));
  assert.equal(missing.status, 409);
  assert.equal((await jsonBody(missing)).code, "archive_lease_unavailable");
  assert.equal(env.DB.db.prepare(
    "SELECT status FROM archive_review_assignments WHERE archive_assignment_id=?",
  ).get(revived.assignmentId).status, "leased");
});

test("supported archive decisions require exact 5W1H grounding and append an observation without creating a claim", async () => {
  const env = makeEnv({ demo: true });
  seedArchiveWork(env);
  const assignment = await openArchiveWork(env, "alpha-token", "archive_work_one");
  const claimsBefore = env.DB.db.prepare("SELECT count(*) count FROM claims").get().count;
  const bypass = await reviewPost(context({
    env, url: `http://localhost/api/review/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: supportedArchiveBody(),
  }));
  assert.equal(bypass.status, 409);
  assert.equal((await jsonBody(bypass)).code, "archive_route_required");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM archive_review_decisions").get().count, 0);

  const incomplete = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: supportedArchiveBody({ who: "Not stated", whoSourceBasis: "" }),
  }));
  assert.equal(incomplete.status, 400);
  assert.equal((await jsonBody(incomplete)).code, "archive_who_required");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM archive_review_decisions").get().count, 0);

  const accepted = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: supportedArchiveBody(),
  }));
  const result = await jsonBody(accepted);
  assert.equal(accepted.status, 201);
  assert.equal(result.decision, "source_supported");
  assert.equal(result.claimCreated, false);
  assert.equal(result.ratingCreated, false);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claims").get().count, claimsBefore);
  const observation = env.DB.db.prepare(
    `SELECT context_confirmed,exact_source_quote,source_timestamp_seconds,who_text,
      why_source_basis,how_text,public_evidence_note,pass_condition_note,fail_condition_note
     FROM archive_review_observations`
  ).get();
  assert.equal(observation.context_confirmed, 1);
  assert.equal(observation.source_timestamp_seconds, 83);
  assert.equal(observation.who_text, "The named institution");
  assert.equal(observation.how_text, null);
  assert.notEqual(observation.pass_condition_note, observation.fail_condition_note);
  assert.equal(env.DB.db.prepare(
    "SELECT check_status FROM archive_review_source_checks WHERE check_name='how'"
  ).get().check_status, "not_stated");
  assert.throws(() => env.DB.db.exec(
    "UPDATE archive_review_observations SET who_text='changed'"
  ), /append-only/);
  assert.throws(() => env.DB.db.exec("DELETE FROM archive_review_observations"), /append-only/);
});

test("matched supported archive review creates an atomically source-bound candidate", async () => {
  const env = makeEnv({ demo: true });
  seedArchiveWork(env);
  const quote = supportedArchiveBody().exactSourceQuote;
  const transcript = `[CLIP 00:01:00-00:03:00 | GEMINI-GENERATED, NEEDS HUMAN CHECK]\n${quote}\n`
    + `the named institution\nwill complete the event\nbecause the stated condition occurs\n`
    + `in the named region\nduring this year\n`;
  const transcriptSha = await sha256Hex(transcript);
  const quoteStart = transcript.indexOf(quote);
  const transcriptId = "transcript_archive_one_1";
  const artifactKey = "test/archive-one-transcript.txt";
  env.DB.db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(transcriptId, "source_archive_one_1", artifactKey, transcriptSha,
    new TextEncoder().encode(transcript).byteLength, "en", 1,
    "test_verified_transcript", "test:archive-conveyor", "2026-07-20T11:06:00Z");
  env.DB.db.prepare(`INSERT INTO archive_transcript_match_checks
    (archive_match_check_id,archive_revision_id,archive_video_link_id,transcript_id,
     source_item_id,prophecy_sha256,matcher_version,transcript_sha256,match_status,
     match_method,exact_quote,quote_start,quote_end,approximate_clip_start_seconds,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run("archive_match_one_1", "archive_revision_one_current", "archive_link_one_1",
    transcriptId, "source_archive_one_1", "c".repeat(64), "whole_cell_v1", transcriptSha,
    "matched_exact", "exact_text_v1", quote, quoteStart, quoteStart + quote.length, 60,
    "2026-07-20T11:07:00Z");
  const assignment = await openArchiveWork(env, "alpha-token", "archive_work_one");
  env.ARTIFACTS = { get: async () => null };
  const unavailable = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: supportedArchiveBody(),
  }));
  assert.equal(unavailable.status, 503);
  assert.equal((await jsonBody(unavailable)).code, "archive_conveyor_unavailable");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM archive_review_decisions").get().count, 0);
  assert.equal(env.DB.db.prepare(
    "SELECT status FROM archive_review_assignments WHERE archive_assignment_id=?",
  ).get(assignment.assignmentId).status, "leased");
  assert.equal(env.DB.db.prepare(
    "SELECT status FROM archive_verification_work_items WHERE archive_work_item_id='archive_work_one'",
  ).get().status, "ready");

  env.ARTIFACTS = {
    get: async (key) => key === artifactKey ? { text: async () => transcript } : null,
  };
  const mismatched = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: supportedArchiveBody({ exactSourceQuote: "A different source quotation." }),
  }));
  assert.equal(mismatched.status, 409);
  assert.equal((await jsonBody(mismatched)).code, "review_quote_receipt_mismatch");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM archive_review_decisions").get().count, 0);

  const badTimestamp = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: supportedArchiveBody({ sourceTimestampSeconds: 180 }),
  }));
  assert.equal(badTimestamp.status, 409);
  assert.equal((await jsonBody(badTimestamp)).code, "review_timestamp_outside_section");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM archive_review_decisions").get().count, 0);

  const accepted = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: supportedArchiveBody(),
  }));
  const result = await jsonBody(accepted);
  assert.equal(accepted.status, 201);
  assert.equal(result.conveyor.bridged, true);
  const readiness = env.DB.db.prepare(`SELECT state,source_identity_json
    FROM candidate_atomic_readiness WHERE readiness_id=?`).get(result.conveyor.readinessId);
  assert.equal(readiness.state, "review_ready");
  assert.deepEqual(JSON.parse(readiness.source_identity_json), {
    personId: "person_troy_black",
    platform: "youtube",
    platformItemId: "archiveVideooneA",
    canonicalUrl: "https://www.youtube.com/watch?v=archiveVideooneA",
  });
  const queued = await queue(env, "beta-token");
  assert.ok(queued.assignments.some((item) =>
    item.workType === "candidate_verification" && item.candidateId === result.conveyor.candidateId));

  const repeated = await bridgeSupportedObservation(env.DB, env.ARTIFACTS, {
    archiveRevisionId: "archive_revision_one_current",
    archiveVideoLinkId: "archive_link_one_1",
    decisionId: "archive_decision_repeat",
    observationId: "archive_observation_repeat",
    decision: normalizeArchiveDecision(supportedArchiveBody()),
    now: "2026-07-20T11:09:00Z",
  });
  assert.equal(repeated.bridged, true);
  assert.equal(env.DB.db.prepare(
    `SELECT count(*) count FROM review_ready_claim_candidates
     WHERE candidate_id IN (?,?)`,
  ).get(result.conveyor.candidateId, repeated.candidateId).count, 2);
});

test("negative archive outcomes require consistent source checks and cannot masquerade as supported framing", async () => {
  const env = makeEnv({ demo: true });
  seedArchiveWork(env);
  const assignment = await openArchiveWork(env, "alpha-token", "archive_work_one");
  const mislabeled = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: { workType: "archive_lead_verification", decision: "archive_mismatch",
      rationale: "The available source context does not contain the archive wording.",
      sourceAvailable: true, contextVerified: true, exactSourceVerified: true, testable: false,
      exactSourceQuote: "Different source wording." },
  }));
  assert.equal(mislabeled.status, 400);
  assert.equal((await jsonBody(mislabeled)).code, "archive_mismatch_cannot_be_supported");

  const accepted = await archiveReviewPost(context({
    env, url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"),
    body: { workType: "archive_lead_verification", decision: "archive_mismatch",
      rationale: "The available source context does not contain the archive wording.",
      sourceAvailable: true, contextVerified: true, exactSourceVerified: false, testable: false,
      exactSourceQuote: "Different source wording.", sourceTimestampSeconds: 20 },
  }));
  assert.equal(accepted.status, 201);
  assert.equal((await jsonBody(accepted)).decision, "archive_mismatch");
  assert.equal(env.DB.db.prepare(
    "SELECT check_status FROM archive_review_source_checks WHERE check_name='exact_source'"
  ).get().check_status, "not_supported");
  const observation = env.DB.db.prepare("SELECT * FROM archive_review_observations").get();
  assert.equal(observation.who_text, null);
  assert.equal(observation.public_evidence_note, null);
});

test("candidate queue is minimal; assigned detail is bounded; confirmed promotion is explicit and append-only", async () => {
  const env = makeEnv({ demo: true });
  seedCandidate(env);
  const queued = await queue(env, "alpha-token");
  assert.equal(queued.assignments[0].workType, "candidate_verification");
  assert.equal(queued.assignments[0].candidateId, "candidate_exact");
  assert.doesNotMatch(JSON.stringify(queued), /A measurable event will happen|transcript_body|r2_key|reviewer_alpha/);

  const assignmentId = queued.assignments[0].assignmentId;
  const detailResponse = await reviewGet(context({
    env, url: `http://localhost/api/review/${assignmentId}`, params: { id: assignmentId },
    headers: headers("alpha-token"),
  }));
  const detail = await jsonBody(detailResponse);
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.subject.exact_quote, "A measurable event will happen by Friday.");
  assert.equal(detail.subject.transcript_quality, "gemini_generated_needs_human_check");
  assert.doesNotMatch(JSON.stringify(detail), /transcript_body|r2_key|reviewer_alpha/);

  const promoted = await reviewPost(context({
    env, url: `http://localhost/api/review/${assignmentId}`, method: "POST", params: { id: assignmentId },
    headers: headers("alpha-token"), body: {
      workType: "candidate_verification", decision: "promote",
      rationale: "I checked the exact quotation and surrounding context in the original public video.",
      originalSourceVerified: true, contextVerified: true,
      title: "Measurable event by Friday", statementType: "testable_prediction",
      atomicProposition: "The stated measurable event would happen by the identified Friday.",
      criteria: "Independent records must show the stated event happened by the bounded deadline.",
      deadline: "2020-09-18", ...groundedPromotion(),
    },
  }));
  assert.equal(promoted.status, 201);
  const promotion = await jsonBody(promoted);
  assert.equal(promotion.decision, "promote");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM candidate_review_decisions").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM candidate_claim_promotions").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT visibility FROM claims WHERE claim_id=?").get(promotion.claimId).visibility, "draft");
  assert.equal(env.DB.db.prepare(
    "SELECT count(*) count FROM review_work_items WHERE claim_id=? AND work_type='claim_adjudication'"
  ).get(promotion.claimId).count, 1);
  assert.throws(() => env.DB.db.exec("UPDATE candidate_review_decisions SET rationale='changed'"), /append-only/);
  const decisionFields = JSON.parse(env.DB.db.prepare(
    "SELECT decision_fields_json FROM candidate_review_decisions WHERE candidate_id='candidate_exact'"
  ).get().decision_fields_json);
  assert.equal(decisionFields.claimElements.why.sourceBasis,
    "Verified source wording for why: the stated reason");

  const publicProfile = await jsonBody(await personGet(context({
    env, url: "https://example.test/api/people/troy-black", params: { slug: "troy-black" },
  })));
  assert.doesNotMatch(JSON.stringify(publicProfile), /reviewer_alpha|I checked the exact quotation|gemini_generated_needs_human_check/);
});

test("assignment ownership and lease expiry are enforced for private reads and writes", async () => {
  const env = makeEnv({ demo: true });
  seedCandidate(env);
  const alpha = (await queue(env, "alpha-token")).assignments[0];
  const stolen = await reviewGet(context({
    env, url: `http://localhost/api/review/${alpha.assignmentId}`, params: { id: alpha.assignmentId },
    headers: headers("beta-token"),
  }));
  assert.equal(stolen.status, 404);
  env.DB.db.prepare("UPDATE review_assignments SET lease_expires_at=? WHERE assignment_id=?")
    .run("2000-01-01T00:00:00Z", alpha.assignmentId);
  const expired = await reviewGet(context({
    env, url: `http://localhost/api/review/${alpha.assignmentId}`, params: { id: alpha.assignmentId },
    headers: headers("alpha-token"),
  }));
  assert.equal(expired.status, 404);
  const reassigned = (await queue(env, "beta-token")).assignments[0];
  assert.equal(reassigned.candidateId, "candidate_exact");
  assert.notEqual(reassigned.assignmentId, alpha.assignmentId);
});

test("a latest quarantined assessment is never materialized or leased as candidate work", async () => {
  const env = makeEnv({ demo: true }); seedCandidate(env);
  env.DB.db.prepare(`INSERT INTO candidate_admissibility_assessments
    (assessment_id,candidate_id,gate_version,decision,how_specificity,grounding_json,rejection_codes_json,assessed_by,created_at)
    VALUES ('assessment_quarantine','candidate_exact','gate-v5','quarantined','not_stated','{}',
      '["manual_safety_quarantine"]','system:test','2026-07-20T10:04:00Z')`).run();
  const result = await queue(env, "alpha-token");
  assert.ok(result.assignments.every((assignment) => assignment.candidateId === null));
  assert.equal(env.DB.db.prepare(
    "SELECT count(*) count FROM review_work_items WHERE candidate_id='candidate_exact'"
  ).get().count, 0);
});

test("a later quarantine immediately removes an already-leased candidate from the reviewer projection", async () => {
  const env = makeEnv({ demo: true }); seedCandidate(env);
  const first = await queue(env, "alpha-token");
  assert.equal(first.assignments[0].candidateId, "candidate_exact");
  env.DB.db.prepare(`INSERT INTO candidate_admissibility_assessments
    (assessment_id,candidate_id,gate_version,decision,how_specificity,grounding_json,rejection_codes_json,assessed_by,created_at)
    VALUES ('assessment_quarantine_after_lease','candidate_exact','gate-v5','quarantined','not_stated','{}',
      '["manual_safety_quarantine"]','system:test','2026-07-20T10:04:00Z')`).run();
  const after = await queue(env, "alpha-token");
  assert.ok(after.assignments.every((assignment) => assignment.candidateId === null));
  const staleDetail = await reviewGet(context({ env,
    url: `http://localhost/api/review/${first.assignments[0].assignmentId}`,
    params: { id: first.assignments[0].assignmentId }, headers: headers("alpha-token") }));
  assert.equal(staleDetail.status, 404);
});

test("promotion fails closed when an essential 5W1H field or its source basis is missing", async () => {
  const env = makeEnv({ demo: true }); seedCandidate(env);
  const assignment = (await queue(env, "alpha-token")).assignments[0];
  const payload = { workType: "candidate_verification", decision: "promote",
    rationale: "I checked the original source and the complete candidate context.",
    originalSourceVerified: true, contextVerified: true,
    title: "Measurable event by Friday", statementType: "testable_prediction",
    atomicProposition: "The stated measurable event would happen by the identified Friday.",
    criteria: "Independent records must show the event by the bounded deadline.",
    deadline: "2020-09-18", ...groundedPromotion(), who: "Not stated" };
  const response = await reviewPost(context({ env, url: `http://localhost/api/review/${assignment.assignmentId}`,
    method: "POST", params: { id: assignment.assignmentId }, headers: headers("alpha-token"), body: payload }));
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).code, "candidate_who_required");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM candidate_review_decisions").get().count, 0);
});

test("candidate rejection records a reasoned append-only decision without creating a claim", async () => {
  const env = makeEnv({ demo: true });
  seedCandidate(env);
  const assignment = (await queue(env, "alpha-token")).assignments[0];
  const before = env.DB.db.prepare("SELECT count(*) count FROM claims").get().count;
  const response = await reviewPost(context({
    env, url: `http://localhost/api/review/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: headers("alpha-token"), body: {
      workType: "candidate_verification", decision: "reject",
      reasonCode: "context_changes_meaning",
      rationale: "The surrounding source context changes the isolated sentence into a non-claim.",
    },
  }));
  assert.equal(response.status, 201);
  assert.equal((await jsonBody(response)).decision, "reject");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claims").get().count, before);
  const stored = env.DB.db.prepare(
    "SELECT decision,decision_fields_json FROM candidate_review_decisions WHERE candidate_id='candidate_exact'"
  ).get();
  assert.equal(stored.decision, "reject");
  assert.deepEqual(JSON.parse(stored.decision_fields_json), { reasonCode: "context_changes_meaning" });
  assert.equal(env.DB.db.prepare(
    "SELECT status FROM review_work_items WHERE candidate_id='candidate_exact'"
  ).get().status, "complete");
});

test("one named human review publishes idempotently after append-only submission", async () => {
  const env = makeEnv({ demo: true });
  seedPublicationEvidence(env);
  const now = new Date().toISOString();
  await leaseReviewWork(env.DB, "reviewer_alpha", env, now);
  const alpha = await switchLease(env.DB, "reviewer_alpha", `work_${CLAIM_ID}`, env, now);
  assert.equal(alpha.claim_id, CLAIM_ID);
  const normalized = normalizeReview(claimReview());
  await submitAssignedClaimReview(env.DB, alpha.assignment_id, "reviewer_alpha", normalized,
    now, null, "Joshua");
  assert.equal(env.DB.db.prepare("SELECT state FROM publication_evaluations WHERE claim_id=?").get(CLAIM_ID).state, "needed");
  assert.equal(env.DB.db.prepare("SELECT visibility FROM claims WHERE claim_id=?").get(CLAIM_ID).visibility, "draft");

  assert.equal(await reconcileNeededPublications(env.DB), 1);
  assert.equal(env.DB.db.prepare("SELECT visibility FROM claims WHERE claim_id=?").get(CLAIM_ID).visibility, "published");
  await reconcilePublication(env.DB, CLAIM_ID);
  await reconcilePublication(env.DB, CLAIM_ID);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claim_revisions WHERE claim_id=?").get(CLAIM_ID).count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claim_events WHERE claim_id=? AND event_type='published'").get(CLAIM_ID).count, 1);
  assert.equal(JSON.parse(env.DB.db.prepare(
    "SELECT decision_json FROM claim_revisions WHERE claim_id=?"
  ).get(CLAIM_ID).decision_json).reviewerNames[0], "Joshua");
});
