/**
 * HARD GATE: every reviewer workflow that persists data must actually persist,
 * and success responses must include receipt ids the UI can show.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as queueGet, onRequestPost as queuePost } from "../functions/api/review/queue.js";
import { onRequestGet as reviewGet, onRequestPost as reviewPost } from "../functions/api/review/[id].js";
import { onRequestGet as feedbackGet, onRequestPost as feedbackPost } from "../functions/api/review/feedback.js";
import { onRequestGet as pendingGet } from "../functions/api/review/pending.js";
import { onRequestGet as scorecardGet } from "../functions/api/review/scorecard.js";
import { onRequestGet as archiveQueueGet } from "../functions/api/review/archive/queue.js";
import { onRequestGet as sourceGet } from "../functions/api/people/[slug]/sources.js";
import { quarantinePendingTranscriptItem } from "../scanner/src/transcript-batch.js";
import { context, jsonBody, makeEnv } from "./helpers/d1.mjs";

const CLAIM_ID = "southeast-asia-oil-2021";
const demoHeaders = (token) => ({ "x-demo-reviewer-token": token });

function seedPublicationEvidence(env) {
  // Seed the exact evidence ids cited by the oil AI draft (migration 0030),
  // with roles/methods that satisfy validateReviewPrerequisites for Accept.
  const insert = env.DB.db.prepare(
    `INSERT INTO evidence
     (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,source_role,
      note,search_query,cutoff_date,created_at,verification_method)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    "evidence_oil_original_video", CLAIM_ID, "original_statement",
    "https://www.youtube.com/watch?v=ZidiIdg3U4M", "Original video",
    "2020-09-10", "2026-07-19", "platform", "Verified transcript fixture.",
    null, null, "2026-07-19", "authorized_transcript",
  );
  insert.run(
    "evidence_oil_rystad_2021", CLAIM_ID, "independent_outcome",
    "https://example.test/rystad", "Independent outcome",
    "2022-01-01", "2026-07-19", "independent", "Independent production data.",
    null, null, "2026-07-19", "unverified",
  );
  insert.run(
    "evidence_oil_prior_iea2017", CLAIM_ID, "contemporaneous_public_information",
    "https://example.test/iea", "Prior IEA",
    "2017-01-01", "2026-07-19", "independent", "Pre-statement public info.",
    "southeast asia oil", "2020-09-10", "2026-07-19", "unverified",
  );
  insert.run(
    "evidence_oil_prior_seainfra2020", CLAIM_ID, "contemporaneous_public_information",
    "https://example.test/seainfra", "Prior SEA infra",
    "2020-01-01", "2026-07-19", "independent", "Pre-statement public info.",
    "southeast asia oil decline", "2020-09-10", "2026-07-19", "unverified",
  );
  // archive row already seeded in 0002 as retrospective_fulfillment.
  env.DB.db.prepare(
    `INSERT INTO prior_information_receipts
     (receipt_id,claim_id,cutoff_date,status,search_queries_json,sources_checked_json,method_note,completed_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    "receipt_oil_20200910", CLAIM_ID, "2020-09-10", "completed",
    '["southeast asia oil boom"]', '["https://example.test/iea","https://example.test/seainfra"]',
    "E2E prior-information sweep for Accept path.",
    "2026-07-19", "2026-07-19",
  );
}

function reviewContext(env, token, assignmentId, { method = "GET", body } = {}) {
  return context({
    env,
    url: `http://127.0.0.1/api/review/${assignmentId}`,
    method,
    body,
    params: { id: assignmentId },
    headers: demoHeaders(token),
  });
}

async function assign(env, token) {
  const response = await queueGet(context({
    env, url: "http://127.0.0.1/api/review/queue", headers: demoHeaders(token),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await jsonBody(response);
  const leased = (body.assignments || []).find((item) => item.status === "leased" && item.workType !== "archive_lead_verification")
    || (body.assignments || []).find((item) => item.status === "leased");
  assert.ok(leased?.assignmentId, `expected leased assignment, got ${JSON.stringify(body).slice(0, 400)}`);
  return leased;
}

const PRESERVATION = {
  batchId: `txb_${"1".repeat(32)}`,
  completedSourceId: `src_${"a".repeat(32)}`,
  unavailableSourceId: `src_${"b".repeat(32)}`,
  successorSourceId: `src_${"c".repeat(32)}`,
  completedItemId: `txbi_${"1".repeat(32)}_${"a".repeat(32)}`,
  unavailableItemId: `txbi_${"1".repeat(32)}_${"b".repeat(32)}`,
  successorItemId: `txbi_${"1".repeat(32)}_${"c".repeat(32)}`,
  publishedClaimId: "preserved-published-claim",
  oilWorkId: "work_southeast-asia-oil-2021",
  oilAssignmentId: "assignment_preserved_oil_alpha",
};

function insertSource(db, sourceItemId, youtubeId, availability = "available") {
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,
     first_discovered_at,last_seen_at,availability)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(sourceItemId, "person_troy_black", "source_troy_site",
      "youtube", youtubeId, `https://www.youtube.com/watch?v=${youtubeId}`,
      "2026-08-03T10:00:00.000Z", "2026-08-03T10:00:00.000Z", availability);
}

function seedPreservationFixture(env) {
  const db = env.DB.db;
  insertSource(db, PRESERVATION.completedSourceId, "KeepDone001");
  insertSource(db, PRESERVATION.unavailableSourceId, "GoneVideo01", "unknown");
  insertSource(db, PRESERVATION.successorSourceId, "NextVideo01");
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("run_preserved_completed", "person_troy_black", "manual",
      `transcript:${PRESERVATION.completedSourceId}:60:batch:${PRESERVATION.batchId}`,
      "complete", "2026-08-03T10:00:00.000Z", "2026-08-03T10:02:00.000Z", 0,
      "2026-08-03T10:00:00.000Z");
  db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at)
    VALUES (?,?,?,?,?,'en',1,'authorized_transcript','reviewer_fixture',?)`)
    .run("transcript_preserved", PRESERVATION.completedSourceId,
      "private/preserved/transcript.txt", "a".repeat(64), 128, "2026-08-03T10:02:00.000Z");
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("run_preserved_analysis", "person_troy_black", "manual",
      "analysis:preservation-e2e", "complete_with_errors", "2026-08-03T10:03:00.000Z",
      "2026-08-03T10:05:00.000Z", 1, "2026-08-03T10:03:00.000Z");
  db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,transcript_id,input_kind,input_sha256,prompt_version,
     model_family,status,started_at,completed_at,transcript_quality)
    VALUES (?,?,?,'verified_transcript',?,'preservation-v1','workers_ai','completed',?,?,?)`)
    .run("extract_preserved_section", PRESERVATION.completedSourceId, "transcript_preserved",
      "b".repeat(64), "2026-08-03T10:03:00.000Z", "2026-08-03T10:04:00.000Z",
      "gemini_generated_needs_human_check");
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,completed_section_count,failed_section_count,status,
     created_at,completed_at)
    VALUES (?,?,?,?,?,'preservation-v1',2,1,1,'partial',?,NULL)`)
    .run("analysis_preserved", "run_preserved_analysis", "transcript_preserved",
      PRESERVATION.completedSourceId, "a".repeat(64), "2026-08-03T10:03:00.000Z");
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,extraction_run_id,status,attempt_count,error_code,
     started_at,completed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("analysis_section_preserved_complete",
      "analysis_preserved", 0, "c".repeat(64), 0, 0, "extract_preserved_section", "completed", 1,
      null, "2026-08-03T10:03:00.000Z", "2026-08-03T10:04:00.000Z",
      "2026-08-03T10:03:00.000Z");
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,extraction_run_id,status,attempt_count,error_code,
     started_at,completed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("analysis_section_preserved_failed",
      "analysis_preserved", 1, "d".repeat(64), 64, 30, null, "failed", 3,
      "model_unavailable", "2026-08-03T10:04:00.000Z", "2026-08-03T10:05:00.000Z",
      "2026-08-03T10:03:00.000Z");

  const sourceUrl = "https://www.youtube.com/watch?v=KeepDone001";
  db.prepare(`INSERT INTO claims
    (claim_id,person_id,video_id,cluster_id,title,exact_quote,source_url,source_date,
     source_timestamp_seconds,transcript_warning,statement_type,atomic_proposition,criteria,
     deadline,as_of_date,lifecycle_status,proposed_outcome,outcome_status,novelty_status,
     baseline_probability,score_eligible,visibility,created_at)
    VALUES (?, 'person_troy_black',NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,
      'true','no_precursor_found',0.2,1,'draft',?)`).run(PRESERVATION.publishedClaimId,
      "cluster_preserved", "Preserved published claim", "A bounded event will occur.", sourceUrl,
      "2025-01-01", 12, "Human-verified preservation fixture.", "testable_prediction",
      "A bounded event occurred.", "Independent evidence confirms the bounded event.",
      "2025-12-31", "2026-08-03", "resolved", "2026-08-03T10:06:00.000Z");
  db.prepare(`INSERT INTO evidence
    (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,source_role,note,
     search_query,cutoff_date,created_at,verification_method)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("evidence_preserved_original",
      PRESERVATION.publishedClaimId, "original_statement", sourceUrl, "Preserved original",
      "2025-01-01", "2026-08-03", "platform", "Verified original statement.", null, null,
      "2026-08-03T10:06:00.000Z", "authorized_transcript");
  db.prepare(`INSERT INTO evidence
    (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,source_role,note,
     search_query,cutoff_date,created_at,verification_method)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("evidence_preserved_outcome",
      PRESERVATION.publishedClaimId, "independent_outcome", "https://example.test/outcome",
      "Preserved independent outcome", "2026-01-01", "2026-08-03", "independent",
      "Independent outcome evidence.", null, null, "2026-08-03T10:06:00.000Z", "unverified");
  db.prepare(`INSERT INTO review_work_items
    (work_item_id,claim_id,origin_kind,work_type,status,required_matching_reviews,max_reviews,created_at)
    VALUES (?,?, 'existing_ledger_claim','claim_adjudication','ready',2,4,?)`)
    .run("work_preserved_published", PRESERVATION.publishedClaimId, "2026-08-03T10:06:00.000Z");
  for (const [suffix, reviewer] of [["one", "reviewer_preserved_one"], ["two", "reviewer_preserved_two"]]) {
    db.prepare(`INSERT INTO review_assignments
      (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at)
      VALUES (?,?,?,'leased',?,?)`).run(`assignment_preserved_${suffix}`,
      "work_preserved_published", reviewer, "2026-08-03T10:06:00.000Z", "2099-01-01T00:00:00.000Z");
    db.prepare(`INSERT INTO moderator_reviews
      (review_id,claim_id,reviewer_id,claim_type,outcome_status,novelty_status,
       baseline_probability,evidence_ids_json,prior_receipt_id,decision_fingerprint,rationale,created_at)
      VALUES (?,?,?,'testable_prediction','true','no_precursor_found',0.2,?,NULL,?,?,?)`)
      .run(`review_preserved_${suffix}`, PRESERVATION.publishedClaimId, reviewer,
        '["evidence_preserved_original","evidence_preserved_outcome"]',
        `fingerprint_preserved_${suffix}`, `Preserved independent review ${suffix}.`,
        `2026-08-03T10:0${suffix === "one" ? "7" : "8"}:00.000Z`);
    db.prepare(`UPDATE review_assignments SET status='submitted',submitted_at=?
      WHERE assignment_id=?`).run(`2026-08-03T10:0${suffix === "one" ? "7" : "8"}:00.000Z`,
      `assignment_preserved_${suffix}`);
  }
  db.prepare(`UPDATE review_work_items SET status='complete',completed_at=? WHERE work_item_id=?`)
    .run("2026-08-03T10:09:00.000Z", "work_preserved_published");
  db.prepare(`INSERT INTO claim_revisions
    (revision_id,claim_id,revision_number,revision_type,decision_json,actor_ids_json,created_at)
    VALUES (?,?,1,'publication',?,?,?)`).run("revision_preserved_publication",
      PRESERVATION.publishedClaimId, '{"outcomeStatus":"true"}',
      '["reviewer_preserved_one","reviewer_preserved_two"]', "2026-08-03T10:09:00.000Z");
  db.prepare(`UPDATE claims SET visibility='published',publication_summary=?,published_at=?
    WHERE claim_id=?`).run("Two matching human reviews preserved.",
      "2026-08-03T10:09:00.000Z", PRESERVATION.publishedClaimId);
  db.prepare(`UPDATE publication_evaluations SET state='published',last_attempt_at=?,completed_at=?,
    attempt_count=1,publication_revision_id=? WHERE claim_id=?`).run("2026-08-03T10:09:00.000Z",
      "2026-08-03T10:09:00.000Z", "revision_preserved_publication", PRESERVATION.publishedClaimId);
  db.prepare(`INSERT INTO claim_events
    (event_id,claim_id,event_type,actor_id,detail_json,created_at)
    VALUES (?,?, 'published','reviewer_preserved_two',?,?)`).run("event_preserved_published",
      PRESERVATION.publishedClaimId, '{"revisionId":"revision_preserved_publication"}',
      "2026-08-03T10:09:00.000Z");

  db.prepare(`INSERT INTO review_assignments
    (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at)
    VALUES (?,?,?,'leased',?,?)`).run(PRESERVATION.oilAssignmentId, PRESERVATION.oilWorkId,
      "reviewer_alpha", "2026-08-03T10:10:00.000Z", "2099-01-01T00:00:00.000Z");
  db.prepare(`INSERT INTO review_assignments
    (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at)
    VALUES (?,?,?,'released',?,?)`).run("assignment_preserved_oil_beta", PRESERVATION.oilWorkId,
      "reviewer_beta", "2026-08-03T10:10:00.000Z", "2026-08-03T10:11:00.000Z");
  db.prepare(`INSERT INTO review_assignments
    (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at)
    VALUES (?,?,?,'leased',?,?)`).run("assignment_preserved_oil_gamma", PRESERVATION.oilWorkId,
      "reviewer_gamma", "2026-08-03T10:10:00.000Z", "2099-01-01T00:00:00.000Z");
  db.prepare(`INSERT INTO moderator_reviews
    (review_id,claim_id,reviewer_id,claim_type,outcome_status,novelty_status,
     baseline_probability,evidence_ids_json,prior_receipt_id,decision_fingerprint,rationale,created_at)
    VALUES ('review_preserved_oil_gamma',?,'reviewer_gamma','testable_prediction','false',
      'no_precursor_found',0.2,'["evidence_oil_archive"]',NULL,'oil-preserved-gamma',?,?)`)
    .run(CLAIM_ID, "Preserved first human review.", "2026-08-03T10:11:00.000Z");
  db.prepare(`UPDATE review_assignments SET status='submitted',submitted_at=?
    WHERE assignment_id='assignment_preserved_oil_gamma'`).run("2026-08-03T10:11:00.000Z");
  const auditRows = [
    ["audit_preserved_oil_leased", "reviewer_alpha", "assignment_leased", PRESERVATION.oilAssignmentId],
    ["audit_preserved_oil_released", "reviewer_beta", "assignment_released", "assignment_preserved_oil_beta"],
    ["audit_preserved_oil_submitted", "reviewer_gamma", "submission_accepted", "assignment_preserved_oil_gamma"],
  ];
  for (const [auditId, reviewerId, eventType, assignmentId] of auditRows) {
    db.prepare(`INSERT INTO review_audit_events
      (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,assignment_id,detail_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(auditId, reviewerId, eventType, PRESERVATION.oilWorkId,
      CLAIM_ID, assignmentId, "{}", "2026-08-03T10:11:00.000Z");
  }

  db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,completed_item_count,pause_reason,
     resume_after,created_at,started_at,paused_at,transition_count)
    VALUES (?,?,'person_troy_black','paused',3,1,'youtube_data_api_video_not_found',?,?,?,?,5)`)
    .run(PRESERVATION.batchId, "preservation-e2e-key", "2026-08-03T10:00:00.000Z",
      "2026-08-03T10:00:00.000Z", "2026-08-03T10:12:00.000Z",
      "2026-08-03T10:12:00.000Z");
  db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,ordinal,status,run_id,duration_seconds,
     started_at,completed_at,dispatch_state,first_job_dispatched_at,last_job_dispatched_at)
    VALUES (?,?,?,?,1,'completed','run_preserved_completed',60,?,?, 'sent',?,?)`)
    .run(PRESERVATION.completedItemId, PRESERVATION.batchId, PRESERVATION.completedSourceId,
      "KeepDone001", "2026-08-03T10:00:00.000Z", "2026-08-03T10:02:00.000Z",
      "2026-08-03T10:00:30.000Z", "2026-08-03T10:00:30.000Z");
  db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,ordinal,status)
    VALUES (?,?,?,?,2,'pending')`).run(PRESERVATION.unavailableItemId, PRESERVATION.batchId,
      PRESERVATION.unavailableSourceId, "GoneVideo01");
  db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,ordinal,status)
    VALUES (?,?,?,?,3,'pending')`).run(PRESERVATION.successorItemId, PRESERVATION.batchId,
      PRESERVATION.successorSourceId, "NextVideo01");
  db.prepare(`INSERT INTO transcript_batch_events
    (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
    VALUES ('event_preserved_pause',?,?,'batch_paused',?,?)`).run(PRESERVATION.batchId,
      PRESERVATION.unavailableItemId,
      '{"action":"transcript_batch_paused","reason":"youtube_data_api_video_not_found"}',
      "2026-08-03T10:12:00.000Z");
}

function canonicalPreservationRows(db) {
  const select = (sql, ...values) => db.prepare(sql).all(...values);
  return {
    artifacts: select("SELECT * FROM transcript_artifacts WHERE transcript_id='transcript_preserved'"),
    analysisRuns: select("SELECT * FROM transcript_analysis_runs WHERE analysis_run_id='analysis_preserved'"),
    analysisSections: select("SELECT * FROM transcript_analysis_sections WHERE analysis_run_id='analysis_preserved' ORDER BY section_index"),
    claims: select("SELECT * FROM claims WHERE claim_id IN (?,?) ORDER BY claim_id",
      PRESERVATION.publishedClaimId, CLAIM_ID),
    evidence: select("SELECT * FROM evidence WHERE evidence_id LIKE 'evidence_preserved_%' ORDER BY evidence_id"),
    workItems: select("SELECT * FROM review_work_items WHERE work_item_id IN (?,?) ORDER BY work_item_id",
      "work_preserved_published", PRESERVATION.oilWorkId),
    assignments: select("SELECT * FROM review_assignments WHERE assignment_id LIKE 'assignment_preserved_%' ORDER BY assignment_id"),
    reviews: select("SELECT * FROM moderator_reviews WHERE review_id LIKE 'review_preserved_%' ORDER BY review_id"),
    revisions: select("SELECT * FROM claim_revisions WHERE revision_id='revision_preserved_publication'"),
    evaluations: select("SELECT * FROM publication_evaluations WHERE claim_id IN (?,?) ORDER BY claim_id",
      PRESERVATION.publishedClaimId, CLAIM_ID),
    claimEvents: select("SELECT * FROM claim_events WHERE event_id='event_preserved_published'"),
    audits: select("SELECT * FROM review_audit_events WHERE audit_event_id LIKE 'audit_preserved_%' ORDER BY audit_event_id"),
    completedItem: select("SELECT * FROM transcript_batch_items WHERE batch_item_id=?", PRESERVATION.completedItemId),
    targetItem: select("SELECT * FROM transcript_batch_items WHERE batch_item_id=?", PRESERVATION.unavailableItemId),
  };
}

test("1. Queue load leases work and returns principal", async () => {
  const env = makeEnv({ demo: true });
  const response = await queueGet(context({
    env, url: "http://127.0.0.1/api/review/queue", headers: demoHeaders("alpha-token"),
  }));
  assert.equal(response.status, 200);
  const body = await jsonBody(response);
  assert.equal(body.principal.mode, "local_non_deployable_demo");
  assert.ok(Array.isArray(body.assignments));
});

test("2. Pending list returns tracked claims with states", async () => {
  const env = makeEnv({ demo: true });
  const response = await pendingGet(context({
    env, url: "http://127.0.0.1/api/review/pending", headers: demoHeaders("alpha-token"),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await jsonBody(response);
  assert.ok(Array.isArray(body.claims));
  const oil = body.claims.find((row) => row.claimId === CLAIM_ID);
  assert.ok(oil, "oil fixture claim must appear in pending list");
  assert.ok(["ready", "in_preparation", "awaiting_second_review", "awaiting_reconciliation", "decided"].includes(oil.state));
});

test("3. Open assigned claim returns AI draft bundle", async () => {
  const env = makeEnv({ demo: true });
  const leased = await assign(env, "alpha-token");
  const response = await reviewGet(reviewContext(env, "alpha-token", leased.assignmentId));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await jsonBody(response);
  assert.ok(body.aiDraftDecision, JSON.stringify(body).slice(0, 300));
  assert.equal(body.aiDraftDecision.provenance, "ai_generated_needs_human_check");
  assert.equal(body.reviewState.previousDecisionsBlinded, true);
  assert.doesNotMatch(JSON.stringify(body), /reviewer_[a-z]+|previous reviewer rationale/i);
});

test("4. Accept persists moderator_reviews and returns reviewId", async () => {
  const env = makeEnv({ demo: true });
  seedPublicationEvidence(env);
  const leased = await assign(env, "alpha-token");
  const response = await reviewPost(reviewContext(env, "alpha-token", leased.assignmentId, {
    method: "POST",
    body: {
      workType: "claim_adjudication",
      verdict: "agree",
      publicReviewerName: "Joshua",
      rationale: "E2E accept: AI draft matches verified original and independent outcome evidence.",
    },
  }));
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text);
  assert.ok(body.reviewId, text);
  assert.equal(body.sendbackRecorded, false);
  assert.equal(body.advance, true);
  assert.ok(body.publication?.state);

  const count = env.DB.db.prepare(
    "SELECT count(*) c FROM moderator_reviews WHERE claim_id=?",
  ).get(CLAIM_ID).c;
  assert.equal(count, 1);

  const asg = env.DB.db.prepare(
    "SELECT status, submitted_at FROM review_assignments WHERE assignment_id=?",
  ).get(leased.assignmentId);
  assert.equal(asg.status, "submitted");
  assert.ok(asg.submitted_at);

  const reopened = await reviewGet(reviewContext(env, "alpha-token", leased.assignmentId));
  assert.equal(reopened.status, 200);
  const reopenedBody = await jsonBody(reopened);
  assert.equal(reopenedBody.reviewState.ownSubmissionRecorded, true);
  assert.equal(reopenedBody.reviewState.ownDecision.reviewId, body.reviewId);
  assert.equal(reopenedBody.reviewState.ownDecision.outcomeStatus, "false");
  assert.match(reopenedBody.reviewState.ownDecision.rationale, /E2E accept/);
  assert.equal(reopenedBody.reviewState.ownDecision.sendbackRecorded, false);
  assert.doesNotMatch(JSON.stringify(reopenedBody.reviewState), /reviewer_alpha/);
});

test("5. Send-back persists review + research_sendbacks without full evidence packet", async () => {
  const env = makeEnv({ demo: true });
  const leased = await assign(env, "alpha-token");
  const response = await reviewPost(reviewContext(env, "alpha-token", leased.assignmentId, {
    method: "POST",
    body: {
      workType: "claim_adjudication",
      verdict: "disagree",
      publicReviewerName: "Joshua",
      disagreeOutcome: "true",
      rationale: "E2E send-back: Queen deathbed / chosen heir was widely expected — research must learn.",
    },
  }));
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text);
  assert.ok(body.reviewId, text);
  assert.equal(body.sendbackRecorded, true, text);
  assert.equal(body.advance, true);

  const reviews = env.DB.db.prepare(
    "SELECT count(*) c FROM moderator_reviews WHERE claim_id=?",
  ).get(CLAIM_ID).c;
  assert.equal(reviews, 1);

  const sendbacks = env.DB.db.prepare(
    "SELECT lesson, rejected_outcome FROM research_sendbacks WHERE claim_id=?",
  ).all(CLAIM_ID);
  assert.ok(sendbacks.length >= 1, "sendback row required");
  assert.match(String(sendbacks[0].lesson || ""), /widely expected|Queen|heir|research must learn/i);
});

test("6. Feedback POST persists and GET returns own history with receipt", async () => {
  const env = makeEnv({ demo: true });
  const leased = await assign(env, "alpha-token");
  const post = await feedbackPost(context({
    env,
    url: "http://127.0.0.1/api/review/feedback",
    method: "POST",
    headers: demoHeaders("alpha-token"),
    body: {
      category: "evidence_gap",
      message: "E2E proof: feedback must land so the reviewer can see a receipt.",
      claimId: CLAIM_ID,
      assignmentId: leased.assignmentId,
    },
  }));
  const postText = await post.text();
  assert.equal(post.status, 201, postText);
  const saved = JSON.parse(postText);
  assert.ok(saved.feedbackId, postText);
  assert.equal(saved.state, "feedback_recorded");
  assert.equal(saved.actionState, "routed_to_research");

  const rows = env.DB.db.prepare(
    "SELECT feedback_id, message FROM reviewer_feedback WHERE claim_id=?",
  ).all(CLAIM_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].feedback_id, saved.feedbackId);

  const list = await feedbackGet(context({
    env, url: "http://127.0.0.1/api/review/feedback", headers: demoHeaders("alpha-token"),
  }));
  assert.equal(list.status, 200, await list.clone().text());
  const history = await jsonBody(list);
  assert.ok(history.items.some((item) => item.feedbackId === saved.feedbackId));
  assert.match(history.items[0].message, /E2E proof/);
  assert.equal(history.items[0].actionState, "routed_to_research");
  assert.equal(history.items[0].response, null);

  env.DB.db.prepare(`INSERT INTO ai_draft_decisions
    (draft_id,claim_id,revision,claim_type,outcome_status,novelty_status,
     baseline_probability,evidence_ids_json,prior_receipt_id,reasoning,provenance,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "aidraft_oil_feedback_r2", CLAIM_ID, 2, "testable_prediction", "false",
    "no_precursor_found", 0.2, '[]', null,
    "A newer AI research pass considered the claim-linked feedback and produced this pending draft.",
    "ai_generated_needs_human_check", "9999-01-01T00:00:00.000Z",
  );
  const applied = await feedbackGet(context({
    env, url: "http://127.0.0.1/api/review/feedback", headers: demoHeaders("alpha-token"),
  }));
  const appliedHistory = await jsonBody(applied);
  assert.equal(appliedHistory.items[0].actionState, "research_applied");
  assert.equal(appliedHistory.items[0].response.type, "ai_research");
  assert.equal(appliedHistory.items[0].response.outcomeStatus, "false");
  assert.match(appliedHistory.items[0].response.message, /considered the claim-linked feedback/);

  const filtered = await feedbackGet(context({
    env, url: `http://127.0.0.1/api/review/feedback?claimId=${CLAIM_ID}`,
    headers: demoHeaders("alpha-token"),
  }));
  const filteredHistory = await jsonBody(filtered);
  assert.equal(filteredHistory.items.length, 1);
  assert.equal(filteredHistory.items[0].feedbackId, saved.feedbackId);

  const feedbackOwner = env.DB.db.prepare(
    "SELECT reviewer_id FROM reviewer_feedback WHERE feedback_id=?",
  ).get(saved.feedbackId).reviewer_id;
  env.DB.db.prepare(`INSERT INTO reviewer_feedback
    (feedback_id,reviewer_id,category,claim_id,candidate_id,assignment_id,message,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    "feedback_legacy_unlinked", feedbackOwner, "evidence_gap", null, null, null,
    "Legacy client note whose exact claim is recovered from append-only audit evidence.",
    "2026-01-01T00:00:00.000Z",
  );
  env.DB.db.prepare(`INSERT INTO reviewer_feedback_claim_links
    (feedback_id,claim_id,assignment_id,link_reason,linked_at)
    VALUES (?,?,?,?,?)`).run(
    "feedback_legacy_unlinked", CLAIM_ID, leased.assignmentId,
    "audit_event_correlation", "2026-01-01T00:01:00.000Z",
  );
  const corrected = await feedbackGet(context({
    env, url: `http://127.0.0.1/api/review/feedback?claimId=${CLAIM_ID}`,
    headers: demoHeaders("alpha-token"),
  }));
  const correctedHistory = await jsonBody(corrected);
  const correctedItem = correctedHistory.items.find((item) =>
    item.feedbackId === "feedback_legacy_unlinked");
  assert.equal(correctedItem.claimId, CLAIM_ID);
  assert.equal(correctedItem.assignmentId, leased.assignmentId);
  assert.equal(correctedItem.actionState, "research_applied");

  env.DB.db.prepare(`INSERT INTO reviewer_feedback
    (feedback_id,reviewer_id,category,claim_id,candidate_id,assignment_id,message,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    "feedback_live_qa", feedbackOwner, "ai_extraction_quality", null, null, null,
    "Live durable click E2E feedback test receipt.", "2026-01-01T00:02:00.000Z",
  );
  env.DB.db.prepare(`INSERT INTO reviewer_feedback_claim_links
    (feedback_id,claim_id,assignment_id,link_reason,linked_at)
    VALUES (?,?,?,?,?)`).run(
    "feedback_live_qa", CLAIM_ID, leased.assignmentId,
    "live_qa_correlation", "2026-01-01T00:03:00.000Z",
  );
  const qaLinked = await feedbackGet(context({
    env, url: `http://127.0.0.1/api/review/feedback?claimId=${CLAIM_ID}`,
    headers: demoHeaders("alpha-token"),
  }));
  const qaHistory = await jsonBody(qaLinked);
  const qaItem = qaHistory.items.find((item) => item.feedbackId === "feedback_live_qa");
  assert.equal(qaItem.claimId, CLAIM_ID);
  assert.equal(qaItem.actionState, "qa_receipt");
  assert.equal(qaItem.notePurpose, "live_qa_receipt");
  assert.equal(qaItem.response, null);
});

test("7. Scorecard GET loads for authenticated reviewer", async () => {
  const env = makeEnv({ demo: true });
  const response = await scorecardGet(context({
    env, url: "http://127.0.0.1/api/review/scorecard", headers: demoHeaders("alpha-token"),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const body = await jsonBody(response);
  assert.ok(body.basis);
  assert.ok(Array.isArray(body.reviewerFeedback));
});

test("8. Explicit lease switch via queue POST returns assignment receipt", async () => {
  const env = makeEnv({ demo: true });
  const pending = await pendingGet(context({
    env, url: "http://127.0.0.1/api/review/pending", headers: demoHeaders("alpha-token"),
  }));
  const claims = (await jsonBody(pending)).claims || [];
  const ready = claims.find((row) => row.state === "ready" || row.hasDraft);
  assert.ok(ready?.workItemId, "need a ready claim work item");

  const response = await queuePost(context({
    env,
    url: "http://127.0.0.1/api/review/queue",
    method: "POST",
    headers: demoHeaders("alpha-token"),
    body: { leaseWorkItemId: ready.workItemId },
  }));
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text);
  assert.ok(body.assignment?.assignmentId, text);
  assert.equal(body.assignment.workItemId, ready.workItemId);
});

test("9. Archive queue GET is wired (assignments + available + counts)", async () => {
  const env = makeEnv({ demo: true });
  const response = await archiveQueueGet(context({
    env, url: "http://127.0.0.1/api/review/archive/queue", headers: demoHeaders("alpha-token"),
  }));
  // 200 with shape, or 503 only if schema truly missing — never 404 missing module.
  assert.notEqual(response.status, 404);
  if (response.status === 200) {
    const body = await jsonBody(response);
    assert.ok(Array.isArray(body.assignments));
    assert.ok(Array.isArray(body.available));
    assert.ok(body.counts);
  }
});

test("10. Soft-fail paths that previously lied are gone: feedback route must exist", async () => {
  // Import-time existence is the gate; runtime POST already covered.
  assert.equal(typeof feedbackPost, "function");
  assert.equal(typeof feedbackGet, "function");
  assert.equal(typeof pendingGet, "function");
  assert.equal(typeof queuePost, "function");
});

test("11. Quarantine preserves completed and reviewer history while every public phase stays truthful", async () => {
  const env = makeEnv({ demo: true });
  seedPreservationFixture(env);
  env.sent = [];
  env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  const before = canonicalPreservationRows(env.DB.db);
  const targetBefore = JSON.stringify(before.targetItem[0]);
  const completedBefore = Number(env.DB.db.prepare(
    "SELECT completed_item_count FROM transcript_batches WHERE batch_id=?",
  ).get(PRESERVATION.batchId).completed_item_count);

  const action = await quarantinePendingTranscriptItem(env, {
    batchId: PRESERVATION.batchId,
    batchItemId: PRESERVATION.unavailableItemId,
    idempotencyKey: "preservation-e2e-key",
    expectedTransitionCount: 5,
    reasonCode: "source_unavailable",
    observedErrorCode: "youtube_data_api_video_not_found",
    at: "2026-08-03T10:13:00.000Z",
    durationFetcher: async () => new Response('<script>{"lengthSeconds":"60"}</script>'),
  });
  assert.equal(action.contract, "transcript-batch-quarantine-v1");
  assert.equal(action.quarantined, true);
  assert.equal(action.applied, true);
  assert.equal(action.completedItemCount, completedBefore);
  assert.deepEqual(action.counts,
    { completed: 1, active: 1, pending: 0, quarantined: 1, skipped: 0 });
  assert.equal(action.successor.batchItemId, PRESERVATION.successorItemId);
  assert.equal(action.successor.dispatchState, "sent");
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.batchItemId, PRESERVATION.successorItemId);

  const replay = await quarantinePendingTranscriptItem(env, {
    batchId: PRESERVATION.batchId,
    batchItemId: PRESERVATION.unavailableItemId,
    idempotencyKey: "preservation-e2e-key",
    expectedTransitionCount: 5,
    reasonCode: "source_unavailable",
    observedErrorCode: "youtube_data_api_video_not_found",
    at: "2026-08-03T10:14:00.000Z",
    durationFetcher: async () => { throw new Error("replay_must_not_resolve_duration"); },
  });
  assert.equal(replay.reused, true);
  assert.equal(env.sent.length, 1, "idempotent replay must not dispatch a second successor");
  assert.equal(env.DB.db.prepare(`SELECT COUNT(*) count FROM ingestion_jobs
    WHERE run_id=(SELECT run_id FROM transcript_batch_items WHERE batch_item_id=?)`).get(
    PRESERVATION.successorItemId).count, 1);

  const after = canonicalPreservationRows(env.DB.db);
  assert.deepEqual(after, before, "quarantine must not rewrite any completed or reviewer-owned row");
  assert.equal(JSON.stringify(after.targetItem[0]), targetBefore,
    "the disposed pending row stays byte-for-byte pristine");
  const batchAfter = env.DB.db.prepare(`SELECT status,completed_item_count,transition_count
    FROM transcript_batches WHERE batch_id=?`).get(PRESERVATION.batchId);
  assert.equal(batchAfter.status, "running");
  assert.equal(batchAfter.completed_item_count, completedBefore);
  assert.equal(batchAfter.transition_count, 6);
  assert.equal(env.DB.db.prepare(`SELECT COUNT(*) count FROM transcript_batch_item_dispositions
    WHERE batch_item_id=?`).get(PRESERVATION.unavailableItemId).count, 1);

  const sourceResponse = await sourceGet(context({ env,
    url: "https://example.test/api/people/troy-black/sources?platform=youtube&limit=50",
    params: { slug: "troy-black" },
  }));
  assert.equal(sourceResponse.status, 200, await sourceResponse.clone().text());
  const catalogue = await jsonBody(sourceResponse);
  const byId = Object.fromEntries(catalogue.sources.map((source) => [source.id, source]));
  assert.deepEqual({
    acquisition: byId[PRESERVATION.completedSourceId].acquisitionStatus,
    analysis: byId[PRESERVATION.completedSourceId].analysisStatus,
    humanReview: byId[PRESERVATION.completedSourceId].humanReviewStatus,
    publication: byId[PRESERVATION.completedSourceId].publicStatus,
  }, { acquisition: "acquired", analysis: "partial", humanReview: "reviewed",
    publication: "published" });
  assert.deepEqual({
    acquisition: byId[PRESERVATION.unavailableSourceId].acquisitionStatus,
    analysis: byId[PRESERVATION.unavailableSourceId].analysisStatus,
    humanReview: byId[PRESERVATION.unavailableSourceId].humanReviewStatus,
    publication: byId[PRESERVATION.unavailableSourceId].publicStatus,
  }, { acquisition: "quarantined_source_unavailable", analysis: "not_started",
    humanReview: "not_ready", publication: "not_published" });
  assert.deepEqual({
    acquisition: byId[PRESERVATION.successorSourceId].acquisitionStatus,
    analysis: byId[PRESERVATION.successorSourceId].analysisStatus,
    humanReview: byId[PRESERVATION.successorSourceId].humanReviewStatus,
    publication: byId[PRESERVATION.successorSourceId].publicStatus,
  }, { acquisition: "active", analysis: "not_started", humanReview: "not_ready",
    publication: "not_published" });
  assert.doesNotMatch(JSON.stringify(catalogue),
    /private\/preserved|reviewer_preserved|model_unavailable|youtube_data_api_video_not_found|content_sha256/i);

  const queueResponse = await queueGet(context({ env,
    url: "http://127.0.0.1/api/review/queue", headers: demoHeaders("alpha-token"),
  }));
  assert.equal(queueResponse.status, 200, await queueResponse.clone().text());
  const queue = await jsonBody(queueResponse);
  assert.ok(queue.assignments.some((assignment) =>
    assignment.assignmentId === PRESERVATION.oilAssignmentId && assignment.status === "leased"));
  const bundleResponse = await reviewGet(reviewContext(env, "alpha-token",
    PRESERVATION.oilAssignmentId));
  assert.equal(bundleResponse.status, 200, await bundleResponse.clone().text());
  const bundle = await jsonBody(bundleResponse);
  assert.equal(bundle.assignment.assignmentId, PRESERVATION.oilAssignmentId);
  assert.equal(bundle.subject.claim_id, CLAIM_ID);
  assert.equal(bundle.aiDraftDecision.provenance, "ai_generated_needs_human_check");
  assert.equal(bundle.reviewState.previousDecisionsBlinded, true);
});
