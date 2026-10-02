import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluatePublication, reviewDecisionFingerprint, validateDocReview,
} from "../functions/lib/claims.js";
import { getPersonProfile } from "../functions/lib/repository.js";
import { makeEnv, ROOT } from "./helpers/d1.mjs";

const claim = {
  exact_quote: "A specific statement.", source_url: "https://youtube.com/watch?v=ZidiIdg3U4M",
  source_date: "2020-01-01", source_timestamp_seconds: null,
  statement_type: "testable_prediction", atomic_proposition: "A measurable event.",
  criteria: "An event before the deadline.", deadline: "2020-12-31", as_of_date: "2026-07-19",
};
const archival = {
  evidence_id: "archival", evidence_role: "retrospective_fulfillment", source_role: "speaker_authored",
  verification_method: "unverified", published_at: null, cutoff_date: null,
};
const attestation = {
  doc_attestation_id: "docattest_test", doc_ref: "doc-2026-09",
  doc_title: "Independent Review", doc_verbatim_verdict: "Fail as stated.",
  doc_rubric_version: "doc-rubric-v1",
};
const decision = (overrides = {}) => ({
  claimType: "testable_prediction", outcomeStatus: "false", noveltyStatus: "not_assessed",
  baselineProbability: null, evidenceIds: ["archival"], priorReceiptId: null, ...overrides,
});
const row = (reviewerId, value, attest = attestation) => ({
  reviewer_id: reviewerId,
  claim_type: value.claimType,
  outcome_status: value.outcomeStatus,
  novelty_status: value.noveltyStatus,
  baseline_probability: value.baselineProbability,
  evidence_ids_json: JSON.stringify(value.evidenceIds),
  prior_receipt_id: value.priorReceiptId,
  decision_fingerprint: reviewDecisionFingerprint(value),
  public_reviewer_name: "Joshua",
  ...attest,
});

const normalizedAttestation = {
  verbatimVerdict: attestation.doc_verbatim_verdict,
  rubricVersion: attestation.doc_rubric_version,
  docRef: attestation.doc_ref,
};

test("doc-lane review publishes without deadline, verified original, or independent outcome evidence", () => {
  const dateless = { ...claim, deadline: null };
  const gate = validateDocReview(dateless, [archival], { ...decision(), docAttestation: normalizedAttestation });
  assert.deepEqual(gate, { ok: true, missing: [] });
  const result = evaluatePublication(dateless, [archival], [], [row("reviewer_joshua", decision())]);
  assert.equal(result.state, "published");
  assert.equal(result.lane, "doc_review");
  assert.equal(result.outcomeStatus, "false");
  assert.equal(result.noveltyStatus, "not_assessed");
  assert.equal(result.baselineProbability, null);
  assert.equal(result.verbatimVerdict, "Fail as stated.");
});

test("doc lane forbids assessed novelty, baselines, and prior receipts", () => {
  const assessed = { ...decision(), noveltyStatus: "strong_signals", docAttestation: attestation };
  assert.ok(validateDocReview(claim, [archival], assessed).missing.includes("doc_novelty_must_be_unassessed"));
  const baselined = { ...decision(), baselineProbability: 0.5, docAttestation: attestation };
  assert.ok(validateDocReview(claim, [archival], baselined).missing.includes("doc_baseline_must_be_empty"));
  const receipted = { ...decision(), priorReceiptId: "receipt", docAttestation: attestation };
  assert.ok(validateDocReview(claim, [archival], receipted).missing.includes("doc_prior_receipt_forbidden"));
  assert.equal(evaluatePublication(claim, [archival], [], [row("r", decision({ noveltyStatus: "strong_signals" }))]).state, "blocked");
});

test("doc lane requires verbatim verdict, rubric version, and doc ref", () => {
  for (const key of ["doc_verbatim_verdict", "doc_rubric_version", "doc_ref"]) {
    const attest = { ...attestation, [key]: "  " };
    const gate = validateDocReview(claim, [archival],
      { ...decision(), docAttestation: { verbatimVerdict: attest.doc_verbatim_verdict, rubricVersion: attest.doc_rubric_version, docRef: attest.doc_ref } });
    assert.equal(gate.ok, false);
  }
  const empty = { ...attestation, doc_attestation_id: null };
  assert.equal(evaluatePublication(claim, [archival], [], [row("r", decision(), empty)]).state, "blocked");
});

test("interactive publication is unchanged and carries an explicit lane", () => {
  const verified = {
    evidence_id: "original", evidence_role: "original_statement", source_role: "platform",
    verification_method: "authorized_transcript", published_at: "2020-01-01", cutoff_date: null,
  };
  const outcome = {
    evidence_id: "outcome", evidence_role: "independent_outcome", source_role: "independent",
    verification_method: "unverified", published_at: "2021-01-02", cutoff_date: null,
  };
  const plain = row("reviewer_alpha", decision({ evidenceIds: ["original", "outcome"] }), {});
  const result = evaluatePublication(claim, [verified, outcome], [], [plain]);
  assert.equal(result.state, "published");
  assert.equal(result.lane, "interactive");
});

test("doc-lane migration replay publishes the 150 reviewed claims for Joshua", () => {
  const env = makeEnv();
  const db = env.DB.db;
  // Base env has no Joshua attribution, so 0064 is a verified no-op there.
  assert.equal(db.prepare("SELECT count(*) count FROM doc_review_attestations").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM moderator_reviews").get().count, 0);
  db.prepare(
    `INSERT INTO reviewer_public_attributions (attribution_id,reviewer_id,display_name,created_at)
     VALUES ('attribution_joshua_doctest','reviewer_joshua_doctest','Joshua','2026-09-21T00:00:00.000Z')`
  ).run();
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0064_joshua_doc_adjudications.sql"), "utf8"));

  const published = db.prepare("SELECT count(*) count FROM claims WHERE claim_id LIKE 'tb-%' AND visibility='published'").get().count;
  assert.equal(published, 150);
  assert.equal(db.prepare("SELECT count(*) count FROM claims WHERE claim_id NOT LIKE 'tb-%' AND visibility='published'").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM moderator_reviews").get().count, 150);
  assert.equal(db.prepare("SELECT count(*) count FROM moderator_reviews WHERE novelty_status='not_assessed' AND baseline_probability IS NULL AND prior_receipt_id IS NULL").get().count, 150);
  assert.equal(db.prepare("SELECT count(*) count FROM doc_review_attestations").get().count, 150);
  assert.equal(db.prepare("SELECT count(*) count FROM claim_revisions").get().count, 150);
  assert.equal(db.prepare("SELECT count(*) count FROM review_work_items WHERE work_type='claim_adjudication' AND status='complete'").get().count, 150);
  assert.equal(db.prepare("SELECT count(*) count FROM publication_evaluations WHERE state='published'").get().count, 150);
  const outcomes = db.prepare("SELECT outcome_status outcome,count(*) count FROM claims WHERE claim_id LIKE 'tb-%' GROUP BY outcome_status").all();
  assert.deepEqual(Object.fromEntries(outcomes.map((item) => [item.outcome, item.count])),
    { false: 103, partial: 38, undetermined: 5, not_falsifiable: 3, true: 1 });

  // Stored fingerprints must equal a fresh recomputation (SQL mirrors the code).
  for (const stored of db.prepare("SELECT * FROM moderator_reviews").all()) {
    const recomputed = reviewDecisionFingerprint({
      claimType: stored.claim_type, outcomeStatus: stored.outcome_status,
      noveltyStatus: stored.novelty_status,
      baselineProbability: stored.baseline_probability == null ? null : Number(stored.baseline_probability),
      evidenceIds: JSON.parse(stored.evidence_ids_json), priorReceiptId: stored.prior_receipt_id || null,
    });
    assert.equal(stored.decision_fingerprint, recomputed);
  }

  // The evaluator agrees with the migrated rows (no silent bypass).
  for (const id of ["tb-2020-22-01-abortion-and-the-2020-election", "tb-2023-15-swing-states", "tb-2024-05-trump-stock"]) {
    const claimRow = db.prepare("SELECT * FROM claims WHERE claim_id=?").get(id);
    const evidence = db.prepare("SELECT * FROM evidence WHERE claim_id=?").all(id);
    const reviewRow = db.prepare(
      `SELECT review.*,attribution.display_name public_reviewer_name,
        docatt.attestation_id doc_attestation_id,docatt.doc_ref doc_ref,
        docatt.doc_title doc_title,docatt.verbatim_verdict doc_verbatim_verdict,
        docatt.rubric_version doc_rubric_version
       FROM moderator_reviews review
       LEFT JOIN doc_review_attestations docatt ON docatt.review_id=review.review_id
       LEFT JOIN reviewer_public_attributions attribution ON attribution.reviewer_id=review.reviewer_id
       WHERE review.claim_id=?`
    ).get(id);
    const result = evaluatePublication(claimRow, evidence, [], [reviewRow]);
    assert.equal(result.state, "published");
    assert.equal(result.lane, "doc_review");
    assert.equal(result.outcomeStatus, claimRow.outcome_status);
  }

  // Idempotent replay changes nothing.
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0064_joshua_doc_adjudications.sql"), "utf8"));
  assert.equal(db.prepare("SELECT count(*) count FROM moderator_reviews").get().count, 150);
  assert.equal(db.prepare("SELECT count(*) count FROM claim_revisions").get().count, 150);
});

test("doc-lane publication surfaces Joshua decisions and honest scoring", async () => {
  const env = makeEnv();
  const db = env.DB.db;
  db.prepare(
    `INSERT INTO reviewer_public_attributions (attribution_id,reviewer_id,display_name,created_at)
     VALUES ('attribution_joshua_doctest','reviewer_joshua_doctest','Joshua','2026-09-21T00:00:00.000Z')`
  ).run();
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0064_joshua_doc_adjudications.sql"), "utf8"));
  const profile = await getPersonProfile(env.DB, "troy-black");
  assert.equal(profile.claims.length, 150);
  const record = profile.researchRecords.find((item) => item.id === "tb-2020-22-01-abortion-and-the-2020-election");
  assert.equal(record.humanDecision.reviewerName, "Joshua");
  assert.equal(record.humanDecision.outcomeStatus, "false");
  assert.match(record.humanDecision.rationale, /independent review/);
  assert.match(record.humanDecision.rationale, /no interactive review session/);
  assert.deepEqual(record.missingGates, []);
  assert.equal(record.finalAdjudicationStatus, "published");
  assert.match(profile.claims.find((item) => item.claim_id === record.id).publication_summary,
    /independent review document/);
  assert.equal(profile.score.resolvedClusters, 142);
  assert.equal(profile.score.strictHits, 1);
  assert.equal(profile.score.statisticalResult, "insufficient sample");
  assert.equal(profile.score.expectedHits, null);
  assert.equal(profile.corpusCoverage.finalRatings, 150);
  assert.equal(profile.corpusCoverage.claimsCheckedByPeople, 150);
});
