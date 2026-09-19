import test from "node:test";
import assert from "node:assert/strict";
import {
  deadlineLifecycle, evaluatePublication, normalizeReview, reviewDecisionFingerprint,
  validateClaimForPublication, validateContemporaneousEvidence, validateReviewPrerequisites,
} from "../functions/lib/claims.js";

const claim = {
  exact_quote: "A specific statement.", source_url: "https://youtube.com/watch?v=ZidiIdg3U4M",
  source_date: "2020-01-01", source_timestamp_seconds: null,
  statement_type: "testable_prediction", atomic_proposition: "A measurable event.",
  criteria: "An event before the deadline.", deadline: "2020-12-31", as_of_date: "2026-07-19",
};
const original = {
  evidence_id: "original", evidence_role: "original_statement", source_role: "platform",
  verification_method: "authorized_transcript", published_at: "2020-01-01", cutoff_date: null,
};
const outcome = {
  evidence_id: "outcome", evidence_role: "independent_outcome", source_role: "independent",
  verification_method: "unverified", published_at: "2021-01-02", cutoff_date: null,
};
const prior = {
  evidence_id: "prior", evidence_role: "contemporaneous_public_information", source_role: "independent",
  verification_method: "unverified", published_at: "2019-12-20T00:00:00Z", cutoff_date: "2020-01-01",
};
const receipt = {
  receipt_id: "receipt", status: "completed", cutoff_date: "2020-01-01",
  search_queries_json: '["query"]', sources_checked_json: '["source"]',
};
const decision = (overrides = {}) => ({
  claimType: "testable_prediction", outcomeStatus: "false", noveltyStatus: "not_assessed",
  baselineProbability: null, evidenceIds: ["original", "outcome"], priorReceiptId: null, ...overrides,
});
const row = (reviewerId, value) => ({
  reviewer_id: reviewerId,
  claim_type: value.claimType,
  outcome_status: value.outcomeStatus,
  novelty_status: value.noveltyStatus,
  baseline_probability: value.baselineProbability,
  evidence_ids_json: JSON.stringify(value.evidenceIds),
  prior_receipt_id: value.priorReceiptId,
  decision_fingerprint: reviewDecisionFingerprint(value),
});

test("publication requires inspectable source, test fields, and a testable deadline", () => {
  assert.deepEqual(validateClaimForPublication(claim, decision()), { ok: true, missing: [] });
  const failed = validateClaimForPublication({ ...claim, exact_quote: "", deadline: null }, decision());
  assert.ok(failed.missing.includes("exact_quote"));
  assert.ok(failed.missing.includes("deadline"));
});

test("deadline lifecycle is evaluated as of the current review date", () => {
  const now = new Date("2026-07-19T12:00:00Z");
  assert.equal(deadlineLifecycle("2027-01-01", now), "pending");
  assert.equal(deadlineLifecycle("2026-07-30", now), "due_soon");
  assert.equal(deadlineLifecycle("2025-12-31", now), "deadline_passed_awaiting_review");
});

test("resolved outcomes require verified original and independent outcome evidence", () => {
  let gate = validateReviewPrerequisites(claim, [], [], decision());
  assert.ok(gate.missing.includes("verified_original_statement"));
  assert.ok(gate.missing.includes("independent_outcome_evidence"));
  gate = validateReviewPrerequisites(claim, [original, outcome], [], decision());
  assert.deepEqual(gate, { ok: true, missing: [] });
});

test("assessed novelty requires a completed cutoff-bound receipt and valid source dates", () => {
  const assessed = decision({
    noveltyStatus: "strong_signals", baselineProbability: 0.55,
    evidenceIds: ["original", "outcome", "prior"], priorReceiptId: "receipt",
  });
  assert.deepEqual(validateReviewPrerequisites(claim, [original, outcome, prior], [receipt], assessed), { ok: true, missing: [] });
  const late = { ...prior, published_at: "2020-01-02T00:00:00Z" };
  const gate = validateReviewPrerequisites(claim, [original, outcome, late], [receipt], assessed);
  assert.ok(gate.missing.includes("prior_information_after_claim_cutoff"));
  assert.deepEqual(validateContemporaneousEvidence("2020-01-01", late), { ok: false, code: "after_claim_cutoff" });
});

test("reviewer identity is forbidden in the decision body", () => {
  assert.throws(() => normalizeReview({
    reviewerId: "typed-name", claimType: "testable_prediction", outcomeStatus: "false",
    noveltyStatus: "not_assessed", evidenceIds: ["original"], rationale: "body identity",
  }), /reviewer_identity_body_forbidden/);
  assert.throws(() => normalizeReview({
    claimType: "testable_prediction", outcomeStatus: "true", noveltyStatus: "strong_signals",
    baselineProbability: 0.2, priorReceiptId: "receipt", evidenceIds: ["original"], rationale: "optimistic",
  }), /baseline_too_low_or_invalid/);
});

test("the latest accepted authenticated human review owns publication", () => {
  const first = decision({ outcomeStatus: "undetermined", evidenceIds: ["original"] });
  const matching = decision();
  const result = evaluatePublication(claim, [original, outcome], [], [
    row("one", first), row("two", matching), row("three", matching),
  ]);
  assert.equal(result.state, "published");
  assert.deepEqual(result.reviewerIds, ["three"]);
  const differentEvidence = decision({ evidenceIds: ["original", "outcome", "extra"] });
  assert.equal(evaluatePublication(claim, [original, outcome], [], [
    row("one", matching), row("two", differentEvidence),
  ]).state, "blocked");
});
