import { stableId, sha256 } from "./hash.js";
import { createRun, nowIso, recordSourceMediaMetadata, registerJob } from "./repository.js";
import { fetchYouTubeDataApiDuration, fetchYouTubeDuration,
  CLAIM_EXTRACTION_PROMPT_VERSION, TRANSCRIPT_PLAN_VERSION } from "./transcript.js";

const TYPES = new Set([
  "archive_page", "post_detail", "video_metadata", "description_triage", "transcript_extract", "run_reconcile",
  "video_analysis_primary", "video_analysis_verify", "video_analysis_tiebreak",
]);
const PERSON_ID = "person_troy_black";
export const VIDEO_ANALYSIS_LEASE_MS = 300_000;
export const TRANSCRIPT_LEASE_MS = 900_000;
export const INGESTION_QUEUE_NAME = "prophecy-ledger-ingestion";
export const ANALYSIS_QUEUE_NAME = "prophecy-ledger-analysis";
export function isTranscriptAnalysisEnvelope(envelope) {
  return envelope?.type === "transcript_extract" && ["prepare","analyze"].includes(envelope?.payload?.phase);
}
export function queueForEnvelope(env, envelope) {
  if (!isTranscriptAnalysisEnvelope(envelope)) return env.INGESTION_QUEUE;
  if (!env.ANALYSIS_QUEUE) throw new Error("analysis_queue_binding_missing");
  return env.ANALYSIS_QUEUE;
}
export function deterministicAnalysisBackoff(jobId, attemptCount) {
  const jitter = [...String(jobId || "")].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 11;
  return Math.min(900, 60 * (2 ** Math.max(0, Number(attemptCount || 1) - 1)) + jitter);
}
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
    if (value.payload.planVersion !== TRANSCRIPT_PLAN_VERSION) throw new Error("invalid_transcript_plan_version");
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

export async function validateEnvelopeIdentity(env, envelope) {
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
  if (envelope.type !== "transcript_extract") return;
  const expectedStableKey = envelope.payload.phase === "chunk"
    ? `youtube:${envelope.payload.youtubeId}:transcript:${envelope.payload.planVersion}:chunk:${envelope.payload.chunkIndex}`
    : `youtube:${envelope.payload.youtubeId}:transcript:${envelope.payload.planVersion}:stitch`;
  if (envelope.stableKey !== expectedStableKey) {
    throw new Error(envelope.payload.batchId
      ? "invalid_transcript_batch_binding" : "invalid_transcript_plan_binding");
  }
  if (!envelope.payload.batchId) return;
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
      `transcript:${envelope.payload.sourceItemId}:${envelope.payload.durationSeconds}:plan:${envelope.payload.planVersion}:batch:${envelope.payload.batchId}`).first();
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
export async function startVideoAnalysisCanary(env, { youtubeId, force = false, runId = null,
  durationFetcher = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId || "")) return { started: false, reason: "invalid_youtube_id" };
  const item = await env.DB.prepare(`SELECT * FROM source_items
    WHERE person_id=?1 AND platform='youtube' AND platform_item_id=?2 AND canonical_url=?3`)
    .bind(PERSON_ID, youtubeId, `https://www.youtube.com/watch?v=${youtubeId}`).first();
  if (!item) return { started: false, reason: "trusted_source_item_not_found" };
  let duration = await env.DB.prepare(`SELECT duration_seconds,response_sha256,method
    FROM source_media_metadata WHERE source_item_id=?1
    ORDER BY observed_at DESC,metadata_id DESC LIMIT 1`).bind(item.source_item_id).first();
  if (!duration) {
    try {
      duration = env.YOUTUBE_DATA_API_KEY
        ? await fetchYouTubeDataApiDuration({ youtubeId, apiKey: env.YOUTUBE_DATA_API_KEY,
          fetcher: durationFetcher })
        : await fetchYouTubeDuration({ youtubeId, fetcher: durationFetcher });
    } catch (error) { return { started: false, reason: error.message || "video_duration_unavailable" }; }
    await recordSourceMediaMetadata(env.DB, { sourceItemId: item.source_item_id,
      durationSeconds: duration.durationSeconds, responseSha256: duration.responseSha256,
      method: env.YOUTUBE_DATA_API_KEY ? "youtube_data_api_v3_content_details" :
        "youtube_public_html_length_seconds" });
  }
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
  return { started: true, runId: selectedRunId, firstJobId: first.jobId, youtubeId,
    durationSeconds: Number(duration.durationSeconds) };
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
  const scope = `transcript:${item.source_item_id}:${durationSeconds}:plan:${TRANSCRIPT_PLAN_VERSION}`;
  const prior = await env.DB.prepare(`SELECT run_id,status FROM ingestion_runs
    WHERE person_id=?1 AND scope=?2 ORDER BY created_at DESC,run_id DESC LIMIT 1`)
    .bind(item.person_id, scope).first();
  if (prior && (!force || ["queued", "running"].includes(prior.status))) return { started: true, reused: true, runId: prior.run_id, status: prior.status };
  const selectedRunId = force ? (runId || `run_${crypto.randomUUID()}`) :
    await stableId("runtx", `transcript:${TRANSCRIPT_PLAN_VERSION}:${item.source_item_id}:${durationSeconds}`);
  const created = await createRun(env.DB, { runId: selectedRunId, personId: item.person_id, triggerType: "canary", scope });
  if (!created.inserted) return { started: true, reused: true, runId: selectedRunId, status: created.status };
  const first = await makeEnvelope({ runId: selectedRunId, personId: item.person_id, type: "transcript_extract",
    stableKey: `youtube:${youtubeId}:transcript:${TRANSCRIPT_PLAN_VERSION}:chunk:0`,
    payload: { phase: "chunk", planVersion: TRANSCRIPT_PLAN_VERSION, chunkIndex: 0,
      youtubeId, sourceItemId: item.source_item_id, durationSeconds } });
  await registerJob(env.DB, first);
  try { await env.INGESTION_QUEUE.send(first); }
  catch { return { started: false, runId: selectedRunId, reason: "queue_dispatch_failed" }; }
  return { started: true, runId: selectedRunId, firstJobId: first.jobId, personSlug, youtubeId, durationSeconds,
    durationProvenance: durationMethod };
}

