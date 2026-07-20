import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import {
  leaseReviewWork, listReviewerAssignments, reconcileNeededPublications, recordReviewAudit,
} from "../../lib/review-workflow.js";
import {
  leaseArchiveReviewWork, listArchiveReviewerAssignments,
} from "../../lib/archive-review-workflow.js";
import { apiError, json } from "../../lib/response.js";

function hidden() { return apiError("Not found.", "not_found", 404); }

async function bestEffortAudit(db, event) {
  try { await recordReviewAudit(db, event); } catch { console.error("review_audit_failed"); }
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
    await reconcileNeededPublications(env.DB);
    const archiveAssignment = await leaseArchiveReviewWork(env.DB, principal.reviewerId, env);
    if (!archiveAssignment) await leaseReviewWork(env.DB, principal.reviewerId, env);
    const [archiveAssignments, standardAssignments] = await Promise.all([
      listArchiveReviewerAssignments(env.DB, principal.reviewerId),
      listReviewerAssignments(env.DB, principal.reviewerId),
    ]);
    const assignments = [...archiveAssignments, ...standardAssignments].sort((left, right) => {
      if (left.status !== right.status) return left.status === "leased" ? -1 : 1;
      if (left.workType !== right.workType) {
        return left.workType === "archive_lead_verification" ? -1 : 1;
      }
      return String(left.assignmentId).localeCompare(String(right.assignmentId));
    });
    return json({
      principal: { mode: principal.mode, demo: principal.mode === "local_non_deployable_demo" },
      assignments,
    });
  } catch (error) {
    console.error("review_queue_failed", error);
    return apiError("The reviewer queue is unavailable.", "review_queue_unavailable", 503);
  }
}
