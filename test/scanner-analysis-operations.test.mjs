import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { D1Shim, makeEnv, ROOT } from "./helpers/d1.mjs";
import { fetchHandler } from "../scanner/src/index.js";
import { sha256, stableId } from "../scanner/src/hash.js";
import { makeEnvelope, processEnvelope, processQueueBatch, startTranscriptCanary } from "../scanner/src/jobs.js";
import {
  addRevision, createRun, linkExactEmbedded, recordSourceMediaMetadata, registerJob, upsertSourceItem,
} from "../scanner/src/repository.js";
import {
  completeTranscriptBatchItem, pauseTranscriptBatch, repairLegacyStitchedTranscriptBatchItem,
  quarantinePendingTranscriptItem, resumeScheduledTranscriptBatch, resumeTranscriptBatch, startTranscriptBatch,
  skipActiveTranscriptItem, syncArchiveLinkedTranscriptBatch,
} from "../scanner/src/transcript-batch.js";
import {
  ensureTranscriptAnalysisPreparationRun, LEGACY_STITCH_ALGORITHM, stitchTranscript,
  CLAIM_EXTRACTION_PROMPT_VERSION, transcriptAnalysisPreparationEnvelope, TRANSCRIPT_PLAN_VERSION, transcriptPlan,
} from "../scanner/src/transcript.js";

const AT = "2026-07-20T10:00:00.000Z";
const NEXT_DAY = "2026-07-21T00:00:05.000Z";

const durationFetcher = (seconds = 60) => async () =>
  new Response(`<html><script>{"lengthSeconds":"${seconds}"}</script></html>`, { status: 200 });
const dataApiDurationFetcher = (seconds = 60, calls = []) => async (url) => {
  calls.push(url);
  return new Response(JSON.stringify({ items: [{ id: new URL(url).searchParams.get("id"),
    contentDetails: { duration: `PT${seconds}S` } }] }), { status: 200 });
};

function batchEnv() {
  const env = makeEnv();
  env.sent = [];
  env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body),
    sendBatch: async (messages) => env.sent.push(...messages.map((message) => message.body)) };
  env.ANALYSIS_QUEUE = { send: async (body) => env.sent.push(body),
    sendBatch: async (messages) => env.sent.push(...messages.map((message) => message.body)) };
  env.ANALYSIS_QUEUE = env.INGESTION_QUEUE;
  env.SCANNER_ADMIN_TOKEN = "admin-secret";
  env.SCAN_ENABLED = "0";
  env.TRANSCRIPT_BATCH_ENABLED = "0";
  env.TRANSCRIPT_BATCH_AUTO_ADVANCE = "0";
  return env;
}

function r2Memory() {
  const objects = new Map();
  return { objects, put: async (key, value) => objects.set(key, String(value)),
    get: async (key) => objects.has(key) ? { text: async () => objects.get(key) } : null };
}

function legacyTranscriptPlan(durationSeconds, chunkSeconds = 300, overlapSeconds = 0) {
  const requests = [];
  for (let start = 0; start < durationSeconds; start += chunkSeconds - overlapSeconds) {
    requests.push({ requestStart: start, requestEnd: Math.min(durationSeconds, start + chunkSeconds) });
  }
  return requests.map((request, index) => ({ index, ...request,
    canonicalStart: index ? (requests[index - 1].requestEnd + request.requestStart) / 2 : 0,
    canonicalEnd: index + 1 < requests.length
      ? (request.requestEnd + requests[index + 1].requestStart) / 2 : durationSeconds,
  }));
}

async function seedLinkedVideos(env, videos) {
  await createRun(env.DB, { runId: `run_seed_${videos[0].youtubeId}`, personId: "person_troy_black",
    triggerType: "manual", scope: `seed:${videos[0].youtubeId}`, createdAt: AT });
  const seeded = [];
  for (const [index, video] of videos.entries()) {
    const post = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "official_site",
      platformItemId: String(90_000 + index), canonicalUrl: `https://troyblackvideos.com/post-${video.youtubeId}/`, seenAt: AT });
    await addRevision(env.DB, post.source_item_id, { canonicalUrl: post.canonical_url,
      title: `Post ${video.youtubeId}`, description: "Public description.", publicationDate: video.date,
      embeddedPlatform: "youtube", embeddedItemId: video.youtubeId,
      embeddedUrl: `https://www.youtube.com/watch?v=${video.youtubeId}` },
    { runId: `run_seed_${videos[0].youtubeId}`, parserVersion: "test-v1", fetchedAt: AT });
    const source = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube",
      platformItemId: video.youtubeId, canonicalUrl: `https://www.youtube.com/watch?v=${video.youtubeId}`, seenAt: AT });
    await linkExactEmbedded(env.DB, post.source_item_id, source.source_item_id, AT);
    if (video.hasArtifact) env.DB.db.prepare(`INSERT INTO transcript_artifacts
      (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,provenance,created_at)
      VALUES (?,?,?,?,?,'en',0,'authorized_transcript',?)`).run(`tx_existing_${index}`, source.source_item_id,
      `private/existing-${index}.txt`, String(index + 1).repeat(64), 10, AT);
    seeded.push(source);
  }
  return seeded;
}

async function seedAnalysisPreparation(env, { youtubeId, transcript }) {
  const [source] = await seedLinkedVideos(env, [{ youtubeId, date: "2020-01-01" }]);
  const transcriptSha256 = await sha256(transcript);
  const transcriptId = await stableId("tx", `${source.source_item_id}:${transcriptSha256}`);
  const r2Key = `transcripts/final/person_troy_black/${source.source_item_id}/${transcriptSha256}.txt`;
  await env.ARTIFACTS.put(r2Key, transcript);
  env.DB.db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at)
    VALUES (?,?,?,?,?,'en',0,'gemini_generated_public_youtube_clipped_v1',NULL,?)`)
    .run(transcriptId, source.source_item_id, r2Key, transcriptSha256,
      new TextEncoder().encode(transcript).length, AT);
  const preparation = await transcriptAnalysisPreparationEnvelope({ transcriptId,
    sourceItemId: source.source_item_id, personId: "person_troy_black", transcriptSha256 });
  await ensureTranscriptAnalysisPreparationRun(env.DB, preparation, AT);
  await registerJob(env.DB, preparation, AT);
  return preparation;
}

test("an in-flight Workers AI call is already visible as a durable started-only receipt", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const preparation = await seedAnalysisPreparation(env, { youtubeId: "StartedRcpt1",
    transcript: "[CLIP 00:00:00-00:05:00]\nNo concrete prediction here." });
  await processEnvelope(env, preparation, { at: AT });
  const analysis = env.sent.pop();
  let resolveAi;
  let signalProviderStarted;
  const providerStarted = new Promise((resolve) => { signalProviderStarted = resolve; });
  env.AI_MODEL = "local-model"; env.AI_FALLBACK_MODEL = "";
  env.AI = { run: () => {
    signalProviderStarted();
    return new Promise((resolve) => { resolveAi = resolve; });
  } };
  const processing = processEnvelope(env, analysis, { at: AT });
  await Promise.race([providerStarted, processing.then(() => {
    throw new Error("analysis_completed_before_provider_started");
  })]);
  const inFlightReceipts = env.DB.db.prepare(`SELECT status,completed_at FROM text_ai_attempt_receipt_history
    ORDER BY started_at,receipt_id`).all();
  assert.deepEqual(inFlightReceipts.map((row) => ({ ...row })),
    [{ status: "started", completed_at: null }]);
  resolveAi({ response: JSON.stringify({ candidates: [] }) });
  await processing;
  assert.deepEqual(env.DB.db.prepare(`SELECT status FROM text_ai_attempt_receipt_history
    ORDER BY status`).all().map((row) => row.status), ["completed", "started"]);
});

test("authenticated transcript reprocess creates one versioned private preparation job and is idempotent", async () => {
  const env = batchEnv();
  env.ARTIFACTS = r2Memory();
  const preparation = await seedAnalysisPreparation(env, {
    youtubeId: "Reprocess01A", transcript: "At 9 AM Friday, Mayor Lee closed the bridge.",
  });
  env.DB.db.prepare("DELETE FROM ingestion_jobs WHERE job_id=?").run(preparation.jobId);
  env.DB.db.prepare("DELETE FROM ingestion_runs WHERE run_id=?").run(preparation.runId);
  const request = () => new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "reprocess", transcriptId: preparation.payload.transcriptId }),
  });
  const unauthorized = await fetchHandler(new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reprocess", transcriptId: preparation.payload.transcriptId }),
  }), env);
  assert.equal(unauthorized.status, 401);
  const firstResponse = await fetchHandler(request(), env);
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  assert.equal(first.promptVersion, CLAIM_EXTRACTION_PROMPT_VERSION);
  assert.equal(first.reused, false);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.phase, "prepare");
  assert.equal("transcript" in env.sent[0].payload, false);
  const secondResponse = await fetchHandler(request(), env);
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json()).reused, true);
  assert.equal(env.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(first), /At 9 AM|transcripts\/final|r2_key/i);
});

test("transcript reprocess retries only a failed queue dispatch and rejects untrusted artifacts", async () => {
  const env = batchEnv();
  env.ARTIFACTS = r2Memory();
  const preparation = await seedAnalysisPreparation(env, {
    youtubeId: "Reprocess02B", transcript: "At noon, the city opened the road.",
  });
  env.DB.db.prepare("DELETE FROM ingestion_jobs WHERE job_id=?").run(preparation.jobId);
  env.DB.db.prepare("DELETE FROM ingestion_runs WHERE run_id=?").run(preparation.runId);
  let fail = true;
  env.INGESTION_QUEUE.send = async (body) => {
    if (fail) throw new Error("queue unavailable");
    env.sent.push(body);
  };
  const request = () => fetchHandler(new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "reprocess", transcriptId: preparation.payload.transcriptId }),
  }), env);
  assert.equal((await request()).status, 503);
  fail = false;
  assert.equal((await request()).status, 202);
  assert.equal(env.sent.length, 1);
  assert.equal((await request()).status, 200);
  assert.equal(env.sent.length, 1);
  const [untrustedSource] = await seedLinkedVideos(env, [{ youtubeId: "Untrusted03", date: "2020-01-02" }]);
  env.DB.db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at)
    VALUES ('tx_untrusted',?, 'private/untrusted.txt',?,10,'en',0,'authorized_transcript',NULL,?)`)
    .run(untrustedSource.source_item_id, "f".repeat(64), AT);
  const untrusted = await fetchHandler(new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "reprocess", transcriptId: "tx_untrusted" }),
  }), env);
  assert.equal(untrusted.status, 404);
});

test("transcript reprocess resets and redispatches only final retryable v5 analysis failures", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const transcript = `[CLIP 00:00:00-00:05:00]\nFirst section.\n[CLIP 00:05:00-00:10:00]\nSecond section.`;
  const preparation = await seedAnalysisPreparation(env, { youtubeId: "RetryV5A001", transcript });
  await processEnvelope(env, preparation, { at: AT });
  const [completedEnvelope, failedEnvelope] = env.sent.splice(0);
  env.AI_MODEL = "local-model"; env.AI_FALLBACK_MODEL = "local-fallback";
  env.AI = { run: async () => ({ response: JSON.stringify({ candidates: [] }) }) };
  await processEnvelope(env, completedEnvelope, { at: "2026-07-20T10:01:00.000Z" });
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=3,claimed_at=NULL,
      lease_token=NULL,completed_at=?,error_code='ai_unavailable' WHERE job_id=?`)
    .run("2026-07-20T10:02:00.000Z", failedEnvelope.jobId);
  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=3,
      completed_at=?,error_code='ai_unavailable' WHERE analysis_section_id=?`)
    .run("2026-07-20T10:02:00.000Z", failedEnvelope.payload.analysisSectionId);
  env.DB.db.prepare(`UPDATE ingestion_runs SET status='complete_with_errors',completed_at=? WHERE run_id=?`)
    .run("2026-07-20T10:02:00.000Z", preparation.runId);
  env.sent.length = 0;
  let failDispatch = true;
  env.INGESTION_QUEUE.send = async (body) => {
    if (failDispatch) throw new Error("queue unavailable");
    env.sent.push(body);
  };
  const request = () => fetchHandler(new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "reprocess", transcriptId: preparation.payload.transcriptId }),
  }), env);
  const failedDispatch = await request();
  assert.equal(failedDispatch.status, 503);
  assert.equal((await failedDispatch.json()).dispatchFailed, 1);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_jobs WHERE job_id=?")
    .get(failedEnvelope.jobId).status, "failed");
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_analysis_sections WHERE analysis_section_id=?")
    .get(failedEnvelope.payload.analysisSectionId).status, "failed");
  failDispatch = false;
  const retriedResponse = await request();
  assert.equal(retriedResponse.status, 202);
  const retried = await retriedResponse.json();
  assert.deepEqual({ retried: retried.retried, dispatchFailed: retried.dispatchFailed },
    { retried: 1, dispatchFailed: 0 });
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].jobId, failedEnvelope.jobId);
  assert.equal(env.DB.db.prepare("SELECT attempt_count FROM ingestion_jobs WHERE job_id=?")
    .get(failedEnvelope.jobId).attempt_count, 3);
  assert.equal(env.DB.db.prepare("SELECT attempt_count FROM transcript_analysis_sections WHERE analysis_section_id=?")
    .get(failedEnvelope.payload.analysisSectionId).attempt_count, 3);
  const completed = env.DB.db.prepare(`SELECT status,extraction_run_id FROM transcript_analysis_sections
    WHERE analysis_section_id=?`).get(completedEnvelope.payload.analysisSectionId);
  assert.equal(completed.status, "completed");
  assert.ok(completed.extraction_run_id);
  const duplicate = await request();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).reused, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_events").get().count, 0);
});

test("transcript reprocess never retries final deterministic analysis failures", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const transcript = "[CLIP 00:00:00-00:05:00]\nSection words.";
  const preparation = await seedAnalysisPreparation(env, { youtubeId: "NoRetryV500", transcript });
  await processEnvelope(env, preparation, { at: AT });
  const analysis = env.sent.pop();
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=1,completed_at=?,
      error_code='invalid_transcript_analysis_binding' WHERE job_id=?`).run(AT, analysis.jobId);
  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=1,
      completed_at=?,error_code='invalid_transcript_analysis_binding' WHERE analysis_section_id=?`)
    .run(AT, analysis.payload.analysisSectionId);
  env.sent.length = 0;
  const response = await fetchHandler(new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "reprocess", transcriptId: preparation.payload.transcriptId }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).retried, 0);
  assert.equal(env.sent.length, 0);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_jobs WHERE job_id=?").get(analysis.jobId).status, "failed");
});

test("transcript reprocess retries the exact repaired v5 persistence failure once within the attempt cap", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const transcript = "[CLIP 00:00:00-00:05:00]\nSection words.";
  const preparation = await seedAnalysisPreparation(env, { youtubeId: "RetryFixed01", transcript });
  await processEnvelope(env, preparation, { at: AT });
  const analysis = env.sent.pop();
  const repairedError = "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)";
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=7,completed_at=?,
      error_code=? WHERE job_id=?`).run(AT, repairedError, analysis.jobId);
  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=7,
      completed_at=?,error_code=? WHERE analysis_section_id=?`)
    .run(AT, repairedError, analysis.payload.analysisSectionId);
  env.sent.length = 0;
  const request = () => fetchHandler(new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "reprocess", transcriptId: preparation.payload.transcriptId }),
  }), env);
  const retried = await request();
  assert.equal(retried.status, 202);
  assert.equal((await retried.json()).retried, 1);
  assert.equal(env.sent.length, 1);
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=8,completed_at=?,
      error_code=? WHERE job_id=?`).run(AT, repairedError, analysis.jobId);
  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=8,
      completed_at=?,error_code=? WHERE analysis_section_id=?`)
    .run(AT, repairedError, analysis.payload.analysisSectionId);
  env.sent.length = 0;
  const capped = await request();
  assert.equal(capped.status, 200);
  assert.equal((await capped.json()).retried, 0);
  assert.equal(env.sent.length, 0);
});

test("authenticated exact section reprocess is idempotent and returns a fresh bounded dispatch receipt", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const transcript = `[CLIP 00:00:00-00:05:00]\nA bounded analysis section.`;
  const preparation = await seedAnalysisPreparation(env, { youtubeId: "SectionRx01", transcript });
  await processEnvelope(env, preparation, { at: AT });
  const envelope = env.sent.pop();
  env.sent.length = 0;
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=2,claimed_at=NULL,
      lease_token=NULL,completed_at=?,error_code='ai_timeout_unconfirmed' WHERE job_id=?`)
    .run("2026-07-20T10:02:00.000Z", envelope.jobId);
  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=2,
      completed_at=?,error_code='ai_timeout_unconfirmed' WHERE analysis_section_id=?`)
    .run("2026-07-20T10:02:00.000Z", envelope.payload.analysisSectionId);
  const request = (key = "analysis-reconciler/test/section") => new Request(
    "https://scanner.example/admin/transcript-analysis", {
      method: "POST", headers: { authorization: "Bearer admin-secret",
        "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ action: "reprocess_section",
        analysisSectionId: envelope.payload.analysisSectionId, expectedAttemptCount: 2 }),
    });
  const unauthorized = await fetchHandler(new Request(request(), {
    headers: { "content-type": "application/json", "idempotency-key": "analysis-reconciler/test/section" },
  }), env);
  assert.equal(unauthorized.status, 401);
  const send = env.ANALYSIS_QUEUE.send;
  env.ANALYSIS_QUEUE.send = async () => { throw new Error("queue unavailable"); };
  const failedDispatch = await fetchHandler(request(), env);
  assert.equal(failedDispatch.status, 503);
  assert.equal((await failedDispatch.json()).reason, "queue_dispatch_failed");
  const pending = { ...env.DB.db.prepare(`SELECT section.status section_status,job.status job_status,
      section.error_code section_error_code,job.error_code job_error_code
    FROM transcript_analysis_sections section JOIN ingestion_jobs job
      ON json_extract(job.payload_json,'$.analysisSectionId')=section.analysis_section_id
    WHERE section.analysis_section_id=?`).get(envelope.payload.analysisSectionId) };
  assert.equal(pending.section_status, "queued"); assert.equal(pending.job_status, "queued");
  assert.match(pending.section_error_code, /^analysis_reprocess_outbox_pending:/);
  assert.equal(pending.job_error_code, pending.section_error_code);
  const outbox = env.DB.db.prepare("SELECT * FROM analysis_reprocess_dispatch_outbox").get();
  assert.equal(outbox.status, "pending");
  // Simulate a Worker eviction after it durably claimed the outbox but before Queue send.
  env.DB.db.prepare(`UPDATE analysis_reprocess_dispatch_outbox SET status='dispatching',
    claim_token='crashed-worker',claimed_at='2026-07-20T09:00:00.000Z',dispatch_attempt_count=dispatch_attempt_count+1
    WHERE action_id=?`).run(outbox.action_id);
  env.ANALYSIS_QUEUE.send = send;
  const firstResponse = await fetchHandler(request(), env);
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  assert.equal(first.contract, "analysis-section-reprocess-v1");
  assert.equal(first.analysisSectionId, envelope.payload.analysisSectionId);
  assert.equal(first.jobId, envelope.jobId);
  assert.equal(first.dispatched, true);
  assert.equal(first.reused, false);
  assert.equal(first.readback.sectionStatus, "queued");
  assert.equal(first.readback.jobStatus, "queued");
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.analysisSectionId, envelope.payload.analysisSectionId);
  assert.equal("transcript" in first, false);

  const replayResponse = await fetchHandler(request(), env);
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.actionId, first.actionId);
  assert.equal(replay.idempotencyKeySha256, first.idempotencyKeySha256);
  assert.equal(replay.dispatched, true);
  assert.equal(replay.reused, true);
  assert.equal(env.sent.length, 1);

  const stale = await fetchHandler(request("analysis-reconciler/test/stale"), env);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).reason, "section_not_retryable");
});

test("legacy exact section reprocess returns a typed successor receipt before validation or outbox", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const transcript = `[CLIP 00:00:00-00:05:00]\nA historical analysis section.`;
  const preparation = await seedAnalysisPreparation(env, { youtubeId: "StaleRoute01", transcript });
  await processEnvelope(env, preparation, { at: AT });
  const envelope = env.sent.pop();
  const currentSection = env.DB.db.prepare(`SELECT section_index,input_sha256,base_offset,
    approximate_timestamp_seconds FROM transcript_analysis_sections WHERE analysis_section_id=?`)
    .get(envelope.payload.analysisSectionId);
  const historicalPromptVersion = "transcript-claims-v9-archive-quoted-checklist";
  const historicalAnalysisRunId = await stableId("txan",
    `${preparation.payload.transcriptId}:${historicalPromptVersion}`);
  const historicalIngestionRunId = await stableId("runan",
    `${historicalAnalysisRunId}:${preparation.payload.sourceItemId}`);
  await createRun(env.DB, { runId: historicalIngestionRunId, personId: "person_troy_black",
    triggerType: "manual", scope: `transcript_analysis:${historicalAnalysisRunId}`, createdAt: AT });
  env.DB.db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,completed_section_count,failed_section_count,status,created_at,completed_at)
    VALUES (?,?,?,?,?,?,1,0,1,'failed',?,?)`).run(historicalAnalysisRunId,
    historicalIngestionRunId, preparation.payload.transcriptId, preparation.payload.sourceItemId,
    preparation.payload.transcriptSha256, historicalPromptVersion, AT, AT);
  const historicalSectionId = await stableId("txas",
    `${historicalAnalysisRunId}:${currentSection.section_index}:${currentSection.input_sha256}`);
  env.DB.db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,status,attempt_count,error_code,completed_at,created_at)
    VALUES (?,?,?,?,?,?,'failed',2,'invalid_json',?,?)`).run(historicalSectionId,
    historicalAnalysisRunId, currentSection.section_index, currentSection.input_sha256,
    currentSection.base_offset, currentSection.approximate_timestamp_seconds, AT, AT);
  const historicalStableKey = `transcript:${preparation.payload.transcriptId}:analysis:${currentSection.section_index}:${historicalPromptVersion}`;
  const historicalEnvelope = await makeEnvelope({ runId: historicalIngestionRunId,
    personId: "person_troy_black", type: "transcript_extract", stableKey: historicalStableKey,
    payload: { ...envelope.payload, analysisRunId: historicalAnalysisRunId,
      analysisSectionId: historicalSectionId, promptVersion: historicalPromptVersion } });
  await registerJob(env.DB, historicalEnvelope, AT);
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=2,
    completed_at=?,error_code='invalid_json' WHERE job_id=?`).run(AT, historicalEnvelope.jobId);
  const before = { ...env.DB.db.prepare(`SELECT status,attempt_count,error_code,completed_at
    FROM transcript_analysis_sections WHERE analysis_section_id=?`)
    .get(historicalSectionId) };
  const response = await fetchHandler(new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret",
      "content-type": "application/json", "idempotency-key": "analysis-reconciler/stale/v9" },
    body: JSON.stringify({ action: "reprocess_section",
      analysisSectionId: historicalSectionId, expectedAttemptCount: 2 }),
  }), env);
  assert.equal(response.status, 409);
  const receipt = await response.json();
  assert.equal(receipt.contract, "analysis-section-reprocess-v1");
  assert.equal(receipt.reason, "stale_prompt_requires_successor");
  assert.equal(receipt.dispatched, false);
  assert.deepEqual({ ...env.DB.db.prepare(`SELECT status,attempt_count,error_code,completed_at
    FROM transcript_analysis_sections WHERE analysis_section_id=?`)
    .get(historicalSectionId) }, before);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_reprocess_dispatch_outbox").get().count, 0);
  assert.equal(env.sent.length, 0);
});
