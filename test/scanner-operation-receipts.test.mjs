import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchHandler } from "../scanner/src/index.js";
import { analysisFailureCanRetry } from "../scanner/src/analysis-operations.js";
import { makeEnv, ROOT } from "./helpers/d1.mjs";

const AT = "2026-08-03T20:30:00.000Z";
const SECTION_ID = `txas_${"1".repeat(32)}`;
const JOB_ID = `job_${"2".repeat(32)}`;
const ANALYSIS_SHA = "a".repeat(64);
const SUCCESSOR_RUN_ID = `txan_${"5".repeat(32)}`;
const SUCCESSOR_SECTION_ID = `txas_${"6".repeat(32)}`;
const SUCCESSOR_JOB_ID = `job_${"7".repeat(32)}`;
const DISPOSITION_ID = `asdp_${"8".repeat(32)}`;
const SOURCE_PROMPT = "transcript-claims-v5-grounded-5w1h-offset-repair";
const TARGET_PROMPT = "transcript-claims-v13-gemini-schema-http400-fallback";

function operationEnv() {
  const env = makeEnv();
  env.SCANNER_ADMIN_TOKEN = "admin-secret";
  return env;
}

function seedFailedAnalysis(env) {
  const db = env.DB.db;
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,
     first_discovered_at,last_seen_at,availability)
    VALUES ('source_operation_receipt','person_troy_black','youtube','OperationReceipt1',
      'https://example.test/operation-receipt',?,?, 'available')`).run(AT, AT);
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES ('run_operation_receipt','person_troy_black','manual','operation-receipt-test',
      'complete_with_errors',?,?,1,?)`).run(AT, AT, AT);
  db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,created_at)
    VALUES ('transcript_operation_receipt','source_operation_receipt',
      'test/operation-receipt.txt',?,10,'en',0,'test_verified_transcript',?)`)
    .run("3".repeat(64), AT);
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,completed_section_count,failed_section_count,status,
     created_at,completed_at)
    VALUES ('analysis_operation_receipt','run_operation_receipt',
      'transcript_operation_receipt','source_operation_receipt',?,
      ?,1,0,1,'failed',?,?)`).run("3".repeat(64), SOURCE_PROMPT, AT, AT);
  db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,completed_at,error_code)
    VALUES (?,'run_operation_receipt','transcript_extract','operation-receipt-section',?,
      'failed',2,?,'invalid_json')`).run(JOB_ID, JSON.stringify({
    phase: "analyze", analysisRunId: "analysis_operation_receipt",
    analysisSectionId: SECTION_ID,
  }), AT);
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,status,attempt_count,error_code,completed_at,created_at)
    VALUES (?,'analysis_operation_receipt',0,?,0,0,'failed',2,'invalid_json',?,?)`)
    .run(SECTION_ID, "4".repeat(64), AT, AT);
}

function seedCompletedSuccessorDisposition(env) {
  const db = env.DB.db;
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,started_at,completed_at,error_count,created_at)
    VALUES ('run_operation_successor','person_troy_black','manual','operation-successor-test',
      'complete',?,?,0,?)`).run(AT, AT, AT);
  db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,transcript_id,input_kind,input_sha256,prompt_version,
     model_family,status,started_at,completed_at,transcript_quality)
    VALUES ('extract_operation_successor','source_operation_receipt','transcript_operation_receipt',
      'verified_transcript',?,?, 'workers_ai','completed',?,?,'human_verified')`)
    .run("4".repeat(64), TARGET_PROMPT, AT, AT);
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,completed_section_count,failed_section_count,status,
     created_at,completed_at)
    VALUES (?,'run_operation_successor','transcript_operation_receipt','source_operation_receipt',
      ?,?,1,1,0,'completed',?,?)`).run(SUCCESSOR_RUN_ID, "3".repeat(64),
    TARGET_PROMPT, AT, AT);
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,extraction_run_id,status,attempt_count,error_code,
     completed_at,created_at)
    VALUES (?,?,0,?,0,0,'extract_operation_successor','completed',1,NULL,?,?)`)
    .run(SUCCESSOR_SECTION_ID, SUCCESSOR_RUN_ID, "4".repeat(64), AT, AT);
  db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,completed_at,error_code)
    VALUES (?,'run_operation_successor','transcript_extract','operation-successor-section',?,
      'completed',1,?,NULL)`).run(SUCCESSOR_JOB_ID, JSON.stringify({
    phase: "analyze", analysisRunId: SUCCESSOR_RUN_ID,
    analysisSectionId: SUCCESSOR_SECTION_ID,
  }), AT);
  db.prepare(`INSERT INTO analysis_section_successor_links
    (link_id,predecessor_section_id,successor_section_id,predecessor_prompt_version,
     successor_prompt_version,action_id,created_at)
    VALUES ('asln_operation_receipt',?,?,?,?, 'asx_operation_receipt',?)`)
    .run(SECTION_ID, SUCCESSOR_SECTION_ID, SOURCE_PROMPT, TARGET_PROMPT, AT);
  db.prepare(`INSERT INTO analysis_section_dispositions
    (disposition_id,predecessor_section_id,successor_section_id,link_id,disposition,
     action_id,created_at)
    VALUES (?,?,?,'asln_operation_receipt','superseded_by_completed_successor',
      'asx_operation_receipt',?)`).run(DISPOSITION_ID, SECTION_ID, SUCCESSOR_SECTION_ID, AT);
}

function analysisTerminal(reason = "invalid_json") {
  return {
    summary: { schemaVersion: 1, contract: "analysis-reconciliation-v1",
      status: "manual_required", mode: "run", runId: `arr_${ANALYSIS_SHA.slice(0, 32)}`,
      idempotencySha256: ANALYSIS_SHA, limit: 25, discovered: 1, completed: 0,
      manualRequired: 1, failed: 0, pending: 0, fatalCode: null,
      startedAt: AT, completedAt: AT },
    itemFinals: [{ analysisSectionId: SECTION_ID, jobId: JOB_ID,
      status: "manual_required", reason, beforeStatus: "failed",
      afterStatus: "failed", readbackAt: AT }],
  };
}

function adminRequest(body, idempotencyKey = null) {
  return new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST", headers: { authorization: "Bearer admin-secret",
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify(body),
  });
}

function persistRequest(terminal = analysisTerminal()) {
  const key = `operation-receipt/analysis_reconciliation/${terminal.summary.runId}/${terminal.summary.idempotencySha256}`;
  return adminRequest({ action: "persist_operation_receipt",
    kind: "analysis_reconciliation", ...terminal }, key);
}

function successorTerminal() {
  const hash = "c".repeat(64);
  return { summary: { schemaVersion: 1, contract: "analysis-reconciliation-v1",
    status: "completed", mode: "run", runId: `arr_${hash.slice(0, 32)}`,
    idempotencySha256: hash, limit: 25, discovered: 1, completed: 1,
    manualRequired: 0, failed: 0, pending: 0, fatalCode: null,
    startedAt: AT, completedAt: AT },
  itemFinals: [{ analysisSectionId: SECTION_ID, jobId: JOB_ID, status: "completed",
    reason: "historical_section_superseded", beforeStatus: "failed",
    afterStatus: "completed", readbackAt: AT, sourcePromptVersion: SOURCE_PROMPT,
    targetPromptVersion: TARGET_PROMPT, successorAnalysisRunId: SUCCESSOR_RUN_ID,
    successorAnalysisSectionId: SUCCESSOR_SECTION_ID, successorJobId: SUCCESSOR_JOB_ID,
    dispositionId: DISPOSITION_ID }] };
}

test("operation receipt persistence is atomic, exact, and idempotent in D1Shim", async () => {
  const env = operationEnv(); seedFailedAnalysis(env);
  const unauthorized = await fetchHandler(new Request(persistRequest(), {
    headers: { "content-type": "application/json" },
  }), env);
  assert.equal(unauthorized.status, 401);

  const firstResponse = await fetchHandler(persistRequest(), env);
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.deepEqual(first, {
    schemaVersion: 1, contract: "operation-receipt-persistence-v1", terminal: true,
    persisted: true, reused: false, kind: "analysis_reconciliation",
    runId: `arr_${ANALYSIS_SHA.slice(0, 32)}`, itemCount: 1,
    readback: { idempotencySha256: ANALYSIS_SHA, limit: 25, discovered: 1,
      completed: 0, manualRequired: 1, failed: 0, status: "failed", itemCount: 1 },
  });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_reconciliation_runs").get().count, 1);
  assert.equal(env.DB.db.prepare(
    "SELECT COUNT(*) count FROM analysis_reconciliation_item_receipts").get().count, 1);

  const replayResponse = await fetchHandler(persistRequest(), env);
  assert.equal(replayResponse.status, 200);
  assert.equal((await replayResponse.json()).reused, true);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_reconciliation_runs").get().count, 1);

  const mismatch = await fetchHandler(persistRequest(analysisTerminal("invalid_payload")), env);
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error, "operation_receipt_item_readback_mismatch");
  assert.equal(env.DB.db.prepare(
    "SELECT safe_reason_code FROM analysis_reconciliation_item_receipts").get().safe_reason_code,
  "invalid_json");
});

test("historical completion persists and reads back the exact six-field successor lineage", async () => {
  const env = operationEnv(); seedFailedAnalysis(env); seedCompletedSuccessorDisposition(env);
  const terminal = successorTerminal();
  const response = await fetchHandler(persistRequest(terminal), env);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).persisted, true);
  const stored = env.DB.db.prepare(`SELECT source_prompt_version,target_prompt_version,
    successor_analysis_run_id,successor_analysis_section_id,successor_job_id,disposition_id
    FROM analysis_reconciliation_item_receipts WHERE analysis_section_id=?`).get(SECTION_ID);
  assert.deepEqual({ ...stored }, { source_prompt_version: SOURCE_PROMPT,
    target_prompt_version: TARGET_PROMPT, successor_analysis_run_id: SUCCESSOR_RUN_ID,
    successor_analysis_section_id: SUCCESSOR_SECTION_ID,
    successor_job_id: SUCCESSOR_JOB_ID, disposition_id: DISPOSITION_ID });

  const mismatch = structuredClone(terminal);
  mismatch.itemFinals[0].dispositionId = `asdp_${"9".repeat(32)}`;
  const mismatchResponse = await fetchHandler(persistRequest(mismatch), env);
  assert.equal(mismatchResponse.status, 503);
  assert.equal((await mismatchResponse.json()).error, "operation_receipt_persistence_failed");
  assert.equal(env.DB.db.prepare(`SELECT disposition_id FROM analysis_reconciliation_item_receipts
    WHERE analysis_section_id=?`).get(SECTION_ID).disposition_id, DISPOSITION_ID);
});

test("D1Shim rolls the item-first batch back when a later constraint cannot commit", async () => {
  const env = operationEnv();
  const hash = "b".repeat(64);
  const summary = { schemaVersion: 1, contract: "machine-conveyor-v1",
    status: "completed", mode: "run", runId: `mcr_${hash.slice(0, 32)}`,
    idempotencySha256: hash, limit: 25, considered: 1, verified: 0, classified: 1,
    promoted: 0, reused: 0, failed: 0, pendingPromotions: 0, fatalCode: null,
    startedAt: AT, completedAt: AT };
  const body = { action: "persist_operation_receipt", kind: "machine_conveyor", summary,
    itemFinals: [{ candidateId: `cand_${"5".repeat(32)}`, readinessId: null,
      workItemId: null, verified: false, status: "skipped", classification: "binding_changed",
      reason: "atomic_binding_changed", readbackAt: AT }] };
  const key = `operation-receipt/machine_conveyor/${summary.runId}/${hash}`;
  const response = await fetchHandler(adminRequest(body, key), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "operation_receipt_persistence_failed");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM machine_conveyor_runs").get().count, 0);
  assert.equal(env.DB.db.prepare(
    "SELECT COUNT(*) count FROM machine_conveyor_item_receipts").get().count, 0);
});

test("bulk section status requires exact unique IDs and returns exact ordered readback", async () => {
  const env = operationEnv(); seedFailedAnalysis(env);
  const response = await fetchHandler(adminRequest({
    action: "read_section_statuses", analysisSectionIds: [SECTION_ID],
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1, contract: "analysis-section-statuses-v1", terminal: true,
    sections: [{ analysisSectionId: SECTION_ID, status: "failed", errorCode: "invalid_json",
      attemptCount: 2, completedAt: AT, jobId: JOB_ID, jobStatus: "failed",
      jobAttemptCount: 2, jobErrorCode: "invalid_json" }],
  });
  const duplicate = await fetchHandler(adminRequest({
    action: "read_section_statuses", analysisSectionIds: [SECTION_ID, SECTION_ID],
  }), env);
  assert.equal(duplicate.status, 400);
  const missing = await fetchHandler(adminRequest({
    action: "read_section_statuses", analysisSectionIds: [`txas_${"9".repeat(32)}`],
  }), env);
  assert.equal(missing.status, 404);
});

test("invalid provider JSON is retryable while deterministic binding failures stay terminal", () => {
  assert.equal(analysisFailureCanRetry("invalid_json"), true);
  assert.equal(analysisFailureCanRetry("provider_invalid_json"), true);
  assert.equal(analysisFailureCanRetry("invalid_candidates"), true);
  assert.equal(analysisFailureCanRetry("ai_invalid_candidates"), true);
  assert.equal(analysisFailureCanRetry("invalid_payload"), true);
  assert.equal(analysisFailureCanRetry("provider_invalid_payload"), true);
  assert.equal(analysisFailureCanRetry("invalid_transcript_analysis_binding"), false);
});

test("Worker receipt source uses binding batch and contains no explicit transaction SQL", () => {
  const source = readFileSync(join(ROOT, "scanner", "src", "operation-receipts.js"), "utf8");
  assert.match(source, /env\.DB\.batch\(statements\)/);
  assert.ok(source.indexOf("analysis_reconciliation_item_receipts") <
    source.indexOf("analysis_reconciliation_runs"));
  assert.ok(source.indexOf("machine_conveyor_item_receipts") <
    source.indexOf("machine_conveyor_runs"));
  assert.doesNotMatch(source, /\b(?:BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i);
});
