import { stableId } from "./hash.js";

const SAFE_REF = /^[A-Za-z0-9_-]{3,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[a-z0-9_-]{1,120}$/;
const ANALYSIS_OUTCOMES = new Set(["completed", "manual_required", "failed"]);
const CONVEYOR_OUTCOMES = new Set(["promoted", "reused", "skipped", "failed"]);
const CONVEYOR_CLASSIFICATIONS = new Set([
  "review_ready", "review_ready_reused", "binding_changed", "already_promoted",
  "work_item_conflict", "readback_mismatch", "insert_receipt_mismatch", "runner_error",
]);

function invalid(code, status = 400) {
  const error = new Error(code); error.code = code; error.status = status; return error;
}
function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(code);
}
function exactKeys(value, keys, code) {
  object(value, code);
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw invalid(code);
}
function integer(value, min, max, code) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(code);
}
function reference(value, code, nullable = false) {
  if (nullable && value === null) return;
  if (!SAFE_REF.test(value || "")) throw invalid(code);
}
function timestamp(value, code, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
      !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) throw invalid(code);
}
function validateHeader(kind, summary, idempotencyKey) {
  const expected = `operation-receipt/${kind}/${summary.runId}/${summary.idempotencySha256}`;
  if (idempotencyKey !== expected) throw invalid("invalid_operation_idempotency_key");
}

function validateAnalysis(summary, items) {
  exactKeys(summary, ["schemaVersion", "contract", "status", "mode", "runId",
    "idempotencySha256", "limit", "discovered", "completed", "manualRequired",
    "failed", "pending", "fatalCode", "startedAt", "completedAt"], "invalid_analysis_summary");
  if (summary.schemaVersion !== 1 || summary.contract !== "analysis-reconciliation-v1" ||
      !["run", "zero_work"].includes(summary.mode) || summary.fatalCode !== null ||
      summary.pending !== 0 || !SHA256.test(summary.idempotencySha256 || "") ||
      summary.runId !== `arr_${summary.idempotencySha256.slice(0, 32)}`) {
    throw invalid("invalid_analysis_summary");
  }
  integer(summary.limit, 1, 25, "invalid_analysis_summary");
  for (const name of ["discovered", "completed", "manualRequired", "failed"]) {
    integer(summary[name], 0, 25, "invalid_analysis_summary");
  }
  if (summary.completed + summary.manualRequired + summary.failed !== summary.discovered ||
      summary.discovered !== items.length) throw invalid("analysis_summary_count_mismatch");
  const expectedStatus = summary.failed ? "failed" : summary.manualRequired ? "manual_required" :
    summary.discovered ? "completed" : "zero_work";
  if (summary.status !== expectedStatus) throw invalid("invalid_analysis_summary_status");
  timestamp(summary.startedAt, "invalid_analysis_summary");
  timestamp(summary.completedAt, "invalid_analysis_summary");
  const seen = new Set();
  for (const item of items) {
    const legacyKeys = ["analysisSectionId", "jobId", "status", "reason", "beforeStatus",
      "afterStatus", "readbackAt"];
    const lineageKeys = [...legacyKeys, "sourcePromptVersion", "targetPromptVersion",
      "successorAnalysisRunId", "successorAnalysisSectionId", "successorJobId", "dispositionId"];
    object(item, "invalid_analysis_item");
    const keys = Object.keys(item).sort().join(",");
    if (![legacyKeys, lineageKeys].some((candidate) => [...candidate].sort().join(",") === keys)) {
      throw invalid("invalid_analysis_item");
    }
    if (!/^txas_[a-f0-9]{32}$/.test(item.analysisSectionId || "") ||
        (item.jobId !== null && !/^job_[a-f0-9]{32}$/.test(item.jobId || "")) ||
        !ANALYSIS_OUTCOMES.has(item.status) || !SAFE_CODE.test(item.reason || "") ||
        item.beforeStatus !== "failed" ||
        !["queued", "processing", "completed", "failed", null].includes(item.afterStatus)) {
      throw invalid("invalid_analysis_item");
    }
    if (lineageKeys.every((key) => Object.hasOwn(item, key))) {
      for (const name of ["sourcePromptVersion", "targetPromptVersion"]) {
        if (item[name] !== null && !SAFE_REF.test(item[name] || "")) throw invalid("invalid_analysis_item");
      }
      for (const [name, pattern] of [["successorAnalysisRunId", /^txan_[a-f0-9]{32}$/],
        ["successorAnalysisSectionId", /^txas_[a-f0-9]{32}$/],
        ["successorJobId", /^job_[a-f0-9]{32}$/], ["dispositionId", SAFE_REF]]) {
        if (item[name] !== null && !pattern.test(item[name] || "")) throw invalid("invalid_analysis_item");
      }
      if (item.reason === "historical_section_superseded" &&
          ["sourcePromptVersion", "targetPromptVersion", "successorAnalysisRunId",
            "successorAnalysisSectionId", "successorJobId", "dispositionId"]
            .some((name) => item[name] === null)) throw invalid("analysis_successor_binding_missing");
    } else if (item.reason === "historical_section_superseded") {
      throw invalid("analysis_successor_binding_missing");
    }
    timestamp(item.readbackAt, "invalid_analysis_item", true);
    if (seen.has(item.analysisSectionId)) throw invalid("duplicate_analysis_item");
    seen.add(item.analysisSectionId);
  }
  const count = (status) => items.filter((item) => item.status === status).length;
  if (count("completed") !== summary.completed ||
      count("manual_required") !== summary.manualRequired ||
      count("failed") !== summary.failed) throw invalid("analysis_item_count_mismatch");
}

function validateConveyor(summary, items) {
  exactKeys(summary, ["schemaVersion", "contract", "status", "mode", "runId",
    "idempotencySha256", "limit", "considered", "verified", "classified", "promoted",
    "reused", "failed", "pendingPromotions", "fatalCode", "startedAt", "completedAt"],
  "invalid_conveyor_summary");
  if (summary.schemaVersion !== 1 || summary.contract !== "machine-conveyor-v1" ||
      !["run", "zero_work"].includes(summary.mode) || summary.fatalCode !== null ||
      !SHA256.test(summary.idempotencySha256 || "") ||
      summary.runId !== `mcr_${summary.idempotencySha256.slice(0, 32)}`) {
    throw invalid("invalid_conveyor_summary");
  }
  integer(summary.limit, 1, 25, "invalid_conveyor_summary");
  for (const name of ["considered", "verified", "classified", "promoted", "reused",
    "failed", "pendingPromotions"]) integer(summary[name], 0, 25, "invalid_conveyor_summary");
  if (summary.considered !== items.length ||
      summary.classified + summary.failed !== summary.considered ||
      summary.promoted + summary.reused > summary.verified ||
      summary.pendingPromotions !== summary.verified - summary.promoted - summary.reused) {
    throw invalid("conveyor_summary_count_mismatch");
  }
  const expectedStatus = summary.failed || summary.pendingPromotions ? "failed" :
    summary.considered ? "completed" : "zero_work";
  if (summary.status !== expectedStatus) throw invalid("invalid_conveyor_summary_status");
  timestamp(summary.startedAt, "invalid_conveyor_summary");
  timestamp(summary.completedAt, "invalid_conveyor_summary");
  const seen = new Set();
  for (const item of items) {
    exactKeys(item, ["candidateId", "readinessId", "workItemId", "verified", "status",
      "classification", "reason", "readbackAt"], "invalid_conveyor_item");
    reference(item.candidateId, "invalid_conveyor_item");
    reference(item.readinessId, "invalid_conveyor_item", true);
    reference(item.workItemId, "invalid_conveyor_item", true);
    if (typeof item.verified !== "boolean" || !CONVEYOR_OUTCOMES.has(item.status) ||
        !CONVEYOR_CLASSIFICATIONS.has(item.classification) ||
        !SAFE_CODE.test(item.reason || "") ||
        (["promoted", "reused"].includes(item.status) &&
          (!item.verified || item.workItemId === null))) throw invalid("invalid_conveyor_item");
    timestamp(item.readbackAt, "invalid_conveyor_item", true);
    if (seen.has(item.candidateId)) throw invalid("duplicate_conveyor_item");
    seen.add(item.candidateId);
  }
  const count = (predicate) => items.filter(predicate).length;
  if (count((item) => item.verified) !== summary.verified ||
      count((item) => item.status !== "failed") !== summary.classified ||
      count((item) => item.status === "promoted") !== summary.promoted ||
      count((item) => item.status === "reused") !== summary.reused ||
      count((item) => item.status === "failed") !== summary.failed ||
      count((item) => item.verified && !["promoted", "reused"].includes(item.status)) !==
        summary.pendingPromotions) throw invalid("conveyor_item_count_mismatch");
}

function analysisStatements(db, summary, items) {
  const statements = items.map((item) => db.prepare(`INSERT OR IGNORE INTO
      analysis_reconciliation_item_receipts
      (item_receipt_id,run_id,analysis_section_id,job_id,outcome,safe_reason_code,
       before_status,after_status,readback_at,created_at,source_prompt_version,
       target_prompt_version,successor_analysis_run_id,successor_analysis_section_id,
       successor_job_id,disposition_id)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`)
    .bind(item.itemReceiptId, summary.runId, item.analysisSectionId, item.jobId, item.status,
      item.reason, item.beforeStatus, item.afterStatus, item.readbackAt, summary.completedAt,
      item.sourcePromptVersion ?? null, item.targetPromptVersion ?? null,
      item.successorAnalysisRunId ?? null, item.successorAnalysisSectionId ?? null,
      item.successorJobId ?? null, item.dispositionId ?? null));
  statements.push(db.prepare(`INSERT OR IGNORE INTO analysis_reconciliation_runs
      (run_id,idempotency_sha256,limit_count,discovered_count,completed_count,
       manual_required_count,failed_count,status,started_at,completed_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
    .bind(summary.runId, summary.idempotencySha256, summary.limit, summary.discovered,
      summary.completed, summary.manualRequired, summary.failed,
      summary.failed || summary.manualRequired ? "failed" : "completed",
      summary.startedAt, summary.completedAt));
  return statements;
}

function conveyorStatements(db, summary, items) {
  const statements = items.map((item) => db.prepare(`INSERT OR IGNORE INTO
      machine_conveyor_item_receipts
      (item_receipt_id,run_id,candidate_id,readiness_id,work_item_id,verified,
       classification,outcome,safe_reason_code,readback_at,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
    .bind(item.itemReceiptId, summary.runId, item.candidateId, item.readinessId,
      item.workItemId, item.verified ? 1 : 0, item.classification, item.status,
      item.reason, item.readbackAt, summary.completedAt));
  statements.push(db.prepare(`INSERT OR IGNORE INTO machine_conveyor_runs
      (run_id,idempotency_sha256,limit_count,considered_count,verified_count,
       classified_count,promoted_count,reused_count,failed_count,pending_promotions_count,
       status,started_at,completed_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`)
    .bind(summary.runId, summary.idempotencySha256, summary.limit, summary.considered,
      summary.verified, summary.classified, summary.promoted, summary.reused, summary.failed,
      summary.pendingPromotions, summary.failed || summary.pendingPromotions ? "failed" : "completed",
      summary.startedAt, summary.completedAt));
  return statements;
}

async function receiptReadback(db, kind, runId) {
  const analysis = kind === "analysis_reconciliation";
  const row = await db.prepare(analysis ? `SELECT idempotency_sha256,limit_count,
      discovered_count,completed_count,manual_required_count,failed_count,status,
      (SELECT COUNT(*) FROM analysis_reconciliation_item_receipts item
       WHERE item.run_id=run.run_id) item_count
    FROM analysis_reconciliation_runs run WHERE run_id=?1` : `SELECT idempotency_sha256,
      limit_count,considered_count,verified_count,classified_count,promoted_count,reused_count,
      failed_count,pending_promotions_count,status,
      (SELECT COUNT(*) FROM machine_conveyor_item_receipts item
       WHERE item.run_id=run.run_id) item_count
    FROM machine_conveyor_runs run WHERE run_id=?1`).bind(runId).first();
  if (!row) throw invalid("operation_receipt_readback_missing", 409);
  return analysis ? {
    idempotencySha256: row.idempotency_sha256, limit: Number(row.limit_count),
    discovered: Number(row.discovered_count), completed: Number(row.completed_count),
    manualRequired: Number(row.manual_required_count), failed: Number(row.failed_count),
    status: row.status, itemCount: Number(row.item_count),
  } : {
    idempotencySha256: row.idempotency_sha256, limit: Number(row.limit_count),
    considered: Number(row.considered_count), verified: Number(row.verified_count),
    classified: Number(row.classified_count), promoted: Number(row.promoted_count),
    reused: Number(row.reused_count), failed: Number(row.failed_count),
    pendingPromotions: Number(row.pending_promotions_count), status: row.status,
    itemCount: Number(row.item_count),
  };
}

async function itemReceiptReadback(db, kind, runId) {
  const analysis = kind === "analysis_reconciliation";
  const rows = await db.prepare(analysis ? `SELECT item_receipt_id,analysis_section_id,job_id,
      outcome,safe_reason_code,before_status,after_status,readback_at,source_prompt_version,
      target_prompt_version,successor_analysis_run_id,successor_analysis_section_id,
      successor_job_id,disposition_id
    FROM analysis_reconciliation_item_receipts WHERE run_id=?1
    ORDER BY analysis_section_id` : `SELECT item_receipt_id,candidate_id,readiness_id,
      work_item_id,verified,classification,outcome,safe_reason_code,readback_at
    FROM machine_conveyor_item_receipts WHERE run_id=?1
    ORDER BY candidate_id`).bind(runId).all();
  return (rows.results || []).map((row) => analysis ? {
    itemReceiptId: row.item_receipt_id, analysisSectionId: row.analysis_section_id,
    jobId: row.job_id, status: row.outcome, reason: row.safe_reason_code,
    beforeStatus: row.before_status, afterStatus: row.after_status,
    readbackAt: row.readback_at, sourcePromptVersion: row.source_prompt_version,
    targetPromptVersion: row.target_prompt_version,
    successorAnalysisRunId: row.successor_analysis_run_id,
    successorAnalysisSectionId: row.successor_analysis_section_id,
    successorJobId: row.successor_job_id, dispositionId: row.disposition_id,
  } : {
    itemReceiptId: row.item_receipt_id, candidateId: row.candidate_id,
    readinessId: row.readiness_id, workItemId: row.work_item_id,
    verified: Number(row.verified) === 1, status: row.outcome,
    classification: row.classification, reason: row.safe_reason_code,
    readbackAt: row.readback_at,
  });
}

export async function persistOperationReceipt(env, { kind, summary, itemFinals,
  idempotencyKey } = {}) {
  if (!["analysis_reconciliation", "machine_conveyor"].includes(kind) ||
      !Array.isArray(itemFinals) || itemFinals.length > 25) {
    throw invalid("invalid_operation_receipt");
  }
  object(summary, "invalid_operation_receipt");
  validateHeader(kind, summary, idempotencyKey);
  if (kind === "analysis_reconciliation") validateAnalysis(summary, itemFinals);
  else validateConveyor(summary, itemFinals);
  const items = await Promise.all(itemFinals.map(async (item) => ({
    ...item, itemReceiptId: await stableId(kind === "analysis_reconciliation" ? "ari" : "mci",
      `${summary.runId}:${kind === "analysis_reconciliation" ?
        item.analysisSectionId : item.candidateId}`),
  })));
  const statements = kind === "analysis_reconciliation" ?
    analysisStatements(env.DB, summary, items) : conveyorStatements(env.DB, summary, items);
  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some((result) => result?.success === false)) {
    throw invalid("operation_receipt_batch_mismatch", 409);
  }
  const readback = await receiptReadback(env.DB, kind, summary.runId);
  const expected = kind === "analysis_reconciliation" ? {
    idempotencySha256: summary.idempotencySha256, limit: summary.limit,
    discovered: summary.discovered, completed: summary.completed,
    manualRequired: summary.manualRequired, failed: summary.failed,
    status: summary.failed || summary.manualRequired ? "failed" : "completed",
    itemCount: summary.discovered,
  } : {
    idempotencySha256: summary.idempotencySha256, limit: summary.limit,
    considered: summary.considered, verified: summary.verified, classified: summary.classified,
    promoted: summary.promoted, reused: summary.reused, failed: summary.failed,
    pendingPromotions: summary.pendingPromotions,
    status: summary.failed || summary.pendingPromotions ? "failed" : "completed",
    itemCount: summary.considered,
  };
  if (JSON.stringify(readback) !== JSON.stringify(expected)) {
    throw invalid("operation_receipt_readback_mismatch", 409);
  }
  const storedItems = await itemReceiptReadback(env.DB, kind, summary.runId);
  const expectedItems = [...items].sort((left, right) =>
    String(kind === "analysis_reconciliation" ? left.analysisSectionId : left.candidateId)
      .localeCompare(String(kind === "analysis_reconciliation" ?
        right.analysisSectionId : right.candidateId))).map((item) =>
    kind === "analysis_reconciliation" ? {
      itemReceiptId: item.itemReceiptId, analysisSectionId: item.analysisSectionId,
      jobId: item.jobId, status: item.status, reason: item.reason,
      beforeStatus: item.beforeStatus, afterStatus: item.afterStatus,
      readbackAt: item.readbackAt, sourcePromptVersion: item.sourcePromptVersion ?? null,
      targetPromptVersion: item.targetPromptVersion ?? null,
      successorAnalysisRunId: item.successorAnalysisRunId ?? null,
      successorAnalysisSectionId: item.successorAnalysisSectionId ?? null,
      successorJobId: item.successorJobId ?? null, dispositionId: item.dispositionId ?? null,
    } : {
      itemReceiptId: item.itemReceiptId, candidateId: item.candidateId,
      readinessId: item.readinessId, workItemId: item.workItemId,
      verified: item.verified, status: item.status,
      classification: item.classification, reason: item.reason,
      readbackAt: item.readbackAt,
    });
  if (JSON.stringify(storedItems) !== JSON.stringify(expectedItems)) {
    throw invalid("operation_receipt_item_readback_mismatch", 409);
  }
  const changes = Number(results.at(-1)?.meta?.changes || 0);
  if (![0, 1].includes(changes)) throw invalid("operation_receipt_batch_mismatch", 409);
  return { schemaVersion: 1, contract: "operation-receipt-persistence-v1",
    terminal: true, persisted: true, reused: changes === 0, kind,
    runId: summary.runId, itemCount: itemFinals.length, readback };
}
