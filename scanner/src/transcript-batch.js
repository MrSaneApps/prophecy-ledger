import { GEMINI_FREE_TIER_MEDIA_SECONDS_MAX, geminiDailyMediaSeconds } from "./gemini-free-tier.js";
import { sha256, stableId } from "./hash.js";
import { nowIso, recordSourceMediaMetadata, registerJob } from "./repository.js";
import {
  fetchYouTubeDataApiDuration, fetchYouTubeDuration, TRANSCRIPT_PLAN_VERSION,
} from "./transcript.js";
import { repairLegacyStitchedTranscriptBatchItemImpl } from "./transcript-batch-legacy-repair.js";

const PERSON_ID = "person_troy_black";
const BATCH_ID = /^txb_[a-f0-9]{32}$/;
const BATCH_ITEM_ID = /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SOURCE_UNAVAILABLE_REASON = "source_unavailable";
const SOURCE_UNAVAILABLE_ERROR = "youtube_data_api_video_not_found";

function changed(result) {
  return Boolean(result?.meta?.changes);
}
async function currentPhysicalMedia(env, at) {
  const mediaDay = new Date(at).toISOString().slice(0, 10);
  const limitSeconds = geminiDailyMediaSeconds(env);
  const tables = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('gemini_physical_request_reservations','gemini_physical_day_debits')`).all();
  const available = new Set((tables.results || []).map((row) => row.name)).size === 2;
  const usage = available ? await env.DB.prepare(`SELECT (SELECT COALESCE(SUM(reserved_seconds),0) FROM
    gemini_physical_request_reservations WHERE media_day=?1) request_seconds,(SELECT COALESCE(SUM(CASE
      WHEN reason='legacy_cutover_fail_closed' AND reserved_seconds>=86400 AND ?2<=?3 THEN 0 ELSE reserved_seconds END),0)
    FROM gemini_physical_day_debits WHERE media_day=?1) debit_seconds`)
    .bind(mediaDay, limitSeconds, GEMINI_FREE_TIER_MEDIA_SECONDS_MAX).first() : null;
  const mediaSeconds = Number(usage?.request_seconds || 0) + Number(usage?.debit_seconds || 0);
  return { mediaDay, mediaSeconds, mediaLimitSeconds: limitSeconds, exhausted: available && mediaSeconds >= limitSeconds, available };
}
export function nextTranscriptBatchDay(at = nowIso()) {
  const next = new Date(at);
  next.setUTCHours(24, 0, 5, 0);
  return next.toISOString();
}

function transcriptEnvelope(item, payload = null) {
  if (payload) return {
    version: 1, jobId: payload.jobId, runId: payload.runId, personId: payload.personId,
    type: payload.type, stableKey: payload.stableKey, payload: payload.payload,
  };
  const stableKey = `youtube:${item.youtube_id}:transcript:${TRANSCRIPT_PLAN_VERSION}:chunk:0`;
  return {
    version: 1,
    jobId: item.first_job_id,
    runId: item.run_id,
    personId: PERSON_ID,
    type: "transcript_extract",
    stableKey,
    payload: {
      phase: "chunk", planVersion: TRANSCRIPT_PLAN_VERSION, chunkIndex: 0, youtubeId: item.youtube_id,
      sourceItemId: item.source_item_id, durationSeconds: Number(item.duration_seconds),
      batchId: item.batch_id, batchItemId: item.batch_item_id,
    },
  };
}

async function firstTranscriptEnvelope(item) {
  if (item.first_job_id) return transcriptEnvelope(item);
  const stableKey = `youtube:${item.youtube_id}:transcript:${TRANSCRIPT_PLAN_VERSION}:chunk:0`;
  const firstJobId = await stableId("job", `${item.run_id}:transcript_extract:${stableKey}`);
  return transcriptEnvelope({ ...item, first_job_id: firstJobId });
}

async function storedResumableEnvelope(db, item) {
  const row = await db.prepare(`SELECT job.job_id,job.run_id,job.job_type,job.stable_key,job.payload_json,run.person_id
    FROM ingestion_jobs job JOIN ingestion_runs run ON run.run_id=job.run_id
    WHERE job.run_id=?1 AND job.status IN ('queued','failed')
    ORDER BY CASE job.status WHEN 'queued' THEN 0 ELSE 1 END,job.claimed_at,job.job_id LIMIT 1`).bind(item.run_id).first();
  if (!row) return null;
  return transcriptEnvelope(item, { jobId: row.job_id, runId: row.run_id, personId: row.person_id,
    type: row.job_type, stableKey: row.stable_key, payload: JSON.parse(row.payload_json) });
}

async function batchRowByKey(db, idempotencyKey) {
  return db.prepare("SELECT * FROM transcript_batches WHERE idempotency_key=?1")
    .bind(idempotencyKey).first();
}

async function batchRow(db, batchId) {
  return db.prepare("SELECT * FROM transcript_batches WHERE batch_id=?1").bind(batchId).first();
}

async function activeItem(db, batchId) {
  return db.prepare(`SELECT item.*,job.job_id first_job_id FROM transcript_batch_items item
    LEFT JOIN ingestion_jobs job ON job.run_id=item.run_id AND job.job_type='transcript_extract'
      AND json_extract(job.payload_json,'$.phase')='chunk' AND json_extract(job.payload_json,'$.chunkIndex')=0
    WHERE item.batch_id=?1 AND item.status='active' ORDER BY job.job_id LIMIT 1`).bind(batchId).first();
}

async function dispositionProjectionAvailable(db) {
  const projection = await db.prepare(`SELECT 1 ok FROM sqlite_master
    WHERE type='view' AND name='effective_transcript_batch_item_dispositions'`).first();
  return projection?.ok === 1;
}

async function statusCounts(db, batchId) {
  let rows;
  try {
    rows = await db.prepare(`SELECT effective_status AS status,COUNT(*) count FROM (
      SELECT CASE WHEN item.status='pending' AND disposition.batch_item_id IS NOT NULL
        THEN 'quarantined' ELSE item.status END AS effective_status
      FROM transcript_batch_items item
      LEFT JOIN effective_transcript_batch_item_dispositions disposition
        ON disposition.batch_item_id=item.batch_item_id
      WHERE item.batch_id=?1
    ) effective_items GROUP BY effective_status`).bind(batchId).all();
  } catch (error) {
    if (!/no such table:\s*effective_transcript_batch_item_dispositions/i.test(String(error?.message || error))) throw error;
    rows = await db.prepare(`SELECT status,COUNT(*) count FROM transcript_batch_items
      WHERE batch_id=?1 GROUP BY status`).bind(batchId).all();
  }
  const counts = { completed: 0, active: 0, pending: 0, quarantined: 0, skipped: 0 };
  for (const row of rows.results || []) counts[row.status] = Number(row.count);
  return counts;
}

export async function transcriptBatchStatus(env, batchId) {
  if (!BATCH_ID.test(batchId || "")) return null;
  const batch = await batchRow(env.DB, batchId);
  if (!batch) return null;
  const counts = await statusCounts(env.DB, batchId);
  const active = await activeItem(env.DB, batchId);
  return {
    batchId: batch.batch_id, status: batch.status, itemCount: Number(batch.item_count),
    completedItemCount: Number(batch.completed_item_count), counts,
    pendingItemCount: counts.pending, quarantinedItemCount: counts.quarantined,
    skippedItemCount: counts.skipped, transitionCount: Number(batch.transition_count || 0),
    pauseReason: batch.pause_reason, resumeAfter: batch.resume_after,
    createdAt: batch.created_at, startedAt: batch.started_at, pausedAt: batch.paused_at,
    completedAt: batch.completed_at,
    activeItem: active ? { batchItemId: active.batch_item_id, sourceItemId: active.source_item_id,
      youtubeId: active.youtube_id, ordinal: Number(active.ordinal), runId: active.run_id,
      durationSeconds: Number(active.duration_seconds) } : null,
  };
}

export async function pauseTranscriptBatch(env, { batchId, batchItemId = null, reason,
  at = nowIso(), resumeAfter = nextTranscriptBatchDay(at), jobId = null, httpStatus = null } = {}) {
  if (!BATCH_ID.test(batchId || "") || (batchItemId && !BATCH_ITEM_ID.test(batchItemId)) || !reason) return null;
  const before = await batchRow(env.DB, batchId);
  if (!before || before.status !== "running") return transcriptBatchStatus(env, batchId);
  const transition = Number(before.transition_count) + 1;
  const eventId = await stableId("txbe", `${batchId}:transition:${transition}:paused`);
  const detail = { action: "transcript_batch_paused", reason, mediaDay: at.slice(0, 10) };
  if (jobId) detail.jobId = jobId;
  if (httpStatus) detail.httpStatus = httpStatus;
  await env.DB.batch([
    env.DB.prepare(`UPDATE transcript_batches SET status='paused',pause_reason=?2,resume_after=?3,paused_at=?4,
        transition_count=?5
      WHERE batch_id=?1 AND status='running' AND transition_count=?6`)
      .bind(batchId, reason, resumeAfter, at, transition, Number(before.transition_count)),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
      (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
      SELECT ?1,?2,?3,'batch_paused',?4,?5
      WHERE EXISTS (SELECT 1 FROM transcript_batches
        WHERE batch_id=?2 AND status='paused' AND transition_count=?6)`)
      .bind(eventId, batchId, batchItemId, JSON.stringify(detail), at, transition),
  ]);
  return transcriptBatchStatus(env, batchId);
}

async function resolveDuration(env, item, durationFetcher) {
  const hasYouTubeDataApi = typeof env.YOUTUBE_DATA_API_KEY === "string" && env.YOUTUBE_DATA_API_KEY.length > 0;
  const method = hasYouTubeDataApi
    ? "youtube_data_api_v3_content_details" : "youtube_public_html_length_seconds";
  const prior = await env.DB.prepare(`SELECT duration_seconds FROM source_media_metadata
    WHERE source_item_id=?1 AND (?2=0 OR method='youtube_data_api_v3_content_details')
    ORDER BY observed_at DESC,metadata_id DESC LIMIT 1`)
    .bind(item.source_item_id, hasYouTubeDataApi ? 1 : 0).first();
  if (prior) return Number(prior.duration_seconds);
  const observed = hasYouTubeDataApi
    ? await fetchYouTubeDataApiDuration({ youtubeId: item.youtube_id,
      apiKey: env.YOUTUBE_DATA_API_KEY, fetcher: durationFetcher })
    : await fetchYouTubeDuration({ youtubeId: item.youtube_id, fetcher: durationFetcher });
  await recordSourceMediaMetadata(env.DB, { sourceItemId: item.source_item_id,
    durationSeconds: observed.durationSeconds, responseSha256: observed.responseSha256, method });
  return observed.durationSeconds;
}

async function finishBatchIfEmpty(env, batchId, at) {
  const eventId = await stableId("txbe", `${batchId}:completed`);
  const hasDispositions = await dispositionProjectionAvailable(env.DB);
  const unfinished = hasDispositions ? `NOT EXISTS (SELECT 1 FROM transcript_batch_items item
          LEFT JOIN effective_transcript_batch_item_dispositions disposition
            ON disposition.batch_item_id=item.batch_item_id
          WHERE item.batch_id=?1 AND (item.status='active'
            OR (item.status='pending' AND disposition.batch_item_id IS NULL)))`
    : `NOT EXISTS (SELECT 1 FROM transcript_batch_items
          WHERE batch_id=?1 AND status IN ('pending','active'))`;
  const [result] = await env.DB.batch([
    env.DB.prepare(`UPDATE transcript_batches SET status='completed',completed_at=?2,
        completed_item_count=(SELECT COUNT(*) FROM transcript_batch_items
          WHERE batch_id=?1 AND status='completed'),pause_reason=NULL,resume_after=NULL
      WHERE batch_id=?1 AND status='running' AND ${unfinished}`).bind(batchId, at),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
      (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
      SELECT ?1,?2,NULL,'batch_completed','{}',?3
      WHERE EXISTS (SELECT 1 FROM transcript_batches WHERE batch_id=?2 AND status='completed')`)
      .bind(eventId, batchId, at),
  ]);
  return changed(result);
}

async function archiveSelectorAvailable(db) {
  const selector = await db.prepare(`SELECT 1 ok FROM sqlite_master
    WHERE type='view' AND name='archive_linked_video_selector'`).first();
  return selector?.ok === 1;
}

async function nextPendingItem(env, batch, excludedBatchItemId = null) {
  const hasDispositions = await dispositionProjectionAvailable(env.DB);
  const dispositionClause = hasDispositions ? `AND NOT EXISTS (
      SELECT 1 FROM effective_transcript_batch_item_dispositions disposition
      WHERE disposition.batch_item_id=item.batch_item_id)` : "";
  if (!(await archiveSelectorAvailable(env.DB))) {
    return env.DB.prepare(`SELECT item.* FROM transcript_batch_items item
      WHERE item.batch_id=?1 AND item.status='pending'
        AND (?2 IS NULL OR item.batch_item_id<>?2) ${dispositionClause}
      ORDER BY item.ordinal,item.batch_item_id LIMIT 1`)
      .bind(batch.batch_id, excludedBatchItemId).first();
  }
  return env.DB.prepare(`SELECT item.* FROM transcript_batch_items item
    WHERE item.batch_id=?1 AND item.status='pending'
      AND (?3 IS NULL OR item.batch_item_id<>?3) ${dispositionClause}
    ORDER BY CASE WHEN EXISTS (
      SELECT 1 FROM archive_linked_video_selector archive
      WHERE archive.person_id=?2 AND archive.source_item_id=item.source_item_id
    ) THEN 0 ELSE 1 END,item.ordinal,item.batch_item_id LIMIT 1`)
    .bind(batch.batch_id, batch.person_id, excludedBatchItemId).first();
}

async function activateNextItem(env, batchId, { at = nowIso(), durationFetcher = fetch } = {}) {
  const batch = await batchRow(env.DB, batchId);
  if (!batch || batch.status !== "running") return { envelope: null, reason: "batch_not_running" };
  if (await activeItem(env.DB, batchId)) return { envelope: null, reason: "item_already_active" };
  const item = await nextPendingItem(env, batch);
  if (!item) {
    await finishBatchIfEmpty(env, batchId, at);
    return { envelope: null, reason: "batch_complete" };
  }
  let durationSeconds;
  try { durationSeconds = await resolveDuration(env, item, durationFetcher); }
  catch (error) {
    await pauseTranscriptBatch(env, { batchId, batchItemId: item.batch_item_id,
      reason: error?.message || "duration_lookup_failed", at, resumeAfter: at });
    return { envelope: null, reason: error?.message || "duration_lookup_failed" };
  }
  // Include activation time so a requeued item cannot collide with a prior failed run/job
  // (prod bug: 5n8QpgQXXaU requeue reused runtxb_019c… and the old failed chunk:0 job forever).
  const runId = await stableId("runtxb",
    `${batchId}:${item.batch_item_id}:${durationSeconds}:${TRANSCRIPT_PLAN_VERSION}:${at}`);
  const stableKey = `youtube:${item.youtube_id}:transcript:${TRANSCRIPT_PLAN_VERSION}:chunk:0`;
  const jobId = await stableId("job", `${runId}:transcript_extract:${stableKey}`);
  const eventId = await stableId("txbe", `${batchId}:${item.batch_item_id}:started`);
  const activated = { ...item, batch_id: batchId, run_id: runId,
    duration_seconds: durationSeconds, first_job_id: jobId };
  const envelope = transcriptEnvelope(activated);
  const [, activation] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO ingestion_runs
      (run_id,person_id,trigger_type,scope,status,created_at)
      VALUES (?1,?2,'manual',?3,'queued',?4)`)
      .bind(runId, PERSON_ID,
        `transcript:${item.source_item_id}:${durationSeconds}:plan:${TRANSCRIPT_PLAN_VERSION}:batch:${batchId}`, at),
    env.DB.prepare(`UPDATE transcript_batch_items SET status='active',run_id=?3,duration_seconds=?4,started_at=?5
      WHERE batch_id=?1 AND batch_item_id=?2 AND status='pending'
        AND NOT EXISTS (SELECT 1 FROM transcript_batch_items WHERE status='active')`)
      .bind(batchId, item.batch_item_id, runId, durationSeconds, at),
    env.DB.prepare(`INSERT OR IGNORE INTO ingestion_jobs
      (job_id,run_id,job_type,stable_key,payload_json,status,claimed_at)
      SELECT ?1,?2,'transcript_extract',?3,?4,'queued',NULL
      WHERE EXISTS (SELECT 1 FROM transcript_batch_items
        WHERE batch_item_id=?5 AND status='active' AND run_id=?2)`)
      .bind(jobId, runId, stableKey, JSON.stringify(envelope.payload), item.batch_item_id),
    env.DB.prepare("UPDATE transcript_batches SET started_at=COALESCE(started_at,?2) WHERE batch_id=?1 AND status='running'")
      .bind(batchId, at),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
      (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
      SELECT ?1,?2,?3,'item_started',?4,?5
      WHERE EXISTS (SELECT 1 FROM transcript_batch_items WHERE batch_item_id=?3 AND status='active' AND run_id=?6)`)
      .bind(eventId, batchId, item.batch_item_id,
        JSON.stringify({ ordinal: Number(item.ordinal), sourceItemId: item.source_item_id }), at, runId),
  ]);
  if (!changed(activation)) return { envelope: null, reason: "activation_lost" };
  return { envelope, reason: null };
}

export async function syncArchiveLinkedTranscriptBatch(env, { batchId, at = nowIso() } = {}) {
  if (!BATCH_ID.test(batchId || "")) return { synced: false, reason: "invalid_batch_id" };
  const batch = await batchRow(env.DB, batchId);
  if (!batch) return { synced: false, reason: "batch_not_found" };
  if (!["running", "paused"].includes(batch.status)) return { synced: false, reason: "batch_not_open" };
  if (!(await archiveSelectorAvailable(env.DB))) return { synced: false, reason: "archive_selector_unavailable" };
  const selected = await env.DB.prepare(`SELECT source.source_item_id,source.platform_item_id youtube_id
    FROM archive_linked_video_selector archive
    JOIN source_items source ON source.source_item_id=archive.source_item_id
    WHERE archive.person_id=?1 AND source.person_id=?1 AND source.platform='youtube'
      AND source.canonical_url='https://www.youtube.com/watch?v=' || source.platform_item_id
      AND NOT EXISTS (SELECT 1 FROM transcript_batch_items item
        WHERE item.batch_id=?2 AND item.source_item_id=source.source_item_id)
      AND NOT EXISTS (SELECT 1 FROM transcript_artifacts artifact
        WHERE artifact.source_item_id=source.source_item_id)
    GROUP BY source.source_item_id,source.platform_item_id
    ORDER BY source.source_item_id`).bind(batch.person_id, batchId).all();
  const missing = selected.results || [];
  if (!missing.length) {
    const status = await transcriptBatchStatus(env, batchId);
    return { synced: true, reused: true, appendedItemCount: 0,
      batchId, itemCount: status.itemCount };
  }
  const maximum = await env.DB.prepare(`SELECT COALESCE(MAX(ordinal),0) maximum
    FROM transcript_batch_items WHERE batch_id=?1`).bind(batchId).first();
  const firstOrdinal = Number(maximum?.maximum || 0) + 1;
  const selectorSha256 = await sha256(missing.map((row) => [row.source_item_id, row.youtube_id]));
  const repairEventId = await stableId("txbrep", `${batchId}:archive_items_appended:${selectorSha256}`);
  const appendedRows = missing.map((row, index) => ({
    batchItemId: `txbi_${batchId.slice(4)}_${row.source_item_id.slice(4)}`,
    sourceItemId: row.source_item_id, youtubeId: row.youtube_id,
    ordinal: firstOrdinal + index,
  }));
  const statements = [env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_items
      (batch_item_id,batch_id,source_item_id,youtube_id,source_publication_date,ordinal,status)
    SELECT json_extract(value,'$.batchItemId'),?1,json_extract(value,'$.sourceItemId'),
      json_extract(value,'$.youtubeId'),NULL,json_extract(value,'$.ordinal'),'pending'
    FROM json_each(?2)`).bind(batchId, JSON.stringify(appendedRows))];
  statements.push(env.DB.prepare(`UPDATE transcript_batches SET item_count=(
    SELECT COUNT(*) FROM transcript_batch_items WHERE batch_id=?1)
    WHERE batch_id=?1 AND status IN ('running','paused')`).bind(batchId));
  statements.push(env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_repair_events
    (repair_event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
    SELECT ?1,?2,NULL,'archive_items_appended',?3,?4
    WHERE EXISTS (SELECT 1 FROM transcript_batches WHERE batch_id=?2 AND status IN ('running','paused'))`)
    .bind(repairEventId, batchId, JSON.stringify({ selectorSha256,
      selectedItemCount: missing.length, firstOrdinal, lastOrdinal: firstOrdinal + missing.length - 1 }), at));
  await env.DB.batch(statements);
  const status = await transcriptBatchStatus(env, batchId);
  const appendedItemCount = status.itemCount - Number(batch.item_count);
  return { synced: true, reused: appendedItemCount === 0, appendedItemCount,
    batchId, itemCount: status.itemCount };
}

export async function repairLegacyStitchedTranscriptBatchItem(env, options = {}) {
  return repairLegacyStitchedTranscriptBatchItemImpl(env, options, {
    batchRow, changed, completeTranscriptBatchItem, dispatchTranscriptBatchEnvelope,
    transcriptBatchStatus,
  });
}
export async function dispatchTranscriptBatchEnvelope(env, batchId, batchItemId, envelope, at = nowIso()) {
  const stale = new Date(Date.parse(at) - 300_000).toISOString();
  const claimed = await env.DB.prepare(`UPDATE transcript_batch_items
    SET dispatch_state='dispatching',dispatch_claimed_at=?3
    WHERE batch_id=?1 AND batch_item_id=?2 AND status='active'
      AND (dispatch_state='pending' OR (dispatch_state='dispatching' AND dispatch_claimed_at<?4))`)
    .bind(batchId, batchItemId, at, stale).run();
  if (!changed(claimed)) {
    const state = await env.DB.prepare("SELECT dispatch_state FROM transcript_batch_items WHERE batch_id=?1 AND batch_item_id=?2")
      .bind(batchId, batchItemId).first();
    return state?.dispatch_state === "sent";
  }
  await registerJob(env.DB, envelope, at);
  try {
    await env.INGESTION_QUEUE.send(envelope);
    await env.DB.prepare(`UPDATE transcript_batch_items SET dispatch_state='sent',dispatch_claimed_at=NULL,
      first_job_dispatched_at=COALESCE(first_job_dispatched_at,?3),last_job_dispatched_at=?3
      WHERE batch_id=?1 AND batch_item_id=?2 AND dispatch_state='dispatching'`)
      .bind(batchId, batchItemId, at).run();
    return true;
  } catch {
    await env.DB.prepare(`UPDATE transcript_batch_items SET dispatch_state='pending',dispatch_claimed_at=NULL
      WHERE batch_id=?1 AND batch_item_id=?2 AND dispatch_state='dispatching'`).bind(batchId, batchItemId).run();
    await pauseTranscriptBatch(env, { batchId, batchItemId, reason: "queue_dispatch_failed",
      at, resumeAfter: at, jobId: envelope.jobId });
    return false;
  }
}

export async function dispatchTranscriptBatchSuccessor(env, envelope, at = nowIso()) {
  await env.INGESTION_QUEUE.send(envelope);
  await env.DB.prepare(`UPDATE transcript_batch_items SET last_job_dispatched_at=?3
    WHERE batch_id=?1 AND batch_item_id=?2 AND status='active' AND run_id=?4`)
    .bind(envelope.payload.batchId, envelope.payload.batchItemId, at, envelope.runId).run();
}

async function staleRepairEnvelope(env, item, at) {
  const processingBefore = new Date(Date.parse(at) - 900_000).toISOString();
  const dispatchBefore = new Date(Date.parse(at) - 300_000).toISOString();
  const expired = await env.DB.prepare(`SELECT job_id FROM ingestion_jobs
    WHERE run_id=?1 AND status='processing' AND claimed_at<?2 ORDER BY claimed_at,job_id LIMIT 1`)
    .bind(item.run_id, processingBefore).first();
  if (expired) await env.DB.prepare(`UPDATE ingestion_jobs SET status='queued',claimed_at=NULL,lease_token=NULL,
      error_code='stale_lease_recovery_pending' WHERE job_id=?1 AND status='processing' AND claimed_at<?2`)
    .bind(expired.job_id, processingBefore).run();
  const queued = await env.DB.prepare(`SELECT 1 ok FROM ingestion_jobs WHERE run_id=?1 AND status='queued' LIMIT 1`)
    .bind(item.run_id).first();
  if (!queued || !item.last_job_dispatched_at || item.last_job_dispatched_at >= dispatchBefore) return null;
  return storedResumableEnvelope(env.DB, item);
}

export async function repairTranscriptBatch(env, batchId, { at = nowIso(), durationFetcher = fetch } = {}) {
  const batch = await batchRow(env.DB, batchId);
  if (!batch || batch.status !== "running") return { repaired: false, reason: "batch_not_running" };
  let active = await activeItem(env.DB, batchId);
  if (!active) {
    const prepared = await activateNextItem(env, batchId, { at, durationFetcher });
    if (!prepared.envelope) {
      const status = await transcriptBatchStatus(env, batchId);
      return { repaired: status?.status === "completed", reason: status?.pauseReason || prepared.reason, ...status };
    }
    active = await activeItem(env.DB, batchId);
  }
  if (active.dispatch_state === "sent") {
    const failed = await env.DB.prepare(`SELECT job_id FROM ingestion_jobs
      WHERE run_id=?1 AND status='failed' ORDER BY completed_at,job_id LIMIT 1`).bind(active.run_id).first();
    if (failed) {
      await pauseTranscriptBatch(env, { batchId, batchItemId: active.batch_item_id,
        reason: "transcript_terminal_error", at, resumeAfter: nextTranscriptBatchDay(at), jobId: failed.job_id });
      return { repaired: false, reason: "transcript_terminal_error", ...(await transcriptBatchStatus(env, batchId)) };
    }
    const repairable = await staleRepairEnvelope(env, active, at);
    if (!repairable) return { repaired: false, reason: "item_already_dispatched", ...(await transcriptBatchStatus(env, batchId)) };
    await dispatchTranscriptBatchSuccessor(env, repairable, at);
    return { repaired: true, reason: null, ...(await transcriptBatchStatus(env, batchId)) };
  }
  const envelope = await storedResumableEnvelope(env.DB, active) || await firstTranscriptEnvelope(active);
  const sent = await dispatchTranscriptBatchEnvelope(env, batchId, active.batch_item_id, envelope, at);
  return { repaired: sent, reason: sent ? null : "dispatch_not_claimed", ...(await transcriptBatchStatus(env, batchId)) };
}

async function createBatch(env, batchId, idempotencyKey, at) {
  const startEventId = await stableId("txbe", `${batchId}:started`);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batches
      (batch_id,idempotency_key,person_id,status,created_at,started_at)
      VALUES (?1,?2,?3,'running',?4,?4)`).bind(batchId, idempotencyKey, PERSON_ID, at),
    env.DB.prepare(`WITH ordered AS (
      SELECT video.source_item_id,video.platform_item_id youtube_id,
        MIN(revision.publication_date) source_publication_date
      FROM source_items video
      JOIN source_item_links link
        ON video.source_item_id IN (link.source_item_id_a,link.source_item_id_b)
       AND link.link_type='embedded_video' AND link.method='exact_platform_id'
      JOIN source_items post ON post.source_item_id=CASE
        WHEN link.source_item_id_a=video.source_item_id THEN link.source_item_id_b ELSE link.source_item_id_a END
      JOIN source_item_revisions revision ON revision.source_item_id=post.source_item_id
      WHERE video.person_id=?2 AND video.platform='youtube' AND post.platform='official_site'
        AND NOT EXISTS (SELECT 1 FROM transcript_artifacts artifact
          WHERE artifact.source_item_id=video.source_item_id)
      GROUP BY video.source_item_id,video.platform_item_id
    ), numbered AS (
      SELECT *,ROW_NUMBER() OVER (ORDER BY source_publication_date IS NULL,
        source_publication_date,source_item_id) ordinal FROM ordered
    )
    INSERT OR IGNORE INTO transcript_batch_items
      (batch_item_id,batch_id,source_item_id,youtube_id,source_publication_date,ordinal,status)
    SELECT 'txbi_' || substr(?1,5) || '_' || substr(source_item_id,5),?1,source_item_id,
      youtube_id,source_publication_date,ordinal,'pending' FROM numbered`)
      .bind(batchId, PERSON_ID),
    env.DB.prepare(`UPDATE transcript_batches SET item_count=(
      SELECT COUNT(*) FROM transcript_batch_items WHERE batch_id=?1)
      WHERE batch_id=?1`).bind(batchId),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
      (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
      SELECT ?1,?2,NULL,'batch_started',?3,?4
      WHERE EXISTS (SELECT 1 FROM transcript_batches WHERE batch_id=?2)`)
      .bind(startEventId, batchId, JSON.stringify({ selector: "troy_exact_linked_no_artifact_oldest_first" }), at),
  ]);
}

export async function startTranscriptBatch(env, { idempotencyKey, at = nowIso(), durationFetcher = fetch } = {}) {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey || "")) return { started: false, reason: "invalid_idempotency_key" };
  const existing = await batchRowByKey(env.DB, idempotencyKey);
  if (existing) {
    if (existing.status === "running") await repairTranscriptBatch(env, existing.batch_id, { at, durationFetcher });
    return { started: true, reused: true, ...(await transcriptBatchStatus(env, existing.batch_id)) };
  }
  const open = await env.DB.prepare("SELECT batch_id FROM transcript_batches WHERE status IN ('running','paused') LIMIT 1").first();
  if (open) return { started: false, reason: "active_batch_exists", batchId: open.batch_id };
  const activeRun = await env.DB.prepare(`SELECT run_id FROM ingestion_runs
    WHERE status IN ('queued','running') AND scope LIKE 'transcript:%'
    ORDER BY created_at,run_id LIMIT 1`).first();
  if (activeRun) return { started: false, reason: "active_transcript_run_exists", runId: activeRun.run_id };
  const batchId = await stableId("txb", `transcript-batch-v1:${idempotencyKey}`);
  try { await createBatch(env, batchId, idempotencyKey, at); }
  catch (error) {
    const raced = await batchRowByKey(env.DB, idempotencyKey);
    if (raced) return { started: true, reused: true, ...(await transcriptBatchStatus(env, raced.batch_id)) };
    if (/active transcript run exists/i.test(error?.message || "")) return { started: false, reason: "active_transcript_run_exists" };
    const winner = await env.DB.prepare("SELECT batch_id FROM transcript_batches WHERE status IN ('running','paused') LIMIT 1").first();
    if (winner && /FOREIGN KEY|UNIQUE constraint/i.test(error?.message || "")) {
      return { started: false, reason: "active_batch_exists", batchId: winner.batch_id };
    }
    if (/UNIQUE constraint/i.test(error?.message || "")) return { started: false, reason: "active_batch_exists" };
    throw error;
  }
  const repaired = await repairTranscriptBatch(env, batchId, { at, durationFetcher });
  const status = await transcriptBatchStatus(env, batchId);
  return { started: status?.status !== "paused", reused: false, reason: status?.pauseReason || repaired.reason, ...status };
}

export async function completeTranscriptBatchItem(env, { batchId, batchItemId,
  at = nowIso(), durationFetcher = fetch } = {}) {
  if (!BATCH_ID.test(batchId || "") || !BATCH_ITEM_ID.test(batchItemId || "")) return [];
  const item = await env.DB.prepare("SELECT * FROM transcript_batch_items WHERE batch_id=?1 AND batch_item_id=?2")
    .bind(batchId, batchItemId).first();
  if (!item) return [];
  if (item.status === "active") {
    const eventId = await stableId("txbe", `${batchId}:${batchItemId}:completed`);
    await env.DB.batch([
      env.DB.prepare(`UPDATE transcript_batch_items SET status='completed',completed_at=?3
        WHERE batch_id=?1 AND batch_item_id=?2 AND status='active'`).bind(batchId, batchItemId, at),
      env.DB.prepare(`UPDATE transcript_batches SET completed_item_count=(
        SELECT COUNT(*) FROM transcript_batch_items WHERE batch_id=?1 AND status='completed')
        WHERE batch_id=?1 AND status='running'`).bind(batchId),
      env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
        (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
        SELECT ?1,?2,?3,'item_completed','{}',?4
        WHERE EXISTS (SELECT 1 FROM transcript_batch_items WHERE batch_item_id=?3 AND status='completed')`)
        .bind(eventId, batchId, batchItemId, at),
    ]);
  } else if (item.status === "completed") {
    const active = await activeItem(env.DB, batchId);
    if (active) {
      const queued = await storedResumableEnvelope(env.DB, active);
      return queued ? [queued] : [];
    }
  }
  const prepared = await activateNextItem(env, batchId, { at, durationFetcher });
  return prepared.envelope ? [prepared.envelope] : [];
}

async function dispositionForItem(db, batchId, batchItemId) {
  return db.prepare(`SELECT * FROM transcript_batch_item_dispositions
    WHERE batch_id=?1 AND batch_item_id=?2 AND disposition='source_unavailable'`)
    .bind(batchId, batchItemId).first();
}

async function advanceQuarantinedBatch(env, disposition, { at, durationFetcher }) {
  const batch = await batchRow(env.DB, disposition.batch_id);
  if (!batch || batch.status !== "running") return false;
  const successorId = disposition.successor_batch_item_id;
  if (!successorId) {
    await finishBatchIfEmpty(env, disposition.batch_id, at);
    return true;
  }
  let successor = await env.DB.prepare(`SELECT * FROM transcript_batch_items
    WHERE batch_id=?1 AND batch_item_id=?2`).bind(disposition.batch_id, successorId).first();
  if (!successor) return false;
  if (successor.status === "pending") {
    if (await activeItem(env.DB, disposition.batch_id)) return false;
    const prepared = await activateNextItem(env, disposition.batch_id, { at, durationFetcher });
    if (!prepared.envelope || prepared.envelope.payload.batchItemId !== successorId) return false;
    return dispatchTranscriptBatchEnvelope(env, disposition.batch_id, successorId, prepared.envelope, at);
  }
  if (successor.status === "active" && successor.dispatch_state !== "sent") {
    const envelope = await storedResumableEnvelope(env.DB, successor) || await firstTranscriptEnvelope(successor);
    return dispatchTranscriptBatchEnvelope(env, disposition.batch_id, successorId, envelope, at);
  }
  return ["active", "completed", "skipped"].includes(successor.status);
}

async function quarantineReceipt(env, disposition, { applied, reused, dispatched }) {
  const status = await transcriptBatchStatus(env, disposition.batch_id);
  const successor = disposition.successor_batch_item_id
    ? await env.DB.prepare(`SELECT batch_item_id,youtube_id,status,dispatch_state
        FROM transcript_batch_items WHERE batch_id=?1 AND batch_item_id=?2`)
      .bind(disposition.batch_id, disposition.successor_batch_item_id).first()
    : null;
  return {
    contract: "transcript-batch-quarantine-v1", action: "quarantine_pending_item",
    quarantined: true, applied, reused, dispatched,
    dispositionId: disposition.disposition_id,
    batchId: disposition.batch_id, batchItemId: disposition.batch_item_id,
    youtubeId: disposition.youtube_id,
    reasonCode: disposition.reason_code, observedErrorCode: disposition.observed_error_code,
    transitionBefore: Number(disposition.expected_transition_count),
    transitionAfter: Number(disposition.applied_transition_count),
    successor: successor ? { batchItemId: successor.batch_item_id, youtubeId: successor.youtube_id,
      status: successor.status, dispatchState: successor.dispatch_state } : null,
    ...status,
  };
}

export async function quarantinePendingTranscriptItem(env, { batchId, batchItemId,
  idempotencyKey, expectedTransitionCount, reasonCode, observedErrorCode,
  at = nowIso(), durationFetcher = fetch } = {}) {
  if (!BATCH_ID.test(batchId || "")) return { quarantined: false, reason: "invalid_batch_id" };
  if (!BATCH_ITEM_ID.test(batchItemId || "")) return { quarantined: false, reason: "invalid_batch_item_id" };
  if (!IDEMPOTENCY_KEY.test(idempotencyKey || "")) return { quarantined: false, reason: "invalid_idempotency_key" };
  if (!Number.isInteger(expectedTransitionCount) || expectedTransitionCount < 0) {
    return { quarantined: false, reason: "invalid_transition_count" };
  }
  if (reasonCode !== SOURCE_UNAVAILABLE_REASON || observedErrorCode !== SOURCE_UNAVAILABLE_ERROR) {
    return { quarantined: false, reason: "invalid_disposition_reason" };
  }
  const batch = await batchRow(env.DB, batchId);
  if (!batch) return { quarantined: false, reason: "batch_not_found" };
  if (batch.idempotency_key !== idempotencyKey) {
    return { quarantined: false, reason: "idempotency_key_mismatch", ...(await transcriptBatchStatus(env, batchId)) };
  }
  const item = await env.DB.prepare(`SELECT * FROM transcript_batch_items
    WHERE batch_id=?1 AND batch_item_id=?2`).bind(batchId, batchItemId).first();
  if (!item) return { quarantined: false, reason: "batch_item_not_found" };
  const existing = await dispositionForItem(env.DB, batchId, batchItemId);
  if (existing) {
    if (Number(existing.expected_transition_count) !== expectedTransitionCount ||
        existing.reason_code !== reasonCode || existing.observed_error_code !== observedErrorCode ||
        existing.source_item_id !== item.source_item_id) {
      return { quarantined: false, reason: "disposition_conflict", ...(await transcriptBatchStatus(env, batchId)) };
    }
    const bound = { ...existing, youtube_id: item.youtube_id };
    const dispatched = await advanceQuarantinedBatch(env, bound, { at, durationFetcher });
    return quarantineReceipt(env, bound, { applied: false, reused: true, dispatched });
  }
  if (batch.status !== "paused") {
    return { quarantined: false, reason: "batch_not_paused", ...(await transcriptBatchStatus(env, batchId)) };
  }
  if (Number(batch.transition_count) !== expectedTransitionCount) {
    return { quarantined: false, reason: "transition_mismatch", ...(await transcriptBatchStatus(env, batchId)) };
  }
  if (batch.pause_reason !== SOURCE_UNAVAILABLE_ERROR) {
    return { quarantined: false, reason: "pause_reason_mismatch", ...(await transcriptBatchStatus(env, batchId)) };
  }
  if (item.status !== "pending" || item.run_id || item.duration_seconds != null || item.started_at || item.completed_at) {
    return { quarantined: false, reason: "item_not_pristine_pending", ...(await transcriptBatchStatus(env, batchId)) };
  }
  if (await activeItem(env.DB, batchId)) {
    return { quarantined: false, reason: "active_item_exists", ...(await transcriptBatchStatus(env, batchId)) };
  }
  const artifact = await env.DB.prepare(`SELECT 1 present FROM transcript_artifacts
    WHERE source_item_id=?1 LIMIT 1`).bind(item.source_item_id).first();
  if (artifact) return { quarantined: false, reason: "transcript_artifact_exists", ...(await transcriptBatchStatus(env, batchId)) };
  const latestPause = await env.DB.prepare(`SELECT batch_item_id FROM transcript_batch_events
    WHERE batch_id=?1 AND event_type='batch_paused'
    ORDER BY created_at DESC,event_id DESC LIMIT 1`).bind(batchId).first();
  if (latestPause?.batch_item_id !== batchItemId) {
    return { quarantined: false, reason: "pause_item_mismatch", ...(await transcriptBatchStatus(env, batchId)) };
  }
  const successor = await nextPendingItem(env, batch, batchItemId);
  const transitionAfter = expectedTransitionCount + 1;
  const dispositionId = await stableId("txbd",
    `${batchId}:${batchItemId}:source_unavailable:${observedErrorCode}:transition:${expectedTransitionCount}`);
  const [inserted, transitioned] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_item_dispositions
      (disposition_id,batch_id,batch_item_id,source_item_id,successor_batch_item_id,
       disposition,link_availability,reason_code,observed_error_code,
       expected_transition_count,applied_transition_count,created_at)
      SELECT ?1,batch.batch_id,item.batch_item_id,item.source_item_id,?6,
        'source_unavailable','unavailable',?7,?8,?4,?5,?9
      FROM transcript_batches batch JOIN transcript_batch_items item
        ON item.batch_id=batch.batch_id AND item.batch_item_id=?3
      WHERE batch.batch_id=?2 AND batch.idempotency_key=?10 AND batch.status='paused'
        AND batch.pause_reason=?8 AND batch.transition_count=?4
        AND item.status='pending' AND item.run_id IS NULL AND item.duration_seconds IS NULL
        AND item.started_at IS NULL AND item.completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM transcript_artifacts artifact
          WHERE artifact.source_item_id=item.source_item_id)
        AND NOT EXISTS (SELECT 1 FROM transcript_batch_items active WHERE active.status='active')
        AND (SELECT event.batch_item_id FROM transcript_batch_events event
          WHERE event.batch_id=batch.batch_id AND event.event_type='batch_paused'
          ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1)=item.batch_item_id`)
      .bind(dispositionId, batchId, batchItemId, expectedTransitionCount, transitionAfter,
        successor?.batch_item_id || null, reasonCode, observedErrorCode, at, idempotencyKey),
    env.DB.prepare(`UPDATE transcript_batches SET status='running',pause_reason=NULL,
        resume_after=NULL,paused_at=NULL,transition_count=?3
      WHERE batch_id=?1 AND status='paused' AND transition_count=?2
        AND EXISTS (SELECT 1 FROM transcript_batch_item_dispositions
          WHERE disposition_id=?4 AND applied_transition_count=?3)`)
      .bind(batchId, expectedTransitionCount, transitionAfter, dispositionId),
  ]);
  if (!changed(inserted) || !changed(transitioned)) {
    const raced = await dispositionForItem(env.DB, batchId, batchItemId);
    if (!raced) return { quarantined: false, reason: "quarantine_lost", ...(await transcriptBatchStatus(env, batchId)) };
    const bound = { ...raced, youtube_id: item.youtube_id };
    const dispatched = await advanceQuarantinedBatch(env, bound, { at, durationFetcher });
    return quarantineReceipt(env, bound, { applied: false, reused: true, dispatched });
  }
  const disposition = { ...(await dispositionForItem(env.DB, batchId, batchItemId)), youtube_id: item.youtube_id };
  const dispatched = await advanceQuarantinedBatch(env, disposition, { at, durationFetcher });
  return quarantineReceipt(env, disposition, { applied: true, reused: false, dispatched });
}

export async function skipActiveTranscriptItem(env, { batchId, at = nowIso(),
  durationFetcher = fetch } = {}) {
  if (!BATCH_ID.test(batchId || "")) return { skipped: false, reason: "invalid_batch_id" };
  const batch = await batchRow(env.DB, batchId);
  if (!batch) return { skipped: false, reason: "batch_not_found" };
  if (batch.status !== "paused") {
    return { skipped: false, reason: "batch_not_paused", ...(await transcriptBatchStatus(env, batchId)) };
  }
  const active = await activeItem(env.DB, batchId);
  if (!active) {
    return { skipped: false, reason: "no_active_item", ...(await transcriptBatchStatus(env, batchId)) };
  }
  const failed = await env.DB.prepare(`SELECT job_id FROM ingestion_jobs
    WHERE run_id=?1 AND status='failed' ORDER BY completed_at DESC,job_id LIMIT 1`)
    .bind(active.run_id).first();
  if (!failed) {
    return { skipped: false, reason: "active_item_not_failed", ...(await transcriptBatchStatus(env, batchId)) };
  }
  const transition = Number(batch.transition_count) + 1;
  const eventId = await stableId("txbe", `${batchId}:transition:${transition}:item_skipped`);
  const detail = JSON.stringify({ reason: "admin_skip_after_terminal_failure",
    youtubeId: active.youtube_id, failedJobId: failed.job_id });
  const [skipped, resumed] = await env.DB.batch([
    env.DB.prepare(`UPDATE transcript_batch_items SET status='skipped'
      WHERE batch_id=?1 AND batch_item_id=?2 AND status='active' AND run_id=?3
        AND EXISTS (SELECT 1 FROM transcript_batches
          WHERE batch_id=?1 AND status='paused' AND transition_count=?4)
        AND EXISTS (SELECT 1 FROM ingestion_jobs WHERE run_id=?3 AND status='failed')`)
      .bind(batchId, active.batch_item_id, active.run_id, Number(batch.transition_count)),
    env.DB.prepare(`UPDATE transcript_batches SET status='running',pause_reason=NULL,
        resume_after=NULL,paused_at=NULL,transition_count=?3
      WHERE batch_id=?1 AND status='paused' AND transition_count=?2
        AND EXISTS (SELECT 1 FROM transcript_batch_items
          WHERE batch_id=?1 AND batch_item_id=?4 AND status='skipped')`)
      .bind(batchId, Number(batch.transition_count), transition, active.batch_item_id),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
      (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
      SELECT ?1,?2,?3,'item_skipped',?4,?5
      WHERE EXISTS (SELECT 1 FROM transcript_batches
        WHERE batch_id=?2 AND status='running' AND transition_count=?6)
        AND EXISTS (SELECT 1 FROM transcript_batch_items
          WHERE batch_id=?2 AND batch_item_id=?3 AND status='skipped')`)
      .bind(eventId, batchId, active.batch_item_id, detail, at, transition),
  ]);
  if (!changed(skipped) || !changed(resumed)) {
    return { skipped: false, reason: "skip_lost", ...(await transcriptBatchStatus(env, batchId)) };
  }
  const prepared = await activateNextItem(env, batchId, { at, durationFetcher });
  let dispatched = false;
  if (prepared.envelope) {
    dispatched = await dispatchTranscriptBatchEnvelope(env, batchId,
      prepared.envelope.payload.batchItemId, prepared.envelope, at);
  }
  const status = await transcriptBatchStatus(env, batchId);
  return { skipped: true, dispatched, reason: prepared.envelope && !dispatched
    ? status?.pauseReason || "queue_dispatch_failed" : null, ...status };
}

export async function resumeTranscriptBatch(env, { idempotencyKey, at = nowIso(), durationFetcher = fetch } = {}) {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey || "")) return { resumed: false, reason: "invalid_idempotency_key" };
  const batch = await batchRowByKey(env.DB, idempotencyKey);
  if (!batch) return { resumed: false, reason: "batch_not_found" };
  if (batch.status === "completed") return { resumed: false, reason: "batch_complete", ...(await transcriptBatchStatus(env, batch.batch_id)) };
  if (batch.status !== "paused") return { resumed: false, reason: "batch_not_paused", ...(await transcriptBatchStatus(env, batch.batch_id)) };
  if (batch.resume_after > at) return { resumed: false, reason: "resume_not_ready", ...(await transcriptBatchStatus(env, batch.batch_id)) };
  const media = await currentPhysicalMedia(env, at);
  if (media.exhausted) return { resumed: false, reason: "media_fuse_exhausted",
    mediaDay: media.mediaDay, mediaSeconds: media.mediaSeconds, mediaLimitSeconds: media.mediaLimitSeconds,
    ...(await transcriptBatchStatus(env, batch.batch_id)) };
  const active = await activeItem(env.DB, batch.batch_id);
  const transition = Number(batch.transition_count) + 1;
  const eventId = await stableId("txbe", `${batch.batch_id}:transition:${transition}:resumed`);
  const fuseClause = media.available ? `AND ((SELECT COALESCE(SUM(reserved_seconds),0) FROM gemini_physical_request_reservations
    WHERE media_day=substr(?2,1,10)) + (SELECT COALESCE(SUM(CASE WHEN reason='legacy_cutover_fail_closed' AND reserved_seconds>=86400
      AND ${media.mediaLimitSeconds}<=${GEMINI_FREE_TIER_MEDIA_SECONDS_MAX} THEN 0 ELSE reserved_seconds END),0)
    FROM gemini_physical_day_debits WHERE media_day=substr(?2,1,10))) < ${media.mediaLimitSeconds}` : "";
  const statements = [
    env.DB.prepare(`UPDATE transcript_batches SET status='running',pause_reason=NULL,resume_after=NULL,paused_at=NULL,
        transition_count=?3
      WHERE batch_id=?1 AND status='paused' AND resume_after<=?2 AND transition_count=?4 ${fuseClause}`)
      .bind(batch.batch_id, at, transition, Number(batch.transition_count)),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
      (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
      SELECT ?1,?2,?3,'batch_resumed','{}',?4
      WHERE EXISTS (SELECT 1 FROM transcript_batches
        WHERE batch_id=?2 AND status='running' AND transition_count=?5)`)
      .bind(eventId, batch.batch_id, active?.batch_item_id || null, at, transition),
  ];
  let envelope = null;
  if (active) {
    envelope = await storedResumableEnvelope(env.DB, active);
    if (!envelope) return { resumed: false, reason: "paused_job_not_found", ...(await transcriptBatchStatus(env, batch.batch_id)) };
    statements.splice(1, 0, env.DB.prepare(`UPDATE ingestion_jobs SET status='queued',claimed_at=NULL,lease_token=NULL,
      error_code=NULL,completed_at=NULL WHERE job_id=?1 AND status IN ('queued','failed')
      AND EXISTS (SELECT 1 FROM transcript_batches WHERE batch_id=?2 AND status='running' AND transition_count=?3)`)
      .bind(envelope.jobId, batch.batch_id, transition));
    statements.splice(2, 0, env.DB.prepare(`UPDATE transcript_batch_items SET dispatch_state='pending',dispatch_claimed_at=NULL WHERE
      batch_item_id=?1 AND status='active' AND EXISTS (SELECT 1 FROM transcript_batches WHERE batch_id=?2
        AND status='running' AND transition_count=?3)`)
      .bind(active.batch_item_id, batch.batch_id, transition));
  }
  const [resumed] = await env.DB.batch(statements);
  if (!changed(resumed)) {
    const readback = await currentPhysicalMedia(env, at);
    return { resumed: false, reason: readback.exhausted ? "media_fuse_exhausted" : "resume_lost", mediaDay: readback.mediaDay,
      mediaSeconds: readback.mediaSeconds, mediaLimitSeconds: readback.mediaLimitSeconds, ...(await transcriptBatchStatus(env, batch.batch_id)) };
  }
  let preparedReason = null;
  if (!envelope) {
    const prepared = await activateNextItem(env, batch.batch_id, { at, durationFetcher });
    envelope = prepared.envelope; preparedReason = prepared.reason;
  }
  const sent = envelope ? await dispatchTranscriptBatchEnvelope(env, batch.batch_id,
    envelope.payload.batchItemId, envelope, at) : false;
  const status = await transcriptBatchStatus(env, batch.batch_id);
  return { resumed: sent, reason: sent ? null : status?.pauseReason || preparedReason || "queue_dispatch_failed", ...status };
}

export async function resumeScheduledTranscriptBatch(env, { at = nowIso(), durationFetcher = fetch } = {}) {
  if (env.TRANSCRIPT_BATCH_ENABLED !== "1") return { resumed: false, reason: "batch_disabled" };
  const batch = await env.DB.prepare(`SELECT * FROM transcript_batches
    WHERE status IN ('running','paused') ORDER BY created_at,batch_id LIMIT 1`).first();
  if (!batch) return { resumed: false, reason: "no_open_batch" };
  if (batch.status === "running") return repairTranscriptBatch(env, batch.batch_id, { at, durationFetcher });
  if (batch.resume_after > at) return { resumed: false, reason: "resume_not_ready", batchId: batch.batch_id };
  return resumeTranscriptBatch(env, { idempotencyKey: batch.idempotency_key, at, durationFetcher });
}
