import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPersonProfile, getPublicClaim } from "../functions/lib/repository.js";
import { makeEnv, ROOT } from "./helpers/d1.mjs";

const HALEY = "tb-2024-03-nikki-haley-s-loss";

function seedJoshua(env) {
  env.DB.db.prepare(
    `INSERT INTO reviewer_public_attributions (attribution_id,reviewer_id,display_name,created_at)
     VALUES ('attribution_joshua_doctest','reviewer_joshua_doctest','Joshua','2026-09-21T00:00:00.000Z')`
  ).run();
}

function replayDocLane(env) {
  seedJoshua(env);
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0064_joshua_doc_adjudications.sql"), "utf8"));
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0066_haley_amendment.sql"), "utf8"));
}

test("decision amendments are append-only and chained per claim", () => {
  const env = makeEnv();
  replayDocLane(env);
  const db = env.DB.db;
  assert.equal(db.prepare("SELECT count(*) count FROM claim_decision_amendments").get().count, 1);
  assert.throws(() => db.prepare(
    "UPDATE claim_decision_amendments SET outcome_status='false' WHERE claim_id=?").run(HALEY),
    /append-only/);
  assert.throws(() => db.prepare(
    "DELETE FROM claim_decision_amendments WHERE claim_id=?").run(HALEY),
    /append-only/);
  assert.throws(() => db.prepare(
    `INSERT INTO claim_decision_amendments (amendment_id,claim_id,amendment_number,
      supersedes_revision_id,reviewer_id,corrected_by,outcome_status,novelty_status,
      rationale,created_at)
     VALUES ('dup',?,1,'revision_publication_x','reviewer_joshua_doctest','site_owner',
      'true','not_assessed','dup','2026-09-21T15:00:00.000Z')`).run(HALEY),
    /UNIQUE constraint failed/);
});

test("Haley amendment surfaces the corrected outcome with history", async () => {
  const env = makeEnv();
  replayDocLane(env);
  const profile = await getPersonProfile(env.DB, "troy-black");
  const claim = profile.claims.find((item) => item.claim_id === HALEY);
  assert.equal(claim.outcome_status, "true");
  assert.equal(claim.humanDecision.outcomeStatus, "true");
  assert.equal(claim.humanDecision.correction.previousOutcomeStatus, "false");
  assert.match(claim.humanDecision.correction.rationale, /correct prediction/);
  assert.equal(claim.humanDecision.correction.reviewerName, "Joshua");
  const record = profile.researchRecords.find((item) => item.id === HALEY);
  assert.equal(record.humanDecision.outcomeStatus, "true");
  assert.equal(record.humanDecision.correction.previousOutcomeStatus, "false");
  // Original rows are untouched.
  assert.equal(env.DB.db.prepare("SELECT outcome_status FROM claims WHERE claim_id=?").get(HALEY).outcome_status, "false");
  assert.equal(env.DB.db.prepare("SELECT outcome_status FROM moderator_reviews WHERE claim_id=?").get(HALEY).outcome_status, "false");
  // Unamended claims carry no correction key.
  const other = profile.claims.find((item) => item.claim_id === "tb-2023-15-swing-states");
  assert.equal(other.outcome_status, "true");
  assert.equal("correction" in other.humanDecision, false);
});

test("amended outcomes flow into scoring", async () => {
  const env = makeEnv();
  replayDocLane(env);
  const profile = await getPersonProfile(env.DB, "troy-black");
  assert.equal(profile.score.resolvedClusters, 142);
  assert.equal(profile.score.strictHits, 2);
});

test("latest amendment wins and the claim page keeps full history", async () => {
  const env = makeEnv();
  replayDocLane(env);
  const db = env.DB.db;
  db.prepare(
    `INSERT INTO claim_decision_amendments (amendment_id,claim_id,amendment_number,
      supersedes_revision_id,reviewer_id,corrected_by,outcome_status,novelty_status,
      rationale,created_at)
     SELECT 'amendment_tb_2024_03_02',?1,2,revision_id,'reviewer_joshua_doctest',
      'site_owner','partial','not_assessed','second thoughts test','2026-09-22T00:00:00.000Z'
     FROM claim_revisions WHERE claim_id=?1 AND revision_type='publication'`
  ).run(HALEY);
  const detail = await getPublicClaim(env.DB, HALEY);
  assert.equal(detail.claim.outcome_status, "partial");
  assert.equal(detail.publication.humanDecision.outcomeStatus, "partial");
  assert.equal(detail.publication.humanDecision.correction.amendmentNumber, 2);
  assert.equal(detail.corrections.length, 2);
  assert.deepEqual(detail.corrections.map((item) => item.outcomeStatus), ["true", "partial"]);
  assert.ok(detail.timeline.some((item) => item.event_type === "correction"));
});

test("claims without amendments keep a clean detail shape", async () => {
  const env = makeEnv();
  replayDocLane(env);
  const detail = await getPublicClaim(env.DB, "tb-2023-15-swing-states");
  assert.equal(detail.claim.outcome_status, "true");
  assert.equal("correction" in detail.publication.humanDecision, false);
  assert.deepEqual(detail.corrections, []);
});
