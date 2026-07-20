import { sha256, stableId } from "./hash.js";

export const nowIso = () => new Date().toISOString();

export async function createRun(db, { runId, personId, triggerType, scope, createdAt = nowIso() }) {
  const result = await db.prepare(`INSERT OR IGNORE INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES (?1,?2,?3,?4,'queued',?5)`)
    .bind(runId, personId, triggerType, scope, createdAt).run();
  const row = await db.prepare("SELECT * FROM ingestion_runs WHERE run_id=?1").bind(runId).first();
  return { ...row, inserted: Boolean(result.meta?.changes) };
}

export async function registerJob(db, envelope, createdAt = nowIso()) {
  const payloadJson = JSON.stringify(envelope.payload);
  await db.prepare(`INSERT OR IGNORE INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,claimed_at)
    VALUES (?1,?2,?3,?4,?5,'queued',NULL)`)
    .bind(envelope.jobId, envelope.runId, envelope.type, envelope.stableKey, payloadJson).run();
  await db.prepare("UPDATE ingestion_runs SET status='running',started_at=COALESCE(started_at,?2) WHERE run_id=?1 AND status='queued'")
    .bind(envelope.runId, createdAt).run();
  return db.prepare("SELECT * FROM ingestion_jobs WHERE job_id=?1").bind(envelope.jobId).first();
}

export async function claimJob(db, jobId, leaseToken, { now = nowIso(), leaseMs = 120_000,
  batchId = null, batchItemId = null } = {}) {
  if (Boolean(batchId) !== Boolean(batchItemId)) throw new Error("invalid_transcript_batch_claim");
  const expired = new Date(new Date(now).getTime() - leaseMs).toISOString();
  const result = await db.prepare(`UPDATE ingestion_jobs SET
      status='processing',attempt_count=attempt_count+1,claimed_at=?2,lease_token=?3,error_code=NULL
    WHERE job_id=?1 AND status <> 'completed' AND status <> 'failed'
      AND (status='queued' OR claimed_at IS NULL OR claimed_at < ?4)
      AND (?5 IS NULL OR EXISTS (
        SELECT 1 FROM transcript_batches batch
        JOIN transcript_batch_items item ON item.batch_id=batch.batch_id
        WHERE batch.batch_id=?5 AND batch.status='running'
          AND item.batch_item_id=?6 AND item.status='active'
          AND item.run_id=ingestion_jobs.run_id
      ))`)
    .bind(jobId, now, leaseToken, expired, batchId, batchItemId).run();
  if (!result.meta?.changes) return null;
  return db.prepare("SELECT * FROM ingestion_jobs WHERE job_id=?1 AND lease_token=?2")
    .bind(jobId, leaseToken).first();
}

export async function completeJob(db, jobId, leaseToken, completedAt = nowIso()) {
  const result = await db.prepare(`UPDATE ingestion_jobs SET status='completed',completed_at=?3,
      claimed_at=NULL,lease_token=NULL,error_code=NULL
    WHERE job_id=?1 AND status='processing' AND lease_token=?2`)
    .bind(jobId, leaseToken, completedAt).run();
  return Boolean(result.meta?.changes);
}

export async function failJob(db, jobId, leaseToken, errorCode, { final = false, at = nowIso() } = {}) {
  const result = await db.prepare(`UPDATE ingestion_jobs SET status=?4,error_code=?3,
      completed_at=CASE WHEN ?4='failed' THEN ?5 ELSE NULL END,claimed_at=NULL,lease_token=NULL
    WHERE job_id=?1 AND status='processing' AND lease_token=?2`)
    .bind(jobId, leaseToken, errorCode, final ? "failed" : "queued", at).run();
  return Boolean(result.meta?.changes);
}

export async function deferJob(db, jobId, leaseToken, errorCode, eligibleAt) {
  const result = await db.prepare(`UPDATE ingestion_jobs SET status='queued',error_code=?3,
      completed_at=NULL,claimed_at=?4,lease_token=NULL
    WHERE job_id=?1 AND status='processing' AND lease_token=?2`)
    .bind(jobId, leaseToken, errorCode, eligibleAt).run();
  return Boolean(result.meta?.changes);
}

export async function claimSuccessorDispatch(db, jobId) {
  const result = await db.prepare("UPDATE ingestion_jobs SET successor_enqueued=1 WHERE job_id=?1 AND status='completed' AND successor_enqueued=0")
    .bind(jobId).run();
  return Boolean(result.meta?.changes);
}

export async function resetSuccessorDispatch(db, jobId) {
  await db.prepare("UPDATE ingestion_jobs SET successor_enqueued=0 WHERE job_id=?1 AND status='completed'").bind(jobId).run();
}

export async function recoveryCandidates(db, runId, { now = nowIso(), leaseMs = 120_000, analysisLeaseMs = 300_000, transcriptLeaseMs = 900_000, queuedMs = 300_000, limit = 25 } = {}) {
  const expired = new Date(new Date(now).getTime() - leaseMs).toISOString();
  const analysisExpired = new Date(new Date(now).getTime() - analysisLeaseMs).toISOString();
  const transcriptExpired = new Date(new Date(now).getTime() - transcriptLeaseMs).toISOString();
  const queuedExpired = new Date(new Date(now).getTime() - queuedMs).toISOString();
  const rows = await db.prepare(`SELECT j.job_id,j.run_id,j.job_type,j.stable_key,j.payload_json,r.person_id
    FROM ingestion_jobs j JOIN ingestion_runs r ON r.run_id=j.run_id
    WHERE j.run_id=?1 AND (
      (j.status='processing' AND (
        (j.job_type LIKE 'video_analysis_%' AND j.claimed_at < ?3)
        OR (j.job_type='transcript_extract' AND j.claimed_at < ?6)
        OR (j.job_type NOT LIKE 'video_analysis_%' AND j.job_type<>'transcript_extract' AND j.claimed_at < ?2)))
      OR (j.status='queued' AND j.error_code='stale_lease_recovery_pending')
      OR (j.status='queued' AND j.error_code='transcript_budget_deferred' AND j.claimed_at <= ?7)
      OR (j.status='queued' AND j.attempt_count=0 AND j.error_code IS NULL AND r.created_at < ?4)
    ) ORDER BY j.claimed_at,j.job_id LIMIT ?5`).bind(runId, expired, analysisExpired, queuedExpired, limit, transcriptExpired, now).all();
  return rows.results || [];
}

export async function reserveRecoveryDispatch(db, jobId, reservationToken, { now = nowIso(), leaseMs = 120_000, analysisLeaseMs = 300_000, transcriptLeaseMs = 900_000, queuedMs = 300_000 } = {}) {
  const expired = new Date(new Date(now).getTime() - leaseMs).toISOString();
  const analysisExpired = new Date(new Date(now).getTime() - analysisLeaseMs).toISOString();
  const transcriptExpired = new Date(new Date(now).getTime() - transcriptLeaseMs).toISOString();
  const queuedExpired = new Date(new Date(now).getTime() - queuedMs).toISOString();
  const result = await db.prepare(`UPDATE ingestion_jobs SET
      status='queued',claimed_at=?2,lease_token=?3,error_code='stale_lease_recovery_dispatching'
    WHERE job_id=?1 AND (
      (status='processing' AND (
        (job_type LIKE 'video_analysis_%' AND claimed_at < ?5)
        OR (job_type='transcript_extract' AND claimed_at < ?7)
        OR (job_type NOT LIKE 'video_analysis_%' AND job_type<>'transcript_extract' AND claimed_at < ?4)))
      OR (status='queued' AND error_code='stale_lease_recovery_pending')
      OR (status='queued' AND error_code='transcript_budget_deferred' AND claimed_at <= ?2)
      OR (status='queued' AND attempt_count=0 AND error_code IS NULL AND run_id IN (
        SELECT run_id FROM ingestion_runs WHERE created_at < ?6
      ))
    )`).bind(jobId, now, reservationToken, expired, analysisExpired, queuedExpired, transcriptExpired).run();
  return Boolean(result.meta?.changes);
}

export async function finishRecoveryDispatch(db, jobId, reservationToken, sent) {
  const result = await db.prepare(`UPDATE ingestion_jobs SET claimed_at=NULL,lease_token=NULL,error_code=?3
    WHERE job_id=?1 AND status='queued' AND lease_token=?2
      AND error_code='stale_lease_recovery_dispatching'`)
    .bind(jobId, reservationToken, sent ? "stale_lease_recovered" : "stale_lease_recovery_pending").run();
  return Boolean(result.meta?.changes);
}

export async function upsertSourceItem(db, {
  personId, sourceId = null, platform, platformItemId, canonicalUrl,
  availability = "available", seenAt = nowIso(),
}) {
  const sourceItemId = await stableId("src", `${personId}:${platform}:${platformItemId}`);
  await db.prepare(`INSERT INTO source_items
      (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?7,?8)
    ON CONFLICT(person_id,platform,platform_item_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,availability=excluded.availability`)
    .bind(sourceItemId, personId, sourceId, platform, platformItemId, canonicalUrl, seenAt, availability).run();
  return db.prepare("SELECT * FROM source_items WHERE person_id=?1 AND platform=?2 AND platform_item_id=?3")
    .bind(personId, platform, platformItemId).first();
}

export async function addRevision(db, sourceItemId, metadata, { runId, parserVersion, fetchedAt = nowIso() }) {
  // Identical content hashes intentionally share one immutable revision, even
  // after a later reversion. Per-run availability events preserve when that
  // exact content was observed again without duplicating evidence content.
  const content = {
    canonicalUrl: metadata.canonicalUrl,
    title: metadata.title,
    description: metadata.description || null,
    publicationDate: metadata.publicationDate || null,
    embeddedPlatform: metadata.embeddedPlatform || null,
    embeddedItemId: metadata.embeddedItemId || null,
    embeddedUrl: metadata.embeddedUrl || null,
  };
  const contentSha256 = await sha256(content);
  const revisionId = await stableId("rev", `${sourceItemId}:${contentSha256}`);
  const result = await db.prepare(`INSERT OR IGNORE INTO source_item_revisions
    (revision_id,source_item_id,content_sha256,canonical_url,public_title,first_party_description,
     publication_date,embedded_platform,embedded_item_id,embedded_url,fetched_at,parser_version,source_run_id)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`)
    .bind(revisionId, sourceItemId, contentSha256, content.canonicalUrl, content.title, content.description,
      content.publicationDate, content.embeddedPlatform, content.embeddedItemId, content.embeddedUrl,
      fetchedAt, parserVersion, runId).run();
  return { revisionId, contentSha256, inserted: Boolean(result.meta?.changes) };
}

export const ARCHIVE_PERSIST_STATEMENT_COUNT = 7;
export const ARCHIVE_MAX_BATCH_JSON_BYTES = 1_500_000;
const ARCHIVE_MAX_ROWS = 500;
const ARCHIVE_MAX_LINKS = 3_000;

function archiveJson(value) {
  return JSON.stringify(value);
}

function archivePayloadBytes(payloads) {
  return payloads.reduce((total, payload) => total + new TextEncoder().encode(payload).byteLength, 0);
}

export async function persistFirstPartyArchive(db, {
  runId, sourceId, personId, sourceUrl, adapter, parserVersion,
  responseSha256, rows, fetchedAt = nowIso(),
}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > ARCHIVE_MAX_ROWS) {
    throw new Error("first_party_archive_row_limit");
  }
  const receiptId = await stableId("fpar", `${runId}:${sourceId}:${responseSha256}`);
  const receipts = [{ receiptId, runId, sourceId, personId, adapter, sourceUrl,
    responseSha256, rowCount: rows.length, parserVersion, fetchedAt }];
  const leads = [];
  const revisions = [];
  const observations = [];
  const sourceItemsByYoutubeId = new Map();
  const links = [];
  const workItems = [];
  for (const row of rows) {
    const archiveLeadId = await stableId("fpal", `${sourceId}:${row.publisherElementId}`);
    leads.push({ archiveLeadId, sourceId, personId,
      publisherElementId: row.publisherElementId, createdAt: fetchedAt });
    const content = {
      description: row.description, dateShared: row.dateShared, prophecy: row.prophecy,
      claimedResult: row.claimedResult, claimedEvidence: row.claimedEvidence,
      videoLinks: row.videoLinks, evidenceLinks: row.evidenceLinks,
    };
    const contentSha256 = await sha256(content);
    const archiveRevisionId = await stableId("fprev", `${archiveLeadId}:${contentSha256}`);
    revisions.push({ archiveRevisionId, archiveLeadId, receiptId, contentSha256,
      sourceLocatorYIndex: row.sourceLocatorYIndex, descriptionText: row.description,
      dateSharedText: row.dateShared, prophecyText: row.prophecy,
      claimedResultText: row.claimedResult, claimedEvidenceText: row.claimedEvidence,
      parserVersion, fetchedAt });
    observations.push({
      observationId: await stableId("fpobs", `${receiptId}:${archiveRevisionId}`),
      archiveRevisionId, receiptId, sourceLocatorYIndex: row.sourceLocatorYIndex,
      observedAt: fetchedAt,
    });
    for (const rowLink of [...row.videoLinks, ...row.evidenceLinks]) {
      const role = rowLink.linkRole;
      if (!["original_video", "claimed_follow_up", "claimed_evidence"].includes(role)) {
        throw new Error("first_party_archive_unknown_link_role");
      }
      let sourceItemId = null;
      if (role === "original_video" && rowLink.youtubeId) {
        sourceItemId = await stableId("src", `${personId}:youtube:${rowLink.youtubeId}`);
        sourceItemsByYoutubeId.set(rowLink.youtubeId, {
          sourceItemId, personId, platformItemId: rowLink.youtubeId,
          canonicalUrl: `https://www.youtube.com/watch?v=${rowLink.youtubeId}`,
          seenAt: fetchedAt,
        });
      }
      const archiveLinkId = await stableId("fplink",
        `${archiveRevisionId}:${role}:${rowLink.ordinal}:${rowLink.url}`);
      const provenance = role === "original_video" ? "first_party_claimed_original"
        : role === "claimed_follow_up" ? "first_party_claimed_follow_up"
          : "first_party_claimed_evidence";
      links.push({ archiveLinkId, archiveRevisionId, linkRole: role,
        ordinal: rowLink.ordinal, label: rowLink.label, url: rowLink.url,
        youtubeId: rowLink.youtubeId || null, sourceItemId, provenance });
      if (role === "original_video" && rowLink.youtubeId) {
        const workItemId = await stableId("fpwork", `${archiveRevisionId}:${archiveLinkId}`);
        workItems.push({ workItemId, archiveRevisionId, archiveLinkId, createdAt: fetchedAt });
      }
    }
  }
  if (links.length > ARCHIVE_MAX_LINKS) throw new Error("first_party_archive_link_limit");
  const payloads = [receipts, leads, revisions, observations,
    [...sourceItemsByYoutubeId.values()], links, workItems]
    .map(archiveJson);
  if (archivePayloadBytes(payloads) > ARCHIVE_MAX_BATCH_JSON_BYTES) {
    throw new Error("first_party_archive_payload_too_large");
  }
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO first_party_archive_receipts
      (receipt_id,run_id,source_id,person_id,adapter,source_url,response_sha256,row_count,parser_version,fetched_at)
      SELECT json_extract(value,'$.receiptId'),json_extract(value,'$.runId'),
        json_extract(value,'$.sourceId'),json_extract(value,'$.personId'),json_extract(value,'$.adapter'),
        json_extract(value,'$.sourceUrl'),json_extract(value,'$.responseSha256'),
        json_extract(value,'$.rowCount'),json_extract(value,'$.parserVersion'),json_extract(value,'$.fetchedAt')
      FROM json_each(?1)`).bind(payloads[0]),
    db.prepare(`INSERT OR IGNORE INTO first_party_archive_leads
      (archive_lead_id,source_id,person_id,publisher_element_id,created_at)
      SELECT json_extract(value,'$.archiveLeadId'),json_extract(value,'$.sourceId'),
        json_extract(value,'$.personId'),json_extract(value,'$.publisherElementId'),
        json_extract(value,'$.createdAt') FROM json_each(?1)`).bind(payloads[1]),
    db.prepare(`INSERT OR IGNORE INTO first_party_archive_lead_revisions
      (archive_revision_id,archive_lead_id,receipt_id,content_sha256,source_locator_y_index,
       description_text,date_shared_text,prophecy_text,claimed_result_text,claimed_evidence_text,
       parser_version,fetched_at)
      SELECT json_extract(value,'$.archiveRevisionId'),json_extract(value,'$.archiveLeadId'),
        json_extract(value,'$.receiptId'),json_extract(value,'$.contentSha256'),
        json_extract(value,'$.sourceLocatorYIndex'),json_extract(value,'$.descriptionText'),
        json_extract(value,'$.dateSharedText'),json_extract(value,'$.prophecyText'),
        json_extract(value,'$.claimedResultText'),json_extract(value,'$.claimedEvidenceText'),
        json_extract(value,'$.parserVersion'),json_extract(value,'$.fetchedAt')
      FROM json_each(?1)`).bind(payloads[2]),
    db.prepare(`INSERT OR IGNORE INTO first_party_archive_revision_observations
      (archive_observation_id,archive_revision_id,receipt_id,source_locator_y_index,observed_at)
      SELECT json_extract(value,'$.observationId'),json_extract(value,'$.archiveRevisionId'),
        json_extract(value,'$.receiptId'),json_extract(value,'$.sourceLocatorYIndex'),
        json_extract(value,'$.observedAt') FROM json_each(?1)`).bind(payloads[3]),
    db.prepare(`INSERT INTO source_items
      (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,
       first_discovered_at,last_seen_at,availability)
      SELECT json_extract(value,'$.sourceItemId'),json_extract(value,'$.personId'),NULL,'youtube',
        json_extract(value,'$.platformItemId'),json_extract(value,'$.canonicalUrl'),
        json_extract(value,'$.seenAt'),json_extract(value,'$.seenAt'),'unknown'
      FROM json_each(?1) WHERE true
      ON CONFLICT(person_id,platform,platform_item_id) DO UPDATE SET
        last_seen_at=excluded.last_seen_at,availability=excluded.availability`).bind(payloads[4]),
    db.prepare(`INSERT OR IGNORE INTO first_party_archive_revision_links
      (archive_link_id,archive_revision_id,link_role,ordinal,label,url,youtube_id,source_item_id,provenance)
      SELECT json_extract(value,'$.archiveLinkId'),json_extract(value,'$.archiveRevisionId'),
        json_extract(value,'$.linkRole'),json_extract(value,'$.ordinal'),json_extract(value,'$.label'),
        json_extract(value,'$.url'),json_extract(value,'$.youtubeId'),
        json_extract(value,'$.sourceItemId'),json_extract(value,'$.provenance')
      FROM json_each(?1)`).bind(payloads[5]),
    db.prepare(`INSERT OR IGNORE INTO archive_verification_work_items
      (archive_work_item_id,archive_revision_id,archive_video_link_id,status,created_at)
      SELECT json_extract(value,'$.workItemId'),json_extract(value,'$.archiveRevisionId'),
        json_extract(value,'$.archiveLinkId'),'ready',json_extract(value,'$.createdAt')
      FROM json_each(?1)`).bind(payloads[6]),
  ]);
  if (results.length !== ARCHIVE_PERSIST_STATEMENT_COUNT || results.some((result) => result?.success === false)) {
    throw new Error("first_party_archive_batch_failed");
  }
  return { receiptId, rowCount: rows.length,
    revisionsInserted: Number(results[2]?.meta?.changes || 0),
    observationsInserted: Number(results[3]?.meta?.changes || 0),
    linksInserted: Number(results[5]?.meta?.changes || 0),
    workItemsInserted: Number(results[6]?.meta?.changes || 0),
    statementCount: results.length };
}

export async function archiveLinkedVideoSelector(db, personId, limit = 500) {
  const bounded = Number.isInteger(limit) && limit > 0 && limit <= 2_000 ? limit : 500;
  const result = await db.prepare(`SELECT archive_work_item_id,source_item_id,youtube_id,url,
      date_shared_text,status,priority
    FROM archive_linked_video_selector WHERE person_id=?1
    ORDER BY priority,date_shared_text,archive_work_item_id LIMIT ?2`)
    .bind(personId, bounded).all();
  return result.results || [];
}

export async function linkExactEmbedded(db, sourceItemIdA, sourceItemIdB, createdAt = nowIso()) {
  if (sourceItemIdA === sourceItemIdB) return null;
  const [a, b] = [sourceItemIdA, sourceItemIdB].sort();
  const linkId = await stableId("link", `${a}:${b}:embedded_video`);
  await db.prepare(`INSERT OR IGNORE INTO source_item_links
    (link_id,source_item_id_a,source_item_id_b,link_type,method,confidence,created_at)
    VALUES (?1,?2,?3,'embedded_video','exact_platform_id',1,?4)`)
    .bind(linkId, a, b, createdAt).run();
  return linkId;
}

export async function recordAvailability(db, { sourceItemId, availability, resultCode = null, runId, observedAt = nowIso() }) {
  const eventId = await stableId("avail", `${runId}:${sourceItemId}:${availability}:${resultCode || ""}`);
  await db.prepare(`INSERT OR IGNORE INTO source_availability_events
    (event_id,source_item_id,availability,result_code,run_id,observed_at) VALUES (?1,?2,?3,?4,?5,?6)`)
    .bind(eventId, sourceItemId, availability, resultCode, runId, observedAt).run();
  await db.prepare("UPDATE source_items SET availability=?2,last_seen_at=?3 WHERE source_item_id=?1")
    .bind(sourceItemId, availability, observedAt).run();
}

export async function recordTranscriptUnavailable(db, { sourceItemId, method, provider, status = "not_available", errorCode = null, attemptedAt = nowIso() }) {
  const attemptId = await stableId("txa", `${sourceItemId}:${method}:${provider}:${status}:${errorCode || ""}`);
  await db.prepare(`INSERT OR IGNORE INTO transcript_attempts
    (attempt_id,source_item_id,method,provider,status,attempted_at,public_error_code)
    VALUES (?1,?2,?3,?4,?5,?6,?7)`)
    .bind(attemptId, sourceItemId, method, provider, status, attemptedAt, errorCode).run();
  return attemptId;
}

export async function recordSourceMediaMetadata(db, { sourceItemId, durationSeconds, responseSha256,
  method = "youtube_public_html_length_seconds", observedAt = nowIso() }) {
  const metadataId = await stableId("smm", `${sourceItemId}:${durationSeconds}:${method}:${responseSha256}`);
  await db.prepare(`INSERT OR IGNORE INTO source_media_metadata
    (metadata_id,source_item_id,duration_seconds,method,response_sha256,observed_at)
    VALUES (?1,?2,?3,?4,?5,?6)`)
    .bind(metadataId, sourceItemId, durationSeconds, method, responseSha256, observedAt).run();
  const stored = await db.prepare(`SELECT 1 ok FROM source_media_metadata
    WHERE metadata_id=?1 AND source_item_id=?2 AND duration_seconds=?3 AND method=?4 AND response_sha256=?5`)
    .bind(metadataId, sourceItemId, durationSeconds, method, responseSha256).first();
  if (!stored) throw new Error("source_media_metadata_not_recorded");
  return metadataId;
}

export async function reserveGeminiMedia(db, reservation) {
  try {
    await db.prepare(`INSERT INTO gemini_media_reservations
      (reservation_id,media_day,run_id,job_id,source_item_id,chunk_index,job_attempt,
       start_seconds,end_seconds,reserved_seconds,budget_limit_seconds,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`)
      .bind(reservation.reservationId, reservation.mediaDay, reservation.runId, reservation.jobId,
        reservation.sourceItemId, reservation.chunkIndex, reservation.jobAttempt,
        reservation.startSeconds, reservation.endSeconds, reservation.endSeconds - reservation.startSeconds,
        reservation.budgetLimitSeconds, reservation.createdAt || nowIso()).run();
    return true;
  } catch (error) {
    if (/gemini media budget exhausted/i.test(error?.message || "")) return false;
    if (/UNIQUE constraint failed: gemini_media_reservations/i.test(error?.message || "")) return true;
    throw error;
  }
}

export async function recordTranscriptChunkAttempt(db, attempt) {
  await db.prepare(`INSERT OR IGNORE INTO transcript_chunk_attempts
    (chunk_attempt_id,reservation_id,run_id,job_id,source_item_id,chunk_index,start_seconds,end_seconds,
     overlap_seconds,provider,model_name,prompt_version,request_sha256,response_id,finish_reason,
     input_tokens,output_tokens,r2_key,content_sha256,byte_count,status,error_code,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'google_gemini',?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`)
    .bind(attempt.chunkAttemptId, attempt.reservationId, attempt.runId, attempt.jobId,
      attempt.sourceItemId, attempt.chunkIndex, attempt.startSeconds, attempt.endSeconds,
      attempt.overlapSeconds, attempt.modelName, attempt.promptVersion, attempt.requestSha256,
      attempt.responseId || null, attempt.finishReason || null, attempt.inputTokens,
      attempt.outputTokens, attempt.r2Key || null, attempt.contentSha256 || null,
      attempt.byteCount ?? null, attempt.status, attempt.errorCode || null, attempt.createdAt || nowIso()).run();
}

export async function completedTranscriptChunks(db, runId, sourceItemId) {
  const rows = await db.prepare(`SELECT attempt.* FROM transcript_chunk_attempts attempt
    WHERE attempt.run_id=?1 AND attempt.source_item_id=?2 AND attempt.status='completed'
      AND NOT EXISTS (SELECT 1 FROM transcript_chunk_attempts newer
        WHERE newer.run_id=attempt.run_id AND newer.source_item_id=attempt.source_item_id
          AND newer.chunk_index=attempt.chunk_index AND newer.status='completed'
          AND (newer.created_at>attempt.created_at OR
            (newer.created_at=attempt.created_at AND newer.chunk_attempt_id>attempt.chunk_attempt_id)))
    ORDER BY attempt.chunk_index`).bind(runId, sourceItemId).all();
  return rows.results || [];
}

export async function recordScanReceipt(db, receipt) {
  const receiptId = await stableId("scan", `${receipt.runId}:${receipt.sourceName}`);
  await db.prepare(`INSERT OR IGNORE INTO source_scan_receipts
    (receipt_id,run_id,person_id,source_name,status,item_count,last_page_or_cursor,public_explanation,observed_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .bind(receiptId, receipt.runId, receipt.personId, receipt.sourceName, receipt.status,
      receipt.itemCount || 0, receipt.lastPageOrCursor || null, receipt.publicExplanation, receipt.observedAt || nowIso()).run();
  return receiptId;
}

function videoAttemptStatement(db, attempt) {
  return db.prepare(`INSERT OR IGNORE INTO video_analysis_attempts
    (attempt_id,run_id,job_id,source_item_id,stage,parent_attempt_id,supersedes_attempt_id,
     provider,model_name,prompt_version,prompt_text,video_url,request_sha256,interaction_id,
     transport,gateway_id,gateway_log_id,http_status,raw_output_json,structured_output_json,status,error_code,started_at,completed_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'google_gemini',?8,?9,?10,?11,?12,?13,
      'cloudflare_ai_gateway',?14,?15,?16,?17,?18,?19,?20,?21,?22)`)
    .bind(attempt.attemptId, attempt.runId, attempt.jobId, attempt.sourceItemId, attempt.stage,
      attempt.parentAttemptId || null, attempt.supersedesAttemptId || null, attempt.modelName,
      attempt.promptVersion, attempt.promptText, attempt.videoUrl, attempt.requestSha256,
      attempt.interactionId || null, attempt.gatewayId, attempt.gatewayLogId || null, attempt.httpStatus || null,
      attempt.rawOutput === null ? null : JSON.stringify(attempt.rawOutput),
      attempt.structuredOutput === null ? null : JSON.stringify(attempt.structuredOutput),
      attempt.status, attempt.errorCode || null, attempt.startedAt, attempt.completedAt);
}

export async function recordVideoAnalysisFailure(db, attempt) {
  await videoAttemptStatement(db, attempt).run();
  return attempt.attemptId;
}

export async function recordVideoAnalysisSuccess(db, { attempt, candidates = [], checks = [], agreements = [], escalations = [] }) {
  const statements = [videoAttemptStatement(db, attempt)];
  for (const candidate of candidates) statements.push(db.prepare(`INSERT OR IGNORE INTO video_claim_candidates
    (candidate_id,source_item_id,primary_attempt_id,supersedes_candidate_id,ordinal,exact_quote,
     start_seconds,end_seconds,statement_type,atomic_proposition,explicit_deadline_text,context_before,
     context_after,confidence,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`)
    .bind(candidate.candidateId, candidate.sourceItemId, candidate.primaryAttemptId,
      candidate.supersedesCandidateId || null, candidate.ordinal, candidate.quote,
      candidate.startSeconds, candidate.endSeconds, candidate.statementType,
      candidate.atomicProposition, candidate.deadlineText || null, candidate.contextBefore,
      candidate.contextAfter, candidate.confidence, candidate.createdAt));
  for (const check of checks) statements.push(db.prepare(`INSERT OR IGNORE INTO video_cross_checks
    (check_id,candidate_id,analysis_attempt_id,supersedes_check_id,check_role,exact_quote,
     start_seconds,end_seconds,statement_type,atomic_proposition,explicit_deadline_text,context_before,
     context_after,confidence,supports,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`)
    .bind(check.checkId, check.candidateId, check.analysisAttemptId, check.supersedesCheckId || null,
      check.checkRole, check.quote, check.startSeconds, check.endSeconds, check.statementType,
      check.atomicProposition, check.deadlineText || null, check.contextBefore, check.contextAfter,
      check.confidence, check.supports || null, check.createdAt));
  for (const agreement of agreements) statements.push(db.prepare(`INSERT OR IGNORE INTO video_agreement_results
    (agreement_id,candidate_id,compared_check_id,supersedes_agreement_id,comparison_basis,
     quote_similarity,timestamp_overlap,deadline_agreement,statement_type_agreement,meaning_similarity,
     agrees,outcome,disagreement_reasons_json,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`)
    .bind(agreement.agreementId, agreement.candidateId, agreement.comparedCheckId,
      agreement.supersedesAgreementId || null, agreement.comparisonBasis, agreement.quoteSimilarity,
      agreement.timestampOverlap, agreement.deadlineAgreement ? 1 : 0,
      agreement.statementTypeAgreement ? 1 : 0, agreement.meaningSimilarity,
      agreement.agrees ? 1 : 0, agreement.outcome, JSON.stringify(agreement.reasons), agreement.createdAt));
  for (const escalation of escalations) statements.push(db.prepare(`INSERT OR IGNORE INTO video_escalation_events
    (event_id,candidate_id,agreement_id,prior_event_id,state,reason,actor_principal,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`)
    .bind(escalation.eventId, escalation.candidateId, escalation.agreementId,
      escalation.priorEventId || null, escalation.state, escalation.reason,
      escalation.actorPrincipal || null, escalation.createdAt));
  await db.batch(statements);
  return attempt.attemptId;
}

export async function latestCompletedVideoAttempt(db, jobId) {
  return db.prepare(`SELECT * FROM video_analysis_attempts
    WHERE job_id=?1 AND status='completed' ORDER BY completed_at DESC,attempt_id DESC LIMIT 1`)
    .bind(jobId).first();
}

export async function videoAttempt(db, attemptId, sourceItemId) {
  return db.prepare(`SELECT * FROM video_analysis_attempts
    WHERE attempt_id=?1 AND source_item_id=?2 AND status='completed'`).bind(attemptId, sourceItemId).first();
}

export async function primaryVideoCandidates(db, attemptId) {
  const rows = await db.prepare(`SELECT * FROM video_claim_candidates
    WHERE primary_attempt_id=?1 ORDER BY ordinal,candidate_id`).bind(attemptId).all();
  return rows.results || [];
}

export async function videoChecks(db, attemptId, candidateIds = []) {
  const rows = await db.prepare(`SELECT * FROM video_cross_checks
    WHERE analysis_attempt_id=?1 ORDER BY candidate_id`).bind(attemptId).all();
  const checks = rows.results || [];
  return candidateIds.length ? checks.filter((row) => candidateIds.includes(row.candidate_id)) : checks;
}

export async function disputedVideoCandidateIds(db, verifierAttemptId) {
  const rows = await db.prepare(`SELECT agreement.candidate_id FROM video_agreement_results agreement
    JOIN video_cross_checks check_row ON check_row.check_id=agreement.compared_check_id
    WHERE check_row.analysis_attempt_id=?1 AND agreement.outcome='tiebreaker_required'
    ORDER BY agreement.candidate_id`).bind(verifierAttemptId).all();
  return (rows.results || []).map((row) => row.candidate_id);
}

async function transcriptRunReceipt(db, runId) {
  const reservation = await db.prepare(`SELECT COUNT(*) reservations,COALESCE(SUM(reserved_seconds),0) reserved_seconds
    FROM gemini_media_reservations WHERE run_id=?1`).bind(runId).first();
  const chunks = await db.prepare(`SELECT
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
      COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens
    FROM transcript_chunk_attempts WHERE run_id=?1`).bind(runId).first();
  const stitch = await db.prepare(`SELECT receipt.transcript_id,receipt.duration_seconds,receipt.chunk_count,
      receipt.cue_count,receipt.input_manifest_sha256,receipt.stitch_algorithm,
      artifact.content_sha256,artifact.byte_count,artifact.created_at
    FROM transcript_stitch_receipts receipt JOIN transcript_artifacts artifact ON artifact.transcript_id=receipt.transcript_id
    WHERE receipt.run_id=?1 ORDER BY receipt.created_at DESC,receipt.stitch_id DESC LIMIT 1`).bind(runId).first();
  let extractionRuns = 0; let candidates = 0;
  if (stitch) {
    const extraction = await db.prepare(`SELECT COUNT(DISTINCT run.extraction_run_id) extraction_runs,
        COUNT(candidate.candidate_id) candidates
      FROM extraction_runs run LEFT JOIN claim_candidates candidate ON candidate.extraction_run_id=run.extraction_run_id
      WHERE run.transcript_id=?1 AND run.input_kind='verified_transcript'`).bind(stitch.transcript_id).first();
    extractionRuns = Number(extraction?.extraction_runs || 0); candidates = Number(extraction?.candidates || 0);
  }
  return { reservations: Number(reservation?.reservations || 0), reservedSeconds: Number(reservation?.reserved_seconds || 0),
    completedChunks: Number(chunks?.completed || 0), failedChunks: Number(chunks?.failed || 0),
    inputTokens: Number(chunks?.input_tokens || 0), outputTokens: Number(chunks?.output_tokens || 0),
    artifact: stitch ? { transcriptId: stitch.transcript_id, durationSeconds: stitch.duration_seconds,
      chunkCount: stitch.chunk_count, cueCount: stitch.cue_count, manifestSha256: stitch.input_manifest_sha256,
      contentSha256: stitch.content_sha256, byteCount: stitch.byte_count, stitchAlgorithm: stitch.stitch_algorithm,
      createdAt: stitch.created_at } : null, extractionRuns, candidates };
}

export async function runStatus(db, runId) {
  let run = await db.prepare("SELECT * FROM ingestion_runs WHERE run_id=?1").bind(runId).first();
  if (!run) return null;
  if (["queued", "running"].includes(run.status)) {
    await reconcileRun(db, runId);
    run = await db.prepare("SELECT * FROM ingestion_runs WHERE run_id=?1").bind(runId).first();
  }
  const counts = await db.prepare("SELECT status,count(*) count FROM ingestion_jobs WHERE run_id=?1 GROUP BY status").bind(runId).all();
  return { ...run, jobCounts: Object.fromEntries((counts.results || []).map((row) => [row.status, row.count])),
    ...(run.scope.startsWith("transcript:") ? { transcript: await transcriptRunReceipt(db, runId) } : {}) };
}

export async function reconcileRun(db, runId, at = nowIso()) {
  const rows = (await db.prepare("SELECT status,count(*) count FROM ingestion_jobs WHERE run_id=?1 GROUP BY status").bind(runId).all()).results || [];
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  const outstanding = (counts.queued || 0) + (counts.processing || 0);
  if (outstanding) return { complete: false, counts };
  const status = (counts.failed || 0) ? "complete_with_errors" : "complete";
  await db.prepare("UPDATE ingestion_runs SET status=?2,completed_at=?3,error_count=?4 WHERE run_id=?1")
    .bind(runId, status, at, counts.failed || 0).run();
  return { complete: true, status, counts };
}
