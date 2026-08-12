import { evaluatePublication, SCORE_ELIGIBLE_TYPES } from "./claims.js";

async function all(statement) {
  const result = await statement.all();
  return result.results || [];
}

async function hashId(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function unblindedClaimBundle(db, claimId) {
  const claim = await db.prepare("SELECT * FROM claims WHERE claim_id=?1").bind(claimId).first();
  if (!claim) return null;
  const evidence = await all(db.prepare("SELECT * FROM evidence WHERE claim_id=?1").bind(claimId));
  const receipts = await all(db.prepare("SELECT * FROM prior_information_receipts WHERE claim_id=?1").bind(claimId));
  const latestDraft = await db.prepare(
    "SELECT created_at FROM ai_draft_decisions WHERE claim_id=?1 ORDER BY revision DESC LIMIT 1"
  ).bind(claimId).first();
  const reviews = latestDraft?.created_at
    ? await all(db.prepare(
      "SELECT * FROM moderator_reviews WHERE claim_id=?1 AND created_at>=?2 ORDER BY created_at,review_id"
    ).bind(claimId, latestDraft.created_at))
    : await all(db.prepare(
      "SELECT * FROM moderator_reviews WHERE claim_id=?1 ORDER BY created_at,review_id"
    ).bind(claimId));
  return { claim, evidence, receipts, reviews };
}

export async function reconcilePublication(db, claimId, now = new Date().toISOString()) {
  const bundle = await unblindedClaimBundle(db, claimId);
  if (!bundle) return null;
  const result = evaluatePublication(bundle.claim, bundle.evidence, bundle.receipts, bundle.reviews);
  if (result.state !== "published") {
    await db.batch([
      db.prepare(
        `UPDATE publication_evaluations SET state=?1,last_attempt_at=?2,
          completed_at=?2,attempt_count=attempt_count+1,last_error_code=NULL
         WHERE claim_id=?3`
      ).bind(result.state, now, claimId),
      db.prepare(
        `INSERT INTO review_audit_events
         (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
          assignment_id,detail_json,created_at)
         VALUES (?1,NULL,'evaluation_reconciled',NULL,?2,NULL,NULL,?3,?4)`
      ).bind(`audit_${crypto.randomUUID()}`, claimId, JSON.stringify({ state: result.state }), now),
    ]);
    return result;
  }
  const existing = await db.prepare(
    "SELECT revision_id FROM claim_revisions WHERE claim_id=?1 AND revision_number=1"
  ).bind(claimId).first();
  const revisionId = existing?.revision_id || `revision_publication_${await hashId(claimId)}`;
  const decision = {
    claimType: result.claimType, outcomeStatus: result.outcomeStatus,
    noveltyStatus: result.noveltyStatus, baselineProbability: result.baselineProbability,
    evidenceIds: result.evidenceIds, priorReceiptId: result.priorReceiptId,
    decisionFingerprint: result.decisionFingerprint,
  };
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO claim_revisions
       (revision_id,claim_id,revision_number,revision_type,decision_json,actor_ids_json,created_at)
       VALUES (?1,?2,1,'publication',?3,?4,?5)`
    ).bind(revisionId, claimId, JSON.stringify(decision), JSON.stringify(result.reviewerIds), now),
    db.prepare(
      `UPDATE claims SET statement_type=?1,outcome_status=?2,novelty_status=?3,
       baseline_probability=?4,score_eligible=?5,visibility='published',lifecycle_status=?6,
       publication_summary=?7,published_at=?8 WHERE claim_id=?9 AND visibility='draft'`
    ).bind(result.claimType, result.outcomeStatus, result.noveltyStatus,
      result.baselineProbability, SCORE_ELIGIBLE_TYPES.has(result.claimType) ? 1 : 0,
      ["pending", "not_falsifiable"].includes(result.outcomeStatus) ? "pending" : "resolved",
      "Published after two independently authenticated reviewers matched on the frozen decision and evidence set.",
      now, claimId),
    db.prepare(
      `INSERT OR IGNORE INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
       VALUES (?1,?2,'published','publication_reconciler',?3,?4)`
    ).bind(`event_published_${await hashId(claimId)}`, claimId,
      JSON.stringify({ revisionId, reviewCount: 2 }), now),
    db.prepare("UPDATE review_work_items SET status='complete',completed_at=?1 WHERE claim_id=?2").bind(now, claimId),
    db.prepare(
      `UPDATE publication_evaluations SET state='published',last_attempt_at=?1,completed_at=?1,
       attempt_count=attempt_count+1,last_error_code=NULL,publication_revision_id=?2 WHERE claim_id=?3`
    ).bind(now, revisionId, claimId),
    db.prepare(
      `INSERT INTO review_audit_events
       (audit_event_id,reviewer_id,event_type,work_item_id,claim_id,candidate_id,
        assignment_id,detail_json,created_at)
       VALUES (?1,NULL,'evaluation_reconciled',NULL,?2,NULL,NULL,?3,?4)`
    ).bind(`audit_${crypto.randomUUID()}`, claimId, JSON.stringify({ state: "published" }), now),
  ]);
  return { ...result, revisionId };
}

export async function reconcileNeededPublications(db, limit = 10) {
  const rows = await all(db.prepare(
    "SELECT claim_id FROM publication_evaluations WHERE state='needed' ORDER BY requested_at LIMIT ?1"
  ).bind(limit));
  for (const row of rows) await reconcilePublication(db, row.claim_id);
  return rows.length;
}
