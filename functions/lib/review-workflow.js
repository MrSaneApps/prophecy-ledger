import { deadlineLifecycle } from "./claims.js";
export { reconcileNeededPublications, reconcilePublication } from "./review-publication.js";

const CLAIM_TYPES = new Set([
  "testable_prediction", "present_or_past_factual_claim", "conditional_prediction",
]);
const REJECTION_REASONS = new Set([
  "invalid_quote", "non_falsifiable", "context_changes_meaning", "duplicate",
  "insufficient_source_verification", "missing_essential_context",
  "generic_advice_or_commentary", "non_observable_mental_state",
  "invented_causality_or_mechanism",
]);
const CLAIM_ELEMENTS = ["who", "what", "why", "where", "when", "how"];
const REQUIRED_CLAIM_ELEMENTS = new Set(["who", "what", "why", "where", "when"]);

export class ReviewWorkflowError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

function parseJsonArrayOfStrings(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

async function all(statement) {
  const result = await statement.all();
  return result.results || [];
}

function changes(result) {
  return Number(result?.meta?.changes || 0);
}

function leaseSeconds(env) {
  const configured = Number(env.REVIEW_LEASE_SECONDS || 900);
  return Number.isInteger(configured) && configured >= 60 && configured <= 3600 ? configured : 900;
}

function plusSeconds(now, seconds) {
  return new Date(new Date(now).valueOf() + seconds * 1000).toISOString();
}

export async function recordReviewAudit(db, event, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT INTO review_audit_events
     (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
      assignment_id,detail_json,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
  ).bind(`audit_${crypto.randomUUID()}`, event.reviewerId || null, event.eventType,
    event.workItemId || null, event.claimId || null, event.candidateId || null,
    event.assignmentId || null, JSON.stringify(event.detail || {}), now).run();
}

async function currentAssignment(db, reviewerId, now) {
  return db.prepare(
    `SELECT assignment.assignment_id,assignment.work_item_id,assignment.status,
      assignment.lease_expires_at,work.claim_id,work.candidate_id,work.work_type
     FROM review_assignments assignment
     JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
     WHERE assignment.reviewer_id=?1 AND assignment.status='leased'
       AND assignment.lease_expires_at>?2 AND work.status='ready'
       AND (work.candidate_id IS NULL OR EXISTS (
         SELECT 1 FROM candidate_admissibility_assessments assessment
         WHERE assessment.candidate_id=work.candidate_id AND assessment.decision='eligible'
           AND NOT EXISTS (SELECT 1 FROM candidate_admissibility_assessments newer
             WHERE newer.candidate_id=assessment.candidate_id
               AND (newer.created_at>assessment.created_at OR
                 (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id)))))
     ORDER BY assignment.assigned_at,assignment.assignment_id LIMIT 1`
  ).bind(reviewerId, now).first();
}

async function candidateWorkItems(db, reviewerId, now) {
  return all(db.prepare(
    `SELECT work.work_item_id,work.claim_id,work.candidate_id,work.work_type,
      work.max_reviews
     FROM review_work_items work
     LEFT JOIN claims claim_sort ON claim_sort.claim_id=work.claim_id
     LEFT JOIN publication_evaluations evaluation ON evaluation.claim_id=work.claim_id
     WHERE work.status='ready'
       AND (work.candidate_id IS NULL OR EXISTS (
         SELECT 1 FROM candidate_admissibility_assessments assessment
         WHERE assessment.candidate_id=work.candidate_id AND assessment.decision='eligible'
           AND NOT EXISTS (SELECT 1 FROM candidate_admissibility_assessments newer
             WHERE newer.candidate_id=assessment.candidate_id
               AND (newer.created_at>assessment.created_at OR
                 (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id)))))
       AND NOT EXISTS (SELECT 1 FROM review_assignments own
         WHERE own.work_item_id=work.work_item_id AND own.reviewer_id=?1
           AND own.status='submitted'
           AND (
             work.work_type<>'claim_adjudication'
             OR NOT EXISTS (
               SELECT 1 FROM ai_draft_decisions draft
               WHERE draft.claim_id=work.claim_id
                 AND draft.created_at > COALESCE((
                   SELECT MAX(review.created_at) FROM moderator_reviews review
                   WHERE review.claim_id=work.claim_id AND review.reviewer_id=?1
                 ), '')
             )
           ))
       AND NOT EXISTS (SELECT 1 FROM moderator_reviews review
         WHERE work.claim_id IS NOT NULL AND review.claim_id=work.claim_id AND review.reviewer_id=?1
           AND (
             NOT EXISTS (SELECT 1 FROM ai_draft_decisions d WHERE d.claim_id=work.claim_id)
             OR review.created_at >= (
               SELECT MAX(d.created_at) FROM ai_draft_decisions d WHERE d.claim_id=work.claim_id
             )
           ))
       AND NOT EXISTS (SELECT 1 FROM candidate_review_decisions decision
         WHERE work.candidate_id IS NOT NULL AND decision.candidate_id=work.candidate_id
           AND decision.reviewer_id=?1)
       AND ((work.work_type='candidate_verification' AND NOT EXISTS (
              SELECT 1 FROM candidate_review_decisions decision WHERE decision.candidate_id=work.candidate_id))
         OR (work.work_type='claim_adjudication' AND (
           (SELECT COUNT(*) FROM moderator_reviews review WHERE review.claim_id=work.claim_id)<2
           OR COALESCE(evaluation.state,'needed') IN ('disagreement','blocked','needed'))))
       AND ((SELECT COUNT(*) FROM review_assignments active
              WHERE active.work_item_id=work.work_item_id
                AND (active.status='submitted' OR (active.status='leased' AND active.lease_expires_at>?2)))
            < CASE WHEN work.work_type='candidate_verification' THEN 1
              WHEN (SELECT COUNT(*) FROM moderator_reviews review WHERE review.claim_id=work.claim_id)<2 THEN 2
              ELSE work.max_reviews END)
     ORDER BY CASE work.work_type WHEN 'candidate_verification' THEN 0 ELSE 1 END,
       COALESCE(claim_sort.source_date,work.created_at),work.work_item_id LIMIT 20`
  ).bind(reviewerId, now));
}

async function tryLease(db, work, reviewerId, now, expiresAt) {
  const existing = await db.prepare(
    `SELECT assignment_id, status, lease_expires_at FROM review_assignments
     WHERE work_item_id=?1 AND reviewer_id=?2`
  ).bind(work.work_item_id, reviewerId).first();
  let renewSubmitted = false;
  if (existing?.status === "submitted" && work.work_type === "claim_adjudication" && work.claim_id) {
    const newerDraft = await db.prepare(
      `SELECT 1 ok FROM ai_draft_decisions draft
       WHERE draft.claim_id=?1
         AND draft.created_at > COALESCE((
           SELECT MAX(review.created_at) FROM moderator_reviews review
           WHERE review.claim_id=?1 AND review.reviewer_id=?2
         ), '')`
    ).bind(work.claim_id, reviewerId).first();
    renewSubmitted = Boolean(newerDraft);
  }
  const assignmentId = existing?.assignment_id || `assignment_${crypto.randomUUID()}`;
  const auditId = `audit_${crypto.randomUUID()}`;
  const shouldRenew = existing && (
    existing.status === "released"
    || (existing.status === "leased" && existing.lease_expires_at <= now)
    || renewSubmitted
  );
  // assigned_at is identity-immutable (DB trigger). Renewals only touch lease fields.
  const statement = shouldRenew
    ? db.prepare(
      `UPDATE review_assignments SET status='leased',submitted_at=NULL,
        lease_expires_at=?1,lease_version=lease_version+1
       WHERE assignment_id=?2 AND (
         status='released'
         OR (status='leased' AND lease_expires_at<=?3)
         OR status='submitted'
       )`
    ).bind(expiresAt, assignmentId, now)
    : db.prepare(
      `INSERT OR IGNORE INTO review_assignments
       (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at,lease_version)
       VALUES (?1,?2,?3,'leased',?4,?5,1)`
    ).bind(assignmentId, work.work_item_id, reviewerId, now, expiresAt);
  const [leaseResult] = await db.batch([
    statement,
    db.prepare(
      `INSERT INTO review_audit_events
       (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
        assignment_id,detail_json,created_at)
       SELECT ?1,?2,'assignment_leased',?3,?4,?5,?6,'{}',?7
       WHERE EXISTS (SELECT 1 FROM review_assignments WHERE assignment_id=?6
         AND reviewer_id=?2 AND status='leased' AND lease_expires_at=?8)`
    ).bind(auditId, reviewerId, work.work_item_id, work.claim_id || null,
      work.candidate_id || null, assignmentId, now, expiresAt),
  ]);
  return changes(leaseResult) ? assignmentId : null;
}

export async function leaseReviewWork(db, reviewerId, env, now = new Date().toISOString()) {
  await db.prepare(
    `INSERT OR IGNORE INTO review_work_items
     (work_item_id,claim_id,candidate_id,promotion_id,origin_kind,work_type,status,
      required_matching_reviews,max_reviews,created_at)
     SELECT 'work_candidate_' || candidate.candidate_id,NULL,candidate.candidate_id,NULL,
       'private_extraction_candidate','candidate_verification','ready',2,2,candidate.created_at
     FROM claim_candidates candidate
     WHERE candidate.candidate_kind='exact_transcript_claim' AND candidate.requires_human_review=1
       AND EXISTS (
         SELECT 1 FROM candidate_admissibility_assessments assessment
         WHERE assessment.candidate_id=candidate.candidate_id AND assessment.decision='eligible'
           AND NOT EXISTS (
             SELECT 1 FROM candidate_admissibility_assessments newer
             WHERE newer.candidate_id=assessment.candidate_id
               AND (newer.created_at>assessment.created_at OR
                 (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id))
           )
       )
       AND NOT EXISTS (SELECT 1 FROM candidate_claim_promotions promotion
         WHERE promotion.candidate_id=candidate.candidate_id)`
  ).run();
  let assignment = await currentAssignment(db, reviewerId, now);
  if (!assignment) {
    const expiresAt = plusSeconds(now, leaseSeconds(env));
    for (const work of await candidateWorkItems(db, reviewerId, now)) {
      const assignmentId = await tryLease(db, work, reviewerId, now, expiresAt);
      if (assignmentId) {
        assignment = await db.prepare(
          `SELECT assignment.assignment_id,assignment.work_item_id,assignment.status,
            assignment.lease_expires_at,work.claim_id,work.candidate_id,work.work_type
           FROM review_assignments assignment JOIN review_work_items work
             ON work.work_item_id=assignment.work_item_id WHERE assignment.assignment_id=?1`
        ).bind(assignmentId).first();
        break;
      }
    }
  }
  return assignment;
}

function nextAction(row) {
  if (row.work_status === "complete" || row.visibility === "published") return "complete";
  if (row.assignment_status === "submitted") return "await_matching_review";
  return row.work_type === "candidate_verification" ? "verify_candidate" : "review_claim";
}

export async function switchLease(db, reviewerId, workItemId, env, now = new Date().toISOString()) {
  const targets = (await candidateWorkItems(db, reviewerId, now))
    .filter((work) => work.work_item_id === workItemId);
  if (!targets.length) {
    throw new ReviewWorkflowError("work_unavailable",
      "That claim is not ready for review or is already fully reviewed.", 409);
  }
  const current = await currentAssignment(db, reviewerId, now);
  if (current && current.work_item_id !== workItemId) {
    await db.batch([
      db.prepare(
        `UPDATE review_assignments SET status='released'
         WHERE assignment_id=?1 AND reviewer_id=?2 AND status='leased'`
      ).bind(current.assignment_id, reviewerId),
      db.prepare(
        `INSERT INTO review_audit_events
         (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
          assignment_id,detail_json,created_at)
         VALUES (?1,?2,'assignment_released',?3,NULL,NULL,?4,'{}',?5)`
      ).bind(`audit_${crypto.randomUUID()}`, reviewerId, current.work_item_id,
        current.assignment_id, now),
    ]);
  } else if (current && current.work_item_id === workItemId) {
    return db.prepare(
      `SELECT assignment.assignment_id,assignment.work_item_id,assignment.status,
        assignment.lease_expires_at,work.claim_id,work.candidate_id,work.work_type
       FROM review_assignments assignment JOIN review_work_items work
         ON work.work_item_id=assignment.work_item_id
       WHERE assignment.assignment_id=?1`
    ).bind(current.assignment_id).first();
  }
  const expiresAt = plusSeconds(now, leaseSeconds(env));
  const assignmentId = await tryLease(db, targets[0], reviewerId, now, expiresAt);
  if (!assignmentId) {
    throw new ReviewWorkflowError("work_unavailable", "The claim was taken just now. Refresh the list.", 409);
  }
  return db.prepare(
    `SELECT assignment.assignment_id,assignment.work_item_id,assignment.status,
      assignment.lease_expires_at,work.claim_id,work.candidate_id,work.work_type
     FROM review_assignments assignment JOIN review_work_items work
       ON work.work_item_id=assignment.work_item_id WHERE assignment.assignment_id=?1`
  ).bind(assignmentId).first();
}

export async function listAllClaimWork(db, now = new Date().toISOString()) {
  const rows = await all(db.prepare(
    `SELECT work.work_item_id,claim.claim_id,claim.title,person.display_name person,
      claim.source_date,claim.deadline,claim.visibility,claim.lifecycle_status,
      (SELECT COUNT(*) FROM moderator_reviews review WHERE review.claim_id=claim.claim_id) reviews,
      EXISTS (SELECT 1 FROM ai_draft_decisions draft WHERE draft.claim_id=claim.claim_id) has_draft,
      (work.status='ready' AND EXISTS (
         SELECT 1 FROM ai_draft_decisions draft WHERE draft.claim_id=claim.claim_id
       )) is_ready
     FROM review_work_items work
     JOIN claims claim ON claim.claim_id=work.claim_id
     JOIN people person ON person.person_id=claim.person_id
     WHERE work.work_type='claim_adjudication' AND work.status<>'withdrawn'
     ORDER BY claim.source_date, claim.claim_id`
  ));
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    claimId: row.claim_id,
    title: row.title,
    person: row.person,
    sourceDate: row.source_date,
    deadline: row.deadline,
    reviews: Number(row.reviews || 0),
    hasDraft: Boolean(row.has_draft),
    state: row.visibility === "published" ? "decided"
      : Number(row.reviews || 0) >= 2 ? "awaiting_reconciliation"
      : !row.is_ready ? "in_preparation"
      : Number(row.reviews || 0) === 1 ? "awaiting_second_review" : "ready",
  }));
}

export async function listReviewerAssignments(db, reviewerId, now = new Date().toISOString()) {
  const rows = await all(db.prepare(
    `SELECT assignment.assignment_id,assignment.work_item_id,assignment.status assignment_status,
      assignment.lease_expires_at,work.work_type,work.status work_status,work.claim_id,
      work.candidate_id,claim.title,claim.deadline,claim.lifecycle_status,claim.visibility,
      person.display_name,
      COALESCE(revision.public_title,'Private exact-quote candidate') candidate_title
     FROM review_assignments assignment
     JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
     LEFT JOIN claims claim ON claim.claim_id=work.claim_id
     LEFT JOIN claim_candidates candidate ON candidate.candidate_id=work.candidate_id
     LEFT JOIN source_items source ON source.source_item_id=candidate.source_item_id
     LEFT JOIN people person ON person.person_id=COALESCE(claim.person_id,source.person_id)
     LEFT JOIN source_item_revisions revision ON revision.source_item_id=source.source_item_id
       AND NOT EXISTS (SELECT 1 FROM source_item_revisions newer
         WHERE newer.source_item_id=revision.source_item_id
           AND (newer.fetched_at>revision.fetched_at OR
             (newer.fetched_at=revision.fetched_at AND newer.revision_id>revision.revision_id)))
     WHERE assignment.reviewer_id=?1
       AND (assignment.status='submitted' OR (assignment.status='leased' AND assignment.lease_expires_at>?2))
       AND work.status<>'withdrawn'
       AND (work.candidate_id IS NULL OR EXISTS (
         SELECT 1 FROM candidate_admissibility_assessments assessment
         WHERE assessment.candidate_id=work.candidate_id AND assessment.decision='eligible'
           AND NOT EXISTS (SELECT 1 FROM candidate_admissibility_assessments newer
             WHERE newer.candidate_id=assessment.candidate_id
               AND (newer.created_at>assessment.created_at OR
                 (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id)))))
     ORDER BY CASE assignment.status WHEN 'leased' THEN 0 ELSE 1 END,
       assignment.assigned_at DESC LIMIT 25`
  ).bind(reviewerId, now));
  return rows.map((row) => ({
    assignmentId: row.assignment_id,
    workItemId: row.work_item_id,
    workType: row.work_type,
    subjectId: row.claim_id || row.candidate_id,
    claimId: row.claim_id || null,
    candidateId: row.candidate_id || null,
    person: row.display_name,
    title: row.title || row.candidate_title,
    status: row.assignment_status,
    deadline: row.deadline || null,
    state: row.visibility === "published" ? "published" : (row.lifecycle_status || "needs_human_verification"),
    nextAction: nextAction(row),
    leaseExpiresAt: row.lease_expires_at,
  }));
}

async function assignmentForAccess(db, assignmentId, reviewerId, now, allowSubmitted = true) {
  return db.prepare(
    `SELECT assignment.assignment_id,assignment.work_item_id,assignment.status assignment_status,
      assignment.lease_expires_at,work.work_type,work.claim_id,work.candidate_id,
      work.promotion_id,work.status work_status
     FROM review_assignments assignment JOIN review_work_items work
       ON work.work_item_id=assignment.work_item_id
     WHERE assignment.assignment_id=?1 AND assignment.reviewer_id=?2
       AND ((assignment.status='leased' AND assignment.lease_expires_at>?3)
         ${allowSubmitted ? "OR assignment.status='submitted'" : ""})
       AND (work.candidate_id IS NULL OR EXISTS (
         SELECT 1 FROM candidate_admissibility_assessments assessment
         WHERE assessment.candidate_id=work.candidate_id AND assessment.decision='eligible'
           AND NOT EXISTS (SELECT 1 FROM candidate_admissibility_assessments newer
             WHERE newer.candidate_id=assessment.candidate_id
               AND (newer.created_at>assessment.created_at OR
                 (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id)))))`
  ).bind(assignmentId, reviewerId, now).first();
}

function assignmentProjection(row) {
  return {
    assignmentId: row.assignment_id, workItemId: row.work_item_id,
    workType: row.work_type, status: row.assignment_status,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function getAssignedReviewBundle(db, assignmentId, reviewerId, now = new Date().toISOString()) {
  const assignment = await assignmentForAccess(db, assignmentId, reviewerId, now);
  if (!assignment) return null;
  if (assignment.work_type === "candidate_verification") {
    const subject = await db.prepare(
      `SELECT candidate.candidate_id,person.display_name person_name,
        COALESCE(revision.public_title,'Private exact-quote candidate') title,
        source.canonical_url source_url,revision.publication_date source_date,
        candidate.exact_quote,candidate.quote_start,candidate.quote_end,
        candidate.source_timestamp_seconds,candidate.proposed_statement_type,
        candidate.atomic_proposition_draft,candidate.explicit_deadline_text,
        extraction.transcript_quality,assessment.gate_version,
        assessment.who_text,assessment.what_text,assessment.why_text,
        assessment.where_text,assessment.when_text,assessment.how_text,
        assessment.how_specificity,
        assessment.public_evidence_text,assessment.pass_condition_text,
        assessment.fail_condition_text
       FROM claim_candidates candidate
       JOIN extraction_runs extraction ON extraction.extraction_run_id=candidate.extraction_run_id
       JOIN candidate_admissibility_assessments assessment
         ON assessment.candidate_id=candidate.candidate_id AND assessment.decision='eligible'
         AND NOT EXISTS (
           SELECT 1 FROM candidate_admissibility_assessments newer
           WHERE newer.candidate_id=assessment.candidate_id
             AND (newer.created_at>assessment.created_at OR
               (newer.created_at=assessment.created_at AND newer.assessment_id>assessment.assessment_id))
         )
       JOIN source_items source ON source.source_item_id=candidate.source_item_id
       JOIN people person ON person.person_id=source.person_id
       LEFT JOIN source_item_revisions revision ON revision.source_item_id=source.source_item_id
         AND NOT EXISTS (SELECT 1 FROM source_item_revisions newer
           WHERE newer.source_item_id=revision.source_item_id
             AND (newer.fetched_at>revision.fetched_at OR
               (newer.fetched_at=revision.fetched_at AND newer.revision_id>revision.revision_id)))
       WHERE candidate.candidate_id=?1 AND candidate.candidate_kind='exact_transcript_claim'`
    ).bind(assignment.candidate_id).first();
    return subject ? { assignment: assignmentProjection(assignment), subject } : null;
  }
  const claim = await db.prepare(
    `SELECT claim.claim_id,person.display_name person_name,claim.video_id,claim.cluster_id,
      claim.title,claim.exact_quote,claim.source_url,claim.source_date,
      claim.source_timestamp_seconds,claim.transcript_warning,claim.statement_type,
      claim.atomic_proposition,claim.criteria,claim.deadline,claim.as_of_date,
      claim.lifecycle_status,claim.visibility,claim.created_at
     FROM claims claim JOIN people person ON person.person_id=claim.person_id
     WHERE claim.claim_id=?1`
  ).bind(assignment.claim_id).first();
  if (!claim) return null;
  const evidence = await all(db.prepare(
    `SELECT evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,
      source_role,note,search_query,cutoff_date,verification_method,created_at,
      supporting_excerpt,source_page
     FROM evidence WHERE claim_id=?1 ORDER BY created_at,evidence_id`
  ).bind(assignment.claim_id));
  const draftRow = await db.prepare(
    `SELECT draft_id,revision,claim_type,outcome_status,novelty_status,
      baseline_probability,evidence_ids_json,prior_receipt_id,reasoning,
      provenance,created_at
     FROM ai_draft_decisions WHERE claim_id=?1
     ORDER BY revision DESC LIMIT 1`
  ).bind(assignment.claim_id).first();
  const aiDraftDecision = draftRow ? {
    draftId: draftRow.draft_id,
    revision: draftRow.revision,
    claimType: draftRow.claim_type,
    outcomeStatus: draftRow.outcome_status,
    noveltyStatus: draftRow.novelty_status,
    baselineProbability: draftRow.baseline_probability == null ? null : Number(draftRow.baseline_probability),
    evidenceIds: parseJsonArrayOfStrings(draftRow.evidence_ids_json),
    priorReceiptId: draftRow.prior_receipt_id || null,
    reasoning: draftRow.reasoning,
    provenance: draftRow.provenance,
    createdAt: draftRow.created_at,
  } : null;
  const receipts = await all(db.prepare(
    `SELECT receipt_id,claim_id,cutoff_date,status,search_queries_json,
      sources_checked_json,method_note,completed_at,created_at
     FROM prior_information_receipts WHERE claim_id=?1 ORDER BY created_at,receipt_id`
  ).bind(assignment.claim_id));
  const ownSubmitted = await db.prepare(
    `SELECT 1 submitted FROM moderator_reviews WHERE claim_id=?1 AND reviewer_id=?2`
  ).bind(assignment.claim_id, reviewerId).first();
  let candidateDecisionFields = null;
  if (assignment.promotion_id) {
    const promoted = await db.prepare(
      `SELECT decision.decision_fields_json
       FROM candidate_claim_promotions promotion
       JOIN candidate_review_decisions decision
         ON decision.candidate_id=promotion.candidate_id
        AND decision.promoted_claim_id=promotion.claim_id
        AND decision.decision='promote'
       WHERE promotion.promotion_id=?1`
    ).bind(assignment.promotion_id).first();
    if (promoted?.decision_fields_json) candidateDecisionFields = JSON.parse(promoted.decision_fields_json);
  }
  return {
    assignment: assignmentProjection(assignment), subject: claim, evidence,
    priorInformationReceipts: receipts,
    aiDraftDecision,
    candidateDecisionFields,
    reviewState: { ownSubmissionRecorded: Boolean(ownSubmitted), previousDecisionsBlinded: true },
  };
}

export async function submitAssignedClaimReview(db, assignmentId, reviewerId, review, now = new Date().toISOString(), sendback = null) {
  const assignment = await assignmentForAccess(db, assignmentId, reviewerId, now, false);
  if (!assignment || assignment.work_type !== "claim_adjudication") {
    throw new ReviewWorkflowError("assignment_required", "A live claim assignment is required.", 404);
  }
  const reviewId = `review_${crypto.randomUUID()}`;
  const statements = [
    db.prepare(
      `INSERT INTO moderator_reviews
       (review_id,claim_id,reviewer_id,claim_type,outcome_status,novelty_status,
        baseline_probability,evidence_ids_json,prior_receipt_id,decision_fingerprint,rationale,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
    ).bind(reviewId, assignment.claim_id, reviewerId, review.claimType, review.outcomeStatus,
      review.noveltyStatus, review.baselineProbability, JSON.stringify(review.evidenceIds),
      review.priorReceiptId, review.decisionFingerprint, review.rationale, now),
    db.prepare(
      `UPDATE review_assignments SET status='submitted',submitted_at=?1
       WHERE assignment_id=?2 AND reviewer_id=?3 AND status='leased' AND lease_expires_at>?1`
    ).bind(now, assignmentId, reviewerId),
    db.prepare(
      `INSERT INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
       VALUES (?1,?2,'review_submitted',?3,?4,?5)`
    ).bind(`event_${crypto.randomUUID()}`, assignment.claim_id, reviewerId,
      JSON.stringify({ reviewId, assignmentId, sendback: Boolean(sendback) }), now),
    db.prepare(
      `INSERT INTO review_audit_events
       (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
        assignment_id,detail_json,created_at)
       VALUES (?1,?2,'submission_accepted',?3,?4,NULL,?5,?6,?7)`
    ).bind(`audit_${crypto.randomUUID()}`, reviewerId, assignment.work_item_id,
      assignment.claim_id, assignmentId, JSON.stringify({ sendback: Boolean(sendback) }), now),
  ];
  if (sendback) {
    const lesson = String(sendback.lesson || review.rationale || "").trim().slice(0, 500);
    statements.push(db.prepare(
      `INSERT INTO research_sendbacks
       (sendback_id,claim_id,draft_id,draft_revision,review_id,reviewer_id,
        rejected_outcome,disagreed_outcome,rationale,lesson,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    ).bind(
      `sendback_${crypto.randomUUID()}`, assignment.claim_id, sendback.draftId,
      sendback.draftRevision, reviewId, reviewerId, sendback.rejectedOutcome,
      review.outcomeStatus, review.rationale, lesson, now,
    ));
    statements.push(db.prepare(
      `INSERT INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
       VALUES (?1,?2,'correction',?3,?4,?5)`
    ).bind(`event_${crypto.randomUUID()}`, assignment.claim_id, reviewerId,
      JSON.stringify({
        reviewId, draftId: sendback.draftId, rejectedOutcome: sendback.rejectedOutcome,
        disagreedOutcome: review.outcomeStatus,
      }), now));
    statements.push(db.prepare(
      `UPDATE publication_evaluations SET state='needed',last_attempt_at=?1,
        last_error_code='research_sendback' WHERE claim_id=?2`
    ).bind(now, assignment.claim_id));
  }
  await db.batch(statements);
  return { reviewId, claimId: assignment.claim_id, sendbackRecorded: Boolean(sendback) };
}

function cleanText(value, code, { min = 1, max = 2_000 } = {}) {
  const text = String(value || "").trim();
  if (text.length < min || text.length > max) throw new ReviewWorkflowError(code, "Candidate decision fields are incomplete.", 400);
  return text;
}

export function normalizeCandidateDecision(input) {
  if (Object.hasOwn(input || {}, "reviewerId")) throw new ReviewWorkflowError("reviewer_identity_body_forbidden", "Reviewer identity cannot be supplied.", 400);
  const decision = String(input?.decision || "");
  if (!["promote", "reject"].includes(decision)) throw new ReviewWorkflowError("candidate_decision_invalid", "Choose promote or reject.", 400);
  const rationale = cleanText(input?.rationale, "candidate_rationale_required", { min: 10, max: 4_000 });
  if (decision === "reject") {
    const reasonCode = String(input?.reasonCode || "");
    if (!REJECTION_REASONS.has(reasonCode)) throw new ReviewWorkflowError("candidate_rejection_reason_invalid", "Choose a supported rejection reason.", 400);
    return { decision, rationale, reasonCode };
  }
  if (input?.originalSourceVerified !== true) throw new ReviewWorkflowError("original_source_verification_required", "Confirm the original public source first.", 400);
  if (input?.contextVerified !== true) throw new ReviewWorkflowError("source_context_verification_required", "Confirm the surrounding source context first.", 400);
  const statementType = String(input?.statementType || "");
  if (!CLAIM_TYPES.has(statementType)) throw new ReviewWorkflowError("candidate_statement_type_invalid", "Choose a falsifiable statement type.", 400);
  const deadline = input?.deadline == null || input.deadline === "" ? null : String(input.deadline);
  if (["testable_prediction", "conditional_prediction"].includes(statementType) && !/^\d{4}-\d{2}-\d{2}$/.test(deadline || "")) {
    throw new ReviewWorkflowError("candidate_deadline_required", "Predictions require a bounded YYYY-MM-DD deadline.", 400);
  }
  const elements = {};
  for (const name of CLAIM_ELEMENTS) {
    const value = cleanText(input?.[name], `candidate_${name}_required`, { max: 1_000 });
    if (value.toLowerCase() === "not stated" && REQUIRED_CLAIM_ELEMENTS.has(name)) throw new ReviewWorkflowError(`candidate_${name}_required`, "Every essential claim element must be explicitly stated.", 400);
    const element = input?.claimElements?.[name];
    const sourceBasis = name === "how" && value.toLowerCase() === "not stated"
      ? String(element?.sourceBasis || "").trim()
      : cleanText(element?.sourceBasis, `candidate_${name}_source_basis_required`, { max: 2_000 });
    if (String(element?.value || "").trim() !== value) throw new ReviewWorkflowError(`candidate_${name}_source_basis_mismatch`, "Claim element source basis must match the reviewed value.", 400);
    elements[name] = { value, sourceBasis };
  }
  const publicEvidence = cleanText(input?.publicEvidence, "candidate_public_evidence_required", { max: 2_000 });
  const passCondition = cleanText(input?.passCondition, "candidate_pass_condition_required", { max: 2_000 });
  const failCondition = cleanText(input?.failCondition, "candidate_fail_condition_required", { max: 2_000 });
  if (passCondition === failCondition) throw new ReviewWorkflowError("candidate_evidence_test_not_distinct", "Pass and fail conditions must be distinct.", 400);
  return {
    decision, rationale, originalSourceVerified: true, contextVerified: true, statementType,
    title: cleanText(input?.title, "candidate_title_required", { min: 5, max: 200 }),
    atomicProposition: cleanText(input?.atomicProposition, "candidate_atomic_proposition_required", { min: 10, max: 1_000 }),
    criteria: cleanText(input?.criteria, "candidate_criteria_required", { min: 10, max: 2_000 }),
    deadline, claimElements: elements, who: elements.who.value, what: elements.what.value,
    why: elements.why.value, where: elements.where.value, when: elements.when.value,
    how: elements.how.value, publicEvidence, passCondition, failCondition,
    publicEvidenceSourceBasis: cleanText(input?.publicEvidenceSourceBasis, "candidate_public_evidence_source_basis_required", { max: 2_000 }),
    passConditionSourceBasis: cleanText(input?.passConditionSourceBasis, "candidate_pass_condition_source_basis_required", { max: 2_000 }),
    failConditionSourceBasis: cleanText(input?.failConditionSourceBasis, "candidate_fail_condition_source_basis_required", { max: 2_000 }),
  };
}

async function hashId(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function submitCandidateDecision(db, assignmentId, reviewerId, decision, now = new Date().toISOString()) {
  const assignment = await assignmentForAccess(db, assignmentId, reviewerId, now, false);
  if (!assignment || assignment.work_type !== "candidate_verification") {
    throw new ReviewWorkflowError("assignment_required", "A live candidate assignment is required.", 404);
  }
  const bundle = await getAssignedReviewBundle(db, assignmentId, reviewerId, now);
  const candidate = bundle?.subject;
  if (!candidate) throw new ReviewWorkflowError("candidate_unavailable", "The candidate is unavailable.", 404);
  const decisionId = `candidate_decision_${await hashId(`${assignment.candidate_id}:${reviewerId}`)}`;
  if (decision.decision === "reject") {
    await db.batch([
      db.prepare(
        `INSERT INTO candidate_review_decisions
         (candidate_decision_id,candidate_id,work_item_id,reviewer_id,decision,rationale,
          promoted_claim_id,decision_fields_json,created_at)
         VALUES (?1,?2,?3,?4,'reject',?5,NULL,?6,?7)`
      ).bind(decisionId, assignment.candidate_id, assignment.work_item_id, reviewerId,
        decision.rationale, JSON.stringify({ reasonCode: decision.reasonCode }), now),
      db.prepare("UPDATE review_assignments SET status='submitted',submitted_at=?1 WHERE assignment_id=?2").bind(now, assignmentId),
      db.prepare("UPDATE review_work_items SET status='complete',completed_at=?1 WHERE work_item_id=?2").bind(now, assignment.work_item_id),
      db.prepare(
        `INSERT INTO review_audit_events
         (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
          assignment_id,detail_json,created_at)
         VALUES (?1,?2,'submission_accepted',?3,NULL,?4,?5,?6,?7)`
      ).bind(`audit_${crypto.randomUUID()}`, reviewerId, assignment.work_item_id,
        assignment.candidate_id, assignmentId, JSON.stringify({ decision: "reject" }), now),
    ]);
    return { decisionId, decision: "reject", candidateId: assignment.candidate_id };
  }
  if (!candidate.source_date || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.source_date)) {
    throw new ReviewWorkflowError("candidate_source_date_missing", "A verified source date is required before promotion.", 409);
  }
  if (!Number.isInteger(candidate.source_timestamp_seconds) || candidate.source_timestamp_seconds < 0) {
    throw new ReviewWorkflowError("candidate_timestamp_missing", "A human-verified source timestamp is required before promotion.", 409);
  }
  const suffix = (await hashId(assignment.candidate_id)).slice(0, 24);
  const claimId = `claim_${suffix}`, promotionId = `promotion_${suffix}`;
  const adjudicationWorkId = `work_${claimId}`, evidenceId = `evidence_${suffix}_original`;
  const source = await db.prepare(
    `SELECT source.person_id,source.platform_item_id,source.canonical_url,video.video_id
     FROM claim_candidates candidate JOIN source_items source ON source.source_item_id=candidate.source_item_id
     LEFT JOIN videos video ON video.youtube_id=source.platform_item_id
     WHERE candidate.candidate_id=?1`
  ).bind(assignment.candidate_id).first();
  const asOfDate = now.slice(0, 10);
  const decisionFields = {
    originalSourceVerified: true, contextVerified: true, statementType: decision.statementType,
    title: decision.title, atomicProposition: decision.atomicProposition,
    criteria: decision.criteria, deadline: decision.deadline,
    claimElements: decision.claimElements,
    publicEvidence: decision.publicEvidence, passCondition: decision.passCondition,
    failCondition: decision.failCondition,
    publicEvidenceSourceBasis: decision.publicEvidenceSourceBasis,
    passConditionSourceBasis: decision.passConditionSourceBasis,
    failConditionSourceBasis: decision.failConditionSourceBasis,
  };
  await db.batch([
    db.prepare(
      `INSERT INTO claims
       (claim_id,person_id,video_id,cluster_id,title,exact_quote,source_url,source_date,
        source_timestamp_seconds,transcript_warning,statement_type,atomic_proposition,criteria,
        deadline,as_of_date,lifecycle_status,proposed_outcome,outcome_status,novelty_status,
        score_eligible,visibility,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,
        NULL,'undetermined','not_assessed',0,'draft',?17)`
    ).bind(claimId, source.person_id, source.video_id || null, `cluster_${suffix}`,
      decision.title, candidate.exact_quote, candidate.source_url || source.canonical_url,
      candidate.source_date, candidate.source_timestamp_seconds,
      "The generated transcript was a locator only; an assigned human confirmed the quotation against the original public source.",
      decision.statementType, decision.atomicProposition, decision.criteria, decision.deadline,
      asOfDate, deadlineLifecycle(decision.deadline, new Date(now)), now),
    db.prepare(
      `INSERT INTO evidence
       (evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,source_role,
        note,search_query,cutoff_date,created_at,verification_method)
       VALUES (?1,?2,'original_statement',?3,?4,?5,?6,'platform',?7,NULL,NULL,?6,'timestamp')`
    ).bind(evidenceId, claimId, candidate.source_url || source.canonical_url,
      decision.title, candidate.source_date, now,
      "Original public source and quotation confirmed by an assigned human reviewer."),
    db.prepare(
      `INSERT INTO candidate_review_decisions
       (candidate_decision_id,candidate_id,work_item_id,reviewer_id,decision,rationale,
        promoted_claim_id,decision_fields_json,created_at)
       VALUES (?1,?2,?3,?4,'promote',?5,?6,?7,?8)`
    ).bind(decisionId, assignment.candidate_id, assignment.work_item_id, reviewerId,
      decision.rationale, claimId, JSON.stringify(decisionFields), now),
    db.prepare(
      `INSERT INTO candidate_claim_promotions
       (promotion_id,candidate_id,claim_id,promoted_by_reviewer_id,verification_basis_json,created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(promotionId, assignment.candidate_id, claimId, reviewerId,
      JSON.stringify({ originalSourceVerified: true, sourceTimestampSeconds: candidate.source_timestamp_seconds }), now),
    db.prepare(
      `INSERT INTO review_work_items
       (work_item_id,claim_id,candidate_id,promotion_id,origin_kind,work_type,status,
        required_matching_reviews,max_reviews,created_at)
       VALUES (?1,?2,NULL,?3,'promoted_candidate','claim_adjudication','ready',2,4,?4)`
    ).bind(adjudicationWorkId, claimId, promotionId, now),
    db.prepare("UPDATE review_assignments SET status='submitted',submitted_at=?1 WHERE assignment_id=?2").bind(now, assignmentId),
    db.prepare("UPDATE review_work_items SET status='complete',completed_at=?1 WHERE work_item_id=?2").bind(now, assignment.work_item_id),
    db.prepare(
      `INSERT INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
       VALUES (?1,?2,'created',?3,?4,?5)`
    ).bind(`event_created_${suffix}`, claimId, reviewerId,
      JSON.stringify({ sourceCandidateId: assignment.candidate_id, promotionId }), now),
    db.prepare(
      `INSERT INTO review_audit_events
       (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
        assignment_id,detail_json,created_at)
       VALUES (?1,?2,'submission_accepted',?3,?4,?5,?6,?7,?8)`
    ).bind(`audit_${crypto.randomUUID()}`, reviewerId, assignment.work_item_id, claimId,
      assignment.candidate_id, assignmentId, JSON.stringify({ decision: "promote" }), now),
  ]);
  return { decisionId, decision: "promote", candidateId: assignment.candidate_id, claimId };
}

export async function hasReviewerSubmission(db, assignmentId, reviewerId) {
  const assignment = await db.prepare(
    `SELECT work.work_type, work.claim_id, work.candidate_id
     FROM review_assignments assignment
     JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
     WHERE assignment.assignment_id=?1 AND assignment.reviewer_id=?2`
  ).bind(assignmentId, reviewerId).first();
  if (!assignment) return false;
  if (assignment.work_type === "claim_adjudication" && assignment.claim_id) {
    const latestDraft = await db.prepare(
      `SELECT created_at FROM ai_draft_decisions WHERE claim_id=?1 ORDER BY revision DESC LIMIT 1`
    ).bind(assignment.claim_id).first();
    const row = latestDraft?.created_at
      ? await db.prepare(
        `SELECT 1 present FROM moderator_reviews
         WHERE claim_id=?1 AND reviewer_id=?2 AND created_at>=?3`
      ).bind(assignment.claim_id, reviewerId, latestDraft.created_at).first()
      : await db.prepare(
        `SELECT 1 present FROM moderator_reviews WHERE claim_id=?1 AND reviewer_id=?2`
      ).bind(assignment.claim_id, reviewerId).first();
    return Boolean(row);
  }
  const row = await db.prepare(
    `SELECT 1 present FROM candidate_review_decisions
     WHERE candidate_id=?1 AND reviewer_id=?2`
  ).bind(assignment.candidate_id, reviewerId).first();
  return Boolean(row);
}
