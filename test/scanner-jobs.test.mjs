import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, ROOT } from "./helpers/d1.mjs";
import { dispatchSuccessors, makeEnvelope, processEnvelope, processQueueBatch, scannerStatus,
  startFirstPartyArchiveIngest, startScan, validateEnvelope } from "../scanner/src/jobs.js";
import { claimJob, createRun, persistFirstPartyArchive, recordSourceMediaMetadata,
  recordWorkersAiAttempt, registerJob, upsertSourceItem } from "../scanner/src/repository.js";
import { fetchHandler } from "../scanner/src/index.js";
import { getSourceCatalogue } from "../functions/lib/repository.js";

const archiveHtml = readFileSync(join(ROOT, "test/fixtures/scanner/archive-page.html"), "utf8");
const detailHtml = readFileSync(join(ROOT, "test/fixtures/scanner/post-detail-youtube.html"), "utf8");
const detailNoDateHtml = readFileSync(join(ROOT, "test/fixtures/scanner/post-detail-no-video.html"), "utf8");
const terminalHtml = readFileSync(join(ROOT, "test/fixtures/scanner/archive-terminal.html"), "utf8");
const fulfilledArchiveHtml = readFileSync(join(ROOT, "test/fixtures/scanner/fulfilled-prophecy-archive.html"), "utf8");

function scannerEnv() {
  const env = makeEnv();
  env.PARSER_VERSION = "test-v1";
  env.AI_MODEL = "primary";
  env.AI_FALLBACK_MODEL = "fallback";
  env.SCAN_ENABLED = "1";
  env.sent = [];
  env.aiCalls = 0;
  env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.AI = { run: async () => {
    env.aiCalls += 1;
    return { response: JSON.stringify({ category: "testable_prediction", neutralParaphrase: "The description may contain a prediction." }) };
  } };
  return env;
}

test("envelopes and IDs are deterministic and reject arbitrary job fields", async () => {
  const one = await makeEnvelope({ runId: "run_one", type: "archive_page", stableKey: "page:1", payload: { page: 1 } });
  const two = await makeEnvelope({ runId: "run_one", type: "archive_page", stableKey: "page:1", payload: { page: 1 } });
  assert.equal(one.jobId, two.jobId);
  assert.equal(validateEnvelope(one), one);
  assert.throws(() => validateEnvelope({ ...one, url: "https://example.com" }), /invalid_envelope_fields/);
  assert.throws(() => validateEnvelope({ ...one, payload: { page: 251 } }), /invalid_archive_page/);
});

test("provider-aware attempt receipts preserve confirmed Gemini aborts append-only", async () => {
  const env = makeEnv();
  env.DB.db.exec(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES ('run_text_receipt','person_troy_black','manual','text-receipt','running','2026-08-04');
    INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,claimed_at)
    VALUES ('job_text_receipt','run_text_receipt','description_triage','text-receipt','{}',
      'processing',1,'2026-08-04');`);
  const common = { attemptId: "attempt_text_receipt", workKind: "description_triage",
    jobId: "job_text_receipt", jobAttempt: 1, modelName: "gemini-test",
    providerName: "gemini-ai-gateway", mode: "json_schema", ordinal: 0,
    startedAt: "2026-08-04T05:00:00.000Z" };
  await recordWorkersAiAttempt(env.DB, { ...common, status: "started",
    safeCauseCode: null, fallbackEligible: false });
  await assert.rejects(() => recordWorkersAiAttempt(env.DB, { ...common,
    providerName: "workers-ai", status: "failed", safeCauseCode: "provider_5xx",
    fallbackEligible: true, completedAt: "2026-08-04T05:00:00.500Z", latencyMs: 500 }),
  /terminal missing started receipt/);
  await recordWorkersAiAttempt(env.DB, { ...common, status: "failed",
    safeCauseCode: "ai_timeout_confirmed", fallbackEligible: true,
    completedAt: "2026-08-04T05:00:01.000Z", latencyMs: 1_000 });
  assert.deepEqual(env.DB.db.prepare(`SELECT provider_name,status,safe_cause_code
    FROM text_ai_attempt_receipt_history ORDER BY status`).all().map((row) => ({ ...row })), [
    { provider_name: "gemini-ai-gateway", status: "failed",
      safe_cause_code: "ai_timeout_confirmed" },
    { provider_name: "gemini-ai-gateway", status: "started", safe_cause_code: null },
  ]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM workers_ai_attempt_receipts").get().count, 0);

  env.DB.db.prepare(`INSERT INTO workers_ai_attempt_receipts
    (receipt_id,attempt_id,work_kind,job_id,job_attempt,analysis_run_id,analysis_section_id,
     model_name,mode,ordinal,status,safe_cause_code,http_status,fallback_eligible,
     started_at,completed_at,latency_ms)
    VALUES ('legacy_started_receipt','attempt_legacy_bridge','description_triage',
      'job_text_receipt',1,NULL,NULL,'gemini-test','json_schema',1,'started',NULL,NULL,0,
      '2026-08-04T05:01:00.000Z',NULL,NULL)`).run();
  await recordWorkersAiAttempt(env.DB, {
    ...common, receiptId: "new_terminal_receipt", attemptId: "attempt_legacy_bridge", ordinal: 1,
    startedAt: "2026-08-04T05:01:00.000Z", status: "failed",
    safeCauseCode: "ai_timeout_confirmed", fallbackEligible: true,
    completedAt: "2026-08-04T05:01:01.000Z", latencyMs: 1_000,
  });
  assert.deepEqual(env.DB.db.prepare(`SELECT provider_name,status
    FROM text_ai_attempt_receipt_history WHERE attempt_id='attempt_legacy_bridge'
    ORDER BY status`).all().map((row) => ({ ...row })), [
    { provider_name: "gemini-ai-gateway", status: "failed" },
    { provider_name: "legacy-unspecified", status: "started" },
  ]);
  assert.throws(() => env.DB.db.exec("UPDATE text_ai_attempt_receipts SET model_name='changed'"),
    /append-only/);
  assert.throws(() => env.DB.db.exec("DELETE FROM text_ai_attempt_receipts"), /append-only/);
});

test("disabled scanner blocks scheduled scans but allows authenticated manual work, and malformed Queue messages are acknowledged", async () => {
  const env = scannerEnv();
  env.SCAN_ENABLED = "0";
  env.SCANNER_ADMIN_TOKEN = "admin-secret";
  const manual = await fetchHandler(new Request("https://scanner.example/admin/start", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ scope: "canary" }),
  }), env);
  assert.equal(manual.status, 202);
  assert.equal((await startScan(env, { triggerType: "scheduled", runId: "run_scheduled_disabled" })).reason, "scanner_disabled");
  assert.equal(env.sent.length, 1);
  env.sent = [];
  let acked = false; let retried = false;
  await processQueueBatch({ messages: [{ body: { version: 99 }, ack: () => { acked = true; }, retry: () => { retried = true; } }] }, env);
  assert.equal(acked, true);
  assert.equal(retried, false);
});

test("analysis work is rejected from the acquisition queue without being processed", async () => {
  const env = scannerEnv(); let acked = false; let retried = false;
  await processQueueBatch({ queue: "prophecy-ledger-ingestion", messages: [{
    body: { type: "transcript_extract", payload: { phase: "analyze" } },
    ack: () => { acked = true; }, retry: ({ delaySeconds }) => { retried = delaySeconds === 60; },
  }] }, env);
  assert.equal(acked, false);
  assert.equal(retried, true);
  assert.equal(env.DB.statementCount, 0);
});

test("every full-video Gemini call reserves the physical fuse before fetch and cap exhaustion prevents another call", async () => {
  const env = scannerEnv(); env.GEMINI_DAILY_MEDIA_SECONDS = "60";
  env.GEMINI_API_KEY = "provider-secret";
  env.AI_GATEWAY_ACCOUNT_ID = "2c267ab06352ba2522114c3081a8c5fa";
  env.AI_GATEWAY_ID = "default"; env.AI_GATEWAY_TOKEN = "gateway-secret";
  const source = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube",
    platformItemId: "VideoFuse01", canonicalUrl: "https://www.youtube.com/watch?v=VideoFuse01" });
  await recordSourceMediaMetadata(env.DB, { sourceItemId: source.source_item_id,
    durationSeconds: 60, responseSha256: "a".repeat(64), observedAt: "2026-08-03T12:00:00.000Z" });
  let calls = 0;
  env.GEMINI_FETCH = async () => {
    calls += 1;
    assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM gemini_physical_request_reservations").get().count, 1);
    return new Response(JSON.stringify({ id: "interaction-fuse", model: "gemini-test", status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify({ claims: [] }) }] }],
    }), { status: 200, headers: { "cf-aig-log-id": "safe-log-id" } });
  };
  const firstRun = "run_video_fuse_one";
  await createRun(env.DB, { runId: firstRun, personId: "person_troy_black", triggerType: "canary",
    scope: "video-fuse-one", createdAt: "2026-08-03T12:00:00.000Z" });
  const first = await makeEnvelope({ runId: firstRun, type: "video_analysis_primary",
    stableKey: "youtube:VideoFuse01:primary", payload: { youtubeId: "VideoFuse01", sourceItemId: source.source_item_id } });
  await processEnvelope(env, first, { at: "2026-08-03T12:00:00.000Z",
    physicalNow: () => "2026-08-03T12:00:00.100Z" });
  assert.equal(calls, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM gemini_physical_request_results WHERE status='completed'").get().count, 1);
  const secondRun = "run_video_fuse_two";
  await createRun(env.DB, { runId: secondRun, personId: "person_troy_black", triggerType: "canary",
    scope: "video-fuse-two", createdAt: "2026-08-03T12:01:00.000Z" });
  const second = await makeEnvelope({ runId: secondRun, type: "video_analysis_primary",
    stableKey: "youtube:VideoFuse01:primary:retry", payload: { youtubeId: "VideoFuse01", sourceItemId: source.source_item_id } });
  await assert.rejects(() => processEnvelope(env, second, { at: "2026-08-03T12:01:00.000Z",
    physicalNow: () => "2026-08-03T12:01:00.100Z" }), /gemini_video_budget_deferred/);
  assert.equal(calls, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM gemini_physical_request_reservations").get().count, 1);
});

test("authenticated operations status persists complete metrics for acquisition, analysis, and both DLQs", async () => {
  const env = scannerEnv(); env.SCANNER_ADMIN_TOKEN = "admin-secret";
  const observed = new Date("2026-08-03T10:00:00.000Z");
  const binding = (backlogCount, backlogBytes) => ({ metrics: async () => ({
    backlogCount, backlogBytes, oldestMessageTimestamp: backlogCount ? observed : null,
  }) });
  env.INGESTION_QUEUE = binding(2, 400);
  env.ANALYSIS_QUEUE = binding(1, 200);
  env.INGESTION_DLQ = binding(0, 0);
  env.ANALYSIS_DLQ = binding(0, 0);
  const response = await fetchHandler(new Request("https://scanner.example/admin/operations-status", {
    headers: { authorization: "Bearer admin-secret" },
  }), env);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.contract, "queue-operations-status-v1");
  assert.equal(receipt.healthy, true);
  assert.equal(receipt.queues.length, 4);
  assert.deepEqual(receipt.queues.map((queue) => [queue.queueName, queue.backlogCount,
    queue.backlogBytes, queue.oldestMessageTimestamp]), [
    ["prophecy-ledger-ingestion", 2, 400, observed.toISOString()],
    ["prophecy-ledger-analysis", 1, 200, observed.toISOString()],
    ["prophecy-ledger-ingestion-dlq", 0, 0, null],
    ["prophecy-ledger-analysis-dlq", 0, 0, null],
  ]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM queue_observation_receipts").get().count, 4);
});

test("operations status fails closed and receipts an unavailable queue metric", async () => {
  const env = scannerEnv(); env.SCANNER_ADMIN_TOKEN = "admin-secret";
  const binding = { metrics: async () => ({ backlogCount: 0, backlogBytes: 0,
    oldestMessageTimestamp: null }) };
  env.INGESTION_QUEUE = binding; env.ANALYSIS_QUEUE = binding; env.INGESTION_DLQ = binding;
  const response = await fetchHandler(new Request("https://scanner.example/admin/queue-status", {
    headers: { authorization: "Bearer admin-secret" },
  }), env);
  assert.equal(response.status, 503);
  const receipt = await response.json();
  assert.equal(receipt.healthy, false);
  const unavailable = receipt.queues.find((queue) => queue.queueName === "prophecy-ledger-analysis-dlq");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.safeReasonCode, "queue_binding_missing");
  assert.equal(env.DB.db.prepare(`SELECT COUNT(*) count FROM queue_observation_receipts
    WHERE status='unavailable'`).get().count, 1);
});

test("manual full start reuses an existing queued or running full scan", async () => {
  const env = scannerEnv();
  const first = await startScan(env, { triggerType: "manual", canary: false, runId: "run_full_one" });
  const second = await startScan(env, { triggerType: "manual", canary: false, runId: "run_full_two" });
  assert.equal(first.started, true);
  assert.equal(first.reused, undefined);
  assert.equal(second.started, true);
  assert.equal(second.reused, true);
  assert.equal(second.runId, "run_full_one");
  assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_runs WHERE scope='official_site'").get().count, 1);
});

test("manual first-party archive ingest is frozen, idempotent, and creates only source-verification work", async () => {
  const env = scannerEnv();
  env.SCAN_ENABLED = "0";
  let archiveBatchStatementCount = 0;
  const originalBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    if (statements.length >= 7) archiveBatchStatementCount = statements.length;
    return originalBatch(statements);
  };
  const started = await startFirstPartyArchiveIngest(env, {
    sourceId: "source_troy_archive", expectedMinRows: 2, runId: "run_fulfilled_archive_one",
  });
  assert.equal(started.started, true);
  const envelope = env.sent.shift();
  assert.equal(envelope.type, "archive_page");
  assert.deepEqual(envelope.payload, {
    archiveSourceId: "source_troy_archive", adapter: "wptb_fulfilled_prophecy_v1", expectedMinRows: 2,
  });
  await processEnvelope(env, envelope, { fetcher: async (url) => {
    assert.equal(url, "https://troyblackvideos.com/prophecy-archive-all/");
    return { html: fulfilledArchiveHtml };
  } });
  const db = env.DB.db;
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_leads").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_lead_revisions").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_revision_links").get().count, 4);
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_revision_links WHERE link_role='original_video'").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_revision_links WHERE link_role='claimed_follow_up'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_revision_links WHERE link_role='claimed_evidence'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM source_items WHERE platform='youtube'").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM archive_verification_work_items").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM archive_linked_video_selector WHERE status='ready'").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM claim_candidates").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM claims").get().count, 152);
  const receipt = db.prepare("SELECT response_sha256,row_count FROM first_party_archive_receipts").get();
  assert.equal(receipt.response_sha256.length, 64);
  assert.equal(receipt.row_count, 2);
  assert.equal(archiveBatchStatementCount, 7, "archive persistence must stay far below D1's 50-query invocation cap");
  const revisions = db.prepare("SELECT archive_revision_id FROM first_party_archive_lead_revisions ORDER BY archive_revision_id").all();
  const foreignLink = db.prepare("SELECT archive_link_id,archive_revision_id FROM first_party_archive_revision_links WHERE link_role='original_video' ORDER BY archive_link_id LIMIT 1").get();
  const mismatchedRevision = revisions.find((item) => item.archive_revision_id !== foreignLink.archive_revision_id);
  assert.throws(() => db.prepare(`INSERT INTO archive_verification_work_items
    (archive_work_item_id,archive_revision_id,archive_video_link_id,status,created_at)
    VALUES ('mismatched_work',?,?,'ready','2026-07-20')`).run(
      mismatchedRevision.archive_revision_id, foreignLink.archive_link_id), /FOREIGN KEY constraint/);

  await processEnvelope(env, envelope, { fetcher: async () => { throw new Error("must not refetch completed job"); } });
  const reconcile = env.sent.find((item) => item.runId === "run_fulfilled_archive_one" && item.type === "run_reconcile");
  await processEnvelope(env, reconcile);
  await startFirstPartyArchiveIngest(env, {
    sourceId: "source_troy_archive", runId: "run_fulfilled_archive_two",
  });
  const repeated = env.sent.find((item) => item.runId === "run_fulfilled_archive_two");
  await processEnvelope(env, repeated, { fetcher: async () => ({ html: fulfilledArchiveHtml }) });
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_lead_revisions").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_revision_observations").get().count, 4);
  assert.equal(db.prepare("SELECT count(*) count FROM archive_verification_work_items").get().count, 2);
  assert.equal(db.prepare("SELECT count(*) count FROM first_party_archive_receipts").get().count, 2);
});

test("archive persistence refuses an oversized aggregate JSON payload before issuing D1 batch statements", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_archive_oversized", personId: "person_troy_black",
    triggerType: "manual", scope: "first_party_archive:source_troy_archive" });
  let batchCalled = false;
  const originalBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => { batchCalled = true; return originalBatch(statements); };
  const rows = Array.from({ length: 250 }, (_, index) => ({
    publisherElementId: `wptb-element-text-oversized-${index}`,
    sourceLocatorYIndex: index + 1,
    description: `Description ${index} ${"x".repeat(8_000)}`,
    dateShared: "2026", prophecy: `Prediction ${index}`,
    claimedResult: null, claimedEvidence: null, videoLinks: [], evidenceLinks: [],
  }));
  await assert.rejects(() => persistFirstPartyArchive(env.DB, {
    runId: "run_archive_oversized", sourceId: "source_troy_archive",
    personId: "person_troy_black", sourceUrl: "https://troyblackvideos.com/prophecy-archive-all/",
    adapter: "wptb_fulfilled_prophecy_v1", parserVersion: "test-v1",
    responseSha256: "a".repeat(64), rows,
  }), /first_party_archive_payload_too_large/);
  assert.equal(batchCalled, false);
});

test("first-party archive expected row floor is bound into the Queue job and fails before persistence", async () => {
  const env = scannerEnv();
  const started = await startFirstPartyArchiveIngest(env, {
    sourceId: "source_troy_archive", expectedMinRows: 3, runId: "run_archive_floor",
  });
  assert.equal(started.started, true);
  const envelope = env.sent.shift();
  assert.equal(envelope.payload.expectedMinRows, 3);
  await assert.rejects(() => processEnvelope(env, envelope, {
    fetcher: async () => ({ html: fulfilledArchiveHtml }),
  }), /first_party_archive_below_expected_min_rows/);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM first_party_archive_receipts").get().count, 0);
  const invalid = await startFirstPartyArchiveIngest(env, {
    sourceId: "source_troy_archive", expectedMinRows: 501, runId: "run_archive_bad_floor",
  });
  assert.deepEqual(invalid, { started: false, reason: "invalid_expected_min_rows" });
});

test("authenticated archive route stays manual while both automation flags are disabled", async () => {
  const env = scannerEnv();
  env.SCAN_ENABLED = "0"; env.TRANSCRIPT_BATCH_ENABLED = "0"; env.SCANNER_ADMIN_TOKEN = "admin-secret";
  const response = await fetchHandler(new Request("https://scanner.example/admin/archive-ingest", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "source_troy_archive", expectedMinRows: 100 }),
  }), env);
  assert.equal(response.status, 202);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.expectedMinRows, 100);
  const denied = await fetchHandler(new Request("https://scanner.example/admin/archive-ingest", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "source_troy_archive" }),
  }), env);
  assert.equal(denied.status, 401);
});

test("untrusted video intake fails closed without attributing an arbitrary source to Troy", async () => {
  const env = scannerEnv();
  const youtubeId = "ZidiIdg3U4M";
  await createRun(env.DB, { runId: "run_video_intake", personId: "person_troy_black", triggerType: "intake", scope: "video" });
  const first = await makeEnvelope({
    runId: "run_video_intake", type: "video_metadata", stableKey: `youtube:${youtubeId}`,
    payload: { youtubeId },
  });
  assert.throws(() => validateEnvelope(first), /trusted_source_item_required/);
  await assert.rejects(() => processEnvelope(env, first), /trusted_source_item_required/);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_items WHERE platform='youtube'").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_attempts").get().count, 0);
});

test("trusted discovered video exposes truthful phase status and remains exactly idempotent", async () => {
  const env = scannerEnv();
  const youtubeId = "ZidiIdg3U4M";
  await createRun(env.DB, { runId: "run_video_trusted", personId: "person_troy_black", triggerType: "manual", scope: "video" });
  const source = await upsertSourceItem(env.DB, {
    personId: "person_troy_black", platform: "youtube", platformItemId: youtubeId,
    canonicalUrl: `https://www.youtube.com/watch?v=${youtubeId}`, availability: "unknown",
  });
  const first = await makeEnvelope({
    runId: "run_video_trusted", type: "video_metadata", stableKey: `youtube:${youtubeId}`,
    payload: { youtubeId, sourceItemId: source.source_item_id },
  });
  await processEnvelope(env, first);
  assert.equal(source.availability, "unknown");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_attempts WHERE source_item_id=?").get(source.source_item_id).count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_artifacts WHERE source_item_id=?").get(source.source_item_id).count, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claim_candidates WHERE source_item_id=?").get(source.source_item_id).count, 0);
  const catalogue = await getSourceCatalogue(env.DB, "troy-black", { platform: "youtube" });
  assert.deepEqual({ status: catalogue.sources[0].status,
    acquisitionStatus: catalogue.sources[0].acquisitionStatus,
    analysisStatus: catalogue.sources[0].analysisStatus,
    humanReviewStatus: catalogue.sources[0].humanReviewStatus,
    publicStatus: catalogue.sources[0].publicStatus }, {
    status: "ready_for_human_check",
    acquisitionStatus: "not_started",
    analysisStatus: "not_started",
    humanReviewStatus: "ready",
    publicStatus: "not_published",
  });

  await createRun(env.DB, { runId: "run_video_repeat", personId: "person_troy_black", triggerType: "manual", scope: "video" });
  const repeated = await makeEnvelope({
    runId: "run_video_repeat", type: "video_metadata", stableKey: `youtube:${youtubeId}`,
    payload: { youtubeId, sourceItemId: source.source_item_id },
  });
  await processEnvelope(env, repeated);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_items WHERE platform='youtube' AND platform_item_id=?").get(youtubeId).count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_attempts WHERE source_item_id=?").get(source.source_item_id).count, 1);
});

test("page-one canary inventories unique posts, stores immutable revisions, and dispatches bounded detail work", async () => {
  const env = scannerEnv();
  await upsertSourceItem(env.DB, {
    personId: "person_troy_black", sourceId: "source_troy_site", platform: "official_site",
    platformItemId: "older", canonicalUrl: "https://troyblackvideos.com/older-post/",
  });
  const start = await startScan(env, { canary: true, runId: "run_canary" });
  assert.equal(start.started, true);
  const first = env.sent.shift();
  const result = await processEnvelope(env, first, { fetcher: async () => ({ html: archiveHtml }) });
  assert.equal(result.status, "completed");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_items WHERE platform='official_site'").get().count, 3);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_item_revisions").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT item_count FROM source_scan_receipts WHERE run_id='run_canary'").get().item_count, 2);
  assert.equal(env.sent.filter((job) => job.type === "post_detail").length, 2);
  assert.equal(env.sent.filter((job) => job.type === "archive_page").length, 0);
  const replay = await processEnvelope(env, first, { fetcher: async () => { throw new Error("must not refetch"); } });
  assert.equal(replay.status, "duplicate_completed");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_item_revisions").get().count, 2);

  await startScan(env, { canary: true, runId: "run_canary_repeat" });
  const repeatFirst = env.sent.find((job) => job.runId === "run_canary_repeat" && job.type === "archive_page");
  await processEnvelope(env, repeatFirst, { fetcher: async () => ({ html: archiveHtml }) });
  assert.equal(env.DB.db.prepare("SELECT item_count FROM source_scan_receipts WHERE run_id='run_canary_repeat'").get().item_count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_item_revisions").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM source_availability_events WHERE result_code='archive_seen'").get().count, 4);
});

test("full discovery advances page by page and records the last non-empty page", async () => {
  const env = scannerEnv();
  await startScan(env, { canary: false, runId: "run_full_small" });
  await processEnvelope(env, env.sent.shift(), { fetcher: async () => ({ html: archiveHtml }) });
  const nextPage = env.sent.find((job) => job.type === "archive_page" && job.payload.page === 2);
  assert.ok(nextPage);
  assert.equal(env.sent[0].type, "archive_page");
  assert.equal(env.sent[0].payload.page, 2);
  assert.ok(env.sent.slice(1).some((job) => job.type === "post_detail"));
  await processEnvelope(env, nextPage, { fetcher: async () => ({ html: "<html><body>No matching cards</body></html>" }) });
  const run = env.DB.db.prepare("SELECT archive_last_page,discovery_finished_at FROM ingestion_runs WHERE run_id='run_full_small'").get();
  assert.equal(run.archive_last_page, 1);
  assert.ok(run.discovery_finished_at);
  const receipt = env.DB.db.prepare("SELECT item_count,last_page_or_cursor,status FROM source_scan_receipts WHERE run_id='run_full_small'").get();
  assert.equal(receipt.item_count, 2);
  assert.equal(receipt.last_page_or_cursor, "1");
  assert.equal(receipt.status, "complete");
});

test("live-shaped terminal pagination finishes on page 124 without requesting the HTTP downgrade on page 125", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_terminal", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const page124 = await makeEnvelope({ runId: "run_terminal", type: "archive_page", stableKey: "page:124", payload: { page: 124 } });
  await processEnvelope(env, page124, { fetcher: async (url) => {
    assert.match(url, /page\/124\/$/);
    return { html: terminalHtml };
  } });
  assert.equal(env.sent.some((job) => job.type === "archive_page" && job.payload.page === 125), false);
  const receipt = env.DB.db.prepare("SELECT last_page_or_cursor,status FROM source_scan_receipts WHERE run_id='run_terminal'").get();
  assert.equal(receipt.last_page_or_cursor, "124");
  assert.equal(receipt.status, "complete");
});

test("post detail links an exact embedded YouTube ID and records transcript unavailable without scraping captions", async () => {
  const env = scannerEnv();
  await startScan(env, { canary: true, runId: "run_detail" });
  await processEnvelope(env, env.sent.shift(), { fetcher: async () => ({ html: archiveHtml }) });
  const detail = env.sent.find((job) => job.type === "post_detail" && job.payload.platformItemId === "101");
  await processEnvelope(env, detail, { fetcher: async () => ({ html: detailHtml }) });
  const video = env.DB.db.prepare("SELECT * FROM source_items WHERE platform='youtube'").get();
  assert.equal(video.platform_item_id, "ZidiIdg3U4M");
  assert.equal(env.DB.db.prepare("SELECT method FROM source_item_links").get().method, "exact_platform_id");
  const attempt = env.DB.db.prepare("SELECT status,public_error_code FROM transcript_attempts").get();
  assert.equal(attempt.status, "authorization_required");
  assert.equal(attempt.public_error_code, "transcript_not_supplied");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_artifacts").get().count, 0);
});

test("detail enrichment preserves the archive publication date when detail metadata omits it", async () => {
  const env = scannerEnv();
  await startScan(env, { canary: true, runId: "run_date" });
  await processEnvelope(env, env.sent.shift(), { fetcher: async () => ({ html: archiveHtml }) });
  const detail = env.sent.find((job) => job.type === "post_detail" && job.payload.platformItemId === "102");
  await processEnvelope(env, detail, { fetcher: async () => ({ html: detailNoDateHtml }) });
  const latest = env.DB.db.prepare(`SELECT r.publication_date FROM source_item_revisions r
    JOIN source_items s ON s.source_item_id=r.source_item_id
    WHERE s.platform_item_id='102' ORDER BY r.fetched_at DESC,r.revision_id DESC LIMIT 1`).get();
  assert.equal(latest.publication_date, "2024-01-03");
});

test("description triage stores a paraphrased lead with no quotation or verdict", async () => {
  const env = scannerEnv();
  env.AI.run = async () => {
    env.aiCalls += 1;
    const inFlight = env.DB.db.prepare(`SELECT work_kind,status,analysis_run_id,analysis_section_id
      FROM text_ai_attempt_receipt_history ORDER BY receipt_id`).all().map((row) => ({ ...row }));
    assert.deepEqual(inFlight, [{ work_kind: "description_triage", status: "started",
      analysis_run_id: null, analysis_section_id: null }]);
    return { response: JSON.stringify({ category: "testable_prediction",
      neutralParaphrase: "The description may contain a prediction." }) };
  };
  await startScan(env, { canary: true, runId: "run_triage" });
  await processEnvelope(env, env.sent.shift(), { fetcher: async () => ({ html: archiveHtml }) });
  const detail = env.sent.find((job) => job.type === "post_detail" && job.payload.platformItemId === "101");
  await processEnvelope(env, detail, { fetcher: async () => ({ html: detailHtml }) });
  const triage = env.sent.find((job) => job.type === "description_triage" && job.payload.sourceItemId);
  await processEnvelope(env, triage);
  const lead = env.DB.db.prepare("SELECT * FROM claim_candidates").get();
  assert.equal(lead.candidate_kind, "description_lead");
  assert.equal(lead.exact_quote, null);
  assert.equal(lead.requires_transcript, 1);
  assert.equal(lead.requires_human_review, 1);
  assert.equal(env.aiCalls, 1);
  assert.deepEqual(env.DB.db.prepare(`SELECT status FROM text_ai_attempt_receipt_history
    ORDER BY status`).all().map((row) => row.status), ["completed", "started"]);

  // A new ingestion run reaches the same immutable revision. This bypasses
  // Queue job deduplication and proves the extraction itself avoids AI cost.
  await createRun(env.DB, { runId: "run_triage_repeat", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const repeated = await makeEnvelope({
    runId: "run_triage_repeat", type: "description_triage", stableKey: `revision:${triage.payload.revisionId}`,
    payload: { ...triage.payload },
  });
  await processEnvelope(env, repeated);
  assert.equal(env.aiCalls, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM text_ai_attempt_receipt_history").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM extraction_runs").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claim_candidates").get().count, 1);
});

test("identical descriptions on different posts create distinct source-scoped candidates", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_candidate_scope", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const sourceIds = [`src_${"b".repeat(32)}`, `src_${"c".repeat(32)}`];
  for (let index = 0; index < sourceIds.length; index += 1) {
    env.DB.db.prepare(`INSERT INTO source_items VALUES
      (?, 'person_troy_black', 'source_troy_site', 'official_site', ?, ?,
       '2026-07-19', '2026-07-19', 'available')`)
      .run(sourceIds[index], `same-${index}`, `https://troyblackvideos.com/same-${index}/`);
    env.DB.db.prepare(`INSERT INTO source_item_revisions VALUES
      (?, ?, 'same-content-hash', ?, 'Same title', 'The same possible prediction.',
       '2026-07-19', NULL, NULL, NULL, '2026-07-19', 'test-v1', 'run_candidate_scope')`)
      .run(`rev_same_${index}`, sourceIds[index], `https://troyblackvideos.com/same-${index}/`);
  }
  const jobs = await Promise.all(sourceIds.map((sourceItemId, index) => makeEnvelope({
    runId: "run_candidate_scope", type: "description_triage", stableKey: `revision:rev_same_${index}`,
    payload: { sourceItemId, revisionId: `rev_same_${index}` },
  })));
  await registerJob(env.DB, jobs[1]);
  await processEnvelope(env, jobs[0]);
  await processEnvelope(env, jobs[1]);
  const candidates = env.DB.db.prepare("SELECT candidate_id,source_item_id FROM claim_candidates ORDER BY source_item_id").all();
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].candidate_id, candidates[1].candidate_id);
  assert.deepEqual(candidates.map((row) => row.source_item_id), sourceIds);
});

test("leases reject duplicate workers, permit an expired lease, and protect completion ownership", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_lease", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const envelope = await makeEnvelope({ runId: "run_lease", type: "archive_page", stableKey: "page:1", payload: { page: 1 } });
  await registerJob(env.DB, envelope);
  assert.ok(await claimJob(env.DB, envelope.jobId, "lease-a", { now: "2026-07-19T00:00:00.000Z", leaseMs: 1000 }));
  assert.equal(await claimJob(env.DB, envelope.jobId, "lease-b", { now: "2026-07-19T00:00:00.500Z", leaseMs: 1000 }), null);
  assert.ok(await claimJob(env.DB, envelope.jobId, "lease-c", { now: "2026-07-19T00:00:02.000Z", leaseMs: 1000 }));
});

test("dispatch failure leaves a completed job replayable and deterministic failures stop retrying", async () => {
  const env = scannerEnv();
  await startScan(env, { canary: true, runId: "run_dispatch" });
  const first = env.sent.shift();
  env.INGESTION_QUEUE.send = async () => { throw new Error("queue unavailable"); };
  await assert.rejects(() => processEnvelope(env, first, { fetcher: async () => ({ html: archiveHtml }) }), /queue unavailable/);
  let row = env.DB.db.prepare("SELECT status,successor_enqueued FROM ingestion_jobs WHERE job_id=?").get(first.jobId);
  assert.equal(row.status, "completed");
  assert.equal(row.successor_enqueued, 0);
  env.INGESTION_QUEUE.send = async (body) => env.sent.push(body);
  const replay = await processEnvelope(env, first, { fetcher: async () => ({ html: archiveHtml }) });
  assert.equal(replay.status, "duplicate_completed");
  row = env.DB.db.prepare("SELECT successor_enqueued FROM ingestion_jobs WHERE job_id=?").get(first.jobId);
  assert.equal(row.successor_enqueued, 1);

  await createRun(env.DB, { runId: "run_fail", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const missing = await makeEnvelope({ runId: "run_fail", type: "post_detail", stableKey: "post:999", payload: { platformItemId: "999" } });
  await assert.rejects(() => processEnvelope(env, missing), (error) => error.final === true);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_jobs WHERE job_id=?").get(missing.jobId).status, "failed");
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_fail'").get().status, "complete_with_errors");
});

test("successor registration crash leaves parent replayable and fills the missing tail", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_register_crash", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const parent = await makeEnvelope({ runId: "run_register_crash", type: "run_reconcile", stableKey: "parent", payload: {} });
  await registerJob(env.DB, parent);
  env.DB.db.prepare("UPDATE ingestion_jobs SET status='completed',completed_at='2026-07-19' WHERE job_id=?").run(parent.jobId);
  const children = await Promise.all([1, 2, 3].map((number) => makeEnvelope({
    runId: "run_register_crash", type: "run_reconcile", stableKey: `child:${number}`, payload: {},
  })));
  let registrations = 0;
  await assert.rejects(() => dispatchSuccessors(env, parent.jobId, children, {
    register: async (db, child) => {
      registrations += 1;
      if (registrations === 2) throw new Error("registration crash");
      return registerJob(db, child);
    },
  }), (error) => error.retryable === true);
  assert.equal(env.DB.db.prepare("SELECT successor_enqueued FROM ingestion_jobs WHERE job_id=?").get(parent.jobId).successor_enqueued, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs WHERE run_id='run_register_crash'").get().count, 2);
  await dispatchSuccessors(env, parent.jobId, children);
  assert.equal(env.DB.db.prepare("SELECT successor_enqueued FROM ingestion_jobs WHERE job_id=?").get(parent.jobId).successor_enqueued, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs WHERE run_id='run_register_crash'").get().count, 4);
  assert.equal(env.sent.length, 3);
});

test("mid-send crash leaves every child recoverable and duplicate delivery has no duplicate effects", async () => {
  const env = scannerEnv();
  await createRun(env.DB, {
    runId: "run_send_crash", personId: "person_troy_black", triggerType: "manual",
    scope: "official_site", createdAt: "2026-07-19T00:00:00.000Z",
  });
  const parent = await makeEnvelope({ runId: "run_send_crash", type: "run_reconcile", stableKey: "parent", payload: {} });
  await registerJob(env.DB, parent);
  env.DB.db.prepare("UPDATE ingestion_jobs SET status='completed',completed_at='2026-07-19' WHERE job_id=?").run(parent.jobId);
  const children = await Promise.all([1, 2, 3].map((number) => makeEnvelope({
    runId: "run_send_crash", type: "run_reconcile", stableKey: `child:${number}`, payload: {},
  })));
  let sends = 0;
  env.INGESTION_QUEUE.send = async (message) => {
    sends += 1;
    if (sends === 2) throw new Error("mid-send crash");
    env.sent.push(message);
  };
  await assert.rejects(() => dispatchSuccessors(env, parent.jobId, children), (error) => error.retryable === true);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs WHERE run_id='run_send_crash'").get().count, 4);
  assert.equal(env.DB.db.prepare("SELECT successor_enqueued FROM ingestion_jobs WHERE job_id=?").get(parent.jobId).successor_enqueued, 0);
  env.INGESTION_QUEUE.send = async (message) => env.sent.push(message);
  const recovered = await scannerStatus(env, "run_send_crash", {
    now: "2026-07-19T00:07:00.000Z", queuedMs: 300_000,
  });
  assert.equal(recovered.recovery.recovered, 3);
  while (env.sent.length) await processEnvelope(env, env.sent.shift());
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs WHERE run_id='run_send_crash'").get().count, 4);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs WHERE run_id='run_send_crash' AND status='completed'").get().count, 4);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_send_crash'").get().status, "complete");
});

test("an early reconcile cannot strand a run after the later terminal job drains", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_early_reconcile", personId: "person_troy_black", triggerType: "canary", scope: "official_site" });
  const early = await makeEnvelope({ runId: "run_early_reconcile", type: "run_reconcile", stableKey: "early", payload: {} });
  const laterOne = await makeEnvelope({ runId: "run_early_reconcile", type: "run_reconcile", stableKey: "later:one", payload: {} });
  const terminal = await makeEnvelope({ runId: "run_early_reconcile", type: "run_reconcile", stableKey: "later:two", payload: {} });
  await registerJob(env.DB, laterOne);
  await registerJob(env.DB, terminal);
  await processEnvelope(env, early);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_early_reconcile'").get().status, "running");
  await processEnvelope(env, laterOne);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_early_reconcile'").get().status, "running");
  await processEnvelope(env, terminal);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_early_reconcile'").get().status, "complete");

  // Completed-message replay repairs status written by an older Worker.
  env.DB.db.exec("UPDATE ingestion_runs SET status='running',completed_at=NULL WHERE run_id='run_early_reconcile'");
  await processEnvelope(env, terminal);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_early_reconcile'").get().status, "complete");
});

test("a timed-out primary AI call stays retryable and never overlaps a fallback", async () => {
  const env = scannerEnv();
  env.AI_TIMEOUT_MS = "5";
  env.AI.run = (model) => {
    env.aiCalls += 1;
    if (model === "primary") return new Promise(() => {});
    return Promise.resolve({ response: JSON.stringify({ category: "testable_prediction", neutralParaphrase: "A possible prediction." }) });
  };
  await createRun(env.DB, { runId: "run_ai_timeout", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const sourceId = `src_${"a".repeat(32)}`;
  env.DB.db.prepare(`INSERT INTO source_items VALUES
    (?, 'person_troy_black', 'source_troy_site', 'official_site', 'timeout-post',
     'https://troyblackvideos.com/timeout-post/', '2026-07-19', '2026-07-19', 'available')`).run(sourceId);
  env.DB.db.prepare(`INSERT INTO source_item_revisions VALUES
    ('rev_timeout', ?, 'timeout-hash', 'https://troyblackvideos.com/timeout-post/',
     'Timeout post', 'This description may contain a prediction.', '2026-07-19',
     NULL, NULL, NULL, '2026-07-19', 'test-v1', 'run_ai_timeout')`).run(sourceId);
  const triage = await makeEnvelope({
    runId: "run_ai_timeout", type: "description_triage", stableKey: "revision:rev_timeout",
    payload: { sourceItemId: sourceId, revisionId: "rev_timeout" },
  });
  await assert.rejects(() => processEnvelope(env, triage),
    (error) => error.code === "ai_timeout_unconfirmed" && error.final === false);
  assert.equal(env.aiCalls, 1);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_jobs WHERE job_id=?").get(triage.jobId).status, "queued");
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_ai_timeout'").get().status, "running");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claim_candidates WHERE source_item_id=?").get(sourceId).count, 0);
  assert.deepEqual(env.DB.db.prepare(`SELECT status,safe_cause_code FROM text_ai_attempt_receipt_history
    ORDER BY status`).all().map((row) => ({ ...row })), [
    { status: "failed", safe_cause_code: "ai_timeout_unconfirmed" },
    { status: "started", safe_cause_code: null },
  ]);
});

test("authenticated status recovery requeues an expired lease exactly once and completes without duplicate successors", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_recover", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const stale = await makeEnvelope({
    runId: "run_recover", type: "run_reconcile", stableKey: "stale",
    payload: {},
  });
  await registerJob(env.DB, stale);
  await claimJob(env.DB, stale.jobId, "old-lease", { now: "2026-07-19T00:00:00.000Z", leaseMs: 120_000 });
  const first = await scannerStatus(env, "run_recover", { now: "2026-07-19T00:03:00.000Z", leaseMs: 120_000 });
  assert.deepEqual(first.recovery, { recovered: 1, dispatchFailed: 0 });
  assert.equal(env.sent.length, 1);
  const second = await scannerStatus(env, "run_recover", { now: "2026-07-19T00:03:01.000Z", leaseMs: 120_000 });
  assert.deepEqual(second.recovery, { recovered: 0, dispatchFailed: 0 });
  assert.equal(env.sent.length, 1);
  await processEnvelope(env, env.sent.shift());
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_recover'").get().status, "complete");
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_jobs WHERE run_id='run_recover'").get().count, 1);
});

test("failed stale-lease redispatch remains reserved for the next authenticated status attempt", async () => {
  const env = scannerEnv();
  await createRun(env.DB, { runId: "run_recover_retry", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const stale = await makeEnvelope({
    runId: "run_recover_retry", type: "run_reconcile", stableKey: "retry",
    payload: {},
  });
  await registerJob(env.DB, stale);
  await claimJob(env.DB, stale.jobId, "old-lease", { now: "2026-07-19T00:00:00.000Z", leaseMs: 120_000 });
  let attempts = 0;
  env.INGESTION_QUEUE.send = async (body) => {
    attempts += 1;
    if (attempts === 1) throw new Error("queue unavailable");
    env.sent.push(body);
  };
  const failed = await scannerStatus(env, "run_recover_retry", { now: "2026-07-19T00:03:00.000Z", leaseMs: 120_000 });
  assert.deepEqual(failed.recovery, { recovered: 0, dispatchFailed: 1 });
  assert.equal(env.DB.db.prepare("SELECT error_code FROM ingestion_jobs WHERE job_id=?").get(stale.jobId).error_code, "stale_lease_recovery_pending");
  const retried = await scannerStatus(env, "run_recover_retry", { now: "2026-07-19T00:03:01.000Z", leaseMs: 120_000 });
  assert.deepEqual(retried.recovery, { recovered: 1, dispatchFailed: 0 });
  assert.equal(attempts, 2);
  assert.equal(env.sent.length, 1);
});

test("unauthenticated status requests cannot trigger stale-lease recovery", async () => {
  const env = scannerEnv();
  env.SCANNER_ADMIN_TOKEN = "admin-secret";
  await createRun(env.DB, { runId: "run_private_recovery", personId: "person_troy_black", triggerType: "manual", scope: "official_site" });
  const stale = await makeEnvelope({
    runId: "run_private_recovery", type: "run_reconcile", stableKey: "private",
    payload: {},
  });
  await registerJob(env.DB, stale);
  await claimJob(env.DB, stale.jobId, "old-lease", { now: "2026-07-19T00:00:00.000Z", leaseMs: 120_000 });
  const response = await fetchHandler(new Request("https://scanner.example/admin/status?runId=run_private_recovery"), env);
  assert.equal(response.status, 401);
  assert.equal(env.sent.length, 0);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_jobs WHERE job_id=?").get(stale.jobId).status, "processing");
});

test("authenticated status sends an old never-attempted queued job once until normal claim completes it", async () => {
  const env = scannerEnv();
  await createRun(env.DB, {
    runId: "run_orphan_queued", personId: "person_troy_black", triggerType: "manual",
    scope: "official_site", createdAt: "2026-07-19T00:00:00.000Z",
  });
  const orphan = await makeEnvelope({
    runId: "run_orphan_queued", type: "run_reconcile", stableKey: "orphan",
    payload: {},
  });
  await registerJob(env.DB, orphan, "2026-07-19T00:00:00.000Z");
  const first = await scannerStatus(env, "run_orphan_queued", {
    now: "2026-07-19T00:07:00.000Z", queuedMs: 300_000,
  });
  assert.deepEqual(first.recovery, { recovered: 1, dispatchFailed: 0 });
  assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT error_code FROM ingestion_jobs WHERE job_id=?").get(orphan.jobId).error_code, "stale_lease_recovered");
  const repeated = await scannerStatus(env, "run_orphan_queued", {
    now: "2026-07-19T00:08:00.000Z", queuedMs: 300_000,
  });
  assert.deepEqual(repeated.recovery, { recovered: 0, dispatchFailed: 0 });
  assert.equal(env.sent.length, 1);
  await processEnvelope(env, env.sent.shift());
  const row = env.DB.db.prepare("SELECT status,attempt_count,error_code FROM ingestion_jobs WHERE job_id=?").get(orphan.jobId);
  assert.equal(row.status, "completed");
  assert.equal(row.attempt_count, 1);
  assert.equal(row.error_code, null);
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_runs WHERE run_id='run_orphan_queued'").get().status, "complete");
});
