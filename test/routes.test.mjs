import test from "node:test";
import assert from "node:assert/strict";
import { insertIntake } from "../functions/lib/repository.js";
import { listPeople } from "../functions/lib/people-directory.js";
import { onRequestPost as intakePost } from "../functions/api/intake.js";
import { onRequestGet as peopleGet } from "../functions/api/people.js";
import { onRequestGet as personGet } from "../functions/api/people/[slug].js";
import { onRequestGet as sourceGet } from "../functions/api/people/[slug]/sources.js";
import { onRequestGet as claimGet } from "../functions/api/claims/[id].js";
import { onRequestGet as reviewGet, onRequestPost as reviewPost } from "../functions/api/review/[id].js";
import { onRequestGet as reviewQueueGet } from "../functions/api/review/queue.js";
import {
  onRequestGet as archiveQueueGet, onRequestPost as archiveQueuePost,
} from "../functions/api/review/archive/queue.js";
import {
  onRequestGet as archiveReviewGet, onRequestPost as archiveReviewPost,
} from "../functions/api/review/archive/[id].js";
import { context, jsonBody, makeEnv } from "./helpers/d1.mjs";

const VIDEO_ID = "ZidiIdg3U4M";
const CLAIM_ID = "southeast-asia-oil-2021";
const demoHeaders = (token) => ({ "x-demo-reviewer-token": token });

function seedPublicationEvidence(env) {
  const insert = env.DB.db.prepare(
    `INSERT INTO evidence
     (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,source_role,
      note,search_query,cutoff_date,created_at,verification_method)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insert.run("original_verified", CLAIM_ID, "original_statement", "https://example.test/transcript",
    "Authorized transcript", "2020-09-10", "2026-07-19", "platform", "Verified for test.",
    null, null, "2026-07-19", "authorized_transcript");
  insert.run("outcome_independent", CLAIM_ID, "independent_outcome", "https://example.test/outcome",
    "Independent outcome record", "2022-01-01", "2026-07-19", "independent", "Independent test fixture.",
    null, null, "2026-07-19", "unverified");
}

const reviewBody = (overrides = {}) => ({
  claimType: "testable_prediction", outcomeStatus: "false", noveltyStatus: "not_assessed",
  baselineProbability: "", priorReceiptId: "", evidenceIds: ["original_verified", "outcome_independent"],
  rationale: "Literal deadline with verified original and independent outcome evidence.", ...overrides,
});

function reviewContext(env, token, assignmentId, { method = "GET", body } = {}) {
  return context({
    env, url: `http://localhost/api/review/${assignmentId}`, method, body,
    params: { id: assignmentId }, headers: demoHeaders(token),
  });
}

async function assign(env, token) {
  const response = await reviewQueueGet(context({
    env, url: "http://localhost/api/review/queue", headers: demoHeaders(token),
  }));
  assert.equal(response.status, 200);
  const body = await jsonBody(response);
  return body.assignments.find((item) => item.status === "leased");
}

async function assignArchive(env, token) {
  const listed = await archiveQueueGet(context({
    env, url: "http://localhost/api/review/archive/queue", headers: demoHeaders(token),
  }));
  assert.equal(listed.status, 200);
  const body = await jsonBody(listed);
  const existing = body.assignments.find((item) =>
    item.workType === "archive_lead_verification" && item.status === "leased");
  if (existing) return existing;
  const target = body.available.find((item) => !item.taken);
  assert.ok(target?.workItemId);
  const response = await archiveQueuePost(context({
    env, url: "http://localhost/api/review/archive/queue", method: "POST",
    headers: demoHeaders(token), body: { leaseArchiveWorkItemId: target.workItemId },
  }));
  assert.equal(response.status, 201, await response.clone().text());
  return (await jsonBody(response)).assignment;
}

function seedArchiveRouteWork(env) {
  const db = env.DB.db;
  const now = "2026-07-20T12:00:00Z";
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES ('run_archive_route','person_troy_black','manual','archive-route-test','complete',?,?,?,?)`
  ).run(now, now, 0, now);
  db.prepare(`INSERT INTO first_party_archive_receipts
    (receipt_id,run_id,source_id,person_id,adapter,source_url,response_sha256,
     row_count,parser_version,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run("receipt_archive_route", "run_archive_route", "source_troy_archive", "person_troy_black",
    "wptb_fulfilled_prophecy_v1", "https://troyblackvideos.com/prophecy-archive-all/",
    "d".repeat(64), 1, "route-test-v1", now);
  db.prepare(`INSERT INTO first_party_archive_leads
    (archive_lead_id,source_id,person_id,publisher_element_id,created_at)
    VALUES ('lead_archive_route','source_troy_archive','person_troy_black','route-row',?)`
  ).run(now);
  db.prepare(`INSERT INTO first_party_archive_lead_revisions
    (archive_revision_id,archive_lead_id,receipt_id,content_sha256,source_locator_y_index,
     description_text,date_shared_text,prophecy_text,claimed_result_text,
     claimed_evidence_text,parser_version,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run("revision_archive_route", "lead_archive_route", "receipt_archive_route", "e".repeat(64),
    1, "Route archive lead", "2020", "A specific event will occur.", "Claimed result",
    "Claimed evidence", "route-test-v1", now);
  db.prepare(`INSERT INTO first_party_archive_revision_links
    (archive_link_id,archive_revision_id,link_role,ordinal,label,url,youtube_id,
     source_item_id,provenance) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("link_archive_route", "revision_archive_route", "original_video", 1, "Original video",
    "https://www.youtube.com/watch?v=routeVideo1", null, null, "first_party_claimed_original");
  db.prepare(`INSERT INTO archive_verification_work_items
    (archive_work_item_id,archive_revision_id,archive_video_link_id,status,created_at)
    VALUES ('work_archive_route','revision_archive_route','link_archive_route','ready',?)`
  ).run(now);
}

test("public people directory returns reusable person data and safe coverage counts", async () => {
  const env = makeEnv();
  env.DB.db.prepare(
    `INSERT INTO people (person_id,slug,display_name,corpus_label,created_at) VALUES (?,?,?,?,?)`
  ).run("person_ada", "ada-example", "Ada Example", "Second public test profile", "2026-07-20T00:00:00Z");
  env.DB.db.prepare(
    `INSERT INTO source_items
     (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("source_ada", "person_ada", null, "official_site", "ada-1", "https://example.test/ada-1",
    "2026-07-20T00:00:00Z", "2026-07-20T00:00:00Z", "available");
  const listed = await listPeople(env.DB);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed[0].person, {
    slug: "troy-black",
    displayName: "Troy Black",
    corpusLabel: "Provisional pilot — selected records, not a complete catalogue",
  });
  assert.equal(listed[0].corpusCoverage.postsFound, 0);
  assert.deepEqual(listed[1].person, {
    slug: "ada-example", displayName: "Ada Example", corpusLabel: "Second public test profile",
  });
  assert.equal(listed[1].corpusCoverage.postsFound, 1);
  const response = await peopleGet(context({ env, url: "https://example.test/api/people" }));
  assert.equal(response.status, 200);
  const body = await jsonBody(response);
  assert.equal(body.people.length, 2);
  assert.equal(body.people[0].person.slug, "troy-black");
  assert.equal(body.people[1].person.slug, "ada-example");
  assert.equal(body.people[1].corpusCoverage.postsFound, 1);
  assert.deepEqual(Object.keys(body.people[0].corpusCoverage).sort(), [
    "archiveClaimsCatalogued", "archiveOriginalVideos", "archiveSourceChecksCompleted",
    "claimsCheckedByPeople", "finalRatings", "lastScanAt", "possibleClaimPosts", "postsFound",
    "scanStatus", "sources", "specificClaimCandidates", "transcriptsAvailable", "videosLinked",
  ]);
  assert.doesNotMatch(JSON.stringify(body), /transcript_body|raw_ai|reviewer_id|model_response/i);
});

test("intake is idempotent and honestly stays pending without a crawl", async () => {
  const env = makeEnv();
  const parsed = { canonicalVideoId: VIDEO_ID, normalizedUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}` };
  assert.equal((await insertIntake(env.DB, parsed, "2026-07-19T00:00:00Z")).reused, false);
  assert.equal((await insertIntake(env.DB, parsed, "2026-07-19T00:00:01Z")).reused, true);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingest_requests").get().count, 1);
});

test("public intake saves for identity confirmation without Queue access or profile attribution", async () => {
  const env = makeEnv();
  const sent = [];
  env.INGESTION_QUEUE = { send: async (message) => sent.push(message) };
  const request = () => context({
    env, url: "https://example.test/api/intake", method: "POST",
    body: { youtubeUrl: `https://youtu.be/${VIDEO_ID}` },
  });
  const response = await intakePost(request());
  assert.equal(response.status, 202);
  const body = await jsonBody(response);
  assert.equal(body.status, "pending_identity");
  assert.equal(body.dispatchStatus, "pending_identity");
  assert.match(body.nextStep, /saved for source and identity confirmation/i);
  assert.match(body.nextStep, /No automatic transcript, claim, or rating/i);
  assert.equal(sent.length, 0);

  const duplicate = await jsonBody(await intakePost(request()));
  assert.equal(duplicate.dispatchStatus, "pending_identity");
  assert.equal(duplicate.reused, true);
  assert.equal(sent.length, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingest_requests").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_runs").get().count, 0);
});

test("an arbitrary valid YouTube ID cannot enter Troy's public source inventory", async () => {
  const env = makeEnv();
  const response = await intakePost(context({ env, url: "https://example.test/api/intake", method: "POST",
    body: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" } }));
  assert.equal(response.status, 202);
  assert.equal((await jsonBody(response)).dispatchStatus, "pending_identity");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_items").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs").get().count, 0);
});

test("public profile exposes neutral catalogue records but no draft verdict fields", async () => {
  const env = makeEnv();
  const response = await personGet(context({
    env, url: "https://example.test/api/people/troy-black", params: { slug: "troy-black" },
  }));
  const body = await jsonBody(response);
  assert.equal(response.status, 200);
  assert.match(body.completeness, /not a complete catalogue/i);
  assert.equal(body.catalogueRecords.length, 2);
  assert.ok(body.catalogueRecords.every((record) => record.record_status === "provisional_not_adjudicated"));
  assert.equal(body.researchRecords.length, 2);
  assert.ok(body.researchRecords.every((record) =>
    record.researchStatus === "provisional_research" &&
    record.finalAdjudicationStatus === "not_adjudicated"));
  const oil = body.researchRecords.find((record) => record.id === "southeast-asia-oil-2021");
  const russia = body.researchRecords.find((record) => record.id === "russia-spring-2022");
  assert.match(oil.currentEvidenceSummary, /5\.06 million.*4\.86 million/i);
  assert.match(oil.currentEvidenceSummary, /timing wrong/i);
  assert.match(russia.currentEvidenceSummary, /no legal change/i);
  assert.match(russia.priorPublicInformationSummary, /public sources and satellite images/i);
  assert.match(russia.corpusWarning, /selects claims described as fulfilled/i);
  assert.ok(body.researchRecords.every((record) => record.revision === env.DB.db.prepare(
    "SELECT MAX(revision_number) AS revision FROM public_research_briefs WHERE claim_id=?"
  ).get(record.id).revision));
  assert.deepEqual(body.corpusCoverage, {
    postsFound: 0, videosLinked: 0, transcriptsAvailable: 0, possibleClaimPosts: 0, specificClaimCandidates: 0,
    archiveClaimsCatalogued: 0, archiveOriginalVideos: 0, archiveSourceChecksCompleted: 0,
    claimsCheckedByPeople: 0, finalRatings: 0, lastScanAt: null, scanStatus: "not_started", sources: [],
  });
  assert.deepEqual(new Set(russia.supportingReferences.map((source) => source.role)),
    new Set(["original_statement", "speaker_archive", "independent_outcome", "prior_public_information"]));
  assert.deepEqual(body.claims, []);
  assert.doesNotMatch(JSON.stringify(body),
    /proposed_outcome|transcript_warning|research_notes|reviewer_id|moderator_reviews/);
});

test("public profile projects only the newest append-only research revision", async () => {
  const env = makeEnv();
  const latest = env.DB.db.prepare(
    `SELECT brief_id,revision_number FROM public_research_briefs
     WHERE claim_id=? ORDER BY revision_number DESC LIMIT 1`
  ).get(CLAIM_ID);
  const nextRevision = latest.revision_number + 1;
  const nextBriefId = `brief_oil_r${nextRevision}`;
  const nextReferenceId = `research_oil_r${nextRevision}_source`;
  env.DB.db.prepare(
    `INSERT INTO public_research_briefs
     (brief_id,claim_id,revision_number,supersedes_brief_id,quotation_source_url,
      headline,evidence_strength,test_framing,evidence_summary,prior_information_summary,
      corpus_warning,missing_gates_json,research_status,as_of_date,created_at)
     SELECT ?,claim_id,?,brief_id,quotation_source_url,
      'Corrected public brief',evidence_strength,test_framing,'Corrected evidence summary',
      prior_information_summary,corpus_warning,missing_gates_json,research_status,
      '2026-07-20','2026-07-20T00:00:00.000Z'
     FROM public_research_briefs WHERE brief_id=?`
  ).run(nextBriefId, nextRevision, latest.brief_id);
  env.DB.db.prepare(
    `INSERT INTO public_research_references
     (reference_id,brief_id,reference_role,title,url,published_at,note,display_order,created_at)
     VALUES (?,?,'independent_outcome','Corrected source',
      'https://example.test/corrected','2026-07-20','Correction evidence',1,'2026-07-20')`
  ).run(nextReferenceId, nextBriefId);
  const response = await personGet(context({
    env, url: "https://example.test/api/people/troy-black", params: { slug: "troy-black" },
  }));
  const body = await jsonBody(response);
  const oil = body.researchRecords.find((record) => record.id === "southeast-asia-oil-2021");
  assert.equal(oil.revision, nextRevision);
  assert.equal(oil.headline, "Corrected public brief");
  assert.deepEqual(oil.supportingReferences.map((source) => source.id), [nextReferenceId]);
});

test("draft public API is 404 and reviewer API requires an authenticated principal", async () => {
  const env = makeEnv({ demo: true });
  const publicResponse = await claimGet(context({
    env, url: `http://localhost/api/claims/${CLAIM_ID}`, params: { id: CLAIM_ID },
  }));
  assert.equal(publicResponse.status, 404);
  assert.equal((await reviewGet(context({
    env, url: `http://localhost/api/review/${CLAIM_ID}`, params: { id: CLAIM_ID },
  }))).status, 404);
  const assignment = await assign(env, "alpha-token");
  const authenticated = await reviewGet(reviewContext(env, "alpha-token", assignment.assignmentId));
  assert.equal(authenticated.status, 200);
  const body = await jsonBody(authenticated);
  assert.equal(body.principal.mode, "local_non_deployable_demo");
  assert.equal("reviewerId" in body.principal, false);
  assert.deepEqual(body.reviewState, { ownSubmissionRecorded: false, previousDecisionsBlinded: true });
});

test("archive review routes preserve Access identity, assignment ownership, and work-type binding", async () => {
  const env = makeEnv({ demo: true });
  seedArchiveRouteWork(env);
  const assignment = await assignArchive(env, "alpha-token");
  assert.equal(assignment.workType, "archive_lead_verification");
  const unauthenticated = await archiveReviewGet(context({ env,
    url: `http://localhost/api/review/archive/${assignment.assignmentId}`,
    params: { id: assignment.assignmentId } }));
  assert.equal(unauthenticated.status, 404);
  const wrongReviewer = await archiveReviewGet(context({ env,
    url: `http://localhost/api/review/archive/${assignment.assignmentId}`,
    params: { id: assignment.assignmentId }, headers: demoHeaders("beta-token") }));
  assert.equal(wrongReviewer.status, 404);
  const wrongType = await archiveReviewPost(context({ env,
    url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: demoHeaders("alpha-token"),
    body: { workType: "claim_adjudication", decision: "source_unavailable",
      rationale: "The assigned source could not be opened for this review." },
  }));
  assert.equal(wrongType.status, 400);
  assert.equal((await jsonBody(wrongType)).code, "work_type_mismatch");
  const spoofed = await archiveReviewPost(context({ env,
    url: `http://localhost/api/review/archive/${assignment.assignmentId}`, method: "POST",
    params: { id: assignment.assignmentId }, headers: demoHeaders("alpha-token"),
    body: { workType: "archive_lead_verification", decision: "source_unavailable",
      rationale: "The assigned source could not be opened for this review.",
      reviewerId: "reviewer_beta", sourceAvailable: false, contextVerified: false,
      exactSourceVerified: false, testable: false },
  }));
  assert.equal(spoofed.status, 400);
  assert.equal((await jsonBody(spoofed)).code, "reviewer_identity_body_forbidden");
  const bypass = await reviewPost(reviewContext(env, "alpha-token", assignment.assignmentId, {
    method: "POST", body: { workType: "archive_lead_verification", decision: "source_unavailable",
      rationale: "The assigned source could not be opened for this review.", sourceAvailable: false,
      contextVerified: false, exactSourceVerified: false, testable: false },
  }));
  assert.equal(bypass.status, 409);
  assert.equal((await jsonBody(bypass)).code, "archive_route_required");
});

test("nonlocal static bearer credentials are not a production reviewer identity", async () => {
  const env = makeEnv();
  const response = await reviewGet(context({
    env, url: `https://ledger.example/api/review/${CLAIM_ID}`, params: { id: CLAIM_ID },
    headers: { Authorization: "Bearer admin-alpha-token" },
  }));
  assert.equal(response.status, 404);
});

test("resolved review fails closed without verified original and independent outcome evidence", async () => {
  const env = makeEnv({ demo: true });
  const assignment = await assign(env, "alpha-token");
  const response = await reviewPost(reviewContext(env, "alpha-token", assignment.assignmentId, {
    method: "POST", body: { workType: "claim_adjudication", ...reviewBody({ evidenceIds: ["evidence_oil_archive"] }) },
  }));
  assert.equal(response.status, 409);
  const body = await jsonBody(response);
  assert.ok(body.details.includes("verified_original_statement"));
  assert.ok(body.details.includes("independent_outcome_evidence"));
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM moderator_reviews").get().count, 0);
});

test("body-supplied identity is rejected and one credential cannot become two reviewers", async () => {
  const env = makeEnv({ demo: true });
  seedPublicationEvidence(env);
  const assignment = await assign(env, "alpha-token");
  const spoof = await reviewPost(reviewContext(env, "alpha-token", assignment.assignmentId, {
    method: "POST", body: { workType: "claim_adjudication", ...reviewBody({ reviewerId: "someone_else" }) },
  }));
  assert.equal(spoof.status, 400);
  const first = await reviewPost(reviewContext(env, "alpha-token", assignment.assignmentId, {
    method: "POST", body: { workType: "claim_adjudication", ...reviewBody() },
  }));
  assert.equal(first.status, 201);
  const duplicate = await reviewPost(reviewContext(env, "alpha-token", assignment.assignmentId, {
    method: "POST", body: { workType: "claim_adjudication", ...reviewBody() },
  }));
  assert.equal(duplicate.status, 409);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM moderator_reviews").get().count, 1);
});

test("two credential-derived matching principals publish one immutable revision", async () => {
  const env = makeEnv({ demo: true });
  seedPublicationEvidence(env);
  const alpha = await assign(env, "alpha-token");
  const first = await reviewPost(reviewContext(env, "alpha-token", alpha.assignmentId, {
    method: "POST", body: { workType: "claim_adjudication", ...reviewBody() },
  }));
  assert.equal((await jsonBody(first)).publication.state, "awaiting_second_review");
  const beta = await assign(env, "beta-token");
  const second = await reviewPost(reviewContext(env, "beta-token", beta.assignmentId, {
    method: "POST", body: { workType: "claim_adjudication", ...reviewBody() },
  }));
  assert.equal((await jsonBody(second)).publication.state, "published");
  const stored = env.DB.db.prepare("SELECT visibility,outcome_status FROM claims WHERE claim_id=?").get(CLAIM_ID);
  assert.equal(stored.visibility, "published");
  assert.equal(stored.outcome_status, "false");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claim_revisions").get().count, 1);
  env.DB.db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
    VALUES (?,?,?,?,?,?,?,?)`).run("source_published_unavailable", "person_troy_black", "youtube", VIDEO_ID,
      `https://www.youtube.com/watch?v=${VIDEO_ID}`, "2026-07-20", "2026-07-20", "unavailable");
  const sourceResponse = await sourceGet(context({ env,
    url: "https://example.test/api/people/troy-black/sources?platform=youtube",
    params: { slug: "troy-black" },
  }));
  const publishedSource = (await jsonBody(sourceResponse)).sources[0];
  assert.equal(publishedSource.status, "source_unavailable");
  assert.equal(publishedSource.humanReviewStatus, "reviewed");
  assert.equal(publishedSource.publicStatus, "published");
  const publicProfile = await jsonBody(await personGet(context({ env,
    url: "https://example.test/api/people/troy-black", params: { slug: "troy-black" },
  })));
  assert.ok(publicProfile.claims.some((claim) => claim.claim_id === CLAIM_ID));
  assert.doesNotMatch(JSON.stringify(publishedSource), /reviewer|rationale|transcript|model/i);
  assert.throws(() => env.DB.db.prepare("UPDATE claims SET title='changed' WHERE claim_id=?").run(CLAIM_ID), /immutable revision/);
  assert.throws(() => env.DB.db.prepare("DELETE FROM claims WHERE claim_id=?").run(CLAIM_ID), /cannot be deleted/);
});
