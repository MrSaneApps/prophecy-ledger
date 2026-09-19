import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers/d1.mjs";
import { processEnvelope, scannerStatus, startVideoAnalysisCanary } from "../scanner/src/jobs.js";
import { upsertSourceItem } from "../scanner/src/repository.js";
import { fetchHandler } from "../scanner/src/index.js";

const YOUTUBE_ID = "ZidiIdg3U4M";
const VIDEO_URL = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`;
const durationFetcher = async () => new Response(
  '<script>{"lengthSeconds":"900"}</script>',
  { status: 200, headers: { "content-type": "text/html" } },
);
const startVideo = (env, options = {}) => startVideoAnalysisCanary(env, {
  ...options,
  durationFetcher,
});

const claim = (overrides = {}) => ({
  quote: "Rain will fall by Friday.", startSeconds: 120, endSeconds: 125,
  statementType: "testable_prediction", atomicProposition: "Rain will fall by Friday.",
  deadlineText: "by Friday", contextBefore: "Before", contextAfter: "After", confidence: 0.92,
  ...overrides,
});

const claimTuple = (value = claim()) => [
  value.quote, value.startSeconds, value.endSeconds, value.statementType,
  value.atomicProposition, value.deadlineText, value.contextBefore, value.contextAfter,
  value.confidence,
];

const checkTuple = (value, includeSupport = false) => [
  value.candidateId, ...claimTuple(value), ...(includeSupport ? [value.supports] : []),
];

function interaction(structured, model, logId = null) {
  return new Response(JSON.stringify({
    id: `interaction-${model}`, model, status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(structured) }] }],
  }), { status: 200, headers: { "content-type": "application/json", ...(logId ? { "cf-aig-log-id": logId } : {}) } });
}

function interactionText(text, model, logId) {
  return new Response(JSON.stringify({
    id: `interaction-${model}`, model, status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  }), { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": logId } });
}

async function videoEnv() {
  const env = makeEnv();
  env.SCANNER_ADMIN_TOKEN = "admin-secret";
  env.GEMINI_API_KEY = "gemini-secret";
  env.AI_GATEWAY_ACCOUNT_ID = "2c267ab06352ba2522114c3081a8c5fa";
  env.AI_GATEWAY_ID = "default";
  env.AI_GATEWAY_TOKEN = "gateway-secret";
  env.GEMINI_PRIMARY_MODEL = "primary-model";
  env.GEMINI_VERIFIER_MODEL = "verifier-model";
  env.GEMINI_TIEBREAKER_MODEL = "tie-model";
  env.sent = []; env.geminiCalls = []; env.responses = [];
  env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.GEMINI_FETCH = async (_url, options) => {
    const body = JSON.parse(options.body);
    env.geminiCalls.push(body);
    const next = env.responses.shift();
    if (next instanceof Response) return next;
    return interaction(next, body.model);
  };
  const source = await upsertSourceItem(env.DB, {
    personId: "person_troy_black", platform: "youtube", platformItemId: YOUTUBE_ID,
    canonicalUrl: VIDEO_URL, availability: "available",
  });
  return { env, source };
}

test("secret-gated video canary accepts only an existing trusted Troy video", async () => {
  const { env } = await videoEnv();
  const unauthorized = await fetchHandler(new Request("https://scanner.example/admin/video-canary", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ youtubeId: YOUTUBE_ID }),
  }), env, { durationFetcher });
  assert.equal(unauthorized.status, 401);
  const missing = await fetchHandler(new Request("https://scanner.example/admin/video-canary", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ youtubeId: "c3vf85nk1O0" }),
  }), env, { durationFetcher });
  assert.equal(missing.status, 404);
  const started = await fetchHandler(new Request("https://scanner.example/admin/video-canary", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ youtubeId: YOUTUBE_ID }),
  }), env, { durationFetcher });
  assert.equal(started.status, 202);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].type, "video_analysis_primary");
  assert.equal(env.sent[0].payload.sourceItemId.startsWith("src_"), true);
});

test("primary and independent verifier create an append-only AI-cross-verified record without a rating", async () => {
  const { env } = await videoEnv();
  env.responses.push(interaction({ claims: [claimTuple()] }, "primary-model", "gateway-log-primary"));
  await startVideo(env, { youtubeId: YOUTUBE_ID, force: true, runId: "run_video_agree" });
  const primaryJob = env.sent.shift();
  await processEnvelope(env, primaryJob);
  const candidate = env.DB.db.prepare("SELECT candidate_id FROM video_claim_candidates").get();
  env.responses.push({ checks: [checkTuple({ candidateId: candidate.candidate_id, ...claim({ quote: "Rain will fall by Friday", startSeconds: 121 }) })] });
  const verifierJob = env.sent.shift();
  await processEnvelope(env, verifierJob);

  assert.equal(env.geminiCalls.length, 2);
  assert.deepEqual(env.geminiCalls.map((call) => call.model), ["primary-model", "verifier-model"]);
  assert.equal(env.geminiCalls.every((call) => call.store === false), true);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM video_analysis_attempts WHERE status='completed'").get().count, 2);
  const primaryAttempt = env.DB.db.prepare("SELECT gateway_log_id,http_status FROM video_analysis_attempts WHERE stage='primary'").get();
  assert.equal(primaryAttempt.gateway_log_id, "gateway-log-primary");
  assert.equal(primaryAttempt.http_status, 200);
  assert.equal(env.DB.db.prepare("SELECT outcome FROM video_agreement_results").get().outcome, "ai_cross_verified");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM video_escalation_events").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_artifacts").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claims").get().count, 2);

  env.DB.db.prepare("UPDATE ingestion_jobs SET successor_enqueued=0 WHERE job_id=?").run(primaryJob.jobId);
  await processEnvelope(env, primaryJob);
  assert.equal(env.geminiCalls.length, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM video_analysis_attempts").get().count, 2);

  const repeatedStart = await startVideo(env, { youtubeId: YOUTUBE_ID, runId: "must_not_start" });
  assert.equal(repeatedStart.reused, true);
  assert.equal(repeatedStart.runId, "run_video_agree");
  assert.equal(env.sent.length, 1);
});

test("a third independent pass resolves one dispute and escalates an unresolved conflict", async () => {
  const { env } = await videoEnv();
  env.responses.push({ claims: [
    claimTuple(),
    claimTuple(claim({ quote: "The river will freeze by winter.", startSeconds: 300, endSeconds: 304, atomicProposition: "The river will freeze by winter.", deadlineText: "by winter" })),
  ] });
  await startVideo(env, { youtubeId: YOUTUBE_ID, force: true, runId: "run_video_tie" });
  await processEnvelope(env, env.sent.shift());
  const candidates = env.DB.db.prepare("SELECT candidate_id,ordinal FROM video_claim_candidates ORDER BY ordinal").all();
  env.responses.push({ checks: [
    checkTuple({ candidateId: candidates[0].candidate_id, ...claim({ quote: "Snow is falling now.", startSeconds: 500, endSeconds: 504, statementType: "present_or_past_factual_claim", atomicProposition: "Snow is falling now.", deadlineText: null }) }),
    checkTuple({ candidateId: candidates[1].candidate_id, ...claim({ quote: "The sea is warm.", startSeconds: 600, endSeconds: 604, statementType: "present_or_past_factual_claim", atomicProposition: "The sea is warm.", deadlineText: null }) }),
  ] });
  await processEnvelope(env, env.sent.shift());
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM video_agreement_results WHERE outcome='tiebreaker_required'").get().count, 2);
  env.responses.push({ checks: [
    checkTuple({ candidateId: candidates[0].candidate_id, ...claim(), supports: "primary" }, true),
    checkTuple({ candidateId: candidates[1].candidate_id, ...claim({ quote: "A mountain will move by winter.", startSeconds: 800, endSeconds: 804, atomicProposition: "A mountain will move by winter.", deadlineText: "by winter" }), supports: "neither" }, true),
  ] });
  await processEnvelope(env, env.sent.shift());
  const final = env.DB.db.prepare(`SELECT outcome,supersedes_agreement_id FROM video_agreement_results
    WHERE outcome <> 'tiebreaker_required' ORDER BY outcome`).all();
  assert.deepEqual(final.map((row) => row.outcome), ["ai_cross_verified", "human_review_required"]);
  assert.equal(final.every((row) => Boolean(row.supersedes_agreement_id)), true);
  assert.equal(env.DB.db.prepare("SELECT state FROM video_escalation_events").get().state, "open");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claims").get().count, 2);
});

test("retryable Gemini failures are recorded as separate immutable attempts before a successful retry", async () => {
  const { env } = await videoEnv();
  env.responses.push(new Response("busy", { status: 503 }), { claims: [] });
  await startVideo(env, { youtubeId: YOUTUBE_ID, force: true, runId: "run_video_retry" });
  const job = env.sent.shift();
  await assert.rejects(() => processEnvelope(env, job), /gemini_http_503/);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_jobs WHERE job_id=?").get(job.jobId).status, "queued");
  const failedAttempt = env.DB.db.prepare("SELECT gateway_log_id,http_status,raw_output_json FROM video_analysis_attempts WHERE status='failed'").get();
  assert.equal(failedAttempt.gateway_log_id, null);
  assert.equal(failedAttempt.http_status, 503);
  assert.equal(JSON.parse(failedAttempt.raw_output_json).bodyExcerpt, "busy");
  await processEnvelope(env, job);
  assert.deepEqual(env.DB.db.prepare("SELECT status FROM video_analysis_attempts ORDER BY completed_at,attempt_id").all().map((row) => row.status).sort(), ["completed", "failed"]);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_video_retry'").get().status, "complete");
});

test("invalid structured model output is retained for audit while the job fails closed", async () => {
  const { env } = await videoEnv();
  env.responses.push({ claims: [{ ...claim(), outcome: "true" }] });
  await startVideo(env, { youtubeId: YOUTUBE_ID, force: true, runId: "run_video_invalid" });
  await assert.rejects(() => processEnvelope(env, env.sent.shift()), /gemini_invalid_claim_fields/);
  const attempt = env.DB.db.prepare("SELECT status,error_code,raw_output_json,structured_output_json FROM video_analysis_attempts").get();
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.error_code, "gemini_invalid_claim_fields");
  assert.equal(JSON.parse(attempt.structured_output_json).claims[0].outcome, "true");
  assert.equal(JSON.parse(attempt.raw_output_json).status, "completed");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM video_claim_candidates").get().count, 0);
});

test("invalid model-output JSON retains the full gateway correlation in the immutable failure", async () => {
  const { env } = await videoEnv();
  env.responses.push(interactionText("not-json", "primary-model", "gateway-log-invalid-json"));
  await startVideo(env, { youtubeId: YOUTUBE_ID, force: true, runId: "run_video_invalid_json" });
  await assert.rejects(() => processEnvelope(env, env.sent.shift()), /gemini_invalid_output_json/);
  const attempt = env.DB.db.prepare(`SELECT status,error_code,gateway_log_id,http_status,raw_output_json,
    structured_output_json FROM video_analysis_attempts`).get();
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.error_code, "gemini_invalid_output_json");
  assert.equal(attempt.gateway_log_id, "gateway-log-invalid-json");
  assert.equal(attempt.http_status, 200);
  assert.equal(JSON.parse(attempt.raw_output_json).status, "completed");
  assert.equal(attempt.structured_output_json, null);
});

test("concurrent default canary starts atomically reuse one deterministic run and enqueue once", async () => {
  const { env } = await videoEnv();
  const [first, second] = await Promise.all([
    startVideo(env, { youtubeId: YOUTUBE_ID }),
    startVideo(env, { youtubeId: YOUTUBE_ID }),
  ]);
  assert.equal(first.runId, second.runId);
  assert.equal([first.reused, second.reused].filter(Boolean).length, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_runs WHERE scope LIKE 'video_analysis:%'").get().count, 1);
  assert.equal(env.sent.length, 1);
});

test("status recovery does not reclaim an in-flight paid analysis inside its five-minute lease", async () => {
  const { env } = await videoEnv();
  let release;
  env.GEMINI_FETCH = async (_url, options) => {
    const body = JSON.parse(options.body);
    env.geminiCalls.push(body);
    return new Promise((resolve) => { release = () => resolve(interaction({ claims: [] }, body.model)); });
  };
  await startVideo(env, { youtubeId: YOUTUBE_ID, force: true, runId: "run_video_inflight" });
  const job = env.sent.shift();
  const processing = processEnvelope(env, job);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const claimedAt = env.DB.db.prepare("SELECT claimed_at FROM ingestion_jobs WHERE job_id=?").get(job.jobId).claimed_at;
  const status = await scannerStatus(env, "run_video_inflight", {
    now: new Date(new Date(claimedAt).getTime() + 180_000).toISOString(),
  });
  assert.deepEqual(status.recovery, { recovered: 0, dispatchFailed: 0 });
  assert.equal(env.geminiCalls.length, 1);
  release();
  await processing;
  assert.equal(env.geminiCalls.length, 1);
});
