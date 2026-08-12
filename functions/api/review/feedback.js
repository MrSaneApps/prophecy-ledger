import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import { apiError, json, readJson } from "../../lib/response.js";

const CATEGORIES = new Set([
  "ai_extraction_quality", "ui_friction", "evidence_gap", "feature_request", "other",
]);

const CATEGORY_LABELS = {
  ai_extraction_quality: "AI candidate quality",
  ui_friction: "UI friction",
  evidence_gap: "Evidence gap",
  feature_request: "Feature request",
  other: "Other",
};

const RESEARCH_CATEGORIES = new Set(["ai_extraction_quality", "evidence_gap"]);

function actionState(category, claimId) {
  return claimId && RESEARCH_CATEGORIES.has(category) ? "routed_to_research" : "maintainer_review";
}

function optionalRef(value, max = 120) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > max) throw new Error("reference_too_long");
  return text;
}

export async function onRequestGet({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  let claimId = null;
  try {
    const requested = new URL(request.url).searchParams.get("claimId");
    claimId = requested ? optionalRef(requested) : null;
  } catch {
    return apiError("The claim reference is invalid.", "reference_invalid", 400);
  }
  try {
    const result = await env.DB.prepare(
      `SELECT feedback.feedback_id, feedback.category, feedback.claim_id,
        feedback.candidate_id, feedback.assignment_id, feedback.message, feedback.created_at,
        feedback.link_reason,
        CASE
          WHEN feedback.link_reason='live_qa_correlation' THEN 'qa_receipt'
          WHEN feedback.category IN ('ai_extraction_quality','evidence_gap')
            AND feedback.claim_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM ai_draft_decisions draft
              WHERE draft.claim_id=feedback.claim_id AND draft.created_at>feedback.created_at)
            THEN 'research_applied'
          WHEN feedback.category IN ('ai_extraction_quality','evidence_gap')
            AND feedback.claim_id IS NOT NULL THEN 'routed_to_research'
          ELSE 'maintainer_review'
        END action_state,
        (SELECT draft.outcome_status FROM ai_draft_decisions draft
          WHERE draft.claim_id=feedback.claim_id AND draft.created_at>feedback.created_at
            AND COALESCE(feedback.link_reason,'')<>'live_qa_correlation'
          ORDER BY draft.created_at DESC,draft.revision DESC LIMIT 1) response_outcome,
        (SELECT draft.reasoning FROM ai_draft_decisions draft
          WHERE draft.claim_id=feedback.claim_id AND draft.created_at>feedback.created_at
            AND COALESCE(feedback.link_reason,'')<>'live_qa_correlation'
          ORDER BY draft.created_at DESC,draft.revision DESC LIMIT 1) response_message,
        (SELECT draft.created_at FROM ai_draft_decisions draft
          WHERE draft.claim_id=feedback.claim_id AND draft.created_at>feedback.created_at
            AND COALESCE(feedback.link_reason,'')<>'live_qa_correlation'
          ORDER BY draft.created_at DESC,draft.revision DESC LIMIT 1) response_created_at
       FROM reviewer_feedback_effective feedback
       WHERE feedback.reviewer_id=?1
         AND (?2 IS NULL OR feedback.claim_id=?2)
       ORDER BY feedback.created_at DESC
       LIMIT 20`
    ).bind(principal.reviewerId, claimId).all();
    const items = (result.results || []).map((row) => ({
      feedbackId: row.feedback_id,
      category: row.category,
      categoryLabel: CATEGORY_LABELS[row.category] || row.category,
      claimId: row.claim_id,
      candidateId: row.candidate_id,
      assignmentId: row.assignment_id,
      message: row.message,
      actionState: row.action_state,
      notePurpose: row.link_reason === "live_qa_correlation" ? "live_qa_receipt" : "reviewer_note",
      createdAt: row.created_at,
      response: row.response_message ? {
        type: "ai_research",
        outcomeStatus: row.response_outcome,
        message: row.response_message,
        createdAt: row.response_created_at,
      } : null,
    }));
    return json({
      items,
      note: "Your feedback is append-only. Claim-linked AI/evidence notes route to research; other notes route to maintainers.",
    });
  } catch (error) {
    console.error("feedback_list_failed", error);
    return apiError("Your feedback history is unavailable.", "feedback_unavailable", 503);
  }
}

export async function onRequestPost({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  let body;
  try { body = await readJson(request, 8_192); } catch (error) {
    return apiError("The feedback must be a small JSON object.", error.message,
      error.message === "body_too_large" ? 413 : 400);
  }
  const category = String(body?.category || "").trim();
  const message = String(body?.message || "").trim();
  if (!CATEGORIES.has(category)) return apiError("Choose a supported feedback category.", "category_invalid", 400);
  if (message.length < 5 || message.length > 4_000) {
    return apiError("Feedback must be between 5 and 4000 characters.", "message_length_invalid", 400);
  }
  let claimId, candidateId, assignmentId;
  try {
    claimId = optionalRef(body.claimId);
    candidateId = optionalRef(body.candidateId);
    assignmentId = optionalRef(body.assignmentId);
  } catch {
    return apiError("References must be short identifiers.", "reference_invalid", 400);
  }
  const feedbackId = `feedback_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO reviewer_feedback
       (feedback_id,reviewer_id,category,claim_id,candidate_id,assignment_id,message,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
    ).bind(feedbackId, principal.reviewerId, category, claimId, candidateId, assignmentId,
      message, createdAt).run();
  } catch (error) {
    if (/FOREIGN KEY/i.test(String(error))) {
      return apiError("The referenced claim or candidate does not exist.", "reference_unknown", 400);
    }
    console.error("feedback_failed", error);
    return apiError("The feedback could not be saved.", "feedback_unavailable", 503);
  }
  return json({
    feedbackId,
    state: "feedback_recorded",
    createdAt,
    category,
    categoryLabel: CATEGORY_LABELS[category] || category,
    actionState: actionState(category, claimId),
    message,
    claimId,
    candidateId,
    assignmentId,
  }, 201);
}
