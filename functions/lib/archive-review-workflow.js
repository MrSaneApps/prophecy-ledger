import { ReviewWorkflowError } from "./review-workflow.js";

const ARCHIVE_DECISIONS = new Set([
  "source_supported", "archive_mismatch", "not_testable", "source_unavailable",
]);
const REQUIRED_ELEMENTS = ["who", "what", "why", "where", "when"];

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

function cleanText(value, code, { min = 1, max = 4_000, optional = false } = {}) {
  const text = String(value ?? "").trim();
  if (optional && !text) return null;
  if (text.length < min || text.length > max) {
    throw new ReviewWorkflowError(code, "The archive source check is incomplete.", 400);
  }
  return text;
}

function bool(value) {
  return value === true;
}

async function currentArchiveAssignment(db, reviewerId, now) {
  return db.prepare(
    `SELECT assignment.archive_assignment_id,assignment.archive_work_item_id,
      assignment.status,assignment.lease_expires_at,work.archive_revision_id,
      work.archive_video_link_id,work.status work_status
     FROM archive_review_assignments assignment
     JOIN archive_verification_work_items work
       ON work.archive_work_item_id=assignment.archive_work_item_id
     WHERE assignment.reviewer_id=?1 AND assignment.status='leased'
       AND assignment.lease_expires_at>?2 AND work.status='ready'
     ORDER BY assignment.assigned_at,assignment.archive_assignment_id LIMIT 1`
  ).bind(reviewerId, now).first();
}

async function hasCurrentStandardAssignment(db, reviewerId, now) {
  const row = await db.prepare(
    `SELECT 1 active FROM review_assignments assignment
     JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
     WHERE assignment.reviewer_id=?1 AND assignment.status='leased'
       AND assignment.lease_expires_at>?2 AND work.status='ready' LIMIT 1`
  ).bind(reviewerId, now).first();
  return Boolean(row);
}

async function archiveWorkItems(db, reviewerId, now) {
  return all(db.prepare(
    `SELECT work.archive_work_item_id,work.archive_revision_id,work.archive_video_link_id
     FROM archive_verification_work_items work
     JOIN first_party_archive_lead_revisions revision
       ON revision.archive_revision_id=work.archive_revision_id
     WHERE work.status='ready'
       AND NOT EXISTS (SELECT 1 FROM archive_review_decisions decision
         WHERE decision.archive_work_item_id=work.archive_work_item_id)
       AND NOT EXISTS (SELECT 1 FROM archive_review_assignments own
         WHERE own.archive_work_item_id=work.archive_work_item_id AND own.reviewer_id=?1
           AND own.status='submitted')
       AND NOT EXISTS (SELECT 1 FROM archive_review_assignments active
         WHERE active.archive_work_item_id=work.archive_work_item_id
           AND (active.status='submitted' OR
             (active.status='leased' AND active.lease_expires_at>?2)))
     ORDER BY COALESCE(NULLIF(revision.date_shared_text,''),revision.fetched_at),
       work.created_at,work.archive_work_item_id LIMIT 20`
  ).bind(reviewerId, now));
}

async function tryLeaseArchive(db, work, reviewerId, now, expiresAt) {
  const existing = await db.prepare(
    `SELECT archive_assignment_id,status,lease_expires_at
     FROM archive_review_assignments
     WHERE archive_work_item_id=?1 AND reviewer_id=?2`
  ).bind(work.archive_work_item_id, reviewerId).first();
  const shouldRenew = existing && (
    existing.status === "released"
    || (existing.status === "leased" && existing.lease_expires_at <= now)
  );
  if (shouldRenew) {
    const result = await db.prepare(
      `UPDATE archive_review_assignments
       SET status='leased',submitted_at=NULL,lease_expires_at=?1,
         lease_version=lease_version+1
       WHERE archive_assignment_id=?2 AND reviewer_id=?3
         AND (status='released' OR (status='leased' AND lease_expires_at<=?4))
         AND NOT EXISTS (SELECT 1 FROM archive_review_assignments active
           WHERE active.archive_work_item_id=?5
             AND active.archive_assignment_id<>?2 AND active.status='leased'
             AND active.lease_expires_at>?4)`
    ).bind(expiresAt, existing.archive_assignment_id, reviewerId, now,
      work.archive_work_item_id).run();
    return changes(result) ? existing.archive_assignment_id : null;
  }
  if (existing) return null;
  const assignmentId = `archive_assignment_${crypto.randomUUID()}`;
  const result = await db.prepare(
    `INSERT OR IGNORE INTO archive_review_assignments
     (archive_assignment_id,archive_work_item_id,reviewer_id,status,assigned_at,
      lease_expires_at,lease_version)
     SELECT ?1,?2,?3,'leased',?4,?5,1
     WHERE EXISTS (SELECT 1 FROM archive_verification_work_items work
       WHERE work.archive_work_item_id=?2 AND work.status='ready')
       AND NOT EXISTS (SELECT 1 FROM archive_review_assignments active
         WHERE active.archive_work_item_id=?2
           AND (active.status='submitted' OR
             (active.status='leased' AND active.lease_expires_at>?4)))`
  ).bind(assignmentId, work.archive_work_item_id, reviewerId, now, expiresAt).run();
  return changes(result) ? assignmentId : null;
}

export async function leaseArchiveReviewWork(db, reviewerId, env, now = new Date().toISOString()) {
  let assignment = await currentArchiveAssignment(db, reviewerId, now);
  if (assignment || await hasCurrentStandardAssignment(db, reviewerId, now)) return assignment;
  const expiresAt = plusSeconds(now, leaseSeconds(env));
  for (const work of await archiveWorkItems(db, reviewerId, now)) {
    const assignmentId = await tryLeaseArchive(db, work, reviewerId, now, expiresAt);
    if (!assignmentId) continue;
    assignment = await db.prepare(
      `SELECT assignment.archive_assignment_id,assignment.archive_work_item_id,
        assignment.status,assignment.lease_expires_at,work.archive_revision_id,
        work.archive_video_link_id,work.status work_status
       FROM archive_review_assignments assignment
       JOIN archive_verification_work_items work
         ON work.archive_work_item_id=assignment.archive_work_item_id
       WHERE assignment.archive_assignment_id=?1`
    ).bind(assignmentId).first();
    break;
  }
  return assignment;
}

async function archiveWorkItemForLease(db, reviewerId, workItemId, now) {
  return db.prepare(
    `SELECT work.archive_work_item_id,work.archive_revision_id,work.archive_video_link_id
     FROM archive_verification_work_items work
     WHERE work.archive_work_item_id=?1 AND work.status='ready'
       AND NOT EXISTS (SELECT 1 FROM archive_review_decisions decision
         WHERE decision.archive_work_item_id=work.archive_work_item_id)
       AND NOT EXISTS (SELECT 1 FROM archive_review_assignments own
         WHERE own.archive_work_item_id=work.archive_work_item_id AND own.reviewer_id=?2
           AND own.status='submitted')
       AND NOT EXISTS (SELECT 1 FROM archive_review_assignments active
         WHERE active.archive_work_item_id=work.archive_work_item_id
           AND (active.status='submitted' OR
             (active.status='leased' AND active.lease_expires_at>?3)))`
  ).bind(workItemId, reviewerId, now).first();
}

async function archiveAssignmentRow(db, assignmentId) {
  return db.prepare(
    `SELECT assignment.archive_assignment_id,assignment.archive_work_item_id,
      assignment.status,assignment.lease_expires_at,work.archive_revision_id,
      work.archive_video_link_id,work.status work_status
     FROM archive_review_assignments assignment
     JOIN archive_verification_work_items work
       ON work.archive_work_item_id=assignment.archive_work_item_id
     WHERE assignment.archive_assignment_id=?1`
  ).bind(assignmentId).first();
}

export async function switchArchiveLease(
  db, reviewerId, workItemId, env, now = new Date().toISOString(),
) {
  const current = await currentArchiveAssignment(db, reviewerId, now);
  if (current?.archive_work_item_id === workItemId) return current;

  const target = await archiveWorkItemForLease(db, reviewerId, workItemId, now);
  if (!target) {
    throw new ReviewWorkflowError("archive_lease_unavailable",
      "That source check is not ready or was taken just now.", 409);
  }
  if (current) {
    await db.prepare(
      `UPDATE archive_review_assignments SET status='released',submitted_at=NULL
       WHERE archive_assignment_id=?1 AND reviewer_id=?2 AND status='leased'`
    ).bind(current.archive_assignment_id, reviewerId).run();
  }

  const expiresAt = plusSeconds(now, leaseSeconds(env));
  const assignmentId = await tryLeaseArchive(db, target, reviewerId, now, expiresAt);
  if (!assignmentId) {
    throw new ReviewWorkflowError("archive_lease_unavailable",
      "That source check was taken just now. Refresh the list.", 409);
  }
  const assignment = await archiveAssignmentRow(db, assignmentId);
  if (!assignment || assignment.archive_work_item_id !== workItemId) {
    throw new ReviewWorkflowError("archive_lease_unavailable",
      "The requested source check could not be opened.", 409);
  }
  return assignment;
}

export async function listArchiveReviewerAssignments(db, reviewerId, now = new Date().toISOString()) {
  const rows = await all(db.prepare(
    `SELECT assignment.archive_assignment_id,assignment.archive_work_item_id,
      assignment.status assignment_status,assignment.lease_expires_at,
      work.status work_status,work.archive_revision_id,work.archive_video_link_id,
      revision.description_text,revision.date_shared_text,person.display_name,
      video.url target_video_url
     FROM archive_review_assignments assignment
     JOIN archive_verification_work_items work
       ON work.archive_work_item_id=assignment.archive_work_item_id
     JOIN first_party_archive_lead_revisions revision
       ON revision.archive_revision_id=work.archive_revision_id
     JOIN first_party_archive_leads lead ON lead.archive_lead_id=revision.archive_lead_id
     JOIN people person ON person.person_id=lead.person_id
     JOIN first_party_archive_revision_links video
       ON video.archive_link_id=work.archive_video_link_id
       AND video.link_role='original_video'
     WHERE assignment.reviewer_id=?1
       AND (assignment.status='submitted' OR
         (assignment.status='leased' AND assignment.lease_expires_at>?2))
       AND work.status<>'withdrawn'
     ORDER BY CASE assignment.status WHEN 'leased' THEN 0 ELSE 1 END,
       assignment.assigned_at DESC LIMIT 25`
  ).bind(reviewerId, now));
  return rows.map((row) => ({
    assignmentId: row.archive_assignment_id,
    workItemId: row.archive_work_item_id,
    workType: "archive_lead_verification",
    subjectId: row.archive_revision_id,
    archiveRevisionId: row.archive_revision_id,
    person: row.display_name,
    title: row.description_text || "First-party archive source check",
    status: row.assignment_status,
    state: "speaker_archive_source_check",
    nextAction: row.work_status === "complete" ? "complete" : "verify_archive_source",
    leaseExpiresAt: row.lease_expires_at,
    sourceDate: row.date_shared_text || null,
    targetVideoUrl: row.target_video_url,
  }));
}

async function archiveAssignmentForAccess(db, assignmentId, reviewerId, now, allowSubmitted = true) {
  return db.prepare(
    `SELECT assignment.archive_assignment_id,assignment.archive_work_item_id,
      assignment.status assignment_status,assignment.lease_expires_at,
      work.status work_status,work.archive_revision_id,work.archive_video_link_id
     FROM archive_review_assignments assignment
     JOIN archive_verification_work_items work
       ON work.archive_work_item_id=assignment.archive_work_item_id
     WHERE assignment.archive_assignment_id=?1 AND assignment.reviewer_id=?2
       AND ((assignment.status='leased' AND assignment.lease_expires_at>?3)
         ${allowSubmitted ? "OR assignment.status='submitted'" : ""})
       AND work.status<>'withdrawn'`
  ).bind(assignmentId, reviewerId, now).first();
}

function assignmentProjection(row) {
  return {
    assignmentId: row.archive_assignment_id,
    workItemId: row.archive_work_item_id,
    workType: "archive_lead_verification",
    status: row.assignment_status,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function getAssignedArchiveReviewBundle(
  db, assignmentId, reviewerId, now = new Date().toISOString(),
) {
  const assignment = await archiveAssignmentForAccess(db, assignmentId, reviewerId, now);
  if (!assignment) return null;
  const subject = await db.prepare(
    `SELECT revision.archive_revision_id,revision.archive_lead_id,
      revision.content_sha256,revision.description_text,revision.date_shared_text,
      revision.prophecy_text,revision.claimed_result_text,revision.claimed_evidence_text,
      revision.source_locator_y_index,revision.fetched_at,
      lead.publisher_element_id,person.display_name person_name,
      receipt.source_url archive_source_url,
      video.archive_link_id assigned_video_link_id,video.ordinal assigned_video_ordinal,
      video.label assigned_video_label,video.url assigned_video_url,
      video.youtube_id assigned_video_youtube_id
     FROM first_party_archive_lead_revisions revision
     JOIN first_party_archive_leads lead ON lead.archive_lead_id=revision.archive_lead_id
     JOIN people person ON person.person_id=lead.person_id
     JOIN first_party_archive_receipts receipt ON receipt.receipt_id=revision.receipt_id
     JOIN first_party_archive_revision_links video
       ON video.archive_link_id=?2 AND video.archive_revision_id=revision.archive_revision_id
       AND video.link_role='original_video'
     WHERE revision.archive_revision_id=?1`
  ).bind(assignment.archive_revision_id, assignment.archive_video_link_id).first();
  if (!subject) return null;
  const links = await all(db.prepare(
    `SELECT archive_link_id,link_role,ordinal,label,url,youtube_id,provenance
     FROM first_party_archive_revision_links WHERE archive_revision_id=?1
     ORDER BY CASE link_role WHEN 'original_video' THEN 0 ELSE 1 END,ordinal,archive_link_id`
  ).bind(assignment.archive_revision_id));
  const versions = await all(db.prepare(
    `SELECT archive_revision_id,content_sha256,fetched_at
     FROM first_party_archive_lead_revisions WHERE archive_lead_id=?1
     ORDER BY fetched_at,archive_revision_id`
  ).bind(subject.archive_lead_id));
  return {
    assignment: assignmentProjection(assignment),
    workType: "archive_lead_verification",
    subject,
    assignedSourceVersion: {
      archiveLinkId: subject.assigned_video_link_id,
      ordinal: subject.assigned_video_ordinal,
      label: subject.assigned_video_label,
      url: subject.assigned_video_url,
      youtubeId: subject.assigned_video_youtube_id,
    },
    originalVideoLinks: links.filter((link) => link.link_role === "original_video").map((link) => ({
      archiveLinkId: link.archive_link_id, ordinal: link.ordinal, label: link.label,
      url: link.url, youtubeId: link.youtube_id, linkRole: link.link_role,
      provenance: link.provenance,
      assigned: link.archive_link_id === subject.assigned_video_link_id,
    })),
    claimedFollowUpLinks: links.filter((link) => link.link_role === "claimed_follow_up").map((link) => ({
      archiveLinkId: link.archive_link_id, ordinal: link.ordinal, label: link.label,
      url: link.url, youtubeId: link.youtube_id, linkRole: link.link_role,
      provenance: link.provenance,
    })),
    claimedEvidenceLinks: links.filter((link) => link.link_role === "claimed_evidence").map((link) => ({
      archiveLinkId: link.archive_link_id, ordinal: link.ordinal, label: link.label,
      url: link.url, youtubeId: link.youtube_id, linkRole: link.link_role,
      provenance: link.provenance,
    })),
    archiveVersions: versions.map((version) => ({
      archiveRevisionId: version.archive_revision_id,
      contentSha256: version.content_sha256,
      fetchedAt: version.fetched_at,
      selected: version.archive_revision_id === assignment.archive_revision_id,
    })),
    boundary: {
      firstPartyRetrospectiveOnly: true,
      claimedEvidenceIsIndependent: false,
      oneOriginalSourceVersionOnly: true,
      canCreateClaimOrRating: false,
      crossVideoSynthesisAllowed: false,
    },
  };
}

export function normalizeArchiveDecision(input) {
  if (Object.hasOwn(input || {}, "reviewerId")) {
    throw new ReviewWorkflowError("reviewer_identity_body_forbidden", "Reviewer identity cannot be supplied.", 400);
  }
  const decision = String(input?.decision || "");
  if (!ARCHIVE_DECISIONS.has(decision)) {
    throw new ReviewWorkflowError("archive_decision_invalid", "Choose a supported archive decision.", 400);
  }
  const rationale = cleanText(input?.rationale, "archive_rationale_required", { min: 10 });
  const sourceAvailable = bool(input?.sourceAvailable);
  const contextVerified = bool(input?.contextVerified);
  const exactSourceVerified = bool(input?.exactSourceVerified);
  const testable = bool(input?.testable);
  const exactSourceQuote = cleanText(input?.exactSourceQuote, "archive_exact_quote_required", {
    min: 3, max: 8_000, optional: decision === "source_unavailable" || decision === "archive_mismatch",
  });
  const rawTimestamp = input?.sourceTimestampSeconds;
  const sourceTimestampSeconds = rawTimestamp === "" || rawTimestamp == null
    ? null : Number(rawTimestamp);
  if (sourceTimestampSeconds != null
      && (!Number.isInteger(sourceTimestampSeconds) || sourceTimestampSeconds < 0)) {
    throw new ReviewWorkflowError("archive_timestamp_invalid", "Use a non-negative whole-second timestamp.", 400);
  }

  if (decision === "source_unavailable") {
    if (sourceAvailable || contextVerified || exactSourceVerified || testable || exactSourceQuote) {
      throw new ReviewWorkflowError("archive_source_unavailable_checks_invalid", "Unavailable sources cannot be marked checked or supported.", 400);
    }
    return { decision, rationale, sourceAvailable, contextVerified, exactSourceVerified, testable,
      exactSourceQuote: null, sourceTimestampSeconds: null, elements: {}, how: null,
      publicEvidenceNote: null, passConditionNote: null, failConditionNote: null };
  }
  if (!sourceAvailable || !contextVerified) {
    throw new ReviewWorkflowError("archive_source_checks_required", "Confirm source availability and surrounding context.", 400);
  }
  if (decision === "archive_mismatch") {
    if (exactSourceVerified) {
      throw new ReviewWorkflowError("archive_mismatch_cannot_be_supported", "An archive mismatch cannot be marked exact-source supported.", 400);
    }
    return { decision, rationale, sourceAvailable, contextVerified, exactSourceVerified, testable: false,
      exactSourceQuote, sourceTimestampSeconds, elements: {}, how: null,
      publicEvidenceNote: null, passConditionNote: null, failConditionNote: null };
  }
  if (decision === "not_testable") {
    if (!exactSourceVerified || testable) {
      throw new ReviewWorkflowError("archive_not_testable_checks_invalid", "Confirm the source wording, but do not mark it testable.", 400);
    }
    return { decision, rationale, sourceAvailable, contextVerified, exactSourceVerified, testable,
      exactSourceQuote, sourceTimestampSeconds, elements: {}, how: null,
      publicEvidenceNote: null, passConditionNote: null, failConditionNote: null };
  }
  if (!exactSourceVerified || !testable) {
    throw new ReviewWorkflowError("archive_supported_checks_required", "Supported archive leads require exact-source and testability confirmation.", 400);
  }
  const elements = {};
  for (const name of REQUIRED_ELEMENTS) {
    const value = cleanText(input?.[name], `archive_${name}_required`, { max: 1_000 });
    if (value.toLowerCase() === "not stated") {
      throw new ReviewWorkflowError(`archive_${name}_required`, "Who, what, why, where, and when must be stated.", 400);
    }
    elements[name] = {
      value,
      sourceBasis: cleanText(input?.[`${name}SourceBasis`], `archive_${name}_source_basis_required`, { max: 2_000 }),
    };
  }
  const how = cleanText(input?.how, "archive_how_invalid", { max: 1_000, optional: true });
  const howSourceBasis = cleanText(input?.howSourceBasis, "archive_how_source_basis_required", {
    max: 2_000, optional: !how,
  });
  if (how && !howSourceBasis) {
    throw new ReviewWorkflowError("archive_how_source_basis_required", "A stated How needs exact source support.", 400);
  }
  const publicEvidenceNote = cleanText(input?.publicEvidenceNote, "archive_public_evidence_note_required", { max: 2_000 });
  const passConditionNote = cleanText(input?.passConditionNote, "archive_pass_condition_required", { max: 2_000 });
  const failConditionNote = cleanText(input?.failConditionNote, "archive_fail_condition_required", { max: 2_000 });
  if (passConditionNote === failConditionNote) {
    throw new ReviewWorkflowError("archive_pass_fail_not_distinct", "Pass and fail conditions must be distinct.", 400);
  }
  return {
    decision, rationale, sourceAvailable, contextVerified, exactSourceVerified, testable,
    exactSourceQuote, sourceTimestampSeconds, elements,
    how: how ? { value: how, sourceBasis: howSourceBasis } : null,
    publicEvidenceNote, passConditionNote, failConditionNote,
  };
}

function checkStatus(decision, name) {
  if (decision.decision === "source_supported") {
    if (name === "how") return decision.how ? "supported" : "not_stated";
    return "supported";
  }
  if (name === "source_available") return decision.sourceAvailable ? "supported" : "not_supported";
  if (name === "testable") {
    return decision.decision === "not_testable" ? "not_supported" : "not_checked";
  }
  if (name === "exact_source") {
    return decision.exactSourceVerified ? "supported"
      : decision.decision === "archive_mismatch" ? "not_supported" : "not_checked";
  }
  return "not_checked";
}

function checkNote(decision, name) {
  if (decision.decision !== "source_supported") return decision.rationale;
  if (name === "source_available") return "The assigned original-source link was available to the reviewer.";
  if (name === "testable") return "The source states an observable proposition with distinct pass and fail conditions.";
  if (name === "exact_source") return decision.exactSourceQuote;
  if (name === "how") return decision.how?.sourceBasis || "The mechanism was not stated in this source version.";
  return decision.elements[name].sourceBasis;
}

export async function submitArchiveDecision(
  db, assignmentId, reviewerId, decision, now = new Date().toISOString(), options = {},
) {
  const assignment = await archiveAssignmentForAccess(db, assignmentId, reviewerId, now, false);
  if (!assignment) {
    throw new ReviewWorkflowError("assignment_required", "A live archive assignment is required.", 404);
  }
  const decisionId = options.decisionId || `archive_decision_${crypto.randomUUID()}`;
  const observationId = options.observationId || `archive_observation_${crypto.randomUUID()}`;
  const additionalStatements = Array.isArray(options.additionalStatements)
    ? options.additionalStatements : [];
  const checks = ["source_available", "testable", "exact_source", "who", "what", "why", "where", "when", "how"];
  await db.batch([
    db.prepare(
      `INSERT INTO archive_review_decisions
       (archive_decision_id,archive_work_item_id,archive_assignment_id,reviewer_id,
        decision,rationale,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)`
    ).bind(decisionId, assignment.archive_work_item_id, assignmentId, reviewerId,
      decision.decision, decision.rationale, now),
    db.prepare(
      `INSERT INTO archive_review_observations
       (archive_observation_id,archive_decision_id,source_available_confirmed,
        context_confirmed,exact_source_confirmed,exact_source_quote,
        source_timestamp_seconds,who_text,who_source_basis,what_text,what_source_basis,
        why_text,why_source_basis,where_text,where_source_basis,when_text,when_source_basis,
        how_text,how_source_basis,public_evidence_note,pass_condition_note,
        fail_condition_note,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,
        ?17,?18,?19,?20,?21,?22,?23)`
    ).bind(observationId, decisionId, decision.sourceAvailable ? 1 : 0,
      decision.contextVerified ? 1 : 0, decision.exactSourceVerified ? 1 : 0,
      decision.exactSourceQuote, decision.sourceTimestampSeconds,
      decision.elements.who?.value || null, decision.elements.who?.sourceBasis || null,
      decision.elements.what?.value || null, decision.elements.what?.sourceBasis || null,
      decision.elements.why?.value || null, decision.elements.why?.sourceBasis || null,
      decision.elements.where?.value || null, decision.elements.where?.sourceBasis || null,
      decision.elements.when?.value || null, decision.elements.when?.sourceBasis || null,
      decision.how?.value || null, decision.how?.sourceBasis || null,
      decision.publicEvidenceNote, decision.passConditionNote, decision.failConditionNote, now),
    ...checks.map((name) => db.prepare(
      `INSERT INTO archive_review_source_checks
       (archive_source_check_id,archive_decision_id,check_name,check_status,source_note,created_at)
       VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(`archive_check_${crypto.randomUUID()}`, decisionId, name,
      checkStatus(decision, name), checkNote(decision, name), now)),
    ...additionalStatements,
    db.prepare(
      `UPDATE archive_review_assignments SET status='submitted',submitted_at=?1
       WHERE archive_assignment_id=?2 AND reviewer_id=?3 AND status='leased'
         AND lease_expires_at>?1`
    ).bind(now, assignmentId, reviewerId),
    db.prepare(
      `UPDATE archive_verification_work_items SET status='complete',completed_at=?1
       WHERE archive_work_item_id=?2 AND status='ready'`
    ).bind(now, assignment.archive_work_item_id),
  ]);
  return {
    decisionId, observationId, decision: decision.decision,
    archiveWorkItemId: assignment.archive_work_item_id,
    claimCreated: false, ratingCreated: false,
  };
}

export async function hasArchiveReviewerSubmission(db, assignmentId, reviewerId) {
  const row = await db.prepare(
    `SELECT EXISTS(SELECT 1 FROM archive_review_decisions decision
      WHERE decision.archive_assignment_id=assignment.archive_assignment_id
        AND decision.reviewer_id=?2) submitted
     FROM archive_review_assignments assignment
     WHERE assignment.archive_assignment_id=?1 AND assignment.reviewer_id=?2`
  ).bind(assignmentId, reviewerId).first();
  return Boolean(row?.submitted);
}
