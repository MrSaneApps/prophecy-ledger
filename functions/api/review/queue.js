import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import {
  getReviewerPublicName, leaseReviewWork, listReviewerAssignments, reconcileNeededPublications, recordReviewAudit,
  ReviewWorkflowError, switchLease,
} from "../../lib/review-workflow.js";
import { readJson } from "../../lib/response.js";
import {
  listArchiveReviewerAssignments,
} from "../../lib/archive-review-workflow.js";
import { apiError, json } from "../../lib/response.js";

function hidden() { return apiError("Not found.", "not_found", 404); }

async function bestEffortAudit(db, event) {
  try { await recordReviewAudit(db, event); } catch { console.error("review_audit_failed"); }
}

export async function onRequestPost({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) {
    await bestEffortAudit(env.DB, { eventType: "auth_failed", detail: { code: "missing_or_invalid" } });
    return hidden();
  }
  let body;
  try { body = await readJson(request, 2_048); } catch (error) {
    return apiError("The request must be a small JSON object.", error.message, 400);
  }
  const workItemId = String(body?.leaseWorkItemId || "").trim();
  if (!workItemId || workItemId.length > 160) {
    return apiError("Name the claim work item to open.", "work_item_required", 400);
  }
  try {
    const assignment = await switchLease(env.DB, principal.reviewerId, workItemId, env);
    return json({
      assignment: {
        assignmentId: assignment.assignment_id,
        workItemId: assignment.work_item_id,
        workType: assignment.work_type,
        claimId: assignment.claim_id,
        leaseExpiresAt: assignment.lease_expires_at,
      },
    }, 201);
  } catch (error) {
    if (error instanceof ReviewWorkflowError) return apiError(error.message, error.code, error.status);
    console.error("lease_switch_failed", error);
    return apiError("The claim could not be opened.", "lease_unavailable", 503);
  }
}

export async function onRequestGet({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) {
    await bestEffortAudit(env.DB, { eventType: "auth_failed", detail: { code: "missing_or_invalid" } });
    return hidden();
  }
  try {
    await recordReviewAudit(env.DB, {
      reviewerId: principal.reviewerId, eventType: "auth_succeeded", detail: { mode: principal.mode },
    });
    try { await reconcileNeededPublications(env.DB); }
    catch (error) { console.error("review_queue_reconcile_failed", error); }
    // Prefer claim/candidate review work. Archive must never take down the queue.
    try { await leaseReviewWork(env.DB, principal.reviewerId, env); }
    catch (error) { console.error("review_queue_lease_failed", error); }
    let archiveAssignments = [];
    let standardAssignments = [];
    try { standardAssignments = await listReviewerAssignments(env.DB, principal.reviewerId); }
    catch (error) { console.error("review_queue_list_failed", error); throw error; }
    try { archiveAssignments = await listArchiveReviewerAssignments(env.DB, principal.reviewerId); }
    catch (error) { console.error("review_queue_archive_list_failed", error); }
    const workOrder = { claim_adjudication: 0, candidate_verification: 1, archive_lead_verification: 2 };
    const assignments = [...standardAssignments, ...archiveAssignments].sort((left, right) => {
      if (left.status !== right.status) return left.status === "leased" ? -1 : 1;
      const leftOrder = workOrder[left.workType] ?? 9;
      const rightOrder = workOrder[right.workType] ?? 9;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.assignmentId).localeCompare(String(right.assignmentId));
    });
    const publicReviewerName = await getReviewerPublicName(env.DB, principal.reviewerId);
    return json({
      principal: { mode: principal.mode, demo: principal.mode === "local_non_deployable_demo",
        publicReviewerName, needsPublicName: !publicReviewerName },
      assignments,
    });
  } catch (error) {
    console.error("review_queue_failed", error);
    return apiError("The reviewer queue is unavailable.", "review_queue_unavailable", 503);
  }
}
