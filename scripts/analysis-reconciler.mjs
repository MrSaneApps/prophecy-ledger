#!/usr/bin/env node
// Canonical bounded reconciler for current transcript-analysis section debt.
// It never changes acquisition, claims, reviewer data, or publication state.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createOperationReceiptClient } from "./operation-receipt-client.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RETRYABLE_CAUSE = /network|timeout|upstream_429|upstream_5|ai_unavailable|queue|provider_429|provider_5|model_unavailable|ai_timeout_unconfirmed|invalid_json|invalid_candidates|invalid_payload/i;
const REPAIRED_ANALYSIS_FAILURE =
  /^D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_FOREIGNKEY\)$/;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeCode(value, fallback = "runner_error") {
  const code = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return code && code.length <= 120 ? code : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function parseAnalysisReconcilerArgs(args) {
  const known = new Set(["--limit", "--local", "--dry-run"]);
  for (let index = 0; index < args.length; index += 1) {
    if (!known.has(args[index])) throw new Error(`unknown_argument:${args[index]}`);
    if (args[index] === "--limit") index += 1;
  }
  const at = args.indexOf("--limit");
  const raw = at >= 0 ? args[at + 1] : "5";
  if (!/^\d+$/.test(String(raw || ""))) throw new Error("invalid_limit");
  const limit = Number(raw);
  if (limit < 1 || limit > 25) throw new Error("invalid_limit");
  return { limit, local: args.includes("--local"), dryRun: args.includes("--dry-run") };
}

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
}

function d1Args(local, tail) {
  return local
    ? ["d1", "execute", "DB", "--local", "--persist-to", ".wrangler/state", ...tail]
    : ["d1", "execute", "prophecy-ledger", "--remote", ...tail];
}

export function makeAnalysisReconcilerD1({ local = false } = {}) {
  return {
    read(sql) {
      const parsed = JSON.parse(wrangler(d1Args(local, ["--json", "--command", sql])));
      return parsed.flatMap((entry) => entry.results || []);
    },
  };
}

export function analysisDiscoverySql(limit) {
  return `SELECT lineage.* FROM analysis_section_lineage_v2 lineage
    WHERE lineage.debt_state IN ('superseded','finalization_pending','successor_required','successor_pending',
      'successor_retryable','current_retryable','manual_required')
      AND NOT EXISTS (SELECT 1 FROM analysis_reconciliation_item_receipts receipt
        WHERE receipt.analysis_section_id=lineage.analysis_section_id
          AND receipt.target_prompt_version=lineage.target_prompt_version
          AND ((receipt.outcome='manual_required'
            AND lineage.debt_state='manual_required') OR (
            receipt.outcome='completed'
            AND receipt.safe_reason_code='historical_section_superseded'
            AND receipt.source_prompt_version=lineage.source_prompt_version
            AND receipt.successor_analysis_run_id=lineage.successor_analysis_run_id
            AND receipt.successor_analysis_section_id=lineage.successor_analysis_section_id
            AND receipt.successor_job_id=lineage.successor_job_id
            AND receipt.disposition_id=lineage.disposition_id)))
    ORDER BY CASE lineage.debt_state WHEN 'superseded' THEN 0 WHEN 'finalization_pending' THEN 1
      WHEN 'current_retryable' THEN 2 WHEN 'successor_retryable' THEN 3
      WHEN 'successor_pending' THEN 4 WHEN 'successor_required' THEN 5 ELSE 6 END,
      lineage.analysis_section_id
    LIMIT ${limit}`;
}

function normalizeLineage(row) {
  return { ...row,
    analysis_section_id: row.sourceAnalysisSectionId ?? row.analysisSectionId ?? row.analysis_section_id,
    job_id: row.sourceJobId ?? row.source_job_id ?? row.job_id,
    attempt_count: Number(row.sourceAttemptCount ?? row.source_attempt_count ?? row.attempt_count ?? 0),
    job_attempt_count: Number(row.sourceJobAttemptCount ?? row.source_job_attempt_count
      ?? row.job_attempt_count ?? 0),
    section_error_code: row.sourceErrorCode ?? row.source_error_code ?? row.section_error_code ?? null,
    job_error_code: row.sourceJobErrorCode ?? row.source_job_error_code ?? row.job_error_code ?? null,
    section_status: row.sourceStatus ?? row.source_status ?? row.section_status ?? "failed",
    job_status: row.sourceJobStatus ?? row.source_job_status ?? row.job_status ?? "failed",
    source_prompt_version: row.sourcePromptVersion ?? row.source_prompt_version,
    target_prompt_version: row.targetPromptVersion ?? row.target_prompt_version,
    successor_analysis_run_id: row.successorAnalysisRunId ?? row.successor_analysis_run_id ?? null,
    successor_analysis_section_id: row.successorAnalysisSectionId ?? row.successor_analysis_section_id ?? null,
    successor_job_id: row.successorJobId ?? row.successor_job_id ?? null,
    successor_status: row.successorStatus ?? row.successor_status ?? null,
    successor_job_status: row.successorJobStatus ?? row.successor_job_status ?? null,
    successor_attempt_count: Number(row.successorAttemptCount ?? row.successor_attempt_count ?? 0),
    successor_job_attempt_count: Number(row.successorJobAttemptCount ?? row.successor_job_attempt_count ?? 0),
    successor_error_code: row.successorErrorCode ?? row.successor_error_code ?? null,
    successor_job_error_code: row.successorJobErrorCode ?? row.successor_job_error_code ?? null,
    disposition_id: row.dispositionId ?? row.disposition_id ?? null,
    debt_state: row.debtState ?? row.debt_state,
  };
}

export async function dispatchAnalysisAction(item, { operationClient, idempotencyKey,
  timeoutMs = 30_000 } = {}) {
  if (item.debt_state === "current_retryable") {
    return { kind: "current", receipt: await operationClient.reprocessSection(item, {
      idempotencyKey, timeoutMs,
    }) };
  }
  if (["superseded", "successor_required", "successor_retryable", "finalization_pending"]
    .includes(item.debt_state)) {
    return { kind: "historical", receipt: await operationClient.reconcileStaleSection(item, {
      idempotencyKey, timeoutMs,
    }) };
  }
  const code = item.debt_state === "successor_pending" ? "successor_already_pending" :
    "analysis_debt_state_not_actionable";
  throw Object.assign(new Error(code), { code });
}

function itemFinal(item, status, reason, afterStatus, readbackAt, overrides = {}) {
  return { analysisSectionId: item.analysis_section_id, jobId: item.job_id,
    status, reason, beforeStatus: "failed", afterStatus, readbackAt,
    sourcePromptVersion: overrides.sourcePromptVersion ?? item.source_prompt_version ?? null,
    targetPromptVersion: overrides.targetPromptVersion ?? item.target_prompt_version ?? null,
    successorAnalysisRunId: overrides.successorAnalysisRunId ?? item.successor_analysis_run_id ?? null,
    successorAnalysisSectionId: overrides.successorAnalysisSectionId ?? item.successor_analysis_section_id ?? null,
    successorJobId: overrides.successorJobId ?? item.successor_job_id ?? null,
    dispositionId: overrides.dispositionId ?? item.disposition_id ?? null };
}

function retryableCode(value) {
  return RETRYABLE_CAUSE.test(value || "") || REPAIRED_ANALYSIS_FAILURE.test(value || "");
}

function retryable(itemOrRow) {
  return retryableCode(itemOrRow.section_error_code ?? itemOrRow.errorCode ?? "")
    && retryableCode(itemOrRow.job_error_code ?? itemOrRow.jobErrorCode ?? "");
}

function initialDisposition(item, startedAt) {
  // Rediscovered dispositions still need the canonical reused terminal action
  // receipt to agree with a fresh lineage readback before completion is durable.
  if (item.debt_state === "superseded") return null;
  if (item.debt_state === "manual_required") {
    return itemFinal(item, "manual_required",
      safeCode(item.manual_reason || item.safe_reason_code, "deterministic_or_exhausted_failure"),
      item.successor_status || item.section_status || "failed", startedAt);
  }
  if (["successor_required", "successor_pending", "successor_retryable", "finalization_pending"]
    .includes(item.debt_state)) return null;
  if (item.section_status === "completed" && item.job_status === "completed") {
    return itemFinal(item, "completed", "recovered_completed_without_receipt",
      "completed", startedAt);
  }
  if (["completed", "failed"].includes(item.section_status)
      && ["completed", "failed"].includes(item.job_status)
      && item.section_status !== item.job_status) {
    return itemFinal(item, "manual_required", "section_job_terminal_mismatch",
      item.section_status, startedAt);
  }
  const failed = !item.section_status || (item.section_status === "failed" && item.job_status === "failed");
  if (failed && (!retryable(item) || Number(item.attempt_count) >= 8
      || Number(item.job_attempt_count) >= 8)) {
    return itemFinal(item, "manual_required", "deterministic_or_exhausted_failure",
      "failed", startedAt);
  }
  return null;
}

async function dispatchBounded(discovered, context, finals, pending) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, discovered.length) }, async () => {
    while (cursor < discovered.length) {
      const index = cursor++;
      const item = discovered[index];
      const immediate = initialDisposition(item, context.startedAt);
      if (immediate) { finals[index] = immediate; continue; }
      if (item.debt_state === "successor_pending") {
        pending.set(index, { item, kind: "historical", actionReceipt: null }); continue;
      }
      if (context.nowMs() >= context.deadlineMs) {
        finals[index] = itemFinal(item, "failed", "global_deadline_exceeded",
          item.section_status || "failed", context.nowIso());
        continue;
      }
      try {
        const idempotencyKey = `analysis-reconciler/${context.actionHash}/${item.analysis_section_id}`;
        const action = await context.dispatchAction(item, { idempotencyKey,
          timeoutMs: Math.min(30_000, Math.max(1, context.deadlineMs - context.nowMs())) });
        pending.set(index, { item, kind: action.kind, actionReceipt: action.receipt,
          lastActionState: item.debt_state });
      } catch (error) {
        finals[index] = itemFinal(item, "failed",
          safeCode(error?.code || error?.message, "admin_receipt_invalid"), null, null);
      }
    }
  }));
}

function classifyStatus(item, row, observedAt) {
  if (row.jobId !== item.job_id) {
    return itemFinal(item, "failed", "section_job_readback_mismatch", row.status, observedAt);
  }
  if (["completed", "failed"].includes(row.status)
      && ["completed", "failed"].includes(row.jobStatus)
      && row.status !== row.jobStatus) {
    return itemFinal(item, "manual_required", "section_job_terminal_mismatch",
      row.status, observedAt);
  }
  if (row.status === "completed" && row.jobStatus === "completed") {
    return itemFinal(item, "completed", "completed", "completed", observedAt);
  }
  if (row.status === "failed" && row.jobStatus === "failed") {
    if (!retryable(row) || row.attemptCount >= 8 || row.jobAttemptCount >= 8) {
      return itemFinal(item, "manual_required", "deterministic_or_exhausted_failure",
        "failed", observedAt);
    }
    return itemFinal(item, "failed", "retryable_failure_after_attempt", "failed", observedAt);
  }
  return null;
}

function lineageOverrides(row) {
  return { sourcePromptVersion: row.source_prompt_version,
    targetPromptVersion: row.target_prompt_version,
    successorAnalysisRunId: row.successor_analysis_run_id,
    successorAnalysisSectionId: row.successor_analysis_section_id,
    successorJobId: row.successor_job_id, dispositionId: row.disposition_id };
}

function historicalReceiptAgrees(item, row, receipt) {
  if (!receipt) return false;
  const expected = {
    sourceAnalysisSectionId: item.analysis_section_id,
    sourcePromptVersion: row.source_prompt_version,
    targetPromptVersion: row.target_prompt_version,
    successorAnalysisRunId: row.successor_analysis_run_id,
    successorAnalysisSectionId: row.successor_analysis_section_id,
    successorJobId: row.successor_job_id,
    dispositionId: row.disposition_id,
  };
  return Object.entries(expected).every(([key, value]) => receipt[key] === value);
}

function classifyLineage(item, row, actionReceipt, observedAt) {
  if (!row || row.analysis_section_id !== item.analysis_section_id
      || row.source_prompt_version !== item.source_prompt_version
      || row.target_prompt_version !== item.target_prompt_version) {
    return itemFinal(item, "failed", "successor_lineage_readback_mismatch", null, observedAt);
  }
  if (actionReceipt?.terminal === true && actionReceipt.manualRequired === true) {
    if (!historicalReceiptAgrees(item, row, actionReceipt)) {
      return itemFinal(item, "failed", "successor_receipt_readback_mismatch",
        row.successor_status || "failed", observedAt, lineageOverrides(row));
    }
    return itemFinal(item, "manual_required",
      safeCode(actionReceipt.reason, "successor_manual_required"),
      row.successor_status || "failed", observedAt, lineageOverrides(row));
  }
  if (row.debt_state === "manual_required") {
    if (actionReceipt && (!actionReceipt.terminal || !actionReceipt.manualRequired)) {
      return itemFinal(item, "failed", "successor_receipt_readback_mismatch",
        row.successor_status || "failed", observedAt, lineageOverrides(row));
    }
    return itemFinal(item, "manual_required",
      safeCode(actionReceipt?.reason || row.safe_reason_code, "deterministic_or_exhausted_failure"),
      row.successor_status || "failed", observedAt, lineageOverrides(row));
  }
  if (row.debt_state !== "superseded") return null;
  if (!row.disposition_id || !row.successor_analysis_run_id || !row.successor_analysis_section_id
      || !row.successor_job_id || row.successor_status !== "completed"
      || row.successor_job_status !== "completed") {
    return itemFinal(item, "failed", "successor_disposition_readback_mismatch",
      row.successor_status, observedAt, lineageOverrides(row));
  }
  if (!actionReceipt || actionReceipt.terminal !== true) {
    return itemFinal(item, "failed", "successor_terminal_receipt_missing", "completed",
      observedAt, lineageOverrides(row));
  }
  if (actionReceipt?.terminal === true && (actionReceipt.manualRequired !== false
      || !historicalReceiptAgrees(item, row, actionReceipt))) {
    return itemFinal(item, "failed", "successor_receipt_readback_mismatch", "completed",
      observedAt, lineageOverrides(row));
  }
  return itemFinal(item, "completed", "historical_section_superseded", "completed",
    observedAt, lineageOverrides(row));
}

async function dispatchHistoricalUpdates(context, entries, finals, pending, rows) {
  const work = [];
  for (let offset = 0; offset < entries.length; offset += 1) {
    const [index, state] = entries[offset];
    const row = rows[offset];
    if (!row || finals[index] || !["superseded", "finalization_pending", "successor_required",
      "successor_retryable"].includes(row.debt_state)) continue;
    const terminalReceipt = state.actionReceipt?.terminal === true
      && historicalReceiptAgrees(state.item, row, state.actionReceipt);
    if (terminalReceipt || state.lastActionState === row.debt_state) continue;
    work.push({ index, state, row });
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(2, work.length) }, async () => {
    while (cursor < work.length) {
      const { index, state, row } = work[cursor++];
      try {
        const action = await context.dispatchAction({ ...state.item, ...row }, {
          idempotencyKey: `analysis-reconciler/${context.actionHash}/${state.item.analysis_section_id}/${row.debt_state}`,
          timeoutMs: Math.min(30_000, Math.max(1, context.deadlineMs - context.nowMs())),
        });
        pending.set(index, { ...state, actionReceipt: action.receipt,
          lastActionState: row.debt_state });
      } catch (error) {
        finals[index] = itemFinal(state.item, "failed",
          safeCode(error?.code || error?.message, "admin_receipt_invalid"), null, null);
        pending.delete(index);
      }
    }
  }));
}

async function pollPending(context, finals, pending) {
  while (pending.size > 0 && context.nowMs() < context.deadlineMs) {
    const observedAt = context.nowIso();
    for (const kind of ["current", "historical"]) {
      const entries = [...pending.entries()].filter(([, state]) => state.kind === kind);
      if (!entries.length) continue;
      let rows;
      try {
        const ids = entries.map(([, state]) => state.item.analysis_section_id);
        rows = kind === "current"
          ? await context.operationClient.readSectionStatuses(ids, {
            timeoutMs: Math.min(30_000, Math.max(1, context.deadlineMs - context.nowMs())),
          })
          : (await context.operationClient.readSectionLineages(ids, {
            timeoutMs: Math.min(30_000, Math.max(1, context.deadlineMs - context.nowMs())),
          })).map(normalizeLineage);
      } catch (error) {
        const fallback = kind === "current" ? "section_status_receipt_invalid"
          : "section_lineage_receipt_invalid";
        const reason = safeCode(error?.code || error?.message, fallback);
        for (const [index, state] of entries) {
          finals[index] = itemFinal(state.item, "failed", reason, null, null);
          pending.delete(index);
        }
        continue;
      }
      if (kind === "historical") {
        await dispatchHistoricalUpdates(context, entries, finals, pending, rows);
      }
      rows.forEach((row, offset) => {
        const [index] = entries[offset];
        if (!pending.has(index)) return;
        const state = pending.get(index);
        const terminal = kind === "current" ? classifyStatus(state.item, row, observedAt)
          : classifyLineage(state.item, row, state.actionReceipt, observedAt);
        if (terminal) { finals[index] = terminal; pending.delete(index); }
      });
    }
    if (pending.size > 0 && context.nowMs() < context.deadlineMs) {
      await context.sleep(Math.min(context.pollMs,
        Math.max(0, context.deadlineMs - context.nowMs())));
    }
  }
  for (const [index, state] of pending) {
    finals[index] = itemFinal(state.item, "failed", "global_deadline_exceeded", null, context.nowIso());
  }
  pending.clear();
}

function counts(finals) {
  return {
    completed: finals.filter((item) => item.status === "completed").length,
    manualRequired: finals.filter((item) => item.status === "manual_required").length,
    failed: finals.filter((item) => item.status === "failed").length,
    pending: finals.filter((item) => item.status === "dry_run").length,
  };
}

export async function runAnalysisReconciler(options = {}, dependencies = {}) {
  const nowIso = dependencies.nowIso || (() => new Date().toISOString());
  const nowMs = dependencies.nowMs || Date.now;
  const startedAt = nowIso();
  const d1 = dependencies.d1 || makeAnalysisReconcilerD1({ local: options.local });
  let discovered;
  try { discovered = d1.read(analysisDiscoverySql(options.limit)).map(normalizeLineage); }
  catch {
    return { itemFinals: [], summary: { schemaVersion: 1,
      contract: "analysis-reconciliation-v1", status: "failed", mode: "run",
      runId: null, limit: options.limit, discovered: 0, completed: 0,
      manualRequired: 0, failed: 0, pending: 0, fatalCode: "discovery_failed",
      startedAt, completedAt: nowIso(),
    }, exit: { schemaVersion: 1, status: "failure", exitCode: 1 } };
  }
  const identity = JSON.stringify(discovered.map((item) => [item.analysis_section_id,
    item.job_id, item.attempt_count, item.section_error_code, item.job_error_code,
    item.section_status, item.job_status, item.debt_state, item.source_prompt_version,
    item.target_prompt_version, item.successor_analysis_run_id,
    item.successor_analysis_section_id, item.successor_job_id, item.disposition_id]));
  const actionHash = sha256(`analysis-reconciliation-action-v2:${options.limit}:${identity}`).slice(0, 16);
  let itemFinals;
  if (options.dryRun) itemFinals = discovered.map((item) => itemFinal(item, "dry_run",
    "dry_run", item.section_status || "failed", startedAt));
  else {
    itemFinals = new Array(discovered.length);
    const pending = new Map();
    const operationClient = dependencies.operationClient || createOperationReceiptClient({
      token: dependencies.token, adminBase: dependencies.adminBase, fetcher: dependencies.fetcher,
    });
    const globalTimeoutMs = boundedInteger(dependencies.globalTimeoutMs
      ?? process.env.ANALYSIS_RECONCILER_TIMEOUT_MS, 900_000, 1_000, 3_600_000);
    const context = { operationClient, nowIso, nowMs, startedAt,
      deadlineMs: nowMs() + globalTimeoutMs, actionHash,
      pollMs: boundedInteger(dependencies.pollMs ?? process.env.ANALYSIS_RECONCILER_POLL_MS,
        3_000, 100, 60_000),
      sleep: dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      dispatchAction: dependencies.dispatchAction || (dependencies.reprocess
        ? async (candidate, request) => ({ kind: "current",
          receipt: await dependencies.reprocess(candidate, request) })
        : ((candidate, request) => dispatchAnalysisAction(candidate,
          { operationClient, ...request }))),
    };
    await dispatchBounded(discovered, context, itemFinals, pending);
    await pollPending(context, itemFinals, pending);
  }
  const totals = counts(itemFinals);
  const completedAt = nowIso();
  const idempotencySha256 = sha256(`analysis-reconciliation-v2:${options.limit}:${identity}:${JSON.stringify(itemFinals)}`);
  const runId = `arr_${idempotencySha256.slice(0, 32)}`;
  const mode = options.dryRun ? "dry_run" : discovered.length ? "run" : "zero_work";
  const summary = { schemaVersion: 1, contract: "analysis-reconciliation-v1",
    status: options.dryRun ? "dry_run" : totals.failed ? "failed"
      : totals.manualRequired ? "manual_required" : discovered.length ? "completed" : "zero_work",
    mode, runId, idempotencySha256, limit: options.limit, discovered: discovered.length,
    ...totals, fatalCode: null, startedAt, completedAt };
  if (!options.dryRun) {
    const operationClient = dependencies.operationClient || createOperationReceiptClient({
      token: dependencies.token, adminBase: dependencies.adminBase, fetcher: dependencies.fetcher,
    });
    try { await operationClient.persistOperationReceipt("analysis_reconciliation", { itemFinals, summary }); }
    catch (error) {
      summary.status = "failed";
      summary.fatalCode = safeCode(error?.code || error?.message,
        "operation_receipt_persistence_failed");
    }
  }
  const failed = ["failed", "manual_required"].includes(summary.status);
  return { itemFinals, summary,
    exit: { schemaVersion: 1, status: failed ? "failure" : "success", exitCode: failed ? 1 : 0,
      summaryStatus: summary.status } };
}

function emitTerminal(terminal) {
  for (const item of terminal.itemFinals) {
    console.log(`ANALYSIS_RECONCILIATION_ITEM_FINAL ${JSON.stringify(item)}`);
  }
  console.log(`ANALYSIS_RECONCILIATION_SUMMARY ${JSON.stringify(terminal.summary)}`);
  console.log(`ANALYSIS_RECONCILIATION_EXIT ${JSON.stringify(terminal.exit)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  let terminal;
  try {
    const options = parseAnalysisReconcilerArgs(process.argv.slice(2));
    terminal = await runAnalysisReconciler(options);
  } catch (error) {
    terminal = { itemFinals: [], summary: { schemaVersion: 1,
      contract: "analysis-reconciliation-v1", status: "failed", discovered: 0,
      completed: 0, manualRequired: 0, failed: 0, pending: 0,
      fatalCode: safeCode(error?.message, "runner_start_failed") },
    exit: { schemaVersion: 1, status: "failure", exitCode: 1 } };
  }
  emitTerminal(terminal);
  process.exitCode = terminal.exit.exitCode;
}
