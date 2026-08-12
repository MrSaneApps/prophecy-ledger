const DEFAULT_ADMIN_BASE = "https://prophecy-ledger-scanner.stephanjoseph2007.workers.dev";
const OPERATION_KINDS = new Set(["analysis_reconciliation", "machine_conveyor"]);

export class OperationReceiptError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = "OperationReceiptError";
    this.code = code;
    this.cause = cause;
  }
}

function fail(code, cause = null) {
  throw new OperationReceiptError(code, cause);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function safeReason(value, fallback) {
  const code = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return code && code.length <= 120 ? code : fallback;
}

function expectedRunStatus(kind, summary) {
  if (kind === "analysis_reconciliation") {
    return summary.failed || summary.manualRequired ? "failed" : "completed";
  }
  return summary.failed || summary.pendingPromotions ? "failed" : "completed";
}

function expectedReadback(kind, summary, itemCount) {
  const common = { idempotencySha256: summary.idempotencySha256,
    status: expectedRunStatus(kind, summary), itemCount };
  return kind === "analysis_reconciliation" ? { ...common, limit: summary.limit,
    discovered: summary.discovered, completed: summary.completed,
    manualRequired: summary.manualRequired, failed: summary.failed }
    : { ...common, limit: summary.limit, considered: summary.considered,
      verified: summary.verified, classified: summary.classified,
      promoted: summary.promoted, reused: summary.reused, failed: summary.failed,
      pendingPromotions: summary.pendingPromotions };
}

export function operationReceiptIdempotencyKey(kind, summary) {
  if (!OPERATION_KINDS.has(kind) || !/^(?:arr|mcr)_[a-f0-9]{32}$/.test(summary?.runId || "")
      || !/^[a-f0-9]{64}$/.test(summary?.idempotencySha256 || "")) {
    fail("operation_receipt_identity_invalid");
  }
  return `operation-receipt/${kind}/${summary.runId}/${summary.idempotencySha256}`;
}

export function validateOperationReceipt(receipt, { kind, summary, itemFinals }) {
  const keys = ["schemaVersion", "contract", "terminal", "persisted", "reused", "kind",
    "runId", "itemCount", "readback"];
  if (!exactKeys(receipt, keys) || receipt.schemaVersion !== 1
      || receipt.contract !== "operation-receipt-persistence-v1" || receipt.terminal !== true
      || receipt.persisted !== true || typeof receipt.reused !== "boolean"
      || receipt.kind !== kind || receipt.runId !== summary.runId
      || receipt.itemCount !== itemFinals.length) fail("operation_receipt_invalid");
  const expected = expectedReadback(kind, summary, itemFinals.length);
  if (!exactKeys(receipt.readback, Object.keys(expected))) fail("operation_receipt_readback_invalid");
  for (const [key, value] of Object.entries(expected)) {
    if (receipt.readback[key] !== value) fail("operation_receipt_readback_mismatch");
  }
  return receipt;
}

export function validateSectionStatuses(receipt, analysisSectionIds) {
  if (!exactKeys(receipt, ["schemaVersion", "contract", "terminal", "sections"])
      || receipt.schemaVersion !== 1 || receipt.contract !== "analysis-section-statuses-v1"
      || receipt.terminal !== true || !Array.isArray(receipt.sections)
      || receipt.sections.length !== analysisSectionIds.length) fail("section_status_receipt_invalid");
  const rowKeys = ["analysisSectionId", "status", "errorCode", "attemptCount", "completedAt",
    "jobId", "jobStatus", "jobAttemptCount", "jobErrorCode"];
  for (let index = 0; index < analysisSectionIds.length; index += 1) {
    const row = receipt.sections[index];
    if (!exactKeys(row, rowKeys) || row.analysisSectionId !== analysisSectionIds[index]
        || !["queued", "processing", "completed", "failed"].includes(row.status)
        || !["queued", "processing", "completed", "failed"].includes(row.jobStatus)
        || !integer(row.attemptCount) || !integer(row.jobAttemptCount)
        || typeof row.jobId !== "string" || !row.jobId
        || (row.errorCode !== null && typeof row.errorCode !== "string")
        || (row.jobErrorCode !== null && typeof row.jobErrorCode !== "string")
        || (row.completedAt !== null && typeof row.completedAt !== "string")) {
      fail("section_status_receipt_invalid");
    }
  }
  return receipt.sections;
}

export function validateStaleSectionReceipt(receipt, item) {
  const required = ["schemaVersion", "contract", "sourceAnalysisSectionId",
    "expectedAttemptCount", "sourcePromptVersion", "targetPromptVersion", "successorAnalysisRunId",
    "successorAnalysisSectionId", "successorJobId", "successorStatus", "terminal",
    "successorAttemptCount", "dispositionId", "manualRequired", "dispatched", "reused",
    "reason", "observedAt", "actionId", "idempotencyKeySha256"];
  const nullableRef = (value, pattern) => value === null || pattern.test(value || "");
  if (!exactKeys(receipt, required) || receipt.schemaVersion !== 1
      || receipt.contract !== "analysis-stale-section-reconciliation-v1"
      || receipt.sourceAnalysisSectionId !== item.analysis_section_id
      || receipt.expectedAttemptCount !== Number(item.attempt_count)
      || receipt.sourcePromptVersion !== item.source_prompt_version
      || receipt.targetPromptVersion !== item.target_prompt_version
      || !/^asx_[a-f0-9]{32}$/.test(receipt.actionId || "")
      || !/^[a-f0-9]{64}$/.test(receipt.idempotencyKeySha256 || "")
      || !nullableRef(receipt.successorAnalysisRunId, /^txan_[a-f0-9]{32}$/)
      || !nullableRef(receipt.successorAnalysisSectionId, /^txas_[a-f0-9]{32}$/)
      || !nullableRef(receipt.successorJobId, /^job_[a-f0-9]{32}$/)
      || !nullableRef(receipt.dispositionId, /^asdp_[a-f0-9]{32}$/)
      || ![null, "queued", "processing", "completed", "failed"].includes(receipt.successorStatus)
      || !integer(receipt.successorAttemptCount)
      || typeof receipt.terminal !== "boolean" || typeof receipt.manualRequired !== "boolean"
      || typeof receipt.dispatched !== "boolean" || typeof receipt.reused !== "boolean"
      || (receipt.reason !== null && typeof receipt.reason !== "string")
      || typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt))) {
    fail("stale_section_receipt_invalid");
  }
  if (receipt.terminal && !receipt.manualRequired
      && (!receipt.successorAnalysisRunId || !receipt.successorAnalysisSectionId
        || !receipt.successorJobId || !receipt.dispositionId
        || receipt.successorStatus !== "completed"
        || receipt.reason !== "historical_section_superseded")) {
    fail("stale_section_receipt_invalid");
  }
  return receipt;
}

export function validateSectionLineages(receipt, analysisSectionIds) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.contract !== "analysis-section-lineages-v1"
      || receipt.terminal !== true || !Array.isArray(receipt.lineages)
      || receipt.lineages.length !== analysisSectionIds.length) fail("section_lineage_receipt_invalid");
  for (let index = 0; index < analysisSectionIds.length; index += 1) {
    const row = receipt.lineages[index];
    if (!row || row.analysisSectionId !== analysisSectionIds[index]
        || typeof row.debtState !== "string") fail("section_lineage_receipt_invalid");
  }
  return receipt.lineages;
}

async function postAction(body, { token, adminBase, fetcher, idempotencyKey = null,
  timeoutMs = 30_000 }) {
  if (!token) fail("scanner_admin_token_missing");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let response;
  try {
    response = await fetcher(`${adminBase}/admin/transcript-analysis`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, timeoutMs))),
    });
  } catch (cause) { fail("operation_admin_request_failed", cause); }
  const receipt = await response.json().catch(() => null);
  if (!receipt) fail(response.ok ? "operation_admin_non_json_receipt" :
    `operation_admin_http_${response.status}_non_json`);
  if (!response.ok) fail(safeReason(receipt.reason || receipt.error,
    `operation_admin_http_${response.status}`));
  return receipt;
}

export function createOperationReceiptClient({
  token = process.env.SCANNER_ADMIN_TOKEN,
  adminBase = process.env.SCANNER_ADMIN_BASE || DEFAULT_ADMIN_BASE,
  fetcher = fetch,
} = {}) {
  return {
    async reprocessSection(item, { idempotencyKey, timeoutMs = 30_000 } = {}) {
      const receipt = await postAction({ action: "reprocess_section",
        analysisSectionId: item.analysis_section_id,
        expectedAttemptCount: Number(item.attempt_count) }, {
        token, adminBase, fetcher, idempotencyKey, timeoutMs,
      });
      if (receipt?.contract !== "analysis-section-reprocess-v1"
          || receipt.analysisSectionId !== item.analysis_section_id
          || receipt.jobId !== item.job_id || receipt.dispatched !== true) {
        fail("section_reprocess_receipt_invalid");
      }
      return receipt;
    },
    async reconcileStaleSection(item, { idempotencyKey, timeoutMs = 30_000 } = {}) {
      const receipt = await postAction({ action: "reconcile_stale_section",
        analysisSectionId: item.analysis_section_id,
        expectedAttemptCount: Number(item.attempt_count) }, {
        token, adminBase, fetcher, idempotencyKey, timeoutMs,
      });
      return validateStaleSectionReceipt(receipt, item);
    },
    async persistOperationReceipt(kind, terminal, { timeoutMs = 30_000 } = {}) {
      if (!OPERATION_KINDS.has(kind) || !terminal?.summary || !Array.isArray(terminal.itemFinals)) {
        fail("operation_receipt_payload_invalid");
      }
      const idempotencyKey = operationReceiptIdempotencyKey(kind, terminal.summary);
      const receipt = await postAction({ action: "persist_operation_receipt", kind,
        summary: terminal.summary, itemFinals: terminal.itemFinals }, {
        token, adminBase, fetcher, idempotencyKey, timeoutMs,
      });
      return validateOperationReceipt(receipt, { kind, summary: terminal.summary,
        itemFinals: terminal.itemFinals });
    },
    async readSectionStatuses(analysisSectionIds, { timeoutMs = 30_000 } = {}) {
      if (!Array.isArray(analysisSectionIds) || analysisSectionIds.length < 1
          || analysisSectionIds.length > 25 || new Set(analysisSectionIds).size !== analysisSectionIds.length
          || analysisSectionIds.some((id) => !/^txas_[a-f0-9]{32}$/.test(id))) {
        fail("section_status_request_invalid");
      }
      const receipt = await postAction({ action: "read_section_statuses", analysisSectionIds }, {
        token, adminBase, fetcher, timeoutMs,
      });
      return validateSectionStatuses(receipt, analysisSectionIds);
    },
    async readSectionLineages(analysisSectionIds, { timeoutMs = 30_000 } = {}) {
      if (!Array.isArray(analysisSectionIds) || analysisSectionIds.length < 1
          || analysisSectionIds.length > 25 || new Set(analysisSectionIds).size !== analysisSectionIds.length
          || analysisSectionIds.some((id) => !/^txas_[a-f0-9]{32}$/.test(id))) {
        fail("section_lineage_request_invalid");
      }
      const receipt = await postAction({ action: "read_section_lineages", analysisSectionIds }, {
        token, adminBase, fetcher, timeoutMs,
      });
      return validateSectionLineages(receipt, analysisSectionIds);
    },
  };
}
