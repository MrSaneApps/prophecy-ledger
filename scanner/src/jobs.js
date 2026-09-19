import { textAnalysisRuntime, triageDescription } from "./ai.js";
import { gemini429ResumeAfter, geminiDailyMediaSeconds, geminiTranscriptFallbackModel } from "./gemini-free-tier.js";
import { fetchHtml } from "./fetch.js";
import { stableId, sha256 } from "./hash.js";
import {
  addRevision, claimJob, claimSuccessorDispatch, completeJob, failJob,
  completedTranscriptChunks, deferJob, finishRecoveryDispatch,
  linkExactEmbedded, nowIso, reconcileRun, recordAvailability, recordScanReceipt,
  recordTranscriptChunkAttempt, recordTranscriptUnavailable, recoveryCandidates, registerJob,
  recordGeminiPhysicalRequestResult, reserveGeminiMedia, reserveGeminiPhysicalRequest,
  recordWorkersAiAttempt, reserveRecoveryDispatch, persistFirstPartyArchive,
  resetSuccessorDispatch, runStatus, upsertSourceItem,
} from "./repository.js";
import {
  ensureTranscriptAnalysisPreparationRun, fetchYouTubeDataApiDuration, fetchYouTubeDuration,
  prepareTranscriptAnalysisFromArtifact, processTranscriptAnalysis,
  recordTranscriptAnalysisFailure, registerTranscriptAnalysisJobs, requestTranscriptChunk, requestTranscriptChunkWithSplit,
  STITCH_ALGORITHM, stitchTranscript,
  transcriptAnalysisPreparationEnvelope, CLAIM_EXTRACTION_PROMPT_VERSION,
  TRANSCRIPT_MODEL, TRANSCRIPT_PLAN_VERSION, TRANSCRIPT_PROMPT_VERSION, transcriptPlan,
} from "./transcript.js";
import {
  completeTranscriptBatchItem, dispatchTranscriptBatchEnvelope, dispatchTranscriptBatchSuccessor,
  nextTranscriptBatchDay, pauseTranscriptBatch, skipActiveTranscriptItem,
} from "./transcript-batch.js";
import { archiveNextPageState, archiveUrl, parseArchivePage, parseFulfilledProphecyArchive, parsePostDetail } from "./wordpress.js";
import {
  processPrimaryVideoAnalysis, processTiebreakerVideoAnalysis, processVerifierVideoAnalysis,
} from "./video-analysis.js";
import {
  ANALYSIS_QUEUE_NAME, deterministicAnalysisBackoff, INGESTION_QUEUE_NAME,
  isTranscriptAnalysisEnvelope, makeEnvelope, queueForEnvelope,
  startFirstPartyArchiveIngest, startScan, startTranscriptCanary, startVideoAnalysisCanary,
  TRANSCRIPT_LEASE_MS, validateEnvelope, validateEnvelopeIdentity, VIDEO_ANALYSIS_LEASE_MS,
} from "./job-start.js";
export {
  deterministicAnalysisBackoff, makeEnvelope, startFirstPartyArchiveIngest, startScan,
  startTranscriptCanary, startVideoAnalysisCanary, validateEnvelope,
} from "./job-start.js";
import {
  persistOperationReceipt, queueOperationsStatus, readTranscriptAnalysisSectionLineages,
  readTranscriptAnalysisSectionStatuses, reconcileStaleTranscriptAnalysisSection,
  reprocessTranscriptAnalysis, reprocessTranscriptAnalysisSection,
} from "./analysis-operations.js";
export {
  persistOperationReceipt, queueOperationsStatus, readTranscriptAnalysisSectionLineages,
  readTranscriptAnalysisSectionStatuses, reconcileStaleTranscriptAnalysisSection,
  reprocessTranscriptAnalysis, reprocessTranscriptAnalysisSection,
} from "./analysis-operations.js";
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
async function triageHandler(env, envelope, job) {
  const revision = await env.DB.prepare(`SELECT r.* FROM source_item_revisions r
    WHERE r.revision_id=?1 AND r.source_item_id=?2`).bind(envelope.payload.revisionId, envelope.payload.sourceItemId).first();
  if (!revision) throw new Error("revision_not_found");
  if (!revision.first_party_description?.trim()) return [];
  const inputSha = await sha256({ title: revision.public_title, description: revision.first_party_description });
  const extractionId = await stableId("ext", `${revision.source_item_id}:${inputSha}:description-v1`);
  const existingExtraction = await env.DB.prepare(`SELECT status FROM extraction_runs
    WHERE extraction_run_id=?1 AND input_sha256=?2`).bind(extractionId, inputSha).first();
  if (existingExtraction?.status === "completed") return [];
  const onAttempt = async (attempt) => {
    const attemptId = await stableId("wai",
      `${envelope.jobId}:${job.attempt_count}:${attempt.modelName}:${attempt.mode}:${attempt.ordinal}`);
    await recordWorkersAiAttempt(env.DB, { attemptId, workKind: "description_triage",
      jobId: envelope.jobId, jobAttempt: Number(job.attempt_count),
      analysisRunId: null, analysisSectionId: null, ...attempt });
  };
  const runtime = textAnalysisRuntime(env);
  const result = await triageDescription(runtime.ai, {
    title: revision.public_title, description: revision.first_party_description,
    models: runtime.models, timeoutMs: runtime.timeoutMs,
    onAttempt,
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
async function videoAnalysisHandler(env, envelope, job, options = {}) {
  let descriptors;
  if (envelope.type === "video_analysis_primary") descriptors = await processPrimaryVideoAnalysis(env, envelope, job, options);
  else if (envelope.type === "video_analysis_verify") descriptors = await processVerifierVideoAnalysis(env, envelope, job, options);
  else descriptors = await processTiebreakerVideoAnalysis(env, envelope, job, options);
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
    budgetLimitSeconds: geminiDailyMediaSeconds(env),
    timeoutMs: integer(env.GEMINI_TRANSCRIPT_TIMEOUT_MS, 120_000, 10_000, 300_000),
    model: env.GEMINI_TRANSCRIPT_MODEL || TRANSCRIPT_MODEL,
    fallbackModel: geminiTranscriptFallbackModel(env, env.GEMINI_TRANSCRIPT_MODEL || TRANSCRIPT_MODEL),
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
    type: "transcript_extract",
    stableKey: `youtube:${envelope.payload.youtubeId}:transcript:${envelope.payload.planVersion}:chunk:${index + 1}`,
    payload: { ...envelope.payload, chunkIndex: index + 1 } });
  return makeEnvelope({ runId: envelope.runId, personId: envelope.personId, type: "transcript_extract",
    stableKey: `youtube:${envelope.payload.youtubeId}:transcript:${envelope.payload.planVersion}:stitch`,
    payload: { phase: "stitch", planVersion: envelope.payload.planVersion, youtubeId: envelope.payload.youtubeId,
      sourceItemId: envelope.payload.sourceItemId, durationSeconds: envelope.payload.durationSeconds,
      ...(envelope.payload.batchId ? { batchId: envelope.payload.batchId,
        batchItemId: envelope.payload.batchItemId } : {}) } });
}
async function transcriptChunkHandler(env, envelope, job, geminiFetcher,
  { at = nowIso(), physicalNow = nowIso } = {}) {
  await trustedTranscriptItem(env, envelope);
  const settings = transcriptSettings(env);
  const plan = transcriptPlan(envelope.payload.durationSeconds, settings);
  const index = envelope.payload.chunkIndex;
  if (!plan[index]) throw new Error("invalid_transcript_chunk");
  const completed = await completedTranscriptChunks(env.DB, envelope.runId, envelope.payload.sourceItemId);
  const window = plan[index]; const createdAt = at;
  const prior = completed.find((row) => Number(row.chunk_index) === index);
  if (prior) {
    if (prior.job_id !== envelope.jobId || Number(prior.start_seconds) !== window.requestStart ||
        Number(prior.end_seconds) !== window.requestEnd ||
        Number(prior.overlap_seconds) !== settings.overlapSeconds ||
        prior.prompt_version !== TRANSCRIPT_PROMPT_VERSION) throw new Error("transcript_chunk_plan_mismatch");
    return [await nextTranscriptEnvelope(envelope, plan, index)];
  }
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
    const result = await requestTranscriptChunkWithSplit({ apiKey: env.GEMINI_API_KEY,
      videoUrl: `https://www.youtube.com/watch?v=${envelope.payload.youtubeId}`, window,
      model: settings.model, fallbackModel: settings.fallbackModel,
      fetcher: geminiFetcher, timeoutMs: settings.timeoutMs,
      beforePhysicalRequest: async ({ splitPath, window: physicalWindow }) => {
        // A root call and recursive children can cross midnight; meter each call
        // against the UTC day observed immediately before that provider fetch.
        const physicalCreatedAt = physicalNow();
        const physicalRequestId = await stableId("gpr", `${reservationId}:${splitPath}:${physicalWindow.requestStart}:${physicalWindow.requestEnd}`);
        const physicalReserved = await reserveGeminiPhysicalRequest(env.DB, {
          physicalRequestId, logicalReservationId: reservationId, mediaDay: physicalCreatedAt.slice(0, 10),
          runId: envelope.runId, jobId: envelope.jobId, sourceItemId: envelope.payload.sourceItemId,
          chunkIndex: index, jobAttempt: Number(job.attempt_count), splitPath,
          startSeconds: Number(physicalWindow.requestStart), endSeconds: Number(physicalWindow.requestEnd),
          budgetLimitSeconds: settings.budgetLimitSeconds, createdAt: physicalCreatedAt,
        });
        if (!physicalReserved) {
          const error = new Error("transcript_budget_deferred"); error.defer = true;
          error.eligibleAt = nextTranscriptBatchDay(physicalCreatedAt);
          error.retryAfterSeconds = Math.min(43_200, Math.max(300,
            Math.ceil((Date.parse(error.eligibleAt) - Date.parse(physicalCreatedAt)) / 1000)));
          if (envelope.payload.batchId) {
            await pauseTranscriptBatch(env, { batchId: envelope.payload.batchId,
              batchItemId: envelope.payload.batchItemId, reason: "daily_media_cap", at: physicalCreatedAt,
              resumeAfter: error.eligibleAt, jobId: envelope.jobId });
            error.batchPaused = true;
          }
          throw error;
        }
        return physicalRequestId;
      },
      afterPhysicalRequest: async (physical) => {
        const resultId = await stableId("gpres", physical.physicalRequestId);
        await recordGeminiPhysicalRequestResult(env.DB, { resultId, ...physical, completedAt: nowIso() });
      } });
    const contentSha256 = await sha256(result.text);
    const r2Key = `transcripts/chunks/${envelope.personId}/${envelope.payload.sourceItemId}/${envelope.runId}/${index}-${contentSha256}.txt`;
    await env.ARTIFACTS.put(r2Key, result.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { sourceItemId: envelope.payload.sourceItemId, runId: envelope.runId, chunkIndex: String(index) } });
    await recordTranscriptChunkAttempt(env.DB, { ...base, ...result, r2Key, contentSha256,
      byteCount: new TextEncoder().encode(result.text).length, status: "completed" });
  } catch (error) {
    await recordTranscriptChunkAttempt(env.DB, { ...base,
      requestSha256: error.requestSha256 || await sha256({ sourceItemId: envelope.payload.sourceItemId, window, model: settings.model }),
      responseId: error.responseId || null,
      finishReason: error.finishReason || null,
      inputTokens: error.inputTokens ?? null,
      outputTokens: error.outputTokens ?? null,
      status: "failed", errorCode: error.message || "transcript_chunk_failed" });
    if (envelope.payload.batchId && error.message === "gemini_http_429") {
      error.defer = true; error.batchPaused = true;
      const nextDay = nextTranscriptBatchDay(createdAt);
      const shortResume = gemini429ResumeAfter(createdAt, error.retryAfterSeconds);
      error.eligibleAt = shortResume < nextDay ? shortResume : nextDay;
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
    const expectedStableKey = `youtube:${envelope.payload.youtubeId}:transcript:${envelope.payload.planVersion}:chunk:${index}`;
    const expectedJobId = await stableId("job", `${envelope.runId}:transcript_extract:${expectedStableKey}`);
    if (Number(row.chunk_index) !== index || Number(row.start_seconds) !== window.requestStart ||
        Number(row.end_seconds) !== window.requestEnd ||
        Number(row.overlap_seconds) !== settings.overlapSeconds ||
        row.job_id !== expectedJobId || row.prompt_version !== TRANSCRIPT_PROMPT_VERSION ||
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
  const createdAt = at; const manifestSha256 = await sha256({ planVersion: envelope.payload.planVersion,
    chunks: rows.map((row) => ({ chunkIndex: Number(row.chunk_index),
      startSeconds: Number(row.start_seconds), endSeconds: Number(row.end_seconds),
      overlapSeconds: Number(row.overlap_seconds), jobId: row.job_id,
      contentSha256: row.content_sha256 })) });
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
  if (envelope.payload.phase === "chunk") return transcriptChunkHandler(env, envelope, job, geminiFetcher, options);
  if (envelope.payload.phase === "stitch") return transcriptStitchHandler(env, envelope, options);
  if (envelope.payload.phase === "prepare") {
    const prepared = await prepareTranscriptAnalysisFromArtifact(env, envelope.payload, {
      personId: envelope.personId, ingestionRunId: envelope.runId, at: options.at,
    });
    return prepared.envelopes;
  }
  await processTranscriptAnalysis(env, envelope.payload, { at: options.at,
    attemptCount: Number(job.attempt_count), jobId: envelope.jobId });
  return [];
}
async function handle(env, envelope, fetcher, job, geminiFetcher, options) {
  if (envelope.type === "archive_page") return archiveHandler(env, envelope, fetcher);
  if (envelope.type === "post_detail") return detailHandler(env, envelope, fetcher);
  if (envelope.type === "description_triage") return triageHandler(env, envelope, job);
  if (envelope.type === "video_metadata") return videoHandler(env, envelope);
  if (envelope.type === "transcript_extract") return transcriptHandler(env, envelope, job, geminiFetcher, options);
  if (envelope.type === "run_reconcile") return [];
  if (["video_analysis_primary", "video_analysis_verify", "video_analysis_tiebreak"].includes(envelope.type)) return videoAnalysisHandler(env, envelope, job, options);
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
      if (!env.ANALYSIS_QUEUE) throw new Error("analysis_queue_binding_missing");
      if (typeof env.ANALYSIS_QUEUE.sendBatch === "function") {
        for (let index = 0; index < successors.length; index += 100) {
          await env.ANALYSIS_QUEUE.sendBatch(successors.slice(index, index + 100)
            .map((body) => ({ body })));
        }
      } else {
        for (const successor of successors) await env.ANALYSIS_QUEUE.send(successor);
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
      } else await queueForEnvelope(env, successor).send(successor);
    }
  }
  catch (error) { error.retryable = true; await resetSuccessorDispatch(env.DB, jobId); throw error; }
}
export async function processEnvelope(env, raw, { fetcher = (url) => fetchHtml(url), geminiFetcher = fetch,
  durationFetcher = fetch, at = nowIso(), physicalNow = nowIso } = {}) {
  const envelope = validateEnvelope(raw);
  await validateEnvelopeIdentity(env, envelope);
  const existing = await registerJob(env.DB, envelope);
  if (existing.run_id !== envelope.runId || existing.job_type !== envelope.type ||
      existing.stable_key !== envelope.stableKey || existing.payload_json !== JSON.stringify(envelope.payload)) {
    throw new Error("invalid_job_binding");
  }
  if (existing.status === "completed") {
    if (!existing.successor_enqueued) await dispatchSuccessors(env, existing.job_id,
      await handle(env, envelope, fetcher, existing, geminiFetcher, { at, durationFetcher, physicalNow }));
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
    const successors = await handle(env, envelope, fetcher, job, geminiFetcher, { at, durationFetcher, physicalNow });
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
      if (!final) error.retryAfterSeconds = deterministicAnalysisBackoff(envelope.jobId, Number(job.attempt_count));
    }
    if (final && envelope.payload.batchId) {
      await pauseTranscriptBatch(env, { batchId: envelope.payload.batchId,
        batchItemId: envelope.payload.batchItemId,
        reason: retryable ? "transcript_retry_exhausted" : "transcript_terminal_error",
        at, resumeAfter: nextTranscriptBatchDay(at), jobId: envelope.jobId });
      error.batchPaused = true;
      // Do not wait for the daily watchdog: skip the failed item and dispatch the next one now.
      // Tests that assert pause/resume/skip mechanics set TRANSCRIPT_BATCH_AUTO_ADVANCE=0.
      if (env.TRANSCRIPT_BATCH_AUTO_ADVANCE !== "0"
          && (envelope.payload.phase === "chunk" || envelope.payload.phase === "stitch")) {
        try {
          const advanced = await skipActiveTranscriptItem(env, {
            batchId: envelope.payload.batchId, at, durationFetcher,
          });
          error.batchAutoAdvanced = Boolean(advanced?.skipped);
        } catch (advanceError) {
          error.batchAutoAdvanceError = String(advanceError?.message || advanceError).slice(0, 180);
        }
      }
    }
    if (final) await reconcileRun(env.DB, envelope.runId);
    error.final = final;
    throw error;
  }
}
export async function processQueueBatch(batch, env, options = {}) {
  if (batch.queue && ![INGESTION_QUEUE_NAME, ANALYSIS_QUEUE_NAME].includes(batch.queue)) {
    throw new Error("invalid_queue_name");
  }
  for (const message of batch.messages) {
    const analysisEnvelope = isTranscriptAnalysisEnvelope(message.body);
    if ((batch.queue === ANALYSIS_QUEUE_NAME && !analysisEnvelope) ||
        (batch.queue === INGESTION_QUEUE_NAME && analysisEnvelope)) {
      message.retry({ delaySeconds: 60 });
      continue;
    }
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
      await queueForEnvelope(env, envelope).send(envelope);
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
