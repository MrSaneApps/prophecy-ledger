import { normalizeReview, validateReviewPrerequisites } from "../../lib/claims.js";
import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import {
  getAssignedReviewBundle, hasReviewerSubmission, normalizeCandidateDecision,
  reconcilePublication, recordReviewAudit, ReviewWorkflowError, submitAssignedClaimReview,
  submitCandidateDecision,
} from "../../lib/review-workflow.js";
import {
  getAssignedArchiveReviewBundle, hasArchiveReviewerSubmission,
} from "../../lib/archive-review-workflow.js";
import { apiError, json, readJson } from "../../lib/response.js";

function hidden() { return apiError("Not found.", "not_found", 404); }

async function bestEffortAudit(db, event) {
  const archiveAssignmentId = String(event.assignmentId || "").startsWith("archive_assignment_")
    ? event.assignmentId : null;
  const safeEvent = archiveAssignmentId ? {
    ...event, assignmentId: null,
    detail: { ...(event.detail || {}), archiveAssignmentId },
  } : event;
  try { await recordReviewAudit(db, safeEvent); } catch { console.error("review_audit_failed"); }
}

async function authenticate(request, env) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) {
    await bestEffortAudit(env.DB, { eventType: "auth_failed", detail: { code: "missing_or_invalid" } });
    return null;
  }
  await recordReviewAudit(env.DB, {
    reviewerId: principal.reviewerId, eventType: "auth_succeeded", detail: { mode: principal.mode },
  });
  return principal;
}

function publicEvaluation(result) {
  if (!result) return { state: "evaluation_pending" };
  return {
    state: result.state,
    ...(result.missing ? { missing: result.missing } : {}),
    ...(result.outcomeStatus ? { outcomeStatus: result.outcomeStatus } : {}),
  };
}

export async function onRequestGet({ request, env, params }) {
  let principal;
  try { principal = await authenticate(request, env); } catch (error) {
    console.error("review_auth_audit_failed", error);
    return apiError("The reviewer service is unavailable.", "review_unavailable", 503);
  }
  if (!principal) return hidden();
  const assignmentId = String(params.id || "");
  try {
    const bundle = await getAssignedArchiveReviewBundle(
      env.DB, assignmentId, principal.reviewerId,
    ) || await getAssignedReviewBundle(env.DB, assignmentId, principal.reviewerId);
    if (!bundle) {
      await recordReviewAudit(env.DB, {
        reviewerId: principal.reviewerId, eventType: "access_denied",
        detail: { code: "assignment_required" },
      });
      return hidden();
    }
    const archive = bundle.assignment.workType === "archive_lead_verification";
    await recordReviewAudit(env.DB, {
      reviewerId: principal.reviewerId, eventType: "access_granted",
      workItemId: archive ? null : bundle.assignment.workItemId,
      claimId: bundle.assignment.workType === "claim_adjudication" ? bundle.subject.claim_id : null,
      candidateId: bundle.assignment.workType === "candidate_verification" ? bundle.subject.candidate_id : null,
      assignmentId: archive ? null : assignmentId,
      detail: archive
        ? { workType: bundle.assignment.workType, archiveAssignmentId: assignmentId,
          archiveWorkItemId: bundle.assignment.workItemId }
        : { workType: bundle.assignment.workType },
    });
    return json({
      principal: { mode: principal.mode, demo: principal.mode === "local_non_deployable_demo" },
      warning: "Assigned private work. Previous reviewer decisions and rationales are blinded.",
      ...bundle,
    });
  } catch (error) {
    console.error("review_get_failed", error);
    return apiError("The assigned review is unavailable.", "review_unavailable", 503);
  }
}

export async function onRequestPost({ request, env, params }) {
  let principal;
  try { principal = await authenticate(request, env); } catch (error) {
    console.error("review_auth_audit_failed", error);
    return apiError("The reviewer service is unavailable.", "review_unavailable", 503);
  }
  if (!principal) return hidden();
  const assignmentId = String(params.id || "");
  let input;
  try { input = await readJson(request, 16_384); } catch (error) {
    return apiError("The review must be valid JSON.", error.message, error.message === "body_too_large" ? 413 : 400);
  }

  try {
    if (await hasArchiveReviewerSubmission(env.DB, assignmentId, principal.reviewerId)
        || await hasReviewerSubmission(env.DB, assignmentId, principal.reviewerId)) {
      await bestEffortAudit(env.DB, {
        reviewerId: principal.reviewerId, eventType: "submission_rejected", assignmentId,
        detail: { code: "duplicate_reviewer" },
      });
      return apiError("This authenticated reviewer already submitted this assignment.", "duplicate_reviewer", 409);
    }
    const bundle = await getAssignedArchiveReviewBundle(
      env.DB, assignmentId, principal.reviewerId,
    ) || await getAssignedReviewBundle(env.DB, assignmentId, principal.reviewerId);
    if (!bundle) throw new ReviewWorkflowError("assignment_required", "A live assignment is required.", 404);
    if (String(input?.workType || "") !== bundle.assignment.workType) {
      throw new ReviewWorkflowError("work_type_mismatch", "The submission does not match the assignment type.", 400);
    }

    if (bundle.assignment.workType === "candidate_verification") {
      const decision = normalizeCandidateDecision(input);
      const result = await submitCandidateDecision(env.DB, assignmentId, principal.reviewerId, decision);
      return json({ state: "candidate_decision_recorded", ...result }, 201);
    }

    if (bundle.assignment.workType === "archive_lead_verification") {
      return apiError(
        "Archive source checks must use the transcript-bound archive route.",
        "archive_route_required", 409,
      );
    }

    let reviewInput = input;
    let sendback = null;
    if (typeof input?.verdict === "string") {
      const draft = bundle.aiDraftDecision;
      if (!draft) {
        throw new ReviewWorkflowError("draft_missing", "No pending AI draft decision exists for this claim.", 409);
      }
      if (!["agree", "disagree"].includes(input.verdict)) {
        throw new ReviewWorkflowError("verdict_invalid", "Choose agree or disagree.", 400);
      }
      const outcomeStatus = input.verdict === "agree"
        ? draft.outcomeStatus : String(input.disagreeOutcome || "").trim();
      if (input.verdict === "disagree" && !outcomeStatus) {
        throw new ReviewWorkflowError("disagree_outcome_required", "State the outcome you find supported.", 400);
      }
      reviewInput = {
        claimType: draft.claimType,
        outcomeStatus,
        noveltyStatus: draft.noveltyStatus,
        baselineProbability: draft.baselineProbability,
        evidenceIds: draft.evidenceIds,
        priorReceiptId: draft.priorReceiptId,
        rationale: input.rationale,
      };
      if (input.verdict === "disagree") {
        sendback = {
          draftId: draft.draftId,
          draftRevision: draft.revision,
          rejectedOutcome: draft.outcomeStatus,
          lesson: String(input.rationale || "").trim(),
        };
      }
    }
    let review;
    try { review = normalizeReview(reviewInput); } catch (error) {
      throw new ReviewWorkflowError(error.message, "The review did not pass the publication rules.", 400);
    }
    if (bundle.subject.visibility === "published") {
      throw new ReviewWorkflowError("already_published", "This adjudication is immutable after publication.", 409);
    }
    // Send-back (disagree) returns the claim to research; it must NOT be blocked
    // by publication evidence prerequisites. Only Accept (agree / publish path)
    // continues to require the full cited record.
    if (!sendback) {
      const prerequisites = validateReviewPrerequisites(
        bundle.subject, bundle.evidence, bundle.priorInformationReceipts, review,
      );
      if (!prerequisites.ok) {
        return apiError("The cited record is not sufficient for this review decision.",
          "review_prerequisites_missing", 409, prerequisites.missing);
      }
    }
    const accepted = await submitAssignedClaimReview(
      env.DB, assignmentId, principal.reviewerId, review, undefined, sendback,
    );
    const evaluation = sendback
      ? { state: "research_requested" }
      : await reconcilePublication(env.DB, accepted.claimId);
    return json({
      reviewId: accepted.reviewId,
      publication: publicEvaluation(evaluation),
      sendbackRecorded: Boolean(accepted.sendbackRecorded),
      advance: true,
    }, 201);
  } catch (error) {
    const duplicate = /UNIQUE constraint failed: (moderator_reviews|candidate_review_decisions|archive_review_decisions)/.test(String(error));
    const code = duplicate ? "duplicate_reviewer" : (error.code || "review_unavailable");
    await bestEffortAudit(env.DB, {
      reviewerId: principal.reviewerId, eventType: "submission_rejected", assignmentId,
      detail: { code },
    });
    if (duplicate) return apiError("This authenticated reviewer already submitted this assignment.", code, 409);
    if (error instanceof ReviewWorkflowError) return apiError(error.message, error.code, error.status);
    console.error("review_post_failed", error);
    return apiError("The review could not be saved.", "review_unavailable", 503);
  }
}
