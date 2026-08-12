import { resolveReviewerPrincipal } from "../../../lib/reviewer-auth.js";
import {
  leaseArchiveReviewWork, listArchiveReviewerAssignments, switchArchiveLease,
} from "../../../lib/archive-review-workflow.js";
import { ReviewWorkflowError } from "../../../lib/review-workflow.js";
import { apiError, json, readJson } from "../../../lib/response.js";

async function listAvailableArchiveWork(db, reviewerId, now = new Date().toISOString()) {
  try {
    const result = await db.prepare(
      `SELECT work.archive_work_item_id, revision.description_text, revision.date_shared_text,
        EXISTS (
          SELECT 1 FROM archive_transcript_match_checks receipt
          WHERE receipt.archive_revision_id=work.archive_revision_id
            AND receipt.archive_video_link_id=work.archive_video_link_id
            AND receipt.match_status IN ('matched_exact','matched_strict_normalized')
        ) matched,
        EXISTS (
          SELECT 1 FROM archive_review_assignments held
          WHERE held.archive_work_item_id=work.archive_work_item_id
            AND held.status='leased' AND held.lease_expires_at>?1
            AND held.reviewer_id<>?2
        ) taken
       FROM archive_verification_work_items work
       JOIN first_party_archive_lead_revisions revision
         ON revision.archive_revision_id=work.archive_revision_id
       WHERE work.status='ready'
       ORDER BY matched DESC, revision.date_shared_text, work.archive_work_item_id
       LIMIT 40`,
    ).bind(now, reviewerId).all();
    return (result.results || []).map((row) => ({
      workItemId: row.archive_work_item_id,
      title: row.description_text || "Archive source check",
      dateShared: row.date_shared_text || null,
      matched: Boolean(row.matched),
      taken: Boolean(row.taken),
    }));
  } catch (error) {
    console.error("archive_available_fallback", error);
    const result = await db.prepare(
      `SELECT work.archive_work_item_id, revision.description_text, revision.date_shared_text,
        EXISTS (
          SELECT 1 FROM archive_review_assignments held
          WHERE held.archive_work_item_id=work.archive_work_item_id
            AND held.status='leased' AND held.lease_expires_at>?1
            AND held.reviewer_id<>?2
        ) taken
       FROM archive_verification_work_items work
       JOIN first_party_archive_lead_revisions revision
         ON revision.archive_revision_id=work.archive_revision_id
       WHERE work.status='ready'
       ORDER BY revision.date_shared_text, work.archive_work_item_id
       LIMIT 40`,
    ).bind(now, reviewerId).all();
    return (result.results || []).map((row) => ({
      workItemId: row.archive_work_item_id,
      title: row.description_text || "Archive source check",
      dateShared: row.date_shared_text || null,
      matched: false,
      taken: Boolean(row.taken),
    }));
  }
}

async function archiveCounts(db) {
  try {
    const counts = await db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM archive_verification_work_items WHERE status='ready') ready,
        (SELECT COUNT(*) FROM archive_verification_work_items work WHERE work.status='ready'
          AND EXISTS (SELECT 1 FROM archive_transcript_match_checks receipt
            WHERE receipt.archive_revision_id=work.archive_revision_id
              AND receipt.archive_video_link_id=work.archive_video_link_id
              AND receipt.match_status IN ('matched_exact','matched_strict_normalized'))) matched`,
    ).first();
    return { ready: Number(counts?.ready || 0), matched: Number(counts?.matched || 0) };
  } catch (error) {
    console.error("archive_counts_fallback", error);
    const readyOnly = await db.prepare(
      `SELECT COUNT(*) ready FROM archive_verification_work_items WHERE status='ready'`,
    ).first();
    return { ready: Number(readyOnly?.ready || 0), matched: 0 };
  }
}

export async function onRequestGet({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  try {
    await leaseArchiveReviewWork(env.DB, principal.reviewerId, env);
    const assignments = await listArchiveReviewerAssignments(env.DB, principal.reviewerId);
    const available = await listAvailableArchiveWork(env.DB, principal.reviewerId);
    const counts = await archiveCounts(env.DB);
    return json({
      principal: { mode: principal.mode, demo: principal.mode === "local_non_deployable_demo" },
      assignments,
      available,
      counts,
    });
  } catch (error) {
    console.error("archive_queue_failed", error);
    return apiError("The archive queue is unavailable.", "archive_queue_unavailable", 503);
  }
}

export async function onRequestPost({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  let body;
  try { body = await readJson(request, 2_048); } catch (error) {
    return apiError("The request must be a small JSON object.", error.message, 400);
  }
  const workItemId = String(body?.leaseArchiveWorkItemId || "").trim();
  if (!workItemId || workItemId.length > 160) {
    return apiError("Name the archive work item to open.", "work_item_required", 400);
  }
  try {
    const leased = await switchArchiveLease(
      env.DB, principal.reviewerId, workItemId, env,
    );
    const assignments = await listArchiveReviewerAssignments(env.DB, principal.reviewerId);
    const hit = assignments.find((row) => row.assignmentId === leased.archive_assignment_id
      && row.workItemId === workItemId && row.status === "leased");
    if (!hit || leased.archive_work_item_id !== workItemId) {
      return apiError("That source check could not be opened right now.", "archive_lease_unavailable", 409);
    }
    return json({ assignment: hit }, 201);
  } catch (error) {
    if (error instanceof ReviewWorkflowError) {
      return apiError(error.message, error.code, error.status);
    }
    console.error("archive_lease_failed", error);
    return apiError("The source check could not be opened.", "archive_lease_unavailable", 503);
  }
}
