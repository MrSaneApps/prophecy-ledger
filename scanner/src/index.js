import { processQueueBatch, scannerStatus, startFirstPartyArchiveIngest, startScan,
  reprocessTranscriptAnalysis, startTranscriptCanary, startVideoAnalysisCanary } from "./jobs.js";
import {
  repairLegacyStitchedTranscriptBatchItem, resumeScheduledTranscriptBatch, resumeTranscriptBatch,
  startTranscriptBatch, syncArchiveLinkedTranscriptBatch, transcriptBatchStatus,
} from "./transcript-batch.js";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function sameSecret(left, right) {
  if (!left || !right) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([left, right].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) difference |= (x[i] || 0) ^ (y[i] || 0);
  return difference === 0;
}

async function authorized(request, env) {
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : request.headers.get("x-scanner-admin-token") || "";
  return sameSecret(supplied, env.SCANNER_ADMIN_TOKEN || "");
}

async function fetchHandler(request, env, { durationFetcher = fetch } = {}) {
  if (!(await authorized(request, env))) return json({ error: "not_authorized" }, 401);
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/admin/health") {
    const db = await env.DB.prepare("SELECT 1 ok").first();
    const byok = env.AI_GATEWAY_BYOK === "1";
    const aiGateway = Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_ID && env.AI_GATEWAY_TOKEN &&
      (byok || env.GEMINI_API_KEY));
    return json({ ok: db?.ok === 1, scannerEnabled: env.SCAN_ENABLED === "1",
      transcriptBatchEnabled: env.TRANSCRIPT_BATCH_ENABLED === "1", bindings: {
      d1: Boolean(env.DB), queue: Boolean(env.INGESTION_QUEUE), ai: Boolean(env.AI), aiGateway,
      aiGatewayByok: byok, directGemini: Boolean(env.GEMINI_API_KEY),
      youtubeDataApi: Boolean(env.YOUTUBE_DATA_API_KEY), artifacts: Boolean(env.ARTIFACTS),
    } });
  }
  if (request.method === "POST" && url.pathname === "/admin/start") {
    const body = await request.json().catch(() => ({}));
    if (body.scope && !["canary", "full"].includes(body.scope)) return json({ error: "invalid_scope" }, 400);
    const result = await startScan(env, { triggerType: "manual", canary: body.scope === "canary" });
    return json(result, result.started ? 202 : 503);
  }
  if (request.method === "POST" && url.pathname === "/admin/archive-ingest") {
    const body = await request.json().catch(() => ({}));
    const result = await startFirstPartyArchiveIngest(env, {
      sourceId: body.sourceId, expectedMinRows: body.expectedMinRows ?? 1,
    });
    const status = result.started ? (result.reused ? 200 : 202) :
      ["invalid_archive_source_id", "invalid_expected_min_rows"].includes(result.reason) ? 400 :
        result.reason === "trusted_archive_source_not_found" ? 404 : 503;
    return json(result, status);
  }
  if (request.method === "GET" && url.pathname === "/admin/status") {
    const runId = url.searchParams.get("runId");
    if (!runId) return json({ error: "run_id_required" }, 400);
    const result = await scannerStatus(env, runId);
    return result ? json(result) : json({ error: "run_not_found" }, 404);
  }
  if (request.method === "POST" && url.pathname === "/admin/video-canary") {
    const body = await request.json().catch(() => ({}));
    if (body.force !== undefined && typeof body.force !== "boolean") return json({ error: "invalid_force" }, 400);
    const result = await startVideoAnalysisCanary(env, { youtubeId: body.youtubeId, force: body.force === true });
    const status = result.started ? 202 : result.reason === "trusted_source_item_not_found" ? 404 :
      result.reason === "invalid_youtube_id" ? 400 : 503;
    return json(result, status);
  }
  if (request.method === "POST" && url.pathname === "/admin/transcript-canary") {
    const body = await request.json().catch(() => ({}));
    if (body.force !== undefined && typeof body.force !== "boolean") return json({ error: "invalid_force" }, 400);
    const result = await startTranscriptCanary(env, { personSlug: body.personSlug || "troy-black",
      youtubeId: body.youtubeId, expectedDurationSeconds: body.durationSeconds ?? null, force: body.force === true });
    const status = result.started ? 202 : result.reason === "trusted_source_item_not_found" ? 404 :
      result.reason === "transcript_batch_active" ? 409 :
      ["invalid_person_slug", "invalid_youtube_id", "invalid_video_duration", "video_duration_mismatch"].includes(result.reason) ? 400 : 503;
    return json(result, status);
  }
  if (request.method === "POST" && url.pathname === "/admin/transcript-analysis") {
    const body = await request.json().catch(() => ({}));
    if (body.action !== "reprocess") return json({ error: "invalid_action" }, 400);
    const result = await reprocessTranscriptAnalysis(env, { transcriptId: body.transcriptId });
    const status = result.started ? (result.reused ? 200 : 202) :
      result.reason === "invalid_transcript_id" ? 400 :
        result.reason === "trusted_transcript_not_found" ? 404 : 503;
    return json(result, status);
  }
  if (url.pathname === "/admin/transcript-batch" && request.method === "GET") {
    const result = await transcriptBatchStatus(env, url.searchParams.get("batchId"));
    return result ? json(result) : json({ error: "batch_not_found" }, 404);
  }
  if (url.pathname === "/admin/transcript-batch" && request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !["start", "resume", "sync_archive_items", "repair_legacy_stitch"].includes(body.action)) {
      return json({ error: "invalid_action" }, 400);
    }
    if (body.action === "sync_archive_items") {
      const result = await syncArchiveLinkedTranscriptBatch(env, { batchId: body.batchId });
      const status = result.synced ? 200 : result.reason === "invalid_batch_id" ? 400 :
        result.reason === "batch_not_found" ? 404 : 409;
      return json(result, status);
    }
    if (body.action === "repair_legacy_stitch") {
      const result = await repairLegacyStitchedTranscriptBatchItem(env, {
        batchId: body.batchId, batchItemId: body.batchItemId, durationFetcher,
      });
      const status = result.repaired ? 200 : result.reason === "invalid_batch_item" ? 400 :
        result.reason === "batch_item_not_found" ? 404 : 409;
      return json(result, status);
    }
    const idempotencyKey = request.headers.get("idempotency-key") || "";
    if (body.action === "resume") {
      const result = await resumeTranscriptBatch(env, { idempotencyKey, durationFetcher });
      const status = result.resumed ? 202 : result.reason === "batch_not_found" ? 404 :
        result.reason === "invalid_idempotency_key" ? 400 : 409;
      return json(result, status);
    }
    const result = await startTranscriptBatch(env, { idempotencyKey, durationFetcher });
    const status = result.started ? (result.reused ? 200 : 202) :
      result.reason === "invalid_idempotency_key" ? 400 :
        ["active_batch_exists", "active_transcript_run_exists"].includes(result.reason) ? 409 : 503;
    return json(result, status);
  }
  return json({ error: "not_found" }, 404);
}

export default {
  fetch: fetchHandler,
  queue: (batch, env) => processQueueBatch(batch, env),
  scheduled: (_event, env, ctx) => ctx.waitUntil(resumeScheduledTranscriptBatch(env)),
};

export { fetchHandler, sameSecret };
