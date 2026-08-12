import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  analysisDiscoverySql, dispatchAnalysisAction,
  parseAnalysisReconcilerArgs, runAnalysisReconciler,
} from "../scripts/analysis-reconciler.mjs";
import {
  createOperationReceiptClient, validateOperationReceipt, validateSectionLineages,
  validateStaleSectionReceipt,
} from "../scripts/operation-receipt-client.mjs";

const SEC = (digit) => `txas_${digit.repeat(32)}`;
const JOB = (digit) => `job_${digit.repeat(32)}`;
const RUN = (digit) => `txan_${digit.repeat(32)}`;
const DISP = (digit) => `asdp_${digit.repeat(32)}`;
const V9 = "transcript-claims-v9-archive-quoted-checklist";
const V11 = "transcript-claims-v11-gemini-gateway-abortable";
const V12 = "transcript-claims-v12-gemini-gateway-plain-fallback";
const V13 = "transcript-claims-v13-gemini-schema-http400-fallback";

function item(digit, overrides = {}) {
  return { analysis_section_id: SEC(digit), analysis_run_id: RUN(digit),
    attempt_count: 2, section_error_code: "ai_timeout_unconfirmed", job_id: JOB(digit),
    job_error_code: "ai_timeout_unconfirmed", job_attempt_count: 2,
    section_status: "failed", job_status: "failed", debt_state: "current_retryable",
    source_prompt_version: V13, target_prompt_version: V13, ...overrides };
}

function historical(digit, debtState = "successor_required", overrides = {}) {
  return item(digit, { debt_state: debtState, source_prompt_version: V12,
    target_prompt_version: V13, ...overrides });
}

function lineage(candidate, debtState, overrides = {}) {
  return { sourceAnalysisSectionId: candidate.analysis_section_id,
    sourceJobId: candidate.job_id, sourceAttemptCount: candidate.attempt_count,
    sourceJobAttemptCount: candidate.job_attempt_count,
    sourceErrorCode: candidate.section_error_code,
    sourceJobErrorCode: candidate.job_error_code, sourceStatus: "failed",
    sourceJobStatus: "failed", sourcePromptVersion: candidate.source_prompt_version,
    targetPromptVersion: candidate.target_prompt_version,
    successorAnalysisRunId: null, successorAnalysisSectionId: null, successorJobId: null,
    successorStatus: null, successorJobStatus: null, successorAttemptCount: 0,
    successorJobAttemptCount: 0, successorErrorCode: null, successorJobErrorCode: null,
    dispositionId: null, debtState, ...overrides };
}

function staleReceipt(candidate, overrides = {}) {
  return { schemaVersion: 1, contract: "analysis-stale-section-reconciliation-v1",
    actionId: `asx_${"a".repeat(32)}`, idempotencyKeySha256: "b".repeat(64),
    sourceAnalysisSectionId: candidate.analysis_section_id,
    expectedAttemptCount: candidate.attempt_count,
    sourcePromptVersion: candidate.source_prompt_version,
    targetPromptVersion: candidate.target_prompt_version,
    successorAnalysisRunId: RUN("c"), successorAnalysisSectionId: SEC("c"),
    successorJobId: JOB("c"), successorStatus: "queued", successorAttemptCount: 0,
    dispositionId: null, terminal: false, manualRequired: false, dispatched: true,
    reused: false, reason: "successor_pending", observedAt: NOW, ...overrides };
}

function historicalHarness(items, lineageBatches, actionReceipts) {
  const calls = { stale: [], lineage: [], status: [], persisted: [] };
  let readIndex = 0; let actionIndex = 0;
  const operationClient = {
    async reconcileStaleSection(candidate) {
      calls.stale.push(candidate.analysis_section_id);
      return actionReceipts[Math.min(actionIndex++, actionReceipts.length - 1)];
    },
    async readSectionLineages(ids) {
      calls.lineage.push(ids);
      return lineageBatches[Math.min(readIndex++, lineageBatches.length - 1)];
    },
    async readSectionStatuses(ids) { calls.status.push(ids); throw new Error("old_status_polled"); },
    async persistOperationReceipt(kind, terminal) {
      calls.persisted.push({ kind, terminal: structuredClone(terminal) });
      return { persisted: true };
    },
  };
  return { calls, d1: { read: () => items }, operationClient };
}

function status(candidate, overrides = {}) {
  return { analysisSectionId: candidate.analysis_section_id, status: "completed",
    errorCode: null, attemptCount: 3, completedAt: "2026-08-03T10:01:00Z",
    jobId: candidate.job_id, jobStatus: "completed", jobAttemptCount: 3,
    jobErrorCode: null, ...overrides };
}

function harness(items, rows = new Map()) {
  const calls = { reprocess: [], status: [], persisted: [] };
  return { calls, d1: { read: () => items }, operationClient: {
    async readSectionStatuses(ids) {
      calls.status.push(ids);
      return ids.map((id) => rows.get(id));
    },
    async persistOperationReceipt(kind, terminal) {
      calls.persisted.push({ kind, terminal: structuredClone(terminal) });
      return { persisted: true };
    },
  }, reprocess: async (candidate) => { calls.reprocess.push(candidate.analysis_section_id); } };
}

const NOW = "2026-08-03T10:00:00Z";

test("analysis reconciler enforces the bounded CLI limit", () => {
  assert.deepEqual(parseAnalysisReconcilerArgs([]),
    { limit: 5, local: false, dryRun: false });
  assert.deepEqual(parseAnalysisReconcilerArgs(["--limit", "2", "--local", "--dry-run"]),
    { limit: 2, local: true, dryRun: true });
  assert.deepEqual(parseAnalysisReconcilerArgs(["--limit", "25"]),
    { limit: 25, local: false, dryRun: false });
  assert.throws(() => parseAnalysisReconcilerArgs(["--limit", "26"]), /invalid_limit/);
  assert.throws(() => parseAnalysisReconcilerArgs(["--all"]), /unknown_argument/);
});

test("admin rejection preserves its safe reason and non-JSON failures stay typed", async () => {
  const candidate = item("a");
  const rejected = createOperationReceiptClient({ token: "test-token",
    fetcher: async () => new Response(JSON.stringify({ reason: "prompt_version_not_monotonic" }),
      { status: 409, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(() => rejected.reprocessSection(candidate, {
    idempotencyKey: "analysis-reconciler/test/rejection",
  }), (error) => error.code === "prompt_version_not_monotonic");
  const nonJson = createOperationReceiptClient({ token: "test-token",
    fetcher: async () => new Response("upstream unavailable", { status: 502 }),
  });
  await assert.rejects(() => nonJson.reprocessSection(candidate, {
    idempotencyKey: "analysis-reconciler/test/non-json",
  }), (error) => error.code === "operation_admin_http_502_non_json");
});

test("dispatch abstraction routes current and historical debt to distinct canonical actions", async () => {
  const calls = [];
  const operationClient = {
    async reprocessSection(candidate) { calls.push(["current", candidate.analysis_section_id]); return { dispatched: true }; },
    async reconcileStaleSection(candidate) { calls.push(["historical", candidate.analysis_section_id]); return { terminal: false }; },
  };
  await dispatchAnalysisAction(item("a", { debt_state: "current_retryable" }), {
    operationClient, idempotencyKey: "analysis-reconciler/current/a",
  });
  await dispatchAnalysisAction(item("b", { debt_state: "successor_required" }), {
    operationClient, idempotencyKey: "analysis-reconciler/historical/b",
  });
  assert.deepEqual(calls, [["current", SEC("a")], ["historical", SEC("b")]]);
});

test("successor action and lineage receipts enforce the exact source binding", () => {
  const candidate = historical("a");
  const completed = staleReceipt(candidate, { successorStatus: "completed",
    successorAttemptCount: 1, dispositionId: DISP("d"), terminal: true,
    dispatched: false, reused: true, reason: "historical_section_superseded" });
  assert.equal(validateStaleSectionReceipt(completed, candidate), completed);
  assert.throws(() => validateStaleSectionReceipt({ ...completed,
    expectedAttemptCount: candidate.attempt_count + 1 }, candidate), /stale_section_receipt_invalid/);
  const lineages = [{ analysisSectionId: candidate.analysis_section_id,
    debtState: "superseded" }];
  assert.equal(validateSectionLineages({ schemaVersion: 1,
    contract: "analysis-section-lineages-v1", terminal: true, lineages },
  [candidate.analysis_section_id]), lineages);
  assert.throws(() => validateSectionLineages({ schemaVersion: 1,
    contract: "analysis-section-lineages-v1", terminal: true,
    lineages: [{ ...lineages[0], analysisSectionId: SEC("b") }] },
  [candidate.analysis_section_id]), /section_lineage_receipt_invalid/);
});

test("discovery uses the canonical lineage view and ignores only same-generation final receipts", () => {
  const sql = analysisDiscoverySql(25);
  assert.match(sql, /analysis_section_lineage_v2/);
  assert.match(sql, /lineage\.debt_state IN/);
  assert.match(sql, /receipt\.target_prompt_version=lineage\.target_prompt_version/);
  assert.match(sql, /analysis_reconciliation_item_receipts/);
  assert.match(sql, /receipt\.outcome='manual_required'[\s\S]*lineage\.debt_state='manual_required'/);
  assert.match(sql, /receipt\.safe_reason_code='historical_section_superseded'/);
  assert.match(sql, /receipt\.disposition_id=lineage\.disposition_id/);
  assert.match(sql, /lineage\.analysis_section_id/);
});

test("manual history is rediscovered after prior success but true manual debt stays excluded", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE analysis_section_lineage_v2 (
      analysis_section_id TEXT, debt_state TEXT, source_prompt_version TEXT,
      target_prompt_version TEXT, successor_analysis_run_id TEXT,
      successor_analysis_section_id TEXT, successor_job_id TEXT, disposition_id TEXT);
    CREATE TABLE analysis_reconciliation_item_receipts (
      analysis_section_id TEXT, target_prompt_version TEXT, outcome TEXT,
      safe_reason_code TEXT, source_prompt_version TEXT, successor_analysis_run_id TEXT,
      successor_analysis_section_id TEXT, successor_job_id TEXT, disposition_id TEXT);`);
  const insertLineage = db.prepare(`INSERT INTO analysis_section_lineage_v2 VALUES
    (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertReceipt = db.prepare(`INSERT INTO analysis_reconciliation_item_receipts VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const seed = (digit, debtState, outcome = "manual_required") => {
    const sectionId = SEC(digit); const successorSectionId = SEC("c");
    const successorRunId = RUN("c"); const successorJobId = JOB("c");
    const dispositionId = DISP("d");
    insertLineage.run(sectionId, debtState, V9, V12, successorRunId,
      successorSectionId, successorJobId, dispositionId);
    insertReceipt.run(sectionId, V12, outcome,
      outcome === "completed" ? "historical_section_superseded" : "successor_manual_required",
      V9, successorRunId, successorSectionId, successorJobId, dispositionId);
    return sectionId;
  };
  const recoveredId = seed("1", "finalization_pending");
  seed("2", "manual_required");
  seed("3", "finalization_pending", "completed");
  const rows = db.prepare(analysisDiscoverySql(25)).all();
  assert.deepEqual(rows.map((row) => row.analysis_section_id), [recoveredId]);
});

test("discovery drains terminal and existing v13 work before creating successors", () => {
  const sql = analysisDiscoverySql(25);
  const priorities = ["superseded", "finalization_pending", "current_retryable",
    "successor_retryable", "successor_pending", "successor_required"]
    .map((state) => sql.indexOf(`WHEN '${state}'`));
  assert.ok(priorities.every((offset) => offset >= 0));
  assert.deepEqual([...priorities].sort((left, right) => left - right), priorities);
  assert.match(sql, /ELSE 6 END/);
});

test("reconciler dispatches at most two and bulk-polls one final per item", async () => {
  const items = [item("a"), item("b"), item("c")];
  const rows = new Map(items.map((candidate) =>
    [candidate.analysis_section_id, status(candidate)]));
  const h = harness(items, rows);
  let active = 0; let peak = 0;
  const terminal = await runAnalysisReconciler({ limit: 3, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
    reprocess: async (candidate) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1; h.calls.reprocess.push(candidate.analysis_section_id);
    },
  });
  assert.equal(peak, 2);
  assert.equal(terminal.itemFinals.length, 3);
  assert.ok(terminal.itemFinals.every((final) => final.status === "completed"));
  assert.deepEqual(h.calls.status, [items.map((candidate) => candidate.analysis_section_id)]);
  assert.equal(h.calls.persisted.length, 1);
  assert.equal(h.calls.persisted[0].terminal.itemFinals.length, 3);
  assert.equal(terminal.exit.exitCode, 0);
});

test("the exact repaired legacy D1 foreign-key failure is retryable", async () => {
  const repaired = "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)";
  const candidate = item("6", { section_error_code: repaired, job_error_code: repaired });
  const h = harness([candidate], new Map([[candidate.analysis_section_id, status(candidate)]]));
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => 0,
  });
  assert.deepEqual(h.calls.reprocess, [candidate.analysis_section_id]);
  assert.equal(terminal.itemFinals[0].status, "completed");
});

test("unrelated deterministic D1 binding failures remain manual", async () => {
  const candidate = item("7", { section_error_code: "D1_ERROR: unrelated binding failure",
    job_error_code: "D1_ERROR: unrelated binding failure" });
  const h = harness([candidate]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => 0,
  });
  assert.deepEqual(h.calls.reprocess, []);
  assert.equal(terminal.itemFinals[0].status, "manual_required");
  assert.equal(terminal.itemFinals[0].reason, "deterministic_or_exhausted_failure");
});

test("an initially mismatched terminal section and job is classified once without dispatch", async () => {
  const candidate = item("8", { section_status: "completed", job_status: "failed",
    section_error_code: null, job_error_code: "invalid_payload", outbox_status: "sent" });
  const h = harness([candidate]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => 0,
  });
  assert.deepEqual(h.calls.reprocess, []);
  assert.deepEqual(h.calls.status, []);
  assert.equal(terminal.itemFinals[0].status, "manual_required");
  assert.equal(terminal.itemFinals[0].reason, "section_job_terminal_mismatch");
});

test("a polled terminal cross-state mismatch closes as manual_required", async () => {
  const candidate = item("9");
  const mismatched = status(candidate, { status: "completed", jobStatus: "failed",
    jobErrorCode: "invalid_payload" });
  const h = harness([candidate], new Map([[candidate.analysis_section_id, mismatched]]));
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => 0,
  });
  assert.equal(terminal.itemFinals[0].status, "manual_required");
  assert.equal(terminal.itemFinals[0].reason, "section_job_terminal_mismatch");
  assert.equal(h.calls.status.length, 1);
});

test("invalid_json is eligible for one bounded retry", async () => {
  const candidate = item("d", { section_error_code: "invalid_json", job_error_code: "invalid_json" });
  const h = harness([candidate], new Map([[candidate.analysis_section_id, status(candidate)]]));
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => 0,
  });
  assert.deepEqual(h.calls.reprocess, [candidate.analysis_section_id]);
  assert.equal(terminal.itemFinals[0].status, "completed");
});

test("current v13 invalid payload and candidate failures use canonical bounded retry", async () => {
  const items = [item("a", { section_error_code: "invalid_payload",
    job_error_code: "invalid_payload" }), item("b", {
    section_error_code: "invalid_candidates", job_error_code: "invalid_candidates" })];
  const rows = new Map(items.map((candidate) =>
    [candidate.analysis_section_id, status(candidate)]));
  const h = harness(items, rows);
  const terminal = await runAnalysisReconciler({ limit: 2, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => 0,
  });
  assert.deepEqual(h.calls.reprocess, items.map((candidate) => candidate.analysis_section_id));
  assert.ok(terminal.itemFinals.every((final) => final.status === "completed"));
  assert.equal(terminal.summary.manualRequired, 0);
});

test("sent-outbox completed work is receipted without redispatch", async () => {
  const candidate = item("e", { section_status: "completed", job_status: "completed",
    section_error_code: null, job_error_code: null, outbox_status: "sent" });
  const h = harness([candidate]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => 0,
  });
  assert.deepEqual(h.calls.reprocess, []);
  assert.deepEqual(h.calls.status, []);
  assert.equal(terminal.itemFinals[0].status, "completed");
  assert.equal(terminal.itemFinals[0].reason, "recovered_completed_without_receipt");
  assert.equal(h.calls.persisted.length, 1);
});

test("exhausted v12 debt waits for a completed v13 successor disposition before completing", async () => {
  const candidate = historical("3");
  const successor = { successorAnalysisRunId: RUN("c"),
    successorAnalysisSectionId: SEC("c"), successorJobId: JOB("c") };
  const pending = lineage(candidate, "successor_pending", { ...successor,
    successorStatus: "processing", successorJobStatus: "processing" });
  const superseded = lineage(candidate, "superseded", { ...successor,
    successorStatus: "completed", successorJobStatus: "completed",
    successorAttemptCount: 1, successorJobAttemptCount: 1, dispositionId: DISP("d") });
  const h = historicalHarness([candidate], [[pending], [superseded]], [
    staleReceipt(candidate),
    staleReceipt(candidate, { ...successor, successorStatus: "completed",
      successorAttemptCount: 1, dispositionId: DISP("d"), terminal: true,
      dispatched: false, reused: true, reason: "historical_section_superseded" }),
  ]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
    sleep: async () => {},
  });
  assert.equal(terminal.itemFinals[0].status, "completed");
  assert.equal(terminal.itemFinals[0].reason, "historical_section_superseded");
  assert.deepEqual(terminal.itemFinals[0], {
    analysisSectionId: candidate.analysis_section_id, jobId: candidate.job_id,
    status: "completed", reason: "historical_section_superseded", beforeStatus: "failed",
    afterStatus: "completed", readbackAt: NOW, sourcePromptVersion: V12,
    targetPromptVersion: V13, successorAnalysisRunId: RUN("c"),
    successorAnalysisSectionId: SEC("c"), successorJobId: JOB("c"),
    dispositionId: DISP("d"),
  });
  assert.equal(h.calls.stale.length, 2);
  assert.equal(h.calls.status.length, 0);
});

test("a crash-recovered disposition is persisted without touching completed successor work", async () => {
  const successor = { successor_analysis_run_id: RUN("c"),
    successor_analysis_section_id: SEC("c"), successor_job_id: JOB("c"),
    successor_status: "completed", successor_job_status: "completed",
    successor_attempt_count: 1, successor_job_attempt_count: 1,
    disposition_id: DISP("d") };
  const candidate = historical("4", "superseded", successor);
  const readback = lineage(candidate, "superseded", {
    successorAnalysisRunId: RUN("c"), successorAnalysisSectionId: SEC("c"),
    successorJobId: JOB("c"), successorStatus: "completed",
    successorJobStatus: "completed", dispositionId: DISP("d") });
  const terminalReceipt = staleReceipt(candidate, {
    successorStatus: "completed", successorAttemptCount: 1,
    dispositionId: DISP("d"), terminal: true, dispatched: false, reused: true,
    reason: "historical_section_superseded" });
  const h = historicalHarness([candidate], [[readback]], [terminalReceipt]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
  });
  assert.equal(terminal.itemFinals[0].status, "completed");
  assert.equal(h.calls.stale.length, 1);
  assert.equal(h.calls.persisted.length, 1);
});

test("historical queued acceptance is never converted into early success", async () => {
  const candidate = historical("5");
  const pending = lineage(candidate, "successor_pending", {
    successorAnalysisRunId: RUN("c"), successorAnalysisSectionId: SEC("c"),
    successorJobId: JOB("c"), successorStatus: "queued", successorJobStatus: "queued" });
  const h = historicalHarness([candidate], [[pending]], [staleReceipt(candidate)]);
  let clock = 0;
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW,
    nowMs: () => clock, globalTimeoutMs: 1_000, pollMs: 100,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(terminal.itemFinals[0].status, "failed");
  assert.equal(terminal.itemFinals[0].reason, "global_deadline_exceeded");
  assert.equal(h.calls.status.length, 0);
});

test("a terminal successor receipt that disagrees with D1 fails closed", async () => {
  const candidate = historical("6", "superseded", {
    successor_analysis_run_id: RUN("c"), successor_analysis_section_id: SEC("c"),
    successor_job_id: JOB("c"), successor_status: "completed",
    successor_job_status: "completed", disposition_id: DISP("d") });
  const readback = lineage(candidate, "superseded", {
    successorAnalysisRunId: RUN("c"), successorAnalysisSectionId: SEC("c"),
    successorJobId: JOB("c"), successorStatus: "completed",
    successorJobStatus: "completed", dispositionId: DISP("d") });
  const mismatched = staleReceipt(candidate, { successorStatus: "completed",
    dispositionId: DISP("e"), terminal: true, reused: true, dispatched: false,
    reason: "historical_section_superseded" });
  const h = historicalHarness([candidate], [[readback]], [mismatched]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
  });
  assert.equal(terminal.itemFinals[0].status, "failed");
  assert.equal(terminal.itemFinals[0].reason, "successor_receipt_readback_mismatch");
});

test("a superseded readback without a terminal action receipt fails closed", async () => {
  const candidate = historical("8", "superseded", {
    successor_analysis_run_id: RUN("c"), successor_analysis_section_id: SEC("c"),
    successor_job_id: JOB("c"), successor_status: "completed",
    successor_job_status: "completed", disposition_id: DISP("d") });
  const readback = lineage(candidate, "superseded", {
    successorAnalysisRunId: RUN("c"), successorAnalysisSectionId: SEC("c"),
    successorJobId: JOB("c"), successorStatus: "completed",
    successorJobStatus: "completed", dispositionId: DISP("d") });
  const h = historicalHarness([candidate], [[readback]], [staleReceipt(candidate, {
    successorStatus: "completed", dispositionId: DISP("d"), dispatched: false, reused: true,
  })]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
  });
  assert.equal(terminal.itemFinals[0].status, "failed");
  assert.equal(terminal.itemFinals[0].reason, "successor_terminal_receipt_missing");
});

test("a terminal historical manual receipt is final only after matching successor readback", async () => {
  const candidate = historical("7", "successor_retryable", {
    successor_analysis_run_id: RUN("c"), successor_analysis_section_id: SEC("c"),
    successor_job_id: JOB("c"), successor_status: "failed",
    successor_job_status: "failed" });
  const failed = lineage(candidate, "successor_retryable", {
    successorAnalysisRunId: RUN("c"), successorAnalysisSectionId: SEC("c"),
    successorJobId: JOB("c"), successorStatus: "failed", successorJobStatus: "failed",
    successorAttemptCount: 8, successorJobAttemptCount: 8,
    successorErrorCode: "invalid_payload", successorJobErrorCode: "invalid_payload" });
  const manual = staleReceipt(candidate, { successorStatus: "failed",
    successorAttemptCount: 8, terminal: true, manualRequired: true,
    dispatched: false, reused: true, reason: "successor_manual_required" });
  const h = historicalHarness([candidate], [[failed]], [manual]);
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
  });
  assert.equal(terminal.itemFinals[0].status, "manual_required");
  assert.equal(terminal.itemFinals[0].reason, "successor_manual_required");
  assert.equal(h.calls.persisted.length, 1);
});

test("one global deadline closes every pending item with an explicit final", async () => {
  const items = [item("1"), item("2")];
  let clock = 0;
  const rows = new Map(items.map((candidate) => [candidate.analysis_section_id,
    status(candidate, { status: "processing", jobStatus: "processing", completedAt: null })]));
  const h = harness(items, rows);
  const terminal = await runAnalysisReconciler({ limit: 2, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, reprocess: h.reprocess,
    nowIso: () => NOW, nowMs: () => clock, globalTimeoutMs: 1_000, pollMs: 100,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(terminal.itemFinals.length, 2);
  assert.ok(terminal.itemFinals.every((final) => final.reason === "global_deadline_exceeded"));
  assert.equal(terminal.summary.failed, 2);
  assert.equal(h.calls.persisted.length, 1);
});

test("receipt persistence mismatch remains a typed fatal failure", async () => {
  const candidate = item("f", { section_status: "completed", job_status: "completed",
    section_error_code: null, job_error_code: null, outbox_status: "sent" });
  const h = harness([candidate]);
  h.operationClient.persistOperationReceipt = async () => {
    throw Object.assign(new Error("mismatch"), { code: "operation_receipt_readback_mismatch" });
  };
  const terminal = await runAnalysisReconciler({ limit: 1, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
  });
  assert.equal(terminal.summary.status, "failed");
  assert.equal(terminal.summary.fatalCode, "operation_receipt_readback_mismatch");
  assert.equal(terminal.exit.exitCode, 1);
});

test("zero debt persists an explicit zero-work terminal", async () => {
  const h = harness([]);
  const terminal = await runAnalysisReconciler({ limit: 25, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW, nowMs: () => 0,
  });
  assert.equal(terminal.summary.status, "zero_work");
  assert.equal(terminal.summary.discovered, 0);
  assert.equal(h.calls.persisted[0].terminal.itemFinals.length, 0);
  assert.equal(terminal.exit.exitCode, 0);
});

test("strict operation client sends the canonical idempotency key and rejects count drift", async () => {
  const summary = { runId: `arr_${"a".repeat(32)}`, idempotencySha256: "b".repeat(64),
    limit: 25, discovered: 0, completed: 0, manualRequired: 0, failed: 0 };
  let request;
  const receipt = { schemaVersion: 1, contract: "operation-receipt-persistence-v1",
    terminal: true, persisted: true, reused: false, kind: "analysis_reconciliation",
    runId: summary.runId, itemCount: 0, readback: { idempotencySha256: summary.idempotencySha256,
      limit: 25, discovered: 0, completed: 0, manualRequired: 0, failed: 0,
      status: "completed", itemCount: 0 } };
  const client = createOperationReceiptClient({ token: "test-token", adminBase: "https://scanner.test",
    fetcher: async (_url, options) => { request = options; return new Response(JSON.stringify(receipt),
      { status: 200, headers: { "content-type": "application/json" } }); } });
  await client.persistOperationReceipt("analysis_reconciliation", { summary, itemFinals: [] });
  assert.equal(request.headers["idempotency-key"],
    `operation-receipt/analysis_reconciliation/${summary.runId}/${summary.idempotencySha256}`);
  assert.throws(() => validateOperationReceipt({ ...receipt, itemCount: 1 }, {
    kind: "analysis_reconciliation", summary, itemFinals: [],
  }), /operation_receipt_invalid/);
});

test("runner and client source statically ban explicit transaction SQL", () => {
  for (const relative of ["../scripts/analysis-reconciler.mjs",
    "../scripts/machine-conveyor.mjs", "../scripts/operation-receipt-client.mjs"]) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /BEGIN\s+(?:IMMEDIATE|TRANSACTION)|\bCOMMIT\b/i);
  }
});

test("the canonical npm shortcut inherits the receipt-safe default limit", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["reconcile:analysis"], "node scripts/analysis-reconciler.mjs");
});
