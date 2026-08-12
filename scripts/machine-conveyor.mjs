#!/usr/bin/env node
// Canonical machine conveyor. Its only mutation is materializing a ready
// candidate_verification work item after exact atomic-source binding checks.
// It never creates claims, decisions, reviews, assignments, or publications.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { candidateVerificationWork } from "../functions/lib/archive-conveyor.js";
import { sqlQuote } from "./research-lib.mjs";
import { createOperationReceiptClient } from "./operation-receipt-client.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeCode(value, fallback = "runner_error") {
  const code = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return code && code.length <= 120 ? code : fallback;
}

export function parseMachineConveyorArgs(args) {
  const known = new Set(["--limit", "--local", "--dry-run"]);
  for (let index = 0; index < args.length; index += 1) {
    if (!known.has(args[index])) throw new Error(`unknown_argument:${args[index]}`);
    if (args[index] === "--limit") index += 1;
  }
  const at = args.indexOf("--limit");
  const raw = at >= 0 ? args[at + 1] : "25";
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

export function makeMachineConveyorD1({ local = false } = {}) {
  return {
    read(sql) {
      const parsed = JSON.parse(wrangler(d1Args(local, ["--json", "--command", sql])));
      return parsed.flatMap((entry) => entry.results || []);
    },
  };
}

export function machineConveyorDiscoverySql(limit) {
  return `SELECT ready.candidate_id,ready.readiness_id,ready.analysis_section_id,
      ready.readiness_transcript_id transcript_id,ready.source_item_id,
      ready.extraction_run_id,ready.readiness_gate_version gate_version,
      ready.transcript_sha256,ready.section_sha256,ready.readiness_created_at
    FROM review_ready_claim_candidates ready
    WHERE NOT EXISTS (SELECT 1 FROM candidate_claim_promotions promotion
        WHERE promotion.candidate_id=ready.candidate_id)
      AND NOT EXISTS (SELECT 1 FROM candidate_review_decisions decision
        WHERE decision.candidate_id=ready.candidate_id)
      AND NOT EXISTS (
        SELECT 1 FROM machine_conveyor_item_receipts receipt
        JOIN machine_conveyor_runs receipt_run ON receipt_run.run_id=receipt.run_id
        WHERE receipt.candidate_id=ready.candidate_id
          AND receipt.outcome IN ('promoted','reused')
          AND receipt_run.status='completed'
      )
    ORDER BY ready.readiness_created_at,ready.candidate_id
    LIMIT ${limit}`;
}

function exactBindingReadback(d1, item) {
  return d1.read(`SELECT ready.candidate_id,ready.readiness_id,ready.analysis_section_id,
      ready.readiness_transcript_id transcript_id,ready.source_item_id,
      ready.extraction_run_id,ready.readiness_gate_version gate_version,
      ready.transcript_sha256,ready.section_sha256,
      artifact.content_sha256 artifact_sha256,section.input_sha256 section_input_sha256,
      section.status section_status,analysis.transcript_sha256 analysis_sha256,
      extraction.input_sha256 extraction_sha256,extraction.prompt_version extraction_prompt,
      source.platform,source.platform_item_id,source.canonical_url
    FROM review_ready_claim_candidates ready
    JOIN transcript_artifacts artifact ON artifact.transcript_id=ready.readiness_transcript_id
      AND artifact.source_item_id=ready.source_item_id
    JOIN transcript_analysis_sections section
      ON section.analysis_section_id=ready.analysis_section_id
    JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
      AND analysis.transcript_id=ready.readiness_transcript_id
      AND analysis.source_item_id=ready.source_item_id
    JOIN extraction_runs extraction ON extraction.extraction_run_id=ready.extraction_run_id
      AND extraction.transcript_id=ready.readiness_transcript_id
    JOIN source_items source ON source.source_item_id=ready.source_item_id
    WHERE ready.candidate_id=${sqlQuote(item.candidate_id)}
      AND ready.readiness_id=${sqlQuote(item.readiness_id)}
      AND section.status='completed'
      AND artifact.content_sha256=ready.transcript_sha256
      AND analysis.transcript_sha256=ready.transcript_sha256
      AND section.input_sha256=ready.section_sha256
      AND extraction.input_sha256=ready.section_sha256
      AND extraction.prompt_version=ready.readiness_gate_version
    LIMIT 1`)[0] || null;
}

function workReadback(d1, candidateId) {
  return d1.read(`SELECT
      (SELECT COUNT(*) FROM review_ready_claim_candidates ready
        WHERE ready.candidate_id=${sqlQuote(candidateId)}) ready_count,
      (SELECT COUNT(*) FROM review_work_items work
        WHERE work.candidate_id=${sqlQuote(candidateId)}) work_count,
      (SELECT COUNT(*) FROM review_work_items work
        WHERE work.candidate_id=${sqlQuote(candidateId)}
          AND work.work_type='candidate_verification'
          AND work.origin_kind='private_extraction_candidate'
          AND work.status='ready') ready_work_count,
      (SELECT MIN(work_item_id) FROM review_work_items work
        WHERE work.candidate_id=${sqlQuote(candidateId)}) work_item_id,
      (SELECT COUNT(*) FROM candidate_claim_promotions promotion
        WHERE promotion.candidate_id=${sqlQuote(candidateId)}) promotion_count`)[0] || null;
}

function preservationCounts(d1) {
  return d1.read(`SELECT
    (SELECT COUNT(*) FROM claims) claims,
    (SELECT COUNT(*) FROM candidate_claim_promotions) candidate_promotions,
    (SELECT COUNT(*) FROM candidate_review_decisions) candidate_decisions,
    (SELECT COUNT(*) FROM moderator_reviews) moderator_reviews,
    (SELECT COUNT(*) FROM review_assignments) review_assignments,
    (SELECT COUNT(*) FROM claim_revisions) claim_revisions,
    (SELECT COUNT(*) FROM publication_evaluations) publication_evaluations`)[0];
}

function preservationAgrees(before, after) {
  return Object.keys(before || {}).every((key) => Number(before[key]) === Number(after?.[key]));
}

function processCandidate(d1, item, now) {
  const binding = exactBindingReadback(d1, item);
  if (!binding) {
    const state = workReadback(d1, item.candidate_id);
    return { candidateId: item.candidate_id, readinessId: item.readiness_id,
      workItemId: state?.work_item_id || null, verified: false, status: "skipped",
      classification: Number(state?.promotion_count) > 0 ? "already_promoted" : "binding_changed",
      reason: Number(state?.promotion_count) > 0 ? "candidate_already_promoted" : "atomic_binding_changed",
      readbackAt: now };
  }
  const existing = workReadback(d1, item.candidate_id);
  if (Number(existing?.promotion_count) > 0) return {
    candidateId: item.candidate_id, readinessId: item.readiness_id,
    workItemId: existing.work_item_id || null, verified: false, status: "skipped",
    classification: "already_promoted", reason: "candidate_already_promoted", readbackAt: now,
  };
  if (Number(existing?.work_count) > 0 && Number(existing?.ready_work_count) !== 1) return {
    candidateId: item.candidate_id, readinessId: item.readiness_id,
    workItemId: existing.work_item_id || null, verified: true, status: "failed",
    classification: "work_item_conflict", reason: "candidate_work_item_conflict", readbackAt: now,
  };
  const work = candidateVerificationWork(item.candidate_id, now);
  if (Number(existing?.ready_work_count) === 1) return {
    candidateId: item.candidate_id, readinessId: item.readiness_id,
    workItemId: existing.work_item_id, verified: true, status: "reused",
    classification: "review_ready_reused", reason: "candidate_verification_already_ready",
    readbackAt: now,
  };
  const inserted = d1.read(`INSERT INTO review_work_items
      (work_item_id,claim_id,candidate_id,promotion_id,origin_kind,work_type,status,
       required_matching_reviews,max_reviews,created_at)
      VALUES (${sqlQuote(work.workItemId)},NULL,${sqlQuote(work.candidateId)},NULL,
       ${sqlQuote(work.originKind)},${sqlQuote(work.workType)},${sqlQuote(work.status)},
       ${work.requiredMatchingReviews},${work.maxReviews},${sqlQuote(work.createdAt)})
      ON CONFLICT(candidate_id) DO NOTHING RETURNING work_item_id;`);
  const wonInsert = inserted.length === 1 && inserted[0].work_item_id === work.workItemId;
  if (inserted.length > 1 || (inserted.length === 1 && !wonInsert)) return {
    candidateId: item.candidate_id, readinessId: item.readiness_id,
    workItemId: inserted[0]?.work_item_id || null, verified: true, status: "failed",
    classification: "insert_receipt_mismatch", reason: "candidate_work_insert_receipt_mismatch",
    readbackAt: now,
  };
  const after = workReadback(d1, item.candidate_id);
  if (Number(after?.ready_count) !== 1 || Number(after?.work_count) !== 1
      || Number(after?.ready_work_count) !== 1 || after?.work_item_id !== work.workItemId
      || Number(after?.promotion_count) !== 0) return {
    candidateId: item.candidate_id, readinessId: item.readiness_id,
    workItemId: after?.work_item_id || null, verified: true, status: "failed",
    classification: "readback_mismatch", reason: "candidate_work_readback_mismatch", readbackAt: now,
  };
  return { candidateId: item.candidate_id, readinessId: item.readiness_id,
    workItemId: work.workItemId, verified: true, status: wonInsert ? "promoted" : "reused",
    classification: wonInsert ? "review_ready" : "review_ready_reused",
    reason: wonInsert ? "candidate_verification_ready" : "candidate_verification_concurrent_reuse",
    readbackAt: now };
}

function terminalCounts(finals) {
  const verified = finals.filter((item) => item.verified).length;
  const promoted = finals.filter((item) => item.status === "promoted").length;
  const reused = finals.filter((item) => item.status === "reused").length;
  return {
    considered: finals.length,
    verified,
    classified: finals.filter((item) => !["failed", "dry_run"].includes(item.status)).length,
    promoted,
    reused,
    failed: finals.filter((item) => item.status === "failed").length,
    pendingPromotions: verified - promoted - reused,
  };
}

export async function runMachineConveyor(options = {}, dependencies = {}) {
  const nowIso = dependencies.nowIso || (() => new Date().toISOString());
  const startedAt = nowIso();
  const d1 = dependencies.d1 || makeMachineConveyorD1({ local: options.local });
  let discovered;
  try { discovered = d1.read(machineConveyorDiscoverySql(options.limit)); }
  catch {
    return { itemFinals: [], summary: { schemaVersion: 1, contract: "machine-conveyor-v1",
      status: "failed", mode: "run", runId: null, limit: options.limit,
      considered: 0, verified: 0, classified: 0, promoted: 0, reused: 0, failed: 0,
      pendingPromotions: 0, fatalCode: "discovery_failed", startedAt, completedAt: nowIso() },
    exit: { schemaVersion: 1, status: "failure", exitCode: 1 } };
  }
  const identity = JSON.stringify(discovered.map((item) => [item.candidate_id,
    item.readiness_id, item.analysis_section_id, item.transcript_sha256, item.section_sha256]));
  const preservationBefore = preservationCounts(d1);
  let itemFinals;
  if (options.dryRun) itemFinals = discovered.map((item) => ({
    candidateId: item.candidate_id, readinessId: item.readiness_id, workItemId: null,
    verified: false, status: "dry_run", classification: "review_ready",
    reason: "dry_run", readbackAt: startedAt,
  }));
  else itemFinals = discovered.map((item) => {
    try { return processCandidate(d1, item, nowIso()); }
    catch (error) { return { candidateId: item.candidate_id, readinessId: item.readiness_id,
      workItemId: null, verified: false, status: "failed", classification: "runner_error",
      reason: safeCode(error?.code || error?.message, "candidate_processing_failed"),
      readbackAt: nowIso() }; }
  });
  const totals = terminalCounts(itemFinals);
  const completedAt = nowIso();
  const idempotencySha256 = sha256(`machine-conveyor-v1:${options.limit}:${identity}:${JSON.stringify(itemFinals)}`);
  const runId = `mcr_${idempotencySha256.slice(0, 32)}`;
  const preservationAfter = preservationCounts(d1);
  const preserved = preservationAgrees(preservationBefore, preservationAfter);
  const summary = { schemaVersion: 1, contract: "machine-conveyor-v1",
    status: options.dryRun ? "dry_run" : !preserved || totals.failed || totals.pendingPromotions
      ? "failed" : discovered.length ? "completed" : "zero_work",
    mode: options.dryRun ? "dry_run" : discovered.length ? "run" : "zero_work",
    runId, idempotencySha256, limit: options.limit, ...totals,
    fatalCode: preserved ? null : "protected_state_changed", startedAt, completedAt };
  if (!options.dryRun && preserved) {
    const operationClient = dependencies.operationClient || createOperationReceiptClient({
      token: dependencies.token, adminBase: dependencies.adminBase, fetcher: dependencies.fetcher,
    });
    try { await operationClient.persistOperationReceipt("machine_conveyor", { itemFinals, summary }); }
    catch (error) {
      summary.status = "failed";
      summary.fatalCode = safeCode(error?.code || error?.message,
        "operation_receipt_persistence_failed");
    }
  }
  const failed = summary.status === "failed";
  return { itemFinals, summary,
    exit: { schemaVersion: 1, status: failed ? "failure" : "success", exitCode: failed ? 1 : 0,
      summaryStatus: summary.status } };
}

function emitTerminal(terminal) {
  for (const item of terminal.itemFinals) {
    console.log(`MACHINE_CONVEYOR_ITEM_FINAL ${JSON.stringify(item)}`);
  }
  console.log(`MACHINE_CONVEYOR_SUMMARY ${JSON.stringify(terminal.summary)}`);
  console.log(`MACHINE_CONVEYOR_EXIT ${JSON.stringify(terminal.exit)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  let terminal;
  try {
    const options = parseMachineConveyorArgs(process.argv.slice(2));
    terminal = await runMachineConveyor(options);
  } catch (error) {
    terminal = { itemFinals: [], summary: { schemaVersion: 1,
      contract: "machine-conveyor-v1", status: "failed", considered: 0,
      verified: 0, classified: 0, promoted: 0, reused: 0, failed: 0, pendingPromotions: 0,
      fatalCode: String(error?.message || "runner_start_failed").slice(0, 120) },
    exit: { schemaVersion: 1, status: "failure", exitCode: 1 } };
  }
  emitTerminal(terminal);
  process.exitCode = terminal.exit.exitCode;
}
