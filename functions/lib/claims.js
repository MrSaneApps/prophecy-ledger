export const CLAIM_TYPES = new Set([
  "testable_prediction", "present_or_past_factual_claim", "conditional_prediction",
  "symbolic_statement", "general_encouragement", "theological_claim", "personal_interpretation",
]);
export const SCORE_ELIGIBLE_TYPES = new Set(["testable_prediction", "present_or_past_factual_claim"]);
export const OUTCOMES = new Set(["true", "false", "partial", "pending", "undetermined", "not_falsifiable"]);
export const NOVELTY = new Set([
  "already_public", "widely_expected", "strong_signals", "emerging_signals",
  "no_precursor_found", "not_assessed",
]);
const RESOLVED = new Set(["true", "false", "partial"]);
const VERIFIED_ORIGINAL_METHODS = new Set(["timestamp", "authorized_transcript"]);

export const BASELINE_FLOORS = Object.freeze({
  already_public: 0.95,
  widely_expected: 0.75,
  strong_signals: 0.55,
  emerging_signals: 0.35,
  no_precursor_found: 0.15,
});

export function deadlineLifecycle(deadline, asOf = new Date(), dueSoonDays = 30) {
  if (!deadline) return "in_review";
  const end = new Date(`${deadline}T23:59:59.999Z`);
  if (Number.isNaN(end.valueOf())) return "in_review";
  const days = (end.valueOf() - asOf.valueOf()) / 86_400_000;
  if (days < 0) return "deadline_passed_awaiting_review";
  return days <= dueSoonDays ? "due_soon" : "pending";
}

export function validateClaimForPublication(claim, decision) {
  const missing = [];
  for (const field of ["exact_quote", "source_url", "source_date", "atomic_proposition", "criteria", "as_of_date"]) {
    if (!String(claim?.[field] ?? "").trim()) missing.push(field);
  }
  if (!CLAIM_TYPES.has(decision?.claimType)) missing.push("statement_type");
  if (decision?.claimType === "testable_prediction" && !String(claim?.deadline ?? "").trim()) missing.push("deadline");
  return { ok: missing.length === 0, missing };
}

export function validateContemporaneousEvidence(claimDate, item) {
  if (item?.evidence_role !== "contemporaneous_public_information") return { ok: true };
  if (!item.published_at) return { ok: false, code: "published_date_required" };
  const cutoff = new Date(`${claimDate}T23:59:59.999Z`).valueOf();
  const published = new Date(item.published_at).valueOf();
  if (!Number.isFinite(published) || published > cutoff) return { ok: false, code: "after_claim_cutoff" };
  return { ok: true };
}

export function reviewDecisionFingerprint(review) {
  return JSON.stringify({
    claimType: review.claimType,
    outcomeStatus: review.outcomeStatus,
    noveltyStatus: review.noveltyStatus,
    baselineProbability: review.baselineProbability,
    evidenceIds: [...review.evidenceIds].sort(),
    priorReceiptId: review.priorReceiptId || null,
  });
}

export function normalizeReview(input) {
  if (Object.hasOwn(input || {}, "reviewerId")) throw new Error("reviewer_identity_body_forbidden");
  const claimType = String(input?.claimType ?? "").trim();
  const outcomeStatus = String(input?.outcomeStatus ?? "").trim();
  const noveltyStatus = String(input?.noveltyStatus ?? "").trim();
  const rationale = String(input?.rationale ?? "").trim();
  const evidenceIds = Array.isArray(input?.evidenceIds)
    ? [...new Set(input.evidenceIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  const baselineProbability = input?.baselineProbability == null || input.baselineProbability === ""
    ? null : Number(input.baselineProbability);
  const priorReceiptId = input?.priorReceiptId == null || input.priorReceiptId === ""
    ? null : String(input.priorReceiptId).trim();

  if (!CLAIM_TYPES.has(claimType)) throw new Error("claim_type_invalid");
  if (!OUTCOMES.has(outcomeStatus)) throw new Error("outcome_invalid");
  if (!NOVELTY.has(noveltyStatus)) throw new Error("novelty_invalid");
  if (!rationale || evidenceIds.length === 0) throw new Error("evidence_and_rationale_required");
  if (noveltyStatus === "not_assessed") {
    if (baselineProbability != null) throw new Error("baseline_must_be_empty");
    if (priorReceiptId) throw new Error("unexpected_prior_information_receipt");
  } else {
    if (!Number.isFinite(baselineProbability) || baselineProbability < BASELINE_FLOORS[noveltyStatus] || baselineProbability > 1) {
      throw new Error("baseline_too_low_or_invalid");
    }
    if (!priorReceiptId) throw new Error("prior_information_receipt_required");
  }
  const review = { claimType, outcomeStatus, noveltyStatus, baselineProbability, evidenceIds, priorReceiptId, rationale };
  return { ...review, decisionFingerprint: reviewDecisionFingerprint(review) };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function normalizedReviewRow(row) {
  const review = {
    claimType: row.claim_type,
    outcomeStatus: row.outcome_status,
    noveltyStatus: row.novelty_status,
    baselineProbability: row.baseline_probability == null ? null : Number(row.baseline_probability),
    evidenceIds: (parseJsonArray(row.evidence_ids_json) || []).map(String),
    priorReceiptId: row.prior_receipt_id || null,
  };
  return {
    ...review,
    reviewerId: row.reviewer_id,
    reviewerName: row.public_reviewer_name || "Verified reviewer",
    decisionFingerprint: row.decision_fingerprint || reviewDecisionFingerprint(review),
    docAttestation: row.doc_attestation_id ? {
      attestationId: row.doc_attestation_id,
      docRef: row.doc_ref,
      docTitle: row.doc_title,
      verbatimVerdict: row.doc_verbatim_verdict,
      rubricVersion: row.doc_rubric_version,
    } : null,
  };
}

function completedReceipt(receipts, id, sourceDate) {
  const receipt = receipts.find((item) => item.receipt_id === id);
  if (!receipt || receipt.status !== "completed" || receipt.cutoff_date !== sourceDate) return null;
  const queries = parseJsonArray(receipt.search_queries_json);
  const sources = parseJsonArray(receipt.sources_checked_json);
  if (!queries?.length || !sources) return null;
  return receipt;
}

export function validateReviewPrerequisites(claim, evidence, receipts, review) {
  const missing = [];
  const citedIds = new Set(review.evidenceIds);
  const cited = evidence.filter((item) => citedIds.has(item.evidence_id));
  if (cited.length !== citedIds.size) missing.push("cited_evidence_scope");

  const verifiedOriginal = cited.some((item) => {
    if (item.evidence_role !== "original_statement" || !VERIFIED_ORIGINAL_METHODS.has(item.verification_method)) return false;
    return item.verification_method !== "timestamp" || claim.source_timestamp_seconds != null;
  });
  if (!verifiedOriginal) missing.push("verified_original_statement");

  if (RESOLVED.has(review.outcomeStatus) && !cited.some((item) =>
    item.evidence_role === "independent_outcome" && item.source_role === "independent")) {
    missing.push("independent_outcome_evidence");
  }
  if (review.claimType === "testable_prediction" && !String(claim.deadline || "").trim()) missing.push("deadline");

  if (review.noveltyStatus !== "not_assessed") {
    if (!completedReceipt(receipts, review.priorReceiptId, claim.source_date)) {
      missing.push("completed_prior_information_receipt");
    }
    for (const item of cited.filter((entry) => entry.evidence_role === "contemporaneous_public_information")) {
      const result = validateContemporaneousEvidence(claim.source_date, item);
      if (!result.ok) missing.push(`prior_information_${result.code}`);
      if (item.cutoff_date !== claim.source_date) missing.push("prior_information_cutoff_mismatch");
    }
  }
  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}

export function validateDocReview(claim, evidence, decision) {
  const missing = [];
  for (const field of ["exact_quote", "source_url", "source_date", "atomic_proposition", "criteria", "as_of_date"]) {
    if (!String(claim?.[field] ?? "").trim()) missing.push(field);
  }
  if (!CLAIM_TYPES.has(decision?.claimType)) missing.push("statement_type");
  if (decision?.noveltyStatus !== "not_assessed") missing.push("doc_novelty_must_be_unassessed");
  if (decision?.baselineProbability != null) missing.push("doc_baseline_must_be_empty");
  if (decision?.priorReceiptId) missing.push("doc_prior_receipt_forbidden");
  const citedIds = new Set(decision?.evidenceIds || []);
  const cited = evidence.filter((item) => citedIds.has(item.evidence_id));
  if (!citedIds.size || cited.length !== citedIds.size) missing.push("cited_evidence_scope");
  const attestation = decision?.docAttestation || {};
  if (!String(attestation.verbatimVerdict ?? "").trim()) missing.push("doc_verbatim_verdict");
  if (!String(attestation.rubricVersion ?? "").trim()) missing.push("doc_rubric_version");
  if (!String(attestation.docRef ?? "").trim()) missing.push("doc_ref");
  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}

export function evaluatePublication(claim, evidence, receipts, reviews) {
  if (reviews.length < 1) return { state: "needed" };
  const normalized = reviews.map(normalizedReviewRow);
  // A single authenticated human owns the final decision. Legacy claims can
  // contain several accepted reviews, so the newest accepted review wins.
  const decision = normalized.at(-1);
  if (decision.docAttestation) {
    const docGate = validateDocReview(claim, evidence, decision);
    if (docGate.missing.length) return { state: "blocked", missing: docGate.missing };
    return {
      state: "published",
      lane: "doc_review",
      claimType: decision.claimType,
      outcomeStatus: decision.outcomeStatus,
      noveltyStatus: decision.noveltyStatus,
      baselineProbability: decision.baselineProbability,
      evidenceIds: decision.evidenceIds,
      priorReceiptId: decision.priorReceiptId,
      reviewerIds: [decision.reviewerId],
      reviewerNames: [decision.reviewerName],
      decisionFingerprint: decision.decisionFingerprint,
      docRef: decision.docAttestation.docRef,
      docTitle: decision.docAttestation.docTitle,
      rubricVersion: decision.docAttestation.rubricVersion,
      verbatimVerdict: decision.docAttestation.verbatimVerdict,
    };
  }
  const claimGate = validateClaimForPublication(claim, decision);
  const evidenceGate = validateReviewPrerequisites(claim, evidence, receipts, decision);
  const missing = [...claimGate.missing, ...evidenceGate.missing];
  if (missing.length) return { state: "blocked", missing: [...new Set(missing)] };
  return {
    state: "published",
    lane: "interactive",
    claimType: decision.claimType,
    outcomeStatus: decision.outcomeStatus,
    noveltyStatus: decision.noveltyStatus,
    baselineProbability: decision.baselineProbability,
    evidenceIds: decision.evidenceIds,
    priorReceiptId: decision.priorReceiptId,
    reviewerIds: [decision.reviewerId],
    reviewerNames: [decision.reviewerName],
    decisionFingerprint: decision.decisionFingerprint,
  };
}
