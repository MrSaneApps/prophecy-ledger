import { resolveReviewerPrincipal } from "../../../lib/reviewer-auth.js";
import {
  getAssignedArchiveReviewBundle, hasArchiveReviewerSubmission,
  normalizeArchiveDecision, submitArchiveDecision,
} from "../../../lib/archive-review-workflow.js";
import {
  matchedReceiptFor, prepareSupportedObservationBridge,
} from "../../../lib/archive-conveyor.js";
import { ReviewWorkflowError } from "../../../lib/review-workflow.js";
import { apiError, json, readJson } from "../../../lib/response.js";

function hidden() { return apiError("Not found.", "not_found", 404); }

function conveyorError(reason) {
  const unavailable = new Set([
    "artifact_receipt_mismatch", "artifact_unavailable", "artifact_hash_mismatch",
    "source_missing", "source_identity_incomplete",
  ]);
  return unavailable.has(reason)
    ? new ReviewWorkflowError("archive_conveyor_unavailable",
      "The bound transcript could not be verified right now. Retry this source check.", 503)
    : new ReviewWorkflowError(reason,
      "The source-supported decision does not match the bound transcript receipt.", 409);
}

async function assignmentScope(db, assignmentId, reviewerId) {
  return db.prepare(
    `SELECT work.archive_revision_id, work.archive_video_link_id
     FROM archive_review_assignments assignment
     JOIN archive_verification_work_items work
       ON work.archive_work_item_id=assignment.archive_work_item_id
     WHERE assignment.archive_assignment_id=?1 AND assignment.reviewer_id=?2`
  ).bind(assignmentId, reviewerId).first();
}

export async function onRequestGet({ request, env, params }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return hidden();
  const assignmentId = String(params.id || "");
  try {
    const bundle = await getAssignedArchiveReviewBundle(env.DB, assignmentId, principal.reviewerId);
    if (!bundle) return hidden();
    const scope = await assignmentScope(env.DB, assignmentId, principal.reviewerId);
    let matcherReceipt = null;
    if (scope) {
      const receipt = await matchedReceiptFor(env.DB, scope.archive_revision_id, scope.archive_video_link_id);
      if (receipt) {
        matcherReceipt = {
          matchStatus: receipt.match_status,
          matcherVersion: receipt.matcher_version,
          exactQuote: receipt.exact_quote,
          quoteStart: Number(receipt.quote_start),
          quoteEnd: Number(receipt.quote_end),
          clipStartSeconds: receipt.approximate_clip_start_seconds == null
            ? null : Number(receipt.approximate_clip_start_seconds),
        };
      }
    }
    return json({
      principal: { mode: principal.mode, demo: principal.mode === "local_non_deployable_demo" },
      warning: "Assigned private archive source check. First-party claims are leads, not proof.",
      ...bundle,
      matcherReceipt,
    });
  } catch (error) {
    console.error("archive_get_failed", error);
    return apiError("The archive assignment is unavailable.", "archive_unavailable", 503);
  }
}

export async function onRequestPost({ request, env, params }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return hidden();
  const assignmentId = String(params.id || "");
  let input;
  try { input = await readJson(request, 32_768); } catch (error) {
    return apiError("The decision must be valid JSON.", error.message,
      error.message === "body_too_large" ? 413 : 400);
  }
  try {
    if (await hasArchiveReviewerSubmission(env.DB, assignmentId, principal.reviewerId)) {
      return apiError("This reviewer already submitted this archive assignment.", "duplicate_reviewer", 409);
    }
    if (String(input?.workType || "") !== "archive_lead_verification") {
      throw new ReviewWorkflowError(
        "work_type_mismatch", "The submission does not match the assignment type.", 400,
      );
    }
    const scope = await assignmentScope(env.DB, assignmentId, principal.reviewerId);
    const decision = normalizeArchiveDecision(input);
    const now = new Date().toISOString();
    const decisionId = `archive_decision_${crypto.randomUUID()}`;
    const observationId = `archive_observation_${crypto.randomUUID()}`;
    let conveyor = { bridged: false, reason: "not_supported_decision" };
    if (decision.decision === "source_supported") {
      if (!scope) throw new ReviewWorkflowError(
        "assignment_required", "A live archive assignment is required.", 404,
      );
      conveyor = await prepareSupportedObservationBridge(env.DB, env.ARTIFACTS, {
        archiveRevisionId: scope.archive_revision_id,
        archiveVideoLinkId: scope.archive_video_link_id,
        decisionId, observationId, decision, now,
      });
      if (!conveyor.bridged && conveyor.reason !== "no_matched_receipt") {
        throw conveyorError(conveyor.reason);
      }
    }
    const result = await submitArchiveDecision(
      env.DB, assignmentId, principal.reviewerId, decision, now,
      {
        decisionId, observationId,
        additionalStatements: conveyor.bridged ? conveyor.statements : [],
      },
    );
    const { statements: _statements, ...publicConveyor } = conveyor;
    return json({ state: "archive_decision_recorded", ...result, conveyor: publicConveyor }, 201);
  } catch (error) {
    if (error instanceof ReviewWorkflowError) return apiError(error.message, error.code, error.status);
    console.error("archive_post_failed", error);
    return apiError("The archive decision could not be saved.", "archive_unavailable", 503);
  }
}
