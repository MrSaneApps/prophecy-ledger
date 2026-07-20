import { triageDescription } from "./ai.js";
import { fetchHtml } from "./fetch.js";
import { stableId, sha256 } from "./hash.js";
import {
  addRevision, claimJob, claimSuccessorDispatch, completeJob, createRun, failJob,
  completedTranscriptChunks, deferJob, finishRecoveryDispatch,
  linkExactEmbedded, nowIso, reconcileRun, recordAvailability, recordScanReceipt,
  recordSourceMediaMetadata, recordTranscriptChunkAttempt, recordTranscriptUnavailable, recoveryCandidates, registerJob,
  reserveGeminiMedia, reserveRecoveryDispatch, persistFirstPartyArchive,
  resetSuccessorDispatch, runStatus, upsertSourceItem,
} from "./repository.js";
import {
  ensureTranscriptAnalysisPreparationRun, fetchYouTubeDataApiDuration, fetchYouTubeDuration,
  prepareTranscriptAnalysisFromArtifact, processTranscriptAnalysis,
  recordTranscriptAnalysisFailure, refreshAnalysisRun, registerTranscriptAnalysisJobs, requestTranscriptChunk,
  STITCH_ALGORITHM, stitchTranscript,
  transcriptAnalysisPreparationEnvelope, CLAIM_EXTRACTION_PROMPT_VERSION,
  TRANSCRIPT_MODEL, TRANSCRIPT_PROMPT_VERSION, transcriptPlan,
} from "./transcript.js";
import {
  completeTranscriptBatchItem, dispatchTranscriptBatchEnvelope, dispatchTranscriptBatchSuccessor,
  nextTranscriptBatchDay, pauseTranscriptBatch,
} from "./transcript-batch.js";
import { archiveNextPageState, archiveUrl, parseArchivePage, parseFulfilledProphecyArchive, parsePostDetail } from "./wordpress.js";
import {
  processPrimaryVideoAnalysis, processTiebreakerVideoAnalysis, processVerifierVideoAnalysis,
} from "./video-analysis.js";
const TYPES = new Set([
  "archive_page", "post_detail", "video_metadata", "description_triage", "transcript_extract", "run_reconcile",
  "video_analysis_primary", "video_analysis_verify", "video_analysis_tiebreak",
]);
const PERSON_ID = "person_troy_black";
const VIDEO_ANALYSIS_LEASE_MS = 300_000;
const TRANSCRIPT_LEASE_MS = 900_000;
function validateTrustedVideoPayload(payload) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(payload.youtubeId || "")) throw new Error("invalid_youtube_id");
  if (!/^src_[a-f0-9]{32}$/.test(payload.sourceItemId || "")) throw new Error("trusted_source_item_required");
}
export async function makeEnvelope({ runId, personId = PERSON_ID, type, stableKey, payload = {} }) {
  const jobId = await stableId("job", `${runId}:${type}:${stableKey}`);
  return { version: 1, jobId, runId, personId, type, stableKey, payload };
}
export function validateEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_envelope");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "jobId,payload,personId,runId,stableKey,type,version") throw new Error("invalid_envelope_fields");
  if (value.version !== 1 || !TYPES.has(value.type)) throw new Error("unsupported_job");
  for (const key of ["jobId", "runId", "personId", "stableKey"]) if (typeof value[key] !== "string" || !value[key]) throw new Error("invalid_envelope_field");
  if (!/^person_[a-z0-9_]+$/.test(value.personId) || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw new Error("invalid_job_scope");
  const firstPartyArchive = value.type === "archive_page" && value.payload.archiveSourceId !== undefined;
  if (value.type !== "transcript_extract" && !firstPartyArchive && value.personId !== PERSON_ID) throw new Error("invalid_job_scope");
  if (value.type === "archive_page" && !firstPartyArchive &&
      (!Number.isInteger(value.payload.page) || value.payload.page < 1 || value.payload.page > 250)) throw new Error("invalid_archive_page");
  if (firstPartyArchive && (!/^[A-Za-z0-9_-]{3,100}$/.test(value.payload.archiveSourceId || "") ||
      value.payload.adapter !== "wptb_fulfilled_prophecy_v1" ||
      !Number.isInteger(value.payload.expectedMinRows) || value.payload.expectedMinRows < 1 ||
      value.payload.expectedMinRows > 500 ||
      Object.keys(value.payload).sort().join(",") !== "adapter,archiveSourceId,expectedMinRows")) {
    throw new Error("invalid_first_party_archive_payload");
  }
  if (value.type === "post_detail" && !/^\d+$/.test(value.payload.platformItemId || "")) throw new Error("invalid_post_id");
  if (value.type === "description_triage" && !/^src_[a-f0-9]{32}$/.test(value.payload.sourceItemId || "")) throw new Error("invalid_source_item_id");
  if (["video_metadata", "video_analysis_primary", "video_analysis_verify", "video_analysis_tiebreak"].includes(value.type)) validateTrustedVideoPayload(value.payload);
  if (value.type === "transcript_extract") {
    if (value.payload.phase === "prepare") {
      const keys = Object.keys(value.payload).sort().join(",");
      if (keys !== "analysisRunId,phase,promptVersion,sourceItemId,transcriptId,transcriptSha256" ||
          !/^txan_[a-f0-9]{32}$/.test(value.payload.analysisRunId || "") ||
          !/^tx_[a-f0-9]{32}$/.test(value.payload.transcriptId || "") ||
          !/^src_[a-f0-9]{32}$/.test(value.payload.sourceItemId || "") ||
          !/^[a-f0-9]{64}$/.test(value.payload.transcriptSha256 || "") ||
          value.payload.promptVersion !== CLAIM_EXTRACTION_PROMPT_VERSION) {
        throw new Error("invalid_transcript_analysis_preparation_payload");
      }
      return value;
    }
    if (value.payload.phase === "analyze") {
      const keys = Object.keys(value.payload).sort().join(",");
      if (keys !== "analysisRunId,analysisSectionId,inputSha256,phase,promptVersion,sectionIndex,sourceItemId,transcriptId,transcriptSha256" ||
          !/^txan_[a-f0-9]{32}$/.test(value.payload.analysisRunId || "") ||
          !/^txas_[a-f0-9]{32}$/.test(value.payload.analysisSectionId || "") ||
          !/^tx_[a-f0-9]{32}$/.test(value.payload.transcriptId || "") ||
          !/^src_[a-f0-9]{32}$/.test(value.payload.sourceItemId || "") ||
          !Number.isInteger(value.payload.sectionIndex) || value.payload.sectionIndex < 0 ||
          !/^[a-f0-9]{64}$/.test(value.payload.transcriptSha256 || "") ||
          !/^[a-f0-9]{64}$/.test(value.payload.inputSha256 || "") ||
          value.payload.promptVersion !== CLAIM_EXTRACTION_PROMPT_VERSION) {
        throw new Error("invalid_transcript_analysis_payload");
      }
      return value;
    }
    validateTrustedVideoPayload(value.payload);
    if (!["chunk", "stitch"].includes(value.payload.phase) || !Number.isInteger(value.payload.durationSeconds) ||
        value.payload.durationSeconds < 1 || value.payload.durationSeconds > 43_200) throw new Error("invalid_transcript_payload");
    if (value.payload.phase === "chunk" && (!Number.isInteger(value.payload.chunkIndex) || value.payload.chunkIndex < 0)) throw new Error("invalid_transcript_chunk");
    const hasBatchId = value.payload.batchId !== undefined;
    const hasBatchItemId = value.payload.batchItemId !== undefined;
    if (hasBatchId !== hasBatchItemId || (hasBatchId &&
      (!/^txb_[a-f0-9]{32}$/.test(value.payload.batchId) ||
       !/^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/.test(value.payload.batchItemId)))) throw new Error("invalid_transcript_batch_payload");
  }
  if (["video_analysis_verify", "video_analysis_tiebreak"].includes(value.type) && !/^vaa_[a-f0-9]{32}$/.test(value.payload.primaryAttemptId || "")) throw new Error("invalid_primary_attempt_id");
  if (value.type === "video_analysis_tiebreak") {
    if (!/^vaa_[a-f0-9]{32}$/.test(value.payload.verifierAttemptId || "")) throw new Error("invalid_verifier_attempt_id");
    if (!Array.isArray(value.payload.candidateIds) || !value.payload.candidateIds.length || value.payload.candidateIds.length > 25 ||
        new Set(value.payload.candidateIds).size !== value.payload.candidateIds.length ||
        value.payload.candidateIds.some((id) => !/^vcc_[a-f0-9]{32}$/.test(id))) throw new Error("invalid_video_candidate_ids");
  }
  return value;
}

async function validateEnvelopeIdentity(env, envelope) {
  const expectedJobId = await stableId("job", `${envelope.runId}:${envelope.type}:${envelope.stableKey}`);
  if (envelope.jobId !== expectedJobId) throw new Error("invalid_job_identity");
  if (envelope.payload.phase === "prepare") {
    const expectedAnalysisRunId = await stableId("txan",
      `${envelope.payload.transcriptId}:${envelope.payload.promptVersion}`);
    const expectedRunId = await stableId("runan",
      `${expectedAnalysisRunId}:${envelope.payload.sourceItemId}`);
    const expectedStableKey = `transcript:${envelope.payload.transcriptId}:analysis:prepare:${envelope.payload.promptVersion}`;
    if (envelope.payload.analysisRunId !== expectedAnalysisRunId || envelope.runId !== expectedRunId ||
        envelope.stableKey !== expectedStableKey) throw new Error("invalid_transcript_analysis_binding");
    const bound = await env.DB.prepare(`SELECT 1 ok FROM transcript_artifacts artifact
      JOIN source_items source ON source.source_item_id=artifact.source_item_id
      WHERE artifact.transcript_id=?1 AND artifact.source_item_id=?2
        AND artifact.content_sha256=?3 AND source.person_id=?4
        AND artifact.provenance='gemini_generated_public_youtube_clipped_v1'`)
      .bind(envelope.payload.transcriptId, envelope.payload.sourceItemId,
        envelope.payload.transcriptSha256, envelope.personId).first();
    if (!bound) throw new Error("invalid_transcript_analysis_binding");
    return;
  }
  if (envelope.payload.phase === "analyze") {
    const expectedStableKey = `transcript:${envelope.payload.transcriptId}:analysis:${envelope.payload.sectionIndex}:${envelope.payload.promptVersion}`;
    if (envelope.stableKey !== expectedStableKey) throw new Error("invalid_transcript_analysis_binding");
    const bound = await env.DB.prepare(`SELECT 1 ok FROM transcript_analysis_sections section
      JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
      JOIN ingestion_runs run ON run.run_id=analysis.ingestion_run_id
      JOIN source_items source ON source.source_item_id=analysis.source_item_id
      WHERE section.analysis_section_id=?1 AND section.analysis_run_id=?2
        AND section.section_index=?3 AND section.input_sha256=?4
        AND analysis.ingestion_run_id=?5 AND analysis.transcript_id=?6
        AND analysis.source_item_id=?7 AND analysis.transcript_sha256=?8
        AND analysis.prompt_version=?9 AND run.person_id=?10 AND source.person_id=?10`)
      .bind(envelope.payload.analysisSectionId, envelope.payload.analysisRunId,
        envelope.payload.sectionIndex, envelope.payload.inputSha256, envelope.runId,
        envelope.payload.transcriptId, envelope.payload.sourceItemId,
        envelope.payload.transcriptSha256, envelope.payload.promptVersion,
        envelope.personId).first();
    if (!bound) throw new Error("invalid_transcript_analysis_binding");
    return;
  }
  if (!envelope.payload.batchId) return;
  const expectedStableKey = envelope.payload.phase === "chunk"
    ? `youtube:${envelope.payload.youtubeId}:transcript:chunk:${envelope.payload.chunkIndex}`
    : `youtube:${envelope.payload.youtubeId}:transcript:stitch`;
  if (envelope.stableKey !== expectedStableKey) throw new Error("invalid_transcript_batch_binding");
  const bound = await env.DB.prepare(`SELECT 1 ok FROM transcript_batch_items item
    JOIN transcript_batches batch ON batch.batch_id=item.batch_id
    JOIN ingestion_runs run ON run.run_id=item.run_id
    JOIN source_items source ON source.source_item_id=item.source_item_id
    WHERE item.batch_id=?1 AND item.batch_item_id=?2 AND item.run_id=?3
      AND item.source_item_id=?4 AND item.youtube_id=?5 AND item.duration_seconds=?6
      AND batch.person_id=?7 AND run.person_id=?7
      AND run.scope=?8 AND source.person_id=?7 AND source.platform='youtube'
      AND source.platform_item_id=?5`).bind(envelope.payload.batchId,
      envelope.payload.batchItemId, envelope.runId, envelope.payload.sourceItemId,
      envelope.payload.youtubeId, envelope.payload.durationSeconds, envelope.personId,
      `transcript:${envelope.payload.sourceItemId}:${envelope.payload.durationSeconds}:batch:${envelope.payload.batchId}`).first();
  if (!bound) throw new Error("invalid_transcript_batch_binding");
}
export async function startScan(env, { triggerType = "manual", canary = false, runId = `run_${crypto.randomUUID()}` } = {}) {
  if (env.SCAN_ENABLED !== "1" && triggerType === "scheduled") return { started: false, reason: "scanner_disabled" };
  if (!canary) {
    const existing = await env.DB.prepare(`SELECT run_id,status FROM ingestion_runs
      WHERE person_id=?1 AND scope='official_site' AND status IN ('queued','running')
        AND trigger_type <> 'canary' ORDER BY created_at LIMIT 1`).bind(PERSON_ID).first();
    if (existing) return { started: true, reused: true, runId: existing.run_id, status: existing.status };
  }
  await createRun(env.DB, { runId, personId: PERSON_ID, triggerType: canary ? "canary" : triggerType, scope: "official_site" });
  const first = await makeEnvelope({ runId, type: "archive_page", stableKey: "official-site:prophetic-words:page:1", payload: { page: 1, canary } });
  await registerJob(env.DB, first);
  try { await env.INGESTION_QUEUE.send(first); }
  catch (error) { return { started: false, runId, reason: "queue_dispatch_failed" }; }
  return { started: true, runId, firstJobId: first.jobId, canary };
}
export async function startFirstPartyArchiveIngest(env, {
  sourceId, expectedMinRows = 1, runId = `run_${crypto.randomUUID()}`,
} = {}) {
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(sourceId || "")) return { started: false, reason: "invalid_archive_source_id" };
  if (!Number.isInteger(expectedMinRows) || expectedMinRows < 1 || expectedMinRows > 500) {
    return { started: false, reason: "invalid_expected_min_rows" };
  }
  const source = await env.DB.prepare(`SELECT source.source_id,source.person_id,source.url,
      person.slug person_slug
    FROM sources source JOIN people person ON person.person_id=source.person_id
    WHERE source.source_id=?1 AND source.source_type='archive'
      AND source.source_role='retrospective_fulfillment'
      AND source.identity_status='confirmed' AND source.availability='available'`)
    .bind(sourceId).first();
  if (!source) return { started: false, reason: "trusted_archive_source_not_found" };
  const scope = `first_party_archive:${source.source_id}`;
  const active = await env.DB.prepare(`SELECT run_id,status FROM ingestion_runs
    WHERE person_id=?1 AND scope=?2 AND status IN ('queued','running')
    ORDER BY created_at DESC,run_id DESC LIMIT 1`).bind(source.person_id, scope).first();
  if (active) return { started: true, reused: true, runId: active.run_id, status: active.status };
  await createRun(env.DB, { runId, personId: source.person_id, triggerType: "manual", scope });
  const first = await makeEnvelope({
    runId, personId: source.person_id, type: "archive_page",
    stableKey: `first-party-archive:${source.source_id}:wptb-v1`,
    payload: { archiveSourceId: source.source_id, adapter: "wptb_fulfilled_prophecy_v1", expectedMinRows },
  });
  await registerJob(env.DB, first);
  try { await env.INGESTION_QUEUE.send(first); }
  catch { return { started: false, runId, reason: "queue_dispatch_failed" }; }
  return { started: true, runId, firstJobId: first.jobId, personSlug: source.person_slug, sourceId: source.source_id };
}
export async function startVideoAnalysisCanary(env, { youtubeId, force = false, runId = null } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId || "")) return { started: false, reason: "invalid_youtube_id" };
  const item = await env.DB.prepare(`SELECT * FROM source_items
    WHERE person_id=?1 AND platform='youtube' AND platform_item_id=?2 AND canonical_url=?3`)
    .bind(PERSON_ID, youtubeId, `https://www.youtube.com/watch?v=${youtubeId}`).first();
  if (!item) return { started: false, reason: "trusted_source_item_not_found" };
  const prior = await env.DB.prepare(`SELECT run_id,status FROM ingestion_runs
    WHERE person_id=?1 AND scope=?2 ORDER BY created_at DESC,run_id DESC LIMIT 1`)
    .bind(PERSON_ID, `video_analysis:${item.source_item_id}`).first();
  if (prior && (!force || ["queued", "running"].includes(prior.status))) {
    return { started: true, reused: true, runId: prior.run_id, status: prior.status };
  }
  const selectedRunId = force ? (runId || `run_${crypto.randomUUID()}`) :
    await stableId("runv", `video-analysis-v1:${item.source_item_id}`);
  const created = await createRun(env.DB, {
    runId: selectedRunId, personId: PERSON_ID, triggerType: "canary", scope: `video_analysis:${item.source_item_id}`,
  });
  if (!created.inserted) return { started: true, reused: true, runId: selectedRunId, status: created.status };
  const first = await makeEnvelope({
    runId: selectedRunId, type: "video_analysis_primary", stableKey: `youtube:${youtubeId}:primary`,
    payload: { youtubeId, sourceItemId: item.source_item_id },
  });
  await registerJob(env.DB, first);
  try { await env.INGESTION_QUEUE.send(first); }
  catch (error) { return { started: false, runId: selectedRunId, reason: "queue_dispatch_failed" }; }
  return { started: true, runId: selectedRunId, firstJobId: first.jobId, youtubeId };
}
export async function startTranscriptCanary(env, { personSlug = "troy-black", youtubeId, expectedDurationSeconds = null,
  force = false, runId = null, durationFetcher = fetch } = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(personSlug || "")) return { started: false, reason: "invalid_person_slug" };
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId || "")) return { started: false, reason: "invalid_youtube_id" };
  if (expectedDurationSeconds !== null && (!Number.isInteger(expectedDurationSeconds) || expectedDurationSeconds < 1 || expectedDurationSeconds > 43_200)) return { started: false, reason: "invalid_video_duration" };
  const activeBatch = await env.DB.prepare(`SELECT batch_id FROM transcript_batches
    WHERE status IN ('running','paused') LIMIT 1`).first();
  if (activeBatch) return { started: false, reason: "transcript_batch_active", batchId: activeBatch.batch_id };
  const item = await env.DB.prepare(`SELECT item.*,person.slug FROM source_items item
    JOIN people person ON person.person_id=item.person_id
    WHERE person.slug=?1 AND item.platform='youtube' AND item.platform_item_id=?2 AND item.canonical_url=?3`)
    .bind(personSlug, youtubeId, `https://www.youtube.com/watch?v=${youtubeId}`).first();
  if (!item) return { started: false, reason: "trusted_source_item_not_found" };
  const hasYouTubeDataApi = typeof env.YOUTUBE_DATA_API_KEY === "string" && env.YOUTUBE_DATA_API_KEY.length > 0;
  let duration; let durationMethod = hasYouTubeDataApi
    ? "youtube_data_api_v3_content_details" : "youtube_public_html_length_seconds";
  try {
    duration = hasYouTubeDataApi
      ? await fetchYouTubeDataApiDuration({ youtubeId, apiKey: env.YOUTUBE_DATA_API_KEY, fetcher: durationFetcher })
      : await fetchYouTubeDuration({ youtubeId, fetcher: durationFetcher });
  }
  catch (error) {
    const operatorFallback = new Set(["youtube_duration_redirect_blocked", "youtube_duration_network_error", "youtube_duration_timeout"]);
    if (hasYouTubeDataApi || expectedDurationSeconds === null || !operatorFallback.has(error.message)) {
      return { started: false, reason: error.message || "youtube_duration_failed" };
    }
    durationMethod = "operator_supplied_authenticated";
    duration = { durationSeconds: expectedDurationSeconds,
      responseSha256: await sha256({ source: durationMethod, personSlug, youtubeId, durationSeconds: expectedDurationSeconds }) };
  }
  if (expectedDurationSeconds !== null && expectedDurationSeconds !== duration.durationSeconds) return { started: false, reason: "video_duration_mismatch" };
  const durationSeconds = duration.durationSeconds;
  await recordSourceMediaMetadata(env.DB, { sourceItemId: item.source_item_id, durationSeconds,
    responseSha256: duration.responseSha256, method: durationMethod });
  const scope = `transcript:${item.source_item_id}:${durationSeconds}`;
  const prior = await env.DB.prepare(`SELECT run_id,status FROM ingestion_runs
    WHERE person_id=?1 AND scope=?2 ORDER BY created_at DESC,run_id DESC LIMIT 1`)
    .bind(item.person_id, scope).first();
  if (prior && (!force || ["queued", "running"].includes(prior.status))) return { started: true, reused: true, runId: prior.run_id, status: prior.status };
  const selectedRunId = force ? (runId || `run_${crypto.randomUUID()}`) : await stableId("runtx", `transcript-v1:${item.source_item_id}:${durationSeconds}`);
  const created = await createRun(env.DB, { runId: selectedRunId, personId: item.person_id, triggerType: "canary", scope });
  if (!created.inserted) return { started: true, reused: true, runId: selectedRunId, status: created.status };
  const first = await makeEnvelope({ runId: selectedRunId, personId: item.person_id, type: "transcript_extract",
    stableKey: `youtube:${youtubeId}:transcript:chunk:0`,
    payload: { phase: "chunk", chunkIndex: 0, youtubeId, sourceItemId: item.source_item_id, durationSeconds } });
  await registerJob(env.DB, first);
  try { await env.INGESTION_QUEUE.send(first); }
  catch { return { started: false, runId: selectedRunId, reason: "queue_dispatch_failed" }; }
  return { started: true, runId: selectedRunId, firstJobId: first.jobId, personSlug, youtubeId, durationSeconds,
    durationProvenance: durationMethod };
}

export async function reprocessTranscriptAnalysis(env, { transcriptId, at = nowIso() } = {}) {
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(transcriptId || "")) {
    return { started: false, reason: "invalid_transcript_id" };
  }
  const artifact = await env.DB.prepare(`SELECT artifact.transcript_id,artifact.source_item_id,
      artifact.content_sha256,artifact.provenance,source.person_id
    FROM transcript_artifacts artifact
    JOIN source_items source ON source.source_item_id=artifact.source_item_id
    WHERE artifact.transcript_id=?1`).bind(transcriptId).first();
  if (!artifact || artifact.provenance !== "gemini_generated_public_youtube_clipped_v1") {
    return { started: false, reason: "trusted_transcript_not_found" };
  }
  const envelope = await transcriptAnalysisPreparationEnvelope({ transcriptId: artifact.transcript_id,
    sourceItemId: artifact.source_item_id, personId: artifact.person_id,
    transcriptSha256: artifact.content_sha256 });
  await ensureTranscriptAnalysisPreparationRun(env.DB, envelope, at);
  const job = await registerJob(env.DB, envelope, at);
  if (job.run_id !== envelope.runId || job.job_type !== envelope.type ||
      job.stable_key !== envelope.stableKey || job.payload_json !== JSON.stringify(envelope.payload)) {
    throw new Error("invalid_transcript_analysis_binding");
  }
  if (job.status === "completed") {
    const retry = await retryFailedTranscriptAnalysisSections(env, envelope, at);
    if (retry.retried > 0) {
      return { started: true, reused: false, runId: envelope.runId,
        analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
        promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: "queued", ...retry };
    }
    if (retry.dispatchFailed > 0) {
      return { started: false, runId: envelope.runId,
        analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
        promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION,
        reason: "queue_dispatch_failed", ...retry };
    }
    return { started: true, reused: true, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: job.status, ...retry };
  }
  if (job.status !== "queued") {
    return { started: true, reused: true, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: job.status };
  }
  const reservation = `analysis_dispatch_${crypto.randomUUID()}`;
  const reserved = await env.DB.prepare(`UPDATE ingestion_jobs SET
      lease_token=?2,error_code='admin_analysis_reprocess_dispatching'
    WHERE job_id=?1 AND status='queued'
      AND (error_code IS NULL OR error_code='admin_analysis_reprocess_dispatch_pending')`)
    .bind(envelope.jobId, reservation).run();
  if (!reserved.meta?.changes) {
    return { started: true, reused: true, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: "queued" };
  }
  try {
    await env.INGESTION_QUEUE.send(envelope);
    await env.DB.prepare(`UPDATE ingestion_jobs SET lease_token=NULL,
        error_code='admin_analysis_reprocess_dispatched'
      WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
      .bind(envelope.jobId, reservation).run();
  } catch {
    await env.DB.prepare(`UPDATE ingestion_jobs SET lease_token=NULL,
        error_code='admin_analysis_reprocess_dispatch_pending'
      WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
      .bind(envelope.jobId, reservation).run();
    return { started: false, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, reason: "queue_dispatch_failed" };
  }
  return { started: true, reused: false, runId: envelope.runId,
    analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
    promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: "queued" };
}

const RETRYABLE_ANALYSIS_FAILURE = /network|timeout|upstream_429|upstream_5|ai_unavailable|queue/i;
const REPAIRED_ANALYSIS_FAILURE =
  /^D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_FOREIGNKEY\)$/;

function analysisFailureCanRetry(errorCode) {
  return RETRYABLE_ANALYSIS_FAILURE.test(errorCode || "") ||
    REPAIRED_ANALYSIS_FAILURE.test(errorCode || "");
}

async function retryFailedTranscriptAnalysisSections(env, preparation, at) {
  const rows = await env.DB.prepare(`SELECT section.analysis_section_id,section.error_code section_error_code,
      section.completed_at section_completed_at,job.job_id,job.attempt_count,
      job.error_code job_error_code,
      job.completed_at job_completed_at,job.run_id,job.job_type,job.stable_key,job.payload_json,
      run.person_id
    FROM transcript_analysis_sections section
    JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
    JOIN ingestion_jobs job ON job.run_id=analysis.ingestion_run_id
      AND json_extract(job.payload_json,'$.analysisSectionId')=section.analysis_section_id
    JOIN ingestion_runs run ON run.run_id=job.run_id
    WHERE section.analysis_run_id=?1 AND analysis.prompt_version=?2
      AND section.status='failed' AND job.status='failed'
      AND job.job_type='transcript_extract' AND job.attempt_count<8
      AND json_extract(job.payload_json,'$.phase')='analyze'
    ORDER BY section.section_index LIMIT 8`)
    .bind(preparation.payload.analysisRunId, CLAIM_EXTRACTION_PROMPT_VERSION).all();
  const retryable = (rows.results || []).filter((row) =>
    analysisFailureCanRetry(row.section_error_code) &&
    analysisFailureCanRetry(row.job_error_code));
  const reserved = [];
  for (const row of retryable) {
    const reservation = `analysis_retry_${crypto.randomUUID()}`;
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE ingestion_jobs SET status='queued',claimed_at=NULL,
          lease_token=?2,completed_at=NULL
        WHERE job_id=?1 AND status='failed' AND error_code=?3`)
        .bind(row.job_id, reservation, row.job_error_code),
      env.DB.prepare(`UPDATE transcript_analysis_sections SET status='queued',completed_at=NULL,
          error_code=?3
        WHERE analysis_section_id=?1 AND status='failed' AND error_code=?3
          AND EXISTS (SELECT 1 FROM ingestion_jobs WHERE job_id=?2 AND status='queued'
            AND lease_token=?4 AND error_code=?5)`)
        .bind(row.analysis_section_id, row.job_id, row.section_error_code, reservation,
          row.job_error_code),
    ]);
    if (results[0].meta?.changes && results[1].meta?.changes) {
      reserved.push({ ...row, reservation, envelope: {
        version: 1, jobId: row.job_id, runId: row.run_id, personId: row.person_id,
        type: row.job_type, stableKey: row.stable_key, payload: JSON.parse(row.payload_json),
      } });
    } else if (results[0].meta?.changes) {
      await env.DB.prepare(`UPDATE ingestion_jobs SET status='failed',lease_token=NULL,
          completed_at=?3,error_code=?4
        WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
        .bind(row.job_id, reservation, row.job_completed_at, row.job_error_code).run();
    }
  }
  if (!reserved.length) return { eligibleFailed: retryable.length, retried: 0, dispatchFailed: 0 };
  await refreshAnalysisRun(env.DB, preparation.payload.analysisRunId, at);
  await env.DB.prepare(`UPDATE ingestion_runs SET status='running',completed_at=NULL
    WHERE run_id=?1`).bind(preparation.runId).run();
  let retried = 0; let dispatchFailed = 0;
  for (const item of reserved) {
    try {
      await env.INGESTION_QUEUE.send(item.envelope);
      await env.DB.prepare(`UPDATE ingestion_jobs SET claimed_at=NULL,lease_token=NULL
        WHERE job_id=?1 AND status='queued' AND lease_token=?2
          AND error_code=?3`)
        .bind(item.job_id, item.reservation, item.job_error_code).run();
      retried += 1;
    } catch {
      await env.DB.batch([
        env.DB.prepare(`UPDATE ingestion_jobs SET status='failed',claimed_at=NULL,lease_token=NULL,
            completed_at=?3,error_code=?4
          WHERE job_id=?1 AND status='queued' AND lease_token=?2
            AND error_code=?4`)
          .bind(item.job_id, item.reservation, item.job_completed_at, item.job_error_code),
        env.DB.prepare(`UPDATE transcript_analysis_sections SET status='failed',completed_at=?3,
            error_code=?4
          WHERE analysis_section_id=?1 AND status='queued'
            AND error_code=?4
            AND EXISTS (SELECT 1 FROM ingestion_jobs WHERE job_id=?2 AND status='failed')`)
          .bind(item.analysis_section_id, item.job_id,
            item.section_completed_at, item.section_error_code),
      ]);
      dispatchFailed += 1;
    }
  }
  await refreshAnalysisRun(env.DB, preparation.payload.analysisRunId, at);
  if (dispatchFailed && !retried) await reconcileRun(env.DB, preparation.runId, at);
  return { eligibleFailed: retryable.length, retried, dispatchFailed };
}
async function archiveHandler(env, envelope, fetcher) {
  if (envelope.payload.archiveSourceId) return firstPartyArchiveHandler(env, envelope, fetcher);
  const { page, canary = false } = envelope.payload;
  const response = await fetcher(archiveUrl(page));
  const cards = parseArchivePage(response.html);
  const nextPageState = archiveNextPageState(response.html, page);
  const detailSuccessors = [];
  for (const card of cards) {
    const item = await upsertSourceItem(env.DB, {
      personId: envelope.personId, sourceId: "source_troy_site", platform: "official_site",
      platformItemId: card.platformItemId, canonicalUrl: card.canonicalUrl,
    });
    await addRevision(env.DB, item.source_item_id, card, {
      runId: envelope.runId, parserVersion: env.PARSER_VERSION || "official-site-v1",
    });
    await recordAvailability(env.DB, { sourceItemId: item.source_item_id, availability: "available", runId: envelope.runId, resultCode: "archive_seen" });
    detailSuccessors.push(await makeEnvelope({
      runId: envelope.runId, type: "post_detail", stableKey: `official-site:post:${card.platformItemId}`,
      payload: { platformItemId: card.platformItemId },
    }));
  }
  const lastContentPage = cards.length ? page : Math.max(0, page - 1);
  await env.DB.prepare("UPDATE ingestion_runs SET archive_last_page=?2 WHERE run_id=?1 AND COALESCE(archive_last_page,0) < ?2")
    .bind(envelope.runId, lastContentPage).run();
  const successors = [];
  if (!cards.length || nextPageState === false || page === 250 || canary) {
    const count = await env.DB.prepare(`SELECT count(DISTINCT event.source_item_id) count
      FROM source_availability_events event JOIN source_items item ON item.source_item_id=event.source_item_id
      WHERE event.run_id=?1 AND event.result_code='archive_seen' AND item.person_id=?2 AND item.platform='official_site'`)
      .bind(envelope.runId, envelope.personId).first();
    await recordScanReceipt(env.DB, {
      runId: envelope.runId, personId: envelope.personId, sourceName: "official_site",
      status: page === 250 ? "partial" : "complete", itemCount: Number(count?.count || 0), lastPageOrCursor: String(lastContentPage),
      publicExplanation: page === 250 ? "The scan reached its 250-page safety limit." : canary ? "One archive page was checked as a canary." : "The official Prophetic Words archive was checked page by page.",
    });
    await env.DB.prepare("UPDATE ingestion_runs SET discovery_finished_at=?2 WHERE run_id=?1").bind(envelope.runId, nowIso()).run();
  } else {
    // Keep discovery moving ahead of slower detail and AI enrichment while
    // preserving the Queue's existing concurrency and site-fetch limits.
    successors.push(await makeEnvelope({
      runId: envelope.runId, type: "archive_page", stableKey: `official-site:prophetic-words:page:${page + 1}`,
      payload: { page: page + 1, canary: false },
    }));
  }
  successors.push(...detailSuccessors);
  successors.push(await makeEnvelope({ runId: envelope.runId, type: "run_reconcile", stableKey: `after:archive:${page}`, payload: {} }));
  return successors;
}
async function firstPartyArchiveHandler(env, envelope, fetcher) {
  const source = await env.DB.prepare(`SELECT source.source_id,source.person_id,source.url
    FROM sources source WHERE source.source_id=?1 AND source.person_id=?2
      AND source.source_type='archive' AND source.source_role='retrospective_fulfillment'
      AND source.identity_status='confirmed' AND source.availability='available'`)
    .bind(envelope.payload.archiveSourceId, envelope.personId).first();
  if (!source) throw new Error("trusted_archive_source_not_found");
  const response = await fetcher(source.url);
  const responseSha256 = await sha256(response.html);
  const parserVersion = env.ARCHIVE_PARSER_VERSION || "wptb-fulfilled-prophecy-v1";
  const rows = parseFulfilledProphecyArchive(response.html, { sourceUrl: source.url });
  if (!rows.length) throw new Error("first_party_archive_rows_not_found");
  if (rows.length < envelope.payload.expectedMinRows) throw new Error("first_party_archive_below_expected_min_rows");
  const stored = await persistFirstPartyArchive(env.DB, {
    runId: envelope.runId, sourceId: source.source_id, personId: source.person_id,
    sourceUrl: source.url, adapter: envelope.payload.adapter, parserVersion,
    responseSha256, rows,
  });
  await recordScanReceipt(env.DB, {
    runId: envelope.runId, personId: source.person_id,
    sourceName: `first_party_archive:${source.source_id}`, status: "complete",
    itemCount: rows.length, lastPageOrCursor: responseSha256,
    publicExplanation: "A frozen first-party retrospective archive was indexed as unverified leads. No claims or outcomes were created.",
  });
  await env.DB.prepare("UPDATE ingestion_runs SET discovery_finished_at=?2 WHERE run_id=?1")
    .bind(envelope.runId, nowIso()).run();
  return [await makeEnvelope({ runId: envelope.runId, personId: envelope.personId,
    type: "run_reconcile", stableKey: `after:first-party-archive:${source.source_id}`,
    payload: { archiveReceiptId: stored.receiptId } })];
}
async function detailHandler(env, envelope, fetcher) {
  const item = await env.DB.prepare("SELECT * FROM source_items WHERE person_id=?1 AND platform='official_site' AND platform_item_id=?2")
    .bind(envelope.personId, envelope.payload.platformItemId).first();
  if (!item) throw new Error("source_item_not_found");
  const response = await fetcher(item.canonical_url);
  const detail = parsePostDetail(response.html, item.canonical_url);
  if (!detail.publicationDate) {
    const prior = await env.DB.prepare(`SELECT publication_date FROM source_item_revisions
      WHERE source_item_id=?1 AND publication_date IS NOT NULL
      ORDER BY fetched_at DESC,revision_id DESC LIMIT 1`).bind(item.source_item_id).first();
    detail.publicationDate = prior?.publication_date || null;
  }
  const revision = await addRevision(env.DB, item.source_item_id, detail, {
    runId: envelope.runId, parserVersion: env.PARSER_VERSION || "official-site-v1",
  });
  const successors = [await makeEnvelope({
    runId: envelope.runId, type: "description_triage", stableKey: `revision:${revision.revisionId}`,
    payload: { sourceItemId: item.source_item_id, revisionId: revision.revisionId },
  })];
  if (detail.embeddedItemId) {
    const video = await upsertSourceItem(env.DB, {
      personId: envelope.personId, platform: "youtube", platformItemId: detail.embeddedItemId,
      canonicalUrl: detail.embeddedUrl, availability: "unknown",
    });
    await linkExactEmbedded(env.DB, item.source_item_id, video.source_item_id);
    await recordTranscriptUnavailable(env.DB, {
      sourceItemId: video.source_item_id, method: "authorized_transcript_only", provider: "youtube",
      status: "authorization_required", errorCode: "transcript_not_supplied",
    });
    successors.push(await makeEnvelope({
      runId: envelope.runId, type: "video_metadata", stableKey: `youtube:${detail.embeddedItemId}`,
      payload: { youtubeId: detail.embeddedItemId, sourceItemId: video.source_item_id },
    }));
  }
  return successors;
}
async function triageHandler(env, envelope) {
  const revision = await env.DB.prepare(`SELECT r.* FROM source_item_revisions r
    WHERE r.revision_id=?1 AND r.source_item_id=?2`).bind(envelope.payload.revisionId, envelope.payload.sourceItemId).first();
  if (!revision) throw new Error("revision_not_found");
  if (!revision.first_party_description?.trim()) return [];
  const inputSha = await sha256({ title: revision.public_title, description: revision.first_party_description });
  const extractionId = await stableId("ext", `${revision.source_item_id}:${inputSha}:description-v1`);
  const existingExtraction = await env.DB.prepare(`SELECT status FROM extraction_runs
    WHERE extraction_run_id=?1 AND input_sha256=?2`).bind(extractionId, inputSha).first();
  if (existingExtraction?.status === "completed") return [];
  const result = await triageDescription(env.AI, {
    title: revision.public_title, description: revision.first_party_description,
    models: [env.AI_MODEL, env.AI_FALLBACK_MODEL],
    timeoutMs: Number.isFinite(Number(env.AI_TIMEOUT_MS)) && Number(env.AI_TIMEOUT_MS) > 0
      ? Number(env.AI_TIMEOUT_MS) : 45_000,
  });
  await env.DB.prepare(`INSERT OR IGNORE INTO extraction_runs
    (extraction_run_id,source_item_id,input_kind,input_sha256,prompt_version,model_family,status,started_at,completed_at)
    VALUES (?1,?2,'first_party_description',?3,'description-v1',?4,'completed',?5,?5)`)
    .bind(extractionId, revision.source_item_id, inputSha, result.model || "none", nowIso()).run();
  if (["testable_prediction", "other_claimed_revelation"].includes(result.category)) {
    const candidateId = await stableId("cand", `${extractionId}:${revision.source_item_id}:${inputSha}:description-v1:0`);
    await env.DB.prepare(`INSERT OR IGNORE INTO claim_candidates
      (candidate_id,extraction_run_id,source_item_id,candidate_kind,neutral_paraphrase,exact_quote,
       proposed_statement_type,requires_transcript,requires_human_review,created_at)
      VALUES (?1,?2,?3,'description_lead',?4,NULL,?5,1,1,?6)`)
      .bind(candidateId, extractionId, revision.source_item_id, result.neutralParaphrase,
        result.category === "testable_prediction" ? "testable_prediction" : null, nowIso()).run();
  }
  return [];
}
async function videoHandler(env, envelope) {
  const youtubeId = envelope.payload.youtubeId;
  const item = await env.DB.prepare(`SELECT * FROM source_items
    WHERE source_item_id=?1 AND person_id=?2 AND platform='youtube' AND platform_item_id=?3
      AND canonical_url=?4`).bind(envelope.payload.sourceItemId, envelope.personId, youtubeId,
      `https://www.youtube.com/watch?v=${youtubeId}`).first();
  if (!item) throw new Error("trusted_source_item_mismatch");
  await recordTranscriptUnavailable(env.DB, {
    sourceItemId: item.source_item_id, method: "authorized_transcript_only", provider: "youtube",
    status: "authorization_required", errorCode: "transcript_not_supplied",
  });
  return [];
}
async function videoAnalysisHandler(env, envelope, job) {
  let descriptors;
  if (envelope.type === "video_analysis_primary") descriptors = await processPrimaryVideoAnalysis(env, envelope, job);
  else if (envelope.type === "video_analysis_verify") descriptors = await processVerifierVideoAnalysis(env, envelope, job);
  else descriptors = await processTiebreakerVideoAnalysis(env, envelope, job);
  return Promise.all(descriptors.map((descriptor) => makeEnvelope({
    runId: envelope.runId, personId: envelope.personId, ...descriptor,
  })));
}
function transcriptSettings(env) {
  const integer = (value, fallback, minimum, maximum) => {
    const parsed = Number(value); return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
  };
  return {
    chunkSeconds: integer(env.TRANSCRIPT_CHUNK_SECONDS, 300, 60, 300),
    overlapSeconds: integer(env.TRANSCRIPT_OVERLAP_SECONDS, 0, 0, 30),
    budgetLimitSeconds: integer(env.GEMINI_DAILY_MEDIA_SECONDS, 28_800, 1, 28_800),
    timeoutMs: integer(env.GEMINI_TRANSCRIPT_TIMEOUT_MS, 120_000, 10_000, 300_000),
    model: env.GEMINI_TRANSCRIPT_MODEL || TRANSCRIPT_MODEL,
  };
}
async function trustedTranscriptItem(env, envelope) {
  const item = await env.DB.prepare(`SELECT * FROM source_items WHERE source_item_id=?1 AND person_id=?2
    AND platform='youtube' AND platform_item_id=?3 AND canonical_url=?4`)
    .bind(envelope.payload.sourceItemId, envelope.personId, envelope.payload.youtubeId,
      `https://www.youtube.com/watch?v=${envelope.payload.youtubeId}`).first();
  if (!item) throw new Error("trusted_source_item_mismatch");
  return item;
}
async function nextTranscriptEnvelope(envelope, plan, index) {
  if (index + 1 < plan.length) return makeEnvelope({ runId: envelope.runId, personId: envelope.personId,
    type: "transcript_extract", stableKey: `youtube:${envelope.payload.youtubeId}:transcript:chunk:${index + 1}`,
    payload: { ...envelope.payload, chunkIndex: index + 1 } });
  return makeEnvelope({ runId: envelope.runId, personId: envelope.personId, type: "transcript_extract",
    stableKey: `youtube:${envelope.payload.youtubeId}:transcript:stitch`,
    payload: { phase: "stitch", youtubeId: envelope.payload.youtubeId,
      sourceItemId: envelope.payload.sourceItemId, durationSeconds: envelope.payload.durationSeconds,
      ...(envelope.payload.batchId ? { batchId: envelope.payload.batchId,
        batchItemId: envelope.payload.batchItemId } : {}) } });
}
async function transcriptChunkHandler(env, envelope, job, geminiFetcher, at = nowIso()) {
  await trustedTranscriptItem(env, envelope);
  const settings = transcriptSettings(env);
  const plan = transcriptPlan(envelope.payload.durationSeconds, settings);
  const index = envelope.payload.chunkIndex;
  if (!plan[index]) throw new Error("invalid_transcript_chunk");
  const completed = await completedTranscriptChunks(env.DB, envelope.runId, envelope.payload.sourceItemId);
  if (completed.some((row) => Number(row.chunk_index) === index)) return [await nextTranscriptEnvelope(envelope, plan, index)];
  const window = plan[index]; const createdAt = at;
  const reservationId = await stableId("gmr", `${envelope.jobId}:${job.attempt_count}:${index}`);
  const reserved = await reserveGeminiMedia(env.DB, { reservationId, mediaDay: createdAt.slice(0, 10),
    runId: envelope.runId, jobId: envelope.jobId, sourceItemId: envelope.payload.sourceItemId,
    chunkIndex: index, jobAttempt: Number(job.attempt_count), startSeconds: window.requestStart,
    endSeconds: window.requestEnd, budgetLimitSeconds: settings.budgetLimitSeconds, createdAt });
  if (!reserved) {
    const error = new Error("transcript_budget_deferred"); error.defer = true;
    error.eligibleAt = nextTranscriptBatchDay(createdAt);
    error.retryAfterSeconds = Math.min(43_200, Math.max(300, Math.ceil((Date.parse(error.eligibleAt) - Date.parse(createdAt)) / 1000)));
    if (envelope.payload.batchId) {
      await pauseTranscriptBatch(env, { batchId: envelope.payload.batchId,
        batchItemId: envelope.payload.batchItemId, reason: "daily_media_cap", at: createdAt,
        resumeAfter: error.eligibleAt, jobId: envelope.jobId });
      error.batchPaused = true;
    }
    throw error;
  }
  const chunkAttemptId = await stableId("txc", `${reservationId}:${TRANSCRIPT_PROMPT_VERSION}`);
  const base = { chunkAttemptId, reservationId, runId: envelope.runId, jobId: envelope.jobId,
    sourceItemId: envelope.payload.sourceItemId, chunkIndex: index, startSeconds: window.requestStart,
    endSeconds: window.requestEnd, overlapSeconds: settings.overlapSeconds, modelName: settings.model,
    promptVersion: TRANSCRIPT_PROMPT_VERSION, createdAt };
  try {
    const result = await requestTranscriptChunk({ apiKey: env.GEMINI_API_KEY,
      videoUrl: `https://www.youtube.com/watch?v=${envelope.payload.youtubeId}`, window,
      model: settings.model, fetcher: geminiFetcher, timeoutMs: settings.timeoutMs });
    const contentSha256 = await sha256(result.text);
    const r2Key = `transcripts/chunks/${envelope.personId}/${envelope.payload.sourceItemId}/${envelope.runId}/${index}-${contentSha256}.txt`;
    await env.ARTIFACTS.put(r2Key, result.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { sourceItemId: envelope.payload.sourceItemId, runId: envelope.runId, chunkIndex: String(index) } });
    await recordTranscriptChunkAttempt(env.DB, { ...base, ...result, r2Key, contentSha256,
      byteCount: new TextEncoder().encode(result.text).length, status: "completed" });
  } catch (error) {
    await recordTranscriptChunkAttempt(env.DB, { ...base,
      requestSha256: error.requestSha256 || await sha256({ sourceItemId: envelope.payload.sourceItemId, window, model: settings.model }),
      responseId: error.responseId || null, finishReason: null, inputTokens: null, outputTokens: null,
      status: "failed", errorCode: error.message || "transcript_chunk_failed" });
    if (envelope.payload.batchId && error.message === "gemini_http_429") {
      error.defer = true; error.batchPaused = true; error.eligibleAt = nextTranscriptBatchDay(createdAt);
      await pauseTranscriptBatch(env, { batchId: envelope.payload.batchId,
        batchItemId: envelope.payload.batchItemId, reason: "gemini_429", at: createdAt,
        resumeAfter: error.eligibleAt, jobId: envelope.jobId, httpStatus: 429 });
    }
    throw error;
  }
  return [await nextTranscriptEnvelope(envelope, plan, index)];
}
async function transcriptStitchHandler(env, envelope, { at = nowIso(), durationFetcher = fetch } = {}) {
  await trustedTranscriptItem(env, envelope);
  const settings = transcriptSettings(env); const plan = transcriptPlan(envelope.payload.durationSeconds, settings);
  const rows = await completedTranscriptChunks(env.DB, envelope.runId, envelope.payload.sourceItemId);
  if (rows.length !== plan.length || rows.some((row, index) => Number(row.chunk_index) !== index)) {
    const error = new Error("transcript_chunks_incomplete"); error.retryable = true; throw error;
  }
  const chunks = [];
  for (const [index, row] of rows.entries()) {
    const window = plan[index];
    if (Number(row.chunk_index) !== index || Number(row.start_seconds) !== window.requestStart ||
        Number(row.end_seconds) !== window.requestEnd ||
        Number(row.overlap_seconds) !== settings.overlapSeconds ||
        !/^[a-f0-9]{64}$/.test(row.content_sha256 || "")) {
      throw new Error("transcript_chunks_incomplete");
    }
    const object = await env.ARTIFACTS.get(row.r2_key);
    if (!object) { const error = new Error("transcript_chunk_artifact_missing"); error.retryable = true; throw error; }
    const text = await object.text();
    if (await sha256(text) !== row.content_sha256 ||
        new TextEncoder().encode(text).length !== Number(row.byte_count)) {
      throw new Error("transcript_chunk_hash_mismatch");
    }
    chunks.push(text);
  }
  const stitched = stitchTranscript(chunks, plan); const contentSha256 = await sha256(stitched.text);
  const transcriptId = await stableId("tx", `${envelope.payload.sourceItemId}:${contentSha256}`);
  const r2Key = `transcripts/final/${envelope.personId}/${envelope.payload.sourceItemId}/${contentSha256}.txt`;
  await env.ARTIFACTS.put(r2Key, stitched.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { sourceItemId: envelope.payload.sourceItemId, transcriptId } });
  const createdAt = at; const manifestSha256 = await sha256(rows.map((row) => row.content_sha256));
  const stitchId = await stableId("txs", `${envelope.jobId}:${transcriptId}:${STITCH_ALGORITHM}`);
  const attemptId = await stableId("txa", `${transcriptId}:gemini-clipped-v1`);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_artifacts
      (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,provenance,verifier_principal,created_at)
      VALUES (?1,?2,?3,?4,?5,'en',0,'gemini_generated_public_youtube_clipped_v1',NULL,?6)`)
      .bind(transcriptId, envelope.payload.sourceItemId, r2Key, contentSha256, new TextEncoder().encode(stitched.text).length, createdAt),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_attempts
      (attempt_id,source_item_id,method,provider,status,language,attempted_at,public_error_code)
      VALUES (?1,?2,'gemini_public_youtube_clipped','google_gemini','needs_human_check','en',?3,NULL)`)
      .bind(attemptId, envelope.payload.sourceItemId, createdAt),
    env.DB.prepare(`INSERT OR IGNORE INTO transcript_stitch_receipts
      (stitch_id,run_id,job_id,source_item_id,transcript_id,duration_seconds,chunk_count,
       overlap_seconds,cue_count,input_manifest_sha256,stitch_algorithm,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`)
      .bind(stitchId, envelope.runId, envelope.jobId, envelope.payload.sourceItemId, transcriptId,
        envelope.payload.durationSeconds, plan.length, settings.overlapSeconds, stitched.cueCount,
        manifestSha256, STITCH_ALGORITHM, createdAt),
  ]);
  const acquisition = envelope.payload.batchId ? await completeTranscriptBatchItem(env, {
    batchId: envelope.payload.batchId, batchItemId: envelope.payload.batchItemId,
    at: createdAt, durationFetcher,
  }) : [];
  const preparation = await transcriptAnalysisPreparationEnvelope({ transcriptId,
    sourceItemId: envelope.payload.sourceItemId, personId: envelope.personId,
    transcriptSha256: contentSha256 });
  // Generic successor dispatch processes this array in order. The next acquisition
  // is registered and sent before the batch-independent preparation job is created.
  return [...acquisition, preparation];
}
async function transcriptHandler(env, envelope, job, geminiFetcher, options) {
  if (envelope.payload.phase === "chunk") return transcriptChunkHandler(env, envelope, job, geminiFetcher, options.at);
  if (envelope.payload.phase === "stitch") return transcriptStitchHandler(env, envelope, options);
  if (envelope.payload.phase === "prepare") {
    const prepared = await prepareTranscriptAnalysisFromArtifact(env, envelope.payload, {
      personId: envelope.personId, ingestionRunId: envelope.runId, at: options.at,
    });
    return prepared.envelopes;
  }
  await processTranscriptAnalysis(env, envelope.payload, { at: options.at,
    attemptCount: Number(job.attempt_count) });
  return [];
}
async function handle(env, envelope, fetcher, job, geminiFetcher, options) {
  if (envelope.type === "archive_page") return archiveHandler(env, envelope, fetcher);
  if (envelope.type === "post_detail") return detailHandler(env, envelope, fetcher);
  if (envelope.type === "description_triage") return triageHandler(env, envelope);
  if (envelope.type === "video_metadata") return videoHandler(env, envelope);
  if (envelope.type === "transcript_extract") return transcriptHandler(env, envelope, job, geminiFetcher, options);
  if (envelope.type === "run_reconcile") return [];
  if (["video_analysis_primary", "video_analysis_verify", "video_analysis_tiebreak"].includes(envelope.type)) return videoAnalysisHandler(env, envelope, job);
  throw new Error("unsupported_job");
}
export async function dispatchSuccessors(env, jobId, successors, { register = registerJob } = {}) {
  const analysisOnly = successors.length > 0 && successors.every((successor) =>
    successor.type === "transcript_extract" && successor.payload.phase === "analyze");
  const includesPreparation = successors.some((successor) =>
    successor.type === "transcript_extract" && successor.payload.phase === "prepare");
  if (!includesPreparation) {
    try {
      if (analysisOnly) await registerTranscriptAnalysisJobs(env.DB, successors);
      else for (const successor of successors) await register(env.DB, successor);
    } catch (error) {
      error.retryable = true;
      throw error;
    }
  }
  if (!(await claimSuccessorDispatch(env.DB, jobId))) return;
  try {
    if (analysisOnly) {
      if (typeof env.INGESTION_QUEUE.sendBatch === "function") {
        for (let index = 0; index < successors.length; index += 100) {
          await env.INGESTION_QUEUE.sendBatch(successors.slice(index, index + 100)
            .map((body) => ({ body })));
        }
      } else {
        for (const successor of successors) await env.INGESTION_QUEUE.send(successor);
      }
      return;
    }
    for (const successor of successors) {
      if (includesPreparation) {
        if (successor.type === "transcript_extract" && successor.payload.phase === "prepare") {
          await ensureTranscriptAnalysisPreparationRun(env.DB, successor);
        }
        await register(env.DB, successor);
      }
      if (successor.type === "transcript_extract" && successor.payload.batchId &&
          successor.payload.phase === "chunk" && successor.payload.chunkIndex === 0) {
        await dispatchTranscriptBatchEnvelope(env, successor.payload.batchId,
          successor.payload.batchItemId, successor);
      } else if (successor.type === "transcript_extract" && successor.payload.batchId) {
        await dispatchTranscriptBatchSuccessor(env, successor);
      } else await env.INGESTION_QUEUE.send(successor);
    }
  }
  catch (error) { error.retryable = true; await resetSuccessorDispatch(env.DB, jobId); throw error; }
}
export async function processEnvelope(env, raw, { fetcher = (url) => fetchHtml(url), geminiFetcher = fetch,
  durationFetcher = fetch, at = nowIso() } = {}) {
  const envelope = validateEnvelope(raw);
  await validateEnvelopeIdentity(env, envelope);
  const existing = await registerJob(env.DB, envelope);
  if (existing.run_id !== envelope.runId || existing.job_type !== envelope.type ||
      existing.stable_key !== envelope.stableKey || existing.payload_json !== JSON.stringify(envelope.payload)) {
    throw new Error("invalid_job_binding");
  }
  if (existing.status === "completed") {
    if (!existing.successor_enqueued) await dispatchSuccessors(env, existing.job_id,
      await handle(env, envelope, fetcher, existing, geminiFetcher, { at, durationFetcher }));
    // A redelivery is also a repair opportunity for a run completed by an
    // older Worker version or an earlier out-of-order reconciliation.
    await reconcileRun(env.DB, envelope.runId);
    return { status: "duplicate_completed" };
  }
  const leaseToken = crypto.randomUUID();
  const job = await claimJob(env.DB, envelope.jobId, leaseToken, {
    now: at,
    batchId: envelope.payload.batchId || null,
    batchItemId: envelope.payload.batchItemId || null,
    leaseMs: envelope.type === "transcript_extract" && envelope.payload.phase === "analyze" ?
      VIDEO_ANALYSIS_LEASE_MS : envelope.type === "transcript_extract" ? TRANSCRIPT_LEASE_MS :
      envelope.type.startsWith("video_analysis_") ? VIDEO_ANALYSIS_LEASE_MS : 120_000,
  });
  if (!job) return { status: "duplicate_leased" };
  try {
    const successors = await handle(env, envelope, fetcher, job, geminiFetcher, { at, durationFetcher });
    if (!(await completeJob(env.DB, envelope.jobId, leaseToken, at))) throw new Error("lease_lost");
    await dispatchSuccessors(env, envelope.jobId, successors);
    // Every completed work unit reconciles the run. The final job therefore
    // closes the run even when Queue delivery order differs from enqueue order.
    await reconcileRun(env.DB, envelope.runId);
    return { status: "completed", successors: successors.length };
  } catch (error) {
    if (error?.defer) {
      await deferJob(env.DB, envelope.jobId, leaseToken,
        error.batchPaused ? "transcript_batch_paused" : error.message || "job_deferred", error.eligibleAt || at);
      throw error;
    }
    const retryable = error?.retryable || /network|timeout|upstream_429|upstream_5|ai_unavailable|queue/i.test(error?.message || "");
    const final = !retryable || Number(job.attempt_count) >= 3;
    await failJob(env.DB, envelope.jobId, leaseToken, error?.code || error?.message || "job_failed", { final });
    if (envelope.payload.phase === "analyze") {
      await recordTranscriptAnalysisFailure(env, envelope.payload, {
        final, errorCode: error?.code || error?.message || "analysis_failed", at,
      });
    }
    if (final && envelope.payload.batchId) {
      await pauseTranscriptBatch(env, { batchId: envelope.payload.batchId,
        batchItemId: envelope.payload.batchItemId,
        reason: retryable ? "transcript_retry_exhausted" : "transcript_terminal_error",
        at, resumeAfter: nextTranscriptBatchDay(at), jobId: envelope.jobId });
      error.batchPaused = true;
    }
    if (final) await reconcileRun(env.DB, envelope.runId);
    error.final = final;
    throw error;
  }
}
export async function processQueueBatch(batch, env, options = {}) {
  for (const message of batch.messages) {
    try { await processEnvelope(env, message.body, options); message.ack(); }
    catch (error) {
      const validationFailure = /^(invalid_|unsupported_job)/.test(error?.message || "");
      if (error.batchPaused || error.final || validationFailure) message.ack();
      else message.retry({ delaySeconds: error.retryAfterSeconds || 30 });
    }
  }
}
export async function recoverExpiredJobs(env, runId, options = {}) {
  const candidates = await recoveryCandidates(env.DB, runId, options);
  let recovered = 0; let dispatchFailed = 0;
  for (const row of candidates) {
    const reservation = `recovery_${crypto.randomUUID()}`;
    if (!(await reserveRecoveryDispatch(env.DB, row.job_id, reservation, options))) continue;
    let envelope;
    try {
      envelope = validateEnvelope({
        version: 1, jobId: row.job_id, runId: row.run_id, personId: row.person_id,
        type: row.job_type, stableKey: row.stable_key, payload: JSON.parse(row.payload_json),
      });
      await env.INGESTION_QUEUE.send(envelope);
      await finishRecoveryDispatch(env.DB, row.job_id, reservation, true);
      recovered += 1;
    } catch (error) {
      await finishRecoveryDispatch(env.DB, row.job_id, reservation, false);
      dispatchFailed += 1;
    }
  }
  return { recovered, dispatchFailed };
}
export async function scannerStatus(env, runId, options = {}) {
  const recovery = await recoverExpiredJobs(env, runId, options);
  const status = await runStatus(env.DB, runId);
  return status ? { ...status, recovery } : null;
}
export { runStatus };
