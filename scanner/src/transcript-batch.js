import { sha256, stableId } from "./hash.js";
import { completedTranscriptChunks, nowIso, recordSourceMediaMetadata, registerJob } from "./repository.js";
import {
  ensureTranscriptAnalysisPreparationRun, fetchYouTubeDataApiDuration, fetchYouTubeDuration,
  STITCH_ALGORITHM, stitchTranscript, transcriptAnalysisPreparationEnvelope, transcriptPlan,
} from "./transcript.js";

const PERSON_ID = "person_troy_black";
const BATCH_ID = /^txb_[a-f0-9]{32}$/;
const BATCH_ITEM_ID = /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function changed(result) {
  return Boolean(result?.meta?.changes);
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
  const stableKey = `youtube:${item.youtube_id}:transcript:chunk:0`;
  return {
    version: 1,
    jobId: item.first_job_id,
    runId: item.run_id,
    personId: PERSON_ID,
    type: "transcript_extract",
    stableKey,
    payload: {
      phase: "chunk", chunkIndex: 0, youtubeId: item.youtube_id,
      sourceItemId: item.source_item_id, durationSeconds: Number(item.duration_seconds),
      batchId: item.batch_id, batchItemId: item.batch_item_id,
    },
  };
}

async function firstTranscriptEnvelope(item) {
  if (item.first_job_id) return transcriptEnvelope(item);
  const stableKey = `youtube:${item.youtube_id}:transcript:chunk:0`;
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

async function statusCounts(db, batchId) {
  const rows = await db.prepare(`SELECT status,COUNT(*) count FROM transcript_batch_items
    WHERE batch_id=?1 GROUP BY status`).bind(batchId).all();
  return Object.fromEntries((rows.results || []).map((row) => [row.status, Number(row.count)]));
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
  const [result] = await env.DB.batch([
    env.DB.prepare(`UPDATE transcript_batches SET status='completed',completed_at=?2,
        completed_item_count=item_count,pause_reason=NULL,resume_after=NULL
      WHERE batch_id=?1 AND status='running'
        AND NOT EXISTS (SELECT 1 FROM transcript_batch_items
          WHERE batch_id=?1 AND status IN ('pending','active'))`).bind(batchId, at),
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

async function nextPendingItem(env, batch) {
  if (!(await archiveSelectorAvailable(env.DB))) {
    return env.DB.prepare(`SELECT * FROM transcript_batch_items
      WHERE batch_id=?1 AND status='pending' ORDER BY ordinal,batch_item_id LIMIT 1`)
      .bind(batch.batch_id).first();
  }
  return env.DB.prepare(`SELECT item.* FROM transcript_batch_items item
    WHERE item.batch_id=?1 AND item.status='pending'
    ORDER BY CASE WHEN EXISTS (
      SELECT 1 FROM archive_linked_video_selector archive
      WHERE archive.person_id=?2 AND archive.source_item_id=item.source_item_id
    ) THEN 0 ELSE 1 END,item.ordinal,item.batch_item_id LIMIT 1`)
    .bind(batch.batch_id, batch.person_id).first();
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
  const runId = await stableId("runtxb", `${batchId}:${item.batch_item_id}:${durationSeconds}`);
  const stableKey = `youtube:${item.youtube_id}:transcript:chunk:0`;
  const jobId = await stableId("job", `${runId}:transcript_extract:${stableKey}`);
  const eventId = await stableId("txbe", `${batchId}:${item.batch_item_id}:started`);
  const activated = { ...item, batch_id: batchId, run_id: runId,
    duration_seconds: durationSeconds, first_job_id: jobId };
  const envelope = transcriptEnvelope(activated);
  const [, activation] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO ingestion_runs
      (run_id,person_id,trigger_type,scope,status,created_at)
      VALUES (?1,?2,'manual',?3,'queued',?4)`)
      .bind(runId, PERSON_ID, `transcript:${item.source_item_id}:${durationSeconds}:batch:${batchId}`, at),
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

function acquisitionSettings(env) {
  const integer = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
  };
  return { chunkSeconds: integer(env.TRANSCRIPT_CHUNK_SECONDS, 300, 60, 300),
    overlapSeconds: integer(env.TRANSCRIPT_OVERLAP_SECONDS, 0, 0, 30) };
}

async function legacyStitchEvidence(env, item) {
  const receipt = await env.DB.prepare(`SELECT receipt.*,artifact.r2_key,artifact.content_sha256,
      artifact.byte_count,artifact.source_item_id artifact_source_item_id,artifact.provenance,
      job.job_type,job.stable_key,job.payload_json,run.person_id,run.scope,
      source.platform,source.platform_item_id,source.canonical_url
    FROM transcript_stitch_receipts receipt
    JOIN transcript_artifacts artifact ON artifact.transcript_id=receipt.transcript_id
    JOIN ingestion_jobs job ON job.job_id=receipt.job_id AND job.run_id=receipt.run_id
    JOIN ingestion_runs run ON run.run_id=receipt.run_id
    JOIN source_items source ON source.source_item_id=receipt.source_item_id
    WHERE receipt.run_id=?1 AND receipt.source_item_id=?2
    ORDER BY receipt.created_at DESC,receipt.stitch_id DESC LIMIT 1`)
    .bind(item.run_id, item.source_item_id).first();
  if (!receipt) throw new Error("legacy_stitch_receipt_missing");
  let payload;
  try { payload = JSON.parse(receipt.payload_json); }
  catch { throw new Error("legacy_stitch_job_binding_invalid"); }
  const expectedScope = `transcript:${item.source_item_id}:${item.duration_seconds}:batch:${item.batch_id}`;
  const expectedStableKey = `youtube:${item.youtube_id}:transcript:stitch`;
  if (receipt.job_type !== "transcript_extract" || receipt.stable_key !== expectedStableKey ||
      receipt.scope !== expectedScope || receipt.person_id !== item.person_id ||
      receipt.platform !== "youtube" || receipt.platform_item_id !== item.youtube_id ||
      receipt.canonical_url !== `https://www.youtube.com/watch?v=${item.youtube_id}` ||
      receipt.artifact_source_item_id !== item.source_item_id ||
      receipt.provenance !== "gemini_generated_public_youtube_clipped_v1" ||
      payload?.phase !== "stitch" || payload?.batchId !== item.batch_id ||
      payload?.batchItemId !== item.batch_item_id || payload?.sourceItemId !== item.source_item_id ||
      payload?.youtubeId !== item.youtube_id || Number(payload?.durationSeconds) !== Number(item.duration_seconds)) {
    throw new Error("legacy_stitch_job_binding_invalid");
  }
  if (Number(receipt.duration_seconds) !== Number(item.duration_seconds) ||
      receipt.stitch_algorithm !== STITCH_ALGORITHM ||
      !/^[a-f0-9]{64}$/.test(receipt.input_manifest_sha256 || "") ||
      !/^[a-f0-9]{64}$/.test(receipt.content_sha256 || "")) {
    throw new Error("legacy_stitch_receipt_invalid");
  }
  const plan = transcriptPlan(Number(item.duration_seconds), acquisitionSettings(env));
  const chunks = await completedTranscriptChunks(env.DB, item.run_id, item.source_item_id);
  if (chunks.length !== plan.length || Number(receipt.chunk_count) !== plan.length) {
    throw new Error("legacy_stitch_chunks_incomplete");
  }
  const texts = [];
  for (const [index, row] of chunks.entries()) {
    const window = plan[index];
    if (Number(row.chunk_index) !== index || Number(row.start_seconds) !== window.requestStart ||
        Number(row.end_seconds) !== window.requestEnd ||
        Number(row.overlap_seconds) !== acquisitionSettings(env).overlapSeconds ||
        !/^[a-f0-9]{64}$/.test(row.content_sha256 || "")) {
      throw new Error("legacy_stitch_chunks_incomplete");
    }
    const object = await env.ARTIFACTS.get(row.r2_key);
    if (!object) throw new Error("legacy_stitch_chunk_artifact_missing");
    const text = await object.text();
    if (await sha256(text) !== row.content_sha256 ||
        new TextEncoder().encode(text).length !== Number(row.byte_count)) {
      throw new Error("legacy_stitch_chunk_hash_mismatch");
    }
    texts.push(text);
  }
  if (await sha256(chunks.map((row) => row.content_sha256)) !== receipt.input_manifest_sha256) {
    throw new Error("legacy_stitch_manifest_hash_mismatch");
  }
  const expected = stitchTranscript(texts, plan);
  const object = await env.ARTIFACTS.get(receipt.r2_key);
  if (!object) throw new Error("legacy_stitch_artifact_missing");
  const transcript = await object.text();
  if (transcript !== expected.text || await sha256(transcript) !== receipt.content_sha256 ||
      new TextEncoder().encode(transcript).length !== Number(receipt.byte_count) ||
      Number(receipt.cue_count) !== expected.cueCount) {
    throw new Error("legacy_stitch_content_hash_mismatch");
  }
  return { receipt, transcript };
}

async function resumeBatchForLegacyRepair(env, item, at) {
  const batch = await batchRow(env.DB, item.batch_id);
  if (batch.status === "running") return;
  if (batch.status !== "paused") throw new Error("batch_not_open");
  const transition = Number(batch.transition_count) + 1;
  const eventId = await stableId("txbe", `${item.batch_id}:transition:${transition}:resumed`);
  const [resumed] = await env.DB.batch([
    env.DB.prepare(`UPDATE transcript_batches SET status='running',pause_reason=NULL,
      resume_after=NULL,paused_at=NULL,transition_count=?3
      WHERE batch_id=?1 AND status='paused' AND transition_count=?2`)
      .bind(item.batch_id, Number(batch.transition_count), transition),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_events
      (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
      SELECT ?1,?2,?3,'batch_resumed',?4,?5 WHERE EXISTS (
        SELECT 1 FROM transcript_batches WHERE batch_id=?2 AND status='running' AND transition_count=?6)`)
      .bind(eventId, item.batch_id, item.batch_item_id,
        JSON.stringify({ action: "legacy_stitch_repair" }), at, transition),
  ]);
  if (!changed(resumed)) throw new Error("legacy_stitch_resume_lost");
}

export async function repairLegacyStitchedTranscriptBatchItem(env, { batchId, batchItemId,
  at = nowIso(), durationFetcher = fetch } = {}) {
  if (!BATCH_ID.test(batchId || "") || !BATCH_ITEM_ID.test(batchItemId || "")) {
    return { repaired: false, reason: "invalid_batch_item" };
  }
  const existingEvent = await env.DB.prepare(`SELECT repair_event_id FROM transcript_batch_repair_events
    WHERE batch_id=?1 AND batch_item_id=?2 AND event_type='legacy_stitch_repaired' LIMIT 1`)
    .bind(batchId, batchItemId).first();
  if (existingEvent) return { repaired: true, reused: true, batchId, batchItemId };
  const item = await env.DB.prepare(`SELECT item.*,batch.person_id,batch.status batch_status
    FROM transcript_batch_items item JOIN transcript_batches batch ON batch.batch_id=item.batch_id
    WHERE item.batch_id=?1 AND item.batch_item_id=?2`).bind(batchId, batchItemId).first();
  if (!item) return { repaired: false, reason: "batch_item_not_found" };
  if (!["active", "completed"].includes(item.status) || !item.run_id || !item.duration_seconds) {
    return { repaired: false, reason: "legacy_stitch_item_not_repairable" };
  }
  if (item.status === "active" && !["running", "paused"].includes(item.batch_status)) {
    return { repaired: false, reason: "batch_not_open" };
  }
  let evidence;
  try { evidence = await legacyStitchEvidence(env, item); }
  catch (error) { return { repaired: false, reason: error?.message || "legacy_stitch_verification_failed" }; }
  if (item.status === "active") {
    try { await resumeBatchForLegacyRepair(env, item, at); }
    catch (error) { return { repaired: false, reason: error?.message || "legacy_stitch_resume_failed" }; }
  }
  const acquisition = item.status === "active" ? await completeTranscriptBatchItem(env, {
    batchId, batchItemId, at, durationFetcher,
  }) : [];
  for (const envelope of acquisition) {
    const sent = await dispatchTranscriptBatchEnvelope(env, batchId, envelope.payload.batchItemId, envelope, at);
    if (!sent) return { repaired: false, reason: "next_acquisition_dispatch_failed" };
  }
  const preparation = await transcriptAnalysisPreparationEnvelope({
    transcriptId: evidence.receipt.transcript_id, sourceItemId: item.source_item_id,
    personId: item.person_id, transcriptSha256: evidence.receipt.content_sha256,
  });
  try {
    await ensureTranscriptAnalysisPreparationRun(env.DB, preparation, at);
    await registerJob(env.DB, preparation, at);
    await env.INGESTION_QUEUE.send(preparation);
  } catch {
    return { repaired: false, reason: "analysis_preparation_dispatch_failed",
      acquisitionAdvanced: acquisition.length === 1, batchId, batchItemId };
  }
  const repairEventId = await stableId("txbrep",
    `${batchId}:${batchItemId}:legacy_stitch_repaired:${evidence.receipt.transcript_id}:${evidence.receipt.input_manifest_sha256}`);
  await env.DB.prepare(`INSERT OR IGNORE INTO transcript_batch_repair_events
    (repair_event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
    VALUES (?1,?2,?3,'legacy_stitch_repaired',?4,?5)`)
    .bind(repairEventId, batchId, batchItemId, JSON.stringify({
      transcriptId: evidence.receipt.transcript_id,
      contentSha256: evidence.receipt.content_sha256,
      manifestSha256: evidence.receipt.input_manifest_sha256,
      chunkCount: Number(evidence.receipt.chunk_count),
      analysisPreparationJobId: preparation.jobId,
    }), at).run();
  const status = await transcriptBatchStatus(env, batchId);
  return { repaired: true, reused: false, batchId, batchItemId,
    queuedAnalysisSectionCount: 0, analysisPreparationQueued: true,
    acquisitionAdvanced: acquisition.length === 1,
    status: status.status, completedItemCount: status.completedItemCount,
    activeItemCount: Number(status.counts.active || 0) };
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

export async function resumeTranscriptBatch(env, { idempotencyKey, at = nowIso(), durationFetcher = fetch } = {}) {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey || "")) return { resumed: false, reason: "invalid_idempotency_key" };
  const batch = await batchRowByKey(env.DB, idempotencyKey);
  if (!batch) return { resumed: false, reason: "batch_not_found" };
  if (batch.status === "completed") return { resumed: false, reason: "batch_complete", ...(await transcriptBatchStatus(env, batch.batch_id)) };
  if (batch.status !== "paused") return { resumed: false, reason: "batch_not_paused", ...(await transcriptBatchStatus(env, batch.batch_id)) };
  if (batch.resume_after > at) return { resumed: false, reason: "resume_not_ready", ...(await transcriptBatchStatus(env, batch.batch_id)) };
  const active = await activeItem(env.DB, batch.batch_id);
  const transition = Number(batch.transition_count) + 1;
  const eventId = await stableId("txbe", `${batch.batch_id}:transition:${transition}:resumed`);
  const statements = [
    env.DB.prepare(`UPDATE transcript_batches SET status='running',pause_reason=NULL,resume_after=NULL,paused_at=NULL,
        transition_count=?3
      WHERE batch_id=?1 AND status='paused' AND resume_after<=?2 AND transition_count=?4`)
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
    statements.splice(1, 0, env.DB.prepare(`UPDATE ingestion_jobs SET status='queued',claimed_at=NULL,
        lease_token=NULL,error_code=NULL,completed_at=NULL
      WHERE job_id=?1 AND status IN ('queued','failed')`).bind(envelope.jobId));
    statements.splice(2, 0, env.DB.prepare(`UPDATE transcript_batch_items SET dispatch_state='pending',
        dispatch_claimed_at=NULL
      WHERE batch_item_id=?1 AND status='active'`).bind(active.batch_item_id));
  }
  const [resumed] = await env.DB.batch(statements);
  if (!changed(resumed)) return { resumed: false, reason: "resume_lost", ...(await transcriptBatchStatus(env, batch.batch_id)) };
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
