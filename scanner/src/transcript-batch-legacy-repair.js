import { sha256, stableId } from "./hash.js";
import { completedTranscriptChunks, nowIso, registerJob } from "./repository.js";
import { ensureTranscriptAnalysisPreparationRun, LEGACY_STITCH_ALGORITHM,
  stitchTranscript, transcriptAnalysisPreparationEnvelope } from "./transcript.js";

const BATCH_ID = /^txb_[a-f0-9]{32}$/;
const BATCH_ITEM_ID = /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/;

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
      receipt.stitch_algorithm !== LEGACY_STITCH_ALGORITHM ||
      !/^[a-f0-9]{64}$/.test(receipt.input_manifest_sha256 || "") ||
      !/^[a-f0-9]{64}$/.test(receipt.content_sha256 || "")) {
    throw new Error("legacy_stitch_receipt_invalid");
  }
  const settings = acquisitionSettings(env);
  const stride = settings.chunkSeconds - settings.overlapSeconds;
  const requests = [];
  for (let start = 0; start < Number(item.duration_seconds); start += stride) {
    requests.push({ requestStart: start,
      requestEnd: Math.min(Number(item.duration_seconds), start + settings.chunkSeconds) });
  }
  const plan = requests.map((request, index) => ({ index, ...request,
    canonicalStart: index ? (requests[index - 1].requestEnd + request.requestStart) / 2 : 0,
    canonicalEnd: index + 1 < requests.length
      ? (request.requestEnd + requests[index + 1].requestStart) / 2 : Number(item.duration_seconds),
  }));
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

async function resumeBatchForLegacyRepair(env, item, at, operations) {
  const batch = await operations.batchRow(env.DB, item.batch_id);
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
  if (!operations.changed(resumed)) throw new Error("legacy_stitch_resume_lost");
}

export async function repairLegacyStitchedTranscriptBatchItemImpl(env, { batchId, batchItemId,
  at = nowIso(), durationFetcher = fetch } = {}, operations) {
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
    try { await resumeBatchForLegacyRepair(env, item, at, operations); }
    catch (error) { return { repaired: false, reason: error?.message || "legacy_stitch_resume_failed" }; }
  }
  const acquisition = item.status === "active" ? await operations.completeTranscriptBatchItem(env, {
    batchId, batchItemId, at, durationFetcher,
  }) : [];
  for (const envelope of acquisition) {
    const sent = await operations.dispatchTranscriptBatchEnvelope(env, batchId, envelope.payload.batchItemId, envelope, at);
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
  const status = await operations.transcriptBatchStatus(env, batchId);
  return { repaired: true, reused: false, batchId, batchItemId,
    queuedAnalysisSectionCount: 0, analysisPreparationQueued: true,
    acquisitionAdvanced: acquisition.length === 1,
    status: status.status, completedItemCount: status.completedItemCount,
    activeItemCount: Number(status.counts.active || 0) };
}


