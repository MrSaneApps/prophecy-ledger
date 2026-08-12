#!/usr/bin/env node
/**
 * Prophecy Ledger transcript-batch watchdog.
 * - Snapshots completed/pending/media-used
 * - Repairs a running batch via scanner admin start-reuse when leases look stale
 * - Auto-heals paused terminal/retry-exhausted batches (skip one failed active item + resume)
 * - Auto-quarantines one pristine source-unavailable item through the canonical fenced operator
 * - Auto-resumes daily_media_cap / gemini_429 when resume_after is past (never silent-stall after budget reset)
 * - Emails the owner on stall / unrecoverable pause / terminal failure (Resend)
 * Never prints secrets.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analysisDebtCausesSql, analysisDebtSummarySql, classifyResendDelivery,
  currentAcquisitionSql, formatIncidentNotice, hoursBetween,
  incidentEventId, incidentFingerprint, incidentIdFor, noticeDeliveryDisposition,
  isExpectedFuseIncident, noticeEventType, noticeIdempotencyKey,
  persistentNoticeFailureErrors, physicalMediaSql,
  planIncidentLifecycle, prepareQuarantineOperatorRequest, reconcileAcquisitionFailures,
  safeCode, snapshotHash, sqlLiteral,
  validateAnalysisDebtMetrics, validateDailyAction, validateOperationsStatus,
  validateQuarantineReceipt,
} from "./batch-watchdog-core.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT_DIR = join(ROOT, "outputs", "batch-watchdog");
const STATE_PATH = join(OUT_DIR, "state.json");
const BASE = "https://prophecy-ledger-scanner.stephanjoseph2007.workers.dev";
const ALERT_TO = process.env.PROPHECY_ALERT_TO || "stephanjoseph2007@gmail.com";
const ALERT_FROM = process.env.PROPHECY_ALERT_FROM || "Prophecy Ledger Ops <hi@saneapps.com>";
const STALL_HOURS = Number(process.env.PROPHECY_STALL_HOURS || 20);
const DRY_RUN = process.argv.includes("--dry-run");
const QUARANTINE_MODE = process.argv.includes("--quarantine-pending-item");
const MEDIA_BUDGET_SECONDS = 86400;

function loadEnvFile() {
  // Caller should already have sourced nv/env; keep a tiny fallback for cron.
  return;
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: ROOT,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
    ...opts,
  });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").slice(0, 500);
    throw new Error(`${cmd} ${args.join(" ")} failed: ${err}`);
  }
  return res.stdout;
}

function d1(sql) {
  const out = sh("npx", [
    "wrangler", "d1", "execute", "prophecy-ledger",
    "--remote", "--json", "--command", sql,
  ]);
  const parsed = JSON.parse(out);
  return parsed[0]?.results || [];
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function admin(path, { method = "GET", body = null, idempotencyKey = null } = {}) {
  const token = process.env.SCANNER_ADMIN_TOKEN;
  if (!token) throw new Error("SCANNER_ADMIN_TOKEN missing");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = spawnSync("curl", [
    "-sS", "-X", method,
    ...Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
    ...(body ? ["--data-binary", JSON.stringify(body)] : []),
    `${BASE}${path}`,
  ], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`curl failed: ${(res.stderr || "").slice(0, 300)}`);
  return JSON.parse(res.stdout || "{}");
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); }
  catch { return null; }
}

function writeState(state, io = {}) {
  const outputDir = io.outputDir || OUT_DIR;
  const statePath = io.statePath || STATE_PATH;
  const makeDirectory = io.mkdirSync || mkdirSync;
  const writeFile = io.writeFileSync || writeFileSync;
  makeDirectory(outputDir, { recursive: true });
  writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
}

function sendAlert({ subject, text, idempotencyKey }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  if (DRY_RUN) {
    return { dryRun: true, subject, idempotencyKey, textPreview: text.slice(0, 240) };
  }
  const payload = {
    from: ALERT_FROM,
    to: [ALERT_TO],
    subject,
    text,
  };
  const res = spawnSync("curl", [
    "-sS", "-X", "POST",
    "-H", `Authorization: Bearer ${key}`,
    "-H", "content-type: application/json",
    "-H", `Idempotency-Key: ${idempotencyKey}`,
    "--data-binary", JSON.stringify(payload),
    "https://api.resend.com/emails",
  ], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`resend curl failed: ${(res.stderr || "").slice(0, 300)}`);
  const body = JSON.parse(res.stdout || "{}");
  if (!body.id && body.message) throw new Error(`resend error: ${body.message}`);
  return { id: body.id, subject };
}

function retrieveAlertDelivery(providerMessageId) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY missing");
  const id = String(providerMessageId || "");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("invalid_provider_message_id");
  const res = spawnSync("curl", ["-sS", "-H", `Authorization: Bearer ${key}`,
    `https://api.resend.com/emails/${id}`], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`resend readback failed: ${(res.stderr || "").slice(0, 300)}`);
  const body = JSON.parse(res.stdout || "{}");
  if (body.message && !body.last_event) throw new Error("resend_delivery_readback_rejected");
  return classifyResendDelivery(body.last_event);
}

function currentAcquisitionRows(batchId) {
  return batchId ? d1(currentAcquisitionSql(batchId)) : [];
}

function operationsStatusNow() {
  try {
    return admin("/admin/operations-status");
  } catch {
    return { schemaVersion: 1, contract: "queue-operations-status-v1", healthy: false,
      queues: [], safeReasonCode: "queue_metrics_unavailable" };
  }
}

function analysisDebtNow() {
  const total = d1(analysisDebtSummarySql())[0] || {};
  const causes = d1(analysisDebtCausesSql());
  return { failedSections: Number(total.failed_sections || 0),
    failedVideos: Number(total.failed_videos || 0),
    activeSections: Number(total.active_sections || 0),
    activeVideos: Number(total.active_videos || 0),
    inProgressSections: Number(total.in_progress_sections || 0),
    inProgressVideos: Number(total.in_progress_videos || 0),
    manualSections: Number(total.manual_sections || 0),
    manualVideos: Number(total.manual_videos || 0),
    supersededSections: Number(total.superseded_sections || 0),
    supersededVideos: Number(total.superseded_videos || 0),
    debtStateCounts: {
      successor_required: Number(total.successor_required_count || 0),
      successor_pending: Number(total.successor_pending_count || 0),
      successor_retryable: Number(total.successor_retryable_count || 0),
      finalization_pending: Number(total.finalization_pending_count || 0),
      current_retryable: Number(total.current_retryable_count || 0),
      manual_required: Number(total.manual_required_count || 0),
      superseded: Number(total.superseded_count || 0),
    },
    safeCauseCounts: Object.fromEntries(causes.map((row) =>
      [row.safe_cause_code || "unknown_analysis_failure", Number(row.count || 0)])) };
}

function effectiveDispositionCountsSql(batchSql) {
  return `SELECT effective_status AS status,COUNT(*) AS n FROM (
    SELECT CASE WHEN item.status='pending' AND disposition.batch_item_id IS NOT NULL
      THEN 'quarantined' ELSE item.status END AS effective_status
    FROM transcript_batch_items item
    LEFT JOIN effective_transcript_batch_item_dispositions disposition
      ON disposition.batch_item_id=item.batch_item_id
    WHERE item.batch_id=${batchSql}
  ) effective_items GROUP BY effective_status`;
}

function snapshotNow() {
  const batchRows = d1(`SELECT batch_id, idempotency_key, status, pause_reason, resume_after,
    transition_count,
    completed_item_count, item_count, started_at, paused_at, completed_at
    FROM transcript_batches ORDER BY created_at DESC LIMIT 1`);
  const batch = batchRows[0] || null;
  const batchId = batch?.batch_id;
  const quotedBatchId = batchId ? sqlLiteral(batchId, /^txb_[a-f0-9]{32}$/, "batch_id") : null;
  const dispositionView = d1(`SELECT 1 ok FROM sqlite_master
    WHERE type='view' AND name='effective_transcript_batch_item_dispositions'`)[0]?.ok === 1;
  const counts = batchId ? d1(dispositionView ? effectiveDispositionCountsSql(quotedBatchId)
    : `SELECT status,COUNT(*) AS n
    FROM transcript_batch_items WHERE batch_id=${quotedBatchId} GROUP BY status`) : [];
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const today = new Date().toISOString().slice(0, 10);
  const media = d1(physicalMediaSql(today))[0] || { request_seconds: 0, debit_seconds: 0 };
  const requestSeconds = Number(media.request_seconds || 0);
  const debitSeconds = Number(media.debit_seconds || 0);
  const active = batchId ? d1(`SELECT batch_item_id, youtube_id, duration_seconds, started_at,
    last_job_dispatched_at, dispatch_state FROM transcript_batch_items
    WHERE batch_id=${quotedBatchId} AND status='active' LIMIT 1`)[0] || null : null;
  const quarantineTarget = batchId && batch?.status === "paused" ? d1(`WITH latest_pause AS (
      SELECT batch_item_id FROM transcript_batch_events
      WHERE batch_id=${quotedBatchId} AND event_type='batch_paused'
      ORDER BY created_at DESC,event_id DESC LIMIT 1
    )
    SELECT pause.batch_item_id latest_pause_batch_item_id,item.batch_item_id,item.source_item_id,
      item.youtube_id,item.status,item.run_id,item.duration_seconds,item.started_at,item.completed_at,
      (SELECT COUNT(*) FROM transcript_artifacts artifact
        WHERE artifact.source_item_id=item.source_item_id) artifact_count
    FROM latest_pause pause
    JOIN transcript_batch_items item ON item.batch_id=${quotedBatchId}
      AND item.batch_item_id=pause.batch_item_id`)[0] || null : null;
  const acquisitionFailures = reconcileAcquisitionFailures(currentAcquisitionRows(batchId));
  return {
    at: new Date().toISOString(),
    batch,
    byStatus,
    mediaToday: { day: today, used: requestSeconds + debitSeconds,
      requestSeconds, debitSeconds, budget: MEDIA_BUDGET_SECONDS },
    active, quarantineTarget,
    acquisitionFailures,
    analysisDebt: analysisDebtNow(),
    queueMetrics: operationsStatusNow(),
  };
}

function evaluate(prev, cur) {
  const alerts = [];
  const actions = [];
  if (!cur.batch) {
    alerts.push({ level: "warn", code: "no_batch", detail: "No transcript batch row found." });
    return { alerts, actions, healthy: false, progressed: false };
  }
  const done = cur.batch.status === "completed";
  if (cur.batch.status === "paused") {
    const reason = String(cur.batch.pause_reason || "");
    const resumeAfter = cur.batch.resume_after ? Date.parse(cur.batch.resume_after) : 0;
    const resumeReady = !cur.batch.resume_after || (Number.isFinite(resumeAfter) && resumeAfter <= Date.now());
    // skip abandons a poisoned active item; resume retries the same paused batch after a fuse/backoff.
    const skipHealable = /transcript_terminal_error|transcript_retry_exhausted/i.test(reason);
    const resumeHealable = resumeReady && /^(daily_media_cap|gemini_429)$/i.test(reason);
    const quarantineTarget = cur.quarantineTarget;
    const quarantineHealable = reason === "youtube_data_api_video_not_found" &&
      cur.active === null && quarantineTarget?.status === "pending" &&
      quarantineTarget.batch_item_id === quarantineTarget.latest_pause_batch_item_id &&
      quarantineTarget.run_id == null && quarantineTarget.duration_seconds == null &&
      quarantineTarget.started_at == null && quarantineTarget.completed_at == null &&
      Number(quarantineTarget.artifact_count) === 0;
    const mediaUsed = Number(cur.mediaToday?.used);
    const mediaBudget = Number(cur.mediaToday?.budget);
    // The physical guard pauses before a request that would cross the budget, so
    // durable usage can remain just below the limit. The future resume_after is
    // the hold boundary; once it is past, this MUST auto-resume.
    const expectedFuseHold = reason === "daily_media_cap" && !resumeReady;
    if (expectedFuseHold) {
      alerts.push({
        level: "warn",
        code: "daily_media_fuse_hold",
        detail: `Expected daily media fuse hold used=${mediaUsed} budget=${mediaBudget} resume_after=${cur.batch.resume_after || "n/a"}`,
      });
    } else if (quarantineHealable) {
      alerts.push({
        level: "warn",
        code: "batch_paused",
        detail: `Batch paused reason=${reason} with one pristine source-unavailable target.`,
      });
      actions.push("quarantine_unavailable_item");
      alerts.push({
        level: "warn",
        code: "auto_quarantine_queued",
        detail: "Will quarantine at most one exact unavailable-source item through the canonical fenced operator.",
      });
    } else if (skipHealable) {
      alerts.push({
        level: "warn",
        code: "batch_paused",
        detail: `Batch paused reason=${reason || "unknown"} resume_after=${cur.batch.resume_after || "n/a"} resume_ready=${resumeReady}`,
      });
      actions.push("skip_and_resume_paused");
      alerts.push({
        level: "warn",
        code: "auto_heal_queued",
        detail: "Will skip at most one failed active item and resume (canonical admin skip_active_item).",
      });
    } else if (resumeHealable) {
      alerts.push({
        level: "warn",
        code: "batch_paused",
        detail: `Batch paused reason=${reason || "unknown"} resume_after=${cur.batch.resume_after || "n/a"} resume_ready=${resumeReady}`,
      });
      actions.push("resume_paused_batch");
      alerts.push({
        level: "warn",
        code: "auto_resume_queued",
        detail: "Will resume paused batch via canonical admin resume (budget/backoff window elapsed).",
      });
    } else {
      alerts.push({
        level: "error",
        code: "batch_paused",
        detail: `Batch paused reason=${reason || "unknown"} resume_after=${cur.batch.resume_after || "n/a"} resume_ready=${resumeReady}`,
      });
    }
  }
  const completed = Number(cur.batch.completed_item_count || 0);
  const prevCompleted = prev ? Number(prev.batch?.completed_item_count || 0) : null;
  const progressed = prevCompleted == null ? true : completed > prevCompleted;
  const ageHours = prev?.at ? hoursBetween(prev.at, cur.at) : 0;

  // Stale active lease: no dispatch for > 2h while running
  if (cur.batch.status === "running" && cur.active?.last_job_dispatched_at) {
    const quiet = hoursBetween(cur.active.last_job_dispatched_at, cur.at);
    if (quiet >= 2) {
      actions.push("repair_running_batch");
      alerts.push({
        level: "error",
        code: "active_item_stale",
        detail: `Active ${cur.active.youtube_id} quiet ${quiet.toFixed(1)}h since last dispatch`,
      });
    }
  }

  if (prev && ageHours >= STALL_HOURS && !progressed && cur.batch.status === "running") {
    alerts.push({
      level: "error",
      code: "no_progress",
      detail: `No completed-count advance in ${ageHours.toFixed(1)}h (still ${completed}/${cur.batch.item_count})`,
    });
    actions.push("repair_running_batch");
  }

  if ((cur.acquisitionFailures || []).length > 0 && cur.batch.status !== "paused") {
    alerts.push({
      level: "error",
      code: "current_acquisition_failure",
      detail: cur.acquisitionFailures.map((failure) =>
        `${failure.safeReasonCode}:${failure.batchItemId}`).join("; "),
    });
  }

  alerts.push(...validateOperationsStatus(cur.queueMetrics, cur.at));
  alerts.push(...validateAnalysisDebtMetrics(cur.analysisDebt));

  const healthy = alerts.filter((a) => a.level === "error").length === 0;
  return { alerts, actions, healthy, progressed: done ? true : progressed, done };
}

function repair(cur) {
  const key = cur.batch?.idempotency_key;
  if (!key) return { repaired: false, reason: "missing_idempotency_key" };
  // start-reuse path calls repairTranscriptBatch for a running batch
  return admin("/admin/transcript-batch", {
    method: "POST",
    body: { action: "start" },
    idempotencyKey: key,
  });
}

function healPaused(cur) {
  const batchId = cur.batch?.batch_id;
  if (!batchId) return { skipped: false, reason: "missing_batch_id" };
  // skip_active_item also transitions paused -> running and activates the next item
  return admin("/admin/transcript-batch", {
    method: "POST",
    body: { action: "skip_active_item", batchId },
  });
}

function quarantinePaused(cur) {
  return runQuarantineOperatorMode({
    batchId: cur.batch?.batch_id,
    batchItemId: cur.quarantineTarget?.batch_item_id,
    expectedTransitionCount: cur.batch?.transition_count,
  });
}

function resumePaused(cur) {
  const key = cur.batch?.idempotency_key;
  if (!key) return { resumed: false, reason: "missing_idempotency_key" };
  return admin("/admin/transcript-batch", {
    method: "POST",
    body: { action: "resume" },
    idempotencyKey: key,
  });
}

function preservationSnapshot() {
  const tables = [
    "transcript_artifacts", "transcript_analysis_runs", "transcript_analysis_sections",
    "claims", "evidence", "review_work_items", "review_assignments", "moderator_reviews",
    "claim_revisions", "publication_evaluations", "claim_events", "review_audit_events",
  ];
  const counts = Object.fromEntries(tables.map((table) => {
    const row = d1(`SELECT COUNT(*) count FROM ${table}`)[0] || { count: 0 };
    return [table, Number(row.count || 0)];
  }));
  const canonical = JSON.stringify(counts, Object.keys(counts).sort());
  return { counts, sha256: createHash("sha256").update(canonical).digest("hex") };
}

function quarantineReadback(batchId, batchItemId, dispositionId) {
  const batchSql = sqlLiteral(batchId, /^txb_[a-f0-9]{32}$/, "batch_id");
  const itemSql = sqlLiteral(batchItemId, /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/, "batch_item_id");
  const dispositionSql = sqlLiteral(dispositionId, /^txbd_[a-f0-9]{32}$/, "disposition_id");
  const batch = d1(`SELECT batch_id,status,item_count,completed_item_count,transition_count
    FROM transcript_batches WHERE batch_id=${batchSql}`)[0] || null;
  const target = d1(`SELECT batch_item_id,source_item_id,youtube_id,status,run_id,duration_seconds,
    started_at,completed_at FROM transcript_batch_items WHERE batch_id=${batchSql}
      AND batch_item_id=${itemSql}`)[0] || null;
  const disposition = d1(`SELECT disposition_id,batch_id,batch_item_id,source_item_id,
    successor_batch_item_id,reason_code,observed_error_code,expected_transition_count,
    applied_transition_count FROM transcript_batch_item_dispositions
    WHERE disposition_id=${dispositionSql}`)[0] || null;
  const dispositionCount = Number((d1(`SELECT COUNT(*) count FROM transcript_batch_item_dispositions
    WHERE batch_id=${batchSql} AND batch_item_id=${itemSql}`)[0] || {}).count || 0);
  const batchDispositionCount = Number((d1(`SELECT COUNT(*) count
    FROM transcript_batch_item_dispositions WHERE batch_id=${batchSql}`)[0] || {}).count || 0);
  const rows = d1(effectiveDispositionCountsSql(batchSql));
  const counts = { completed: 0, active: 0, pending: 0, quarantined: 0, skipped: 0 };
  for (const row of rows) counts[row.status] = Number(row.n || 0);
  const successor = disposition?.successor_batch_item_id ? d1(`SELECT batch_item_id,youtube_id,status,
    dispatch_state FROM transcript_batch_items WHERE batch_id=${batchSql}
      AND batch_item_id=${sqlLiteral(disposition.successor_batch_item_id,
        /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/, "successor_batch_item_id")}`)[0] || null : null;
  return { batch, target, disposition, dispositionCount, batchDispositionCount, counts, successor,
    preservation: preservationSnapshot() };
}

function runQuarantineOperatorMode(dependencies = {}) {
  if (DRY_RUN) throw new Error("quarantine_mode_does_not_support_dry_run");
  const batchId = dependencies.batchId ?? argumentValue("--batch-id");
  const batchItemId = dependencies.batchItemId ?? argumentValue("--batch-item-id");
  const transitionText = dependencies.expectedTransitionCount
    ?? argumentValue("--expected-transition-count");
  sqlLiteral(batchId, /^txb_[a-f0-9]{32}$/, "batch_id");
  sqlLiteral(batchItemId, /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/, "batch_item_id");
  if (!/^\d+$/.test(String(transitionText || ""))) throw new Error("invalid_transition_count");
  if (!(dependencies.token ?? process.env.SCANNER_ADMIN_TOKEN)) {
    throw new Error("SCANNER_ADMIN_TOKEN missing");
  }
  const before = (dependencies.snapshotNow || snapshotNow)();
  before.preservation = (dependencies.preservationSnapshot || preservationSnapshot)();
  const expectedTransitionCount = Number(transitionText);
  const request = prepareQuarantineOperatorRequest(before,
    { batchId, batchItemId, expectedTransitionCount });
  const action = (dependencies.admin || admin)(request.path, request.options);
  if (!action?.dispositionId) throw new Error(`quarantine_action_failed:${action?.reason || "missing_receipt"}`);
  const after = (dependencies.quarantineReadback || quarantineReadback)(
    batchId, batchItemId, action.dispositionId);
  const validation = validateQuarantineReceipt(before, action, after,
    { batchId, batchItemId, expectedTransitionCount });
  if (!validation.ok) throw new Error(`quarantine_readback_failed:${validation.errors.join(",")}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const at = (dependencies.nowIso || (() => new Date().toISOString()))();
  const receiptPath = join(OUT_DIR, `${at.replace(/[:.]/g, "-")}-quarantine.json`);
  const receipt = {
    contract: "transcript-batch-quarantine-v1", at, batchId, batchItemId,
    dispositionId: action.dispositionId, applied: Boolean(action.applied), reused: Boolean(action.reused),
    transitionBefore: action.transitionBefore, transitionAfter: action.transitionAfter,
    completed: Number(after.batch.completed_item_count), counts: after.counts,
    successor: after.successor ? { batchItemId: after.successor.batch_item_id,
      youtubeId: after.successor.youtube_id, status: after.successor.status,
      dispatchState: after.successor.dispatch_state } : null,
    preservationSha256: after.preservation.sha256, receiptPath,
  };
  const persisted = { receipt, before: {
    batch: { ...before.batch, idempotency_key: undefined }, byStatus: before.byStatus,
    preservation: before.preservation }, action, after };
  if (dependencies.persistReceipt) dependencies.persistReceipt(persisted);
  else writeFileSync(receiptPath, `${JSON.stringify(persisted, null, 2)}\n`);
  (dependencies.emitReceipt || console.log)(
    `TRANSCRIPT_BATCH_QUARANTINE_RECEIPT ${JSON.stringify(receipt)}`);
  return receipt;
}

function incidentConditions(cur, verdict) {
  const conditions = [];
  const causal = cur.acquisitionFailures?.[0] || null;
  for (const alert of verdict.alerts.filter((item) => item.level === "error")) {
    let incidentClass = null;
    if (alert.code === "batch_paused") incidentClass = "batch_paused";
    else if (["no_progress", "active_item_stale", "current_acquisition_failure"].includes(alert.code)) {
      incidentClass = "batch_no_progress";
    } else if (/repair|auto_heal|receipt/.test(alert.code)) incidentClass = "action_receipt_mismatch";
    else if (alert.code === "queue_dlq_nonzero") incidentClass = "queue_dlq";
    else if (/^queue_/.test(alert.code)) incidentClass = "queue_backlog";
    else if (alert.code.startsWith("analysis_reconciliation_")) {
      incidentClass = "analysis_reconciliation_blocked";
    }
    if (!incidentClass) continue;
    const acquisitionScoped = ["batch_paused", "batch_no_progress", "action_receipt_mismatch"]
      .includes(incidentClass);
    const condition = {
      batchId: cur.batch?.batch_id || null,
      batchItemId: acquisitionScoped ? (causal?.batchItemId || cur.active?.batch_item_id || null) : null,
      incidentClass,
      safeReasonCode: safeCode(acquisitionScoped
        ? (causal?.safeReasonCode || cur.batch?.pause_reason || alert.code) : alert.code),
      causalId: acquisitionScoped ? (causal?.causalId || null) : null,
      batchTransitionCount: cur.batch?.transition_count == null
        ? null : Number(cur.batch.transition_count),
      safeCount: Number(cur.batch?.completed_item_count || 0),
    };
    condition.fingerprint = incidentFingerprint(condition);
    condition.incidentId = incidentIdFor(condition.fingerprint);
    if (!conditions.some((entry) => entry.fingerprint === condition.fingerprint)) conditions.push(condition);
  }
  return conditions;
}

function readIncidents() {
  return d1(`SELECT * FROM current_batch_incidents ORDER BY opened_at,incident_id`);
}

function writeIncident(condition, at) {
  const nullable = (value, pattern, label) => value == null ? "NULL" : sqlLiteral(value, pattern, label);
  d1(`INSERT OR IGNORE INTO batch_incidents
    (incident_id,fingerprint_sha256,fingerprint_version,batch_id,batch_item_id,
     incident_class,safe_reason_code,causal_id,batch_transition_count,safe_count,opened_at)
    VALUES (${sqlLiteral(condition.incidentId, /^binc_[a-f0-9]{32}$/, "incident_id")},
      ${sqlLiteral(condition.fingerprint, /^[a-f0-9]{64}$/, "fingerprint")},'batch-incident-v1',
      ${nullable(condition.batchId, /^txb_[a-f0-9]{32}$/, "batch_id")},
      ${nullable(condition.batchItemId, /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/, "batch_item_id")},
      ${sqlLiteral(condition.incidentClass, /^[a-z_]{1,80}$/, "incident_class")},
      ${sqlLiteral(condition.safeReasonCode, /^[a-z0-9_]{1,120}$/, "safe_reason_code")},
      ${nullable(condition.causalId, /^[a-z0-9_:-]{1,160}$/i, "causal_id")},
      ${condition.batchTransitionCount == null ? "NULL" : Number(condition.batchTransitionCount)},
      ${condition.safeCount == null ? "NULL" : Number(condition.safeCount)},
      ${sqlLiteral(at, /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, "incident_at")})`);
  writeIncidentEvent(condition.incidentId, "opened", at, condition.safeReasonCode, condition.safeCount);
}

function writeIncidentEvent(incidentId, eventType, at, reason = null, count = null, providerMessageId = null) {
  const eventId = incidentEventId(incidentId, eventType);
  const nullable = (value, pattern, label) => value == null ? "NULL" : sqlLiteral(value, pattern, label);
  d1(`INSERT OR IGNORE INTO batch_incident_events
    (incident_event_id,incident_id,event_type,safe_reason_code,safe_count,provider_message_id,created_at)
    VALUES (${sqlLiteral(eventId, /^bine_[a-f0-9]{32}$/, "incident_event_id")},
      ${sqlLiteral(incidentId, /^binc_[a-f0-9]{32}$/, "incident_id")},
      ${sqlLiteral(eventType, /^[a-z_]{1,80}$/, "incident_event_type")},
      ${nullable(reason, /^[a-z0-9_]{1,120}$/, "event_reason")},
      ${count == null ? "NULL" : Number(count)},
      ${nullable(providerMessageId, /^[A-Za-z0-9_-]{1,200}$/, "provider_message_id")},
      ${sqlLiteral(at, /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, "incident_event_at")})`);
}

function buildWatchdogReceipt({ pre, post, verdict, actionReceipt, lifecycle, receiptPath }) {
  return { contract: "batch-watchdog-v2", at: post.at,
    preActionSnapshotSha256: snapshotHash(pre), postActionSnapshotSha256: snapshotHash(post),
    healthy: Boolean(verdict.healthy && actionReceipt.ok && lifecycle.errors.length === 0),
    progressed: verdict.progressed, done: Boolean(verdict.done),
    counts: { completed: Number(post.batch?.completed_item_count || 0),
      actionablePending: Number(post.byStatus.pending || 0),
      disposed: Number(post.byStatus.quarantined || 0), skipped: Number(post.byStatus.skipped || 0) },
    analysisDebt: post.analysisDebt,
    incidents: { opened: lifecycle.opened, recovered: lifecycle.recovered,
      openingAccepted: lifecycle.openingAccepted || [], openingNotices: lifecycle.openingNotices,
      openingPending: lifecycle.openingPending || [],
      recoveryAccepted: lifecycle.recoveryAccepted || [], recoveryNotices: lifecycle.recoveryNotices,
      recoveryPending: lifecycle.recoveryPending || [],
      deliveryComplete: lifecycle.deliveryComplete !== false },
    actionReceipt, queueMetrics: post.queueMetrics || null, dryRun: DRY_RUN, receiptPath };
}

function runIncidentLifecycle(conditions, report, at) {
  const ownedClasses = new Set(["batch_paused", "batch_no_progress", "queue_backlog", "queue_dlq",
    "analysis_reconciliation_blocked", "action_receipt_mismatch"]);
  const ownedIncidents = () => readIncidents().filter((row) => ownedClasses.has(row.incident_class));
  if (DRY_RUN) {
    const planned = planIncidentLifecycle(conditions, ownedIncidents());
    return { opened: [], recovered: [], openingAccepted: [], openingNotices: [],
      openingPending: [], recoveryAccepted: [], recoveryNotices: [], recoveryPending: [],
      deliveryComplete: true,
      planned: { opened: planned.opened.length, recovered: planned.recovered.length }, errors: [] };
  }
  const result = { opened: [], recovered: [], openingAccepted: [], openingNotices: [],
    openingPending: [], recoveryAccepted: [], recoveryNotices: [], recoveryPending: [],
    deliveryComplete: true, errors: [] };
  const reconcileAccepted = (incident, kind) => {
    const recovery = kind === "recovery";
    const prefix = recovery ? "recovery_notice" : "opening_notice";
    const providerMessageId = recovery ? incident.recovery_provider_message_id
      : incident.opening_provider_message_id;
    if (!providerMessageId) {
      result[recovery ? "recoveryPending" : "openingPending"].push(incident.incident_id);
      if (!recovery) result.errors.push(`${prefix}_provider_receipt_missing:${incident.incident_id}`);
      return;
    }
    try {
      const delivery = retrieveAlertDelivery(providerMessageId);
      const disposition = noticeDeliveryDisposition(kind, delivery.status);
      if (disposition.eventType?.endsWith("_delivered")) {
        writeIncidentEvent(incident.incident_id, disposition.eventType, at,
          safeCode(incident.safe_reason_code), incident.safe_count, providerMessageId);
        result[recovery ? "recoveryNotices" : "openingNotices"].push(incident.incident_id);
      } else if (disposition.eventType?.endsWith("_failed")) {
        writeIncidentEvent(incident.incident_id, disposition.eventType, at,
          safeCode(`notice_${delivery.lastEvent}`, "notice_delivery_failed"), incident.safe_count,
          providerMessageId);
        if (disposition.blocking) result.errors.push(`${prefix}_failed:${incident.incident_id}`);
      } else if (disposition.pending) {
        result[recovery ? "recoveryPending" : "openingPending"].push(incident.incident_id);
      }
    } catch {
      result[recovery ? "recoveryPending" : "openingPending"].push(incident.incident_id);
    }
  };

  const initialIncidents = ownedIncidents();
  result.errors.push(...persistentNoticeFailureErrors(
    initialIncidents.filter((incident) => !isExpectedFuseIncident(incident))));
  for (const incident of initialIncidents) {
    if (isExpectedFuseIncident(incident)) continue;
    if (incident.opening_notice_accepted && !incident.opening_notice_delivered &&
        !incident.opening_notice_failed) reconcileAccepted(incident, "opening");
    if (incident.recovery_notice_accepted && !incident.recovery_notice_delivered &&
        !incident.recovery_notice_failed) reconcileAccepted(incident, "recovery");
  }

  const first = planIncidentLifecycle(conditions, ownedIncidents());
  for (const condition of first.opened) {
    writeIncident(condition, at);
    result.opened.push(condition.incidentId);
  }
  for (const incident of first.recovered) {
    writeIncidentEvent(incident.incident_id, "recovered", at,
      safeCode(incident.safe_reason_code), incident.safe_count);
    result.recovered.push(incident.incident_id);
  }
  const fresh = ownedIncidents();
  const noticePlan = planIncidentLifecycle(conditions, fresh);
  const blocking = fresh.filter((row) => !row.recovered);
  const deliver = (incident, kind) => {
    const recovery = kind === "recovery";
    const eventPrefix = recovery ? "recovery_notice" : "opening_notice";
    const idempotencyKey = noticeIdempotencyKey(kind, incident.fingerprint_sha256);
    const subject = recovery
      ? `Prophecy Ledger RECOVERED: ${incident.incident_class}/${incident.safe_reason_code}`
      : `Prophecy Ledger ALERT: ${incident.incident_class}/${incident.safe_reason_code}`;
    const remaining = blocking.filter((row) => row.incident_id !== incident.incident_id);
    try {
      const sent = sendAlert({ subject,
        text: formatIncidentNotice(incident, kind, report, remaining), idempotencyKey });
      if (!sent?.id) throw new Error("notice_provider_receipt_missing");
      writeIncidentEvent(incident.incident_id, `${eventPrefix}_accepted`, at,
        safeCode(incident.safe_reason_code), incident.safe_count, sent.id);
      result[recovery ? "recoveryAccepted" : "openingAccepted"].push(incident.incident_id);
      reconcileAccepted({ ...incident,
        [recovery ? "recovery_provider_message_id" : "opening_provider_message_id"]: sent.id }, kind);
    } catch {
      writeIncidentEvent(incident.incident_id, `${eventPrefix}_failed`, at,
        "notice_delivery_failed", incident.safe_count);
      result.errors.push(`${eventPrefix}_failed:${incident.incident_id}`);
    }
  };
  for (const incident of noticePlan.openingNotices) deliver(incident, "opening");
  // Recovery is persisted in D1 and surfaced in the receipt. Only current
  // error-level incidents generate owner email, so no recovery email is sent.
  const verified = ownedIncidents();
  for (const incidentId of result.opened) {
    if (!verified.some((row) => row.incident_id === incidentId)) result.errors.push(`incident_open_readback_missing:${incidentId}`);
  }
  for (const incidentId of result.recovered) {
    if (!verified.some((row) => row.incident_id === incidentId && row.recovered)) {
      result.errors.push(`incident_recovery_readback_missing:${incidentId}`);
    }
  }
  for (const incidentId of result.openingAccepted) {
    if (!verified.some((row) => row.incident_id === incidentId && row.opening_notice_accepted)) {
      result.errors.push(`opening_notice_acceptance_readback_missing:${incidentId}`);
    }
  }
  for (const incidentId of result.recoveryAccepted) {
    if (!verified.some((row) => row.incident_id === incidentId && row.recovery_notice_accepted)) {
      result.errors.push(`recovery_notice_acceptance_readback_missing:${incidentId}`);
    }
  }
  result.deliveryComplete = result.errors.length === 0 && result.openingPending.length === 0;
  return result;
}

function formatReport(cur, verdict, repairResult) {
  const b = cur.batch || {};
  const lines = [
    `Prophecy Ledger batch watchdog @ ${cur.at}`,
    "",
    `Batch: ${b.batch_id || "none"} status=${b.status || "n/a"}`,
    `Progress: ${b.completed_item_count || 0}/${b.item_count || 0}`,
    `Items: ${JSON.stringify(cur.byStatus)}`,
    `Media today: ${cur.mediaToday.used}/${cur.mediaToday.budget || 86400}s`,
    `Analysis debt: active=${cur.analysisDebt?.activeSections || 0}/${cur.analysisDebt?.activeVideos || 0} ` +
      `in_progress=${cur.analysisDebt?.inProgressSections || 0}/${cur.analysisDebt?.inProgressVideos || 0} ` +
      `manual=${cur.analysisDebt?.manualSections || 0}/${cur.analysisDebt?.manualVideos || 0} ` +
      `superseded=${cur.analysisDebt?.supersededSections || 0}/${cur.analysisDebt?.supersededVideos || 0}`,
    `Queue metrics: ${cur.queueMetrics?.contract || "missing"} healthy=${Boolean(cur.queueMetrics?.healthy)}`,
    `Active: ${cur.active ? `${cur.active.youtube_id} (${cur.active.duration_seconds}s)` : "none"}`,
    `Progressed since last snapshot: ${verdict.progressed}`,
    `Healthy: ${verdict.healthy}`,
  ];
  if (verdict.alerts.length) {
    lines.push("", "Alerts:");
    for (const a of verdict.alerts) lines.push(`- [${a.level}] ${a.code}: ${a.detail}`);
  }
  if (repairResult) {
    lines.push("", `Repair result: ${JSON.stringify({
      started: repairResult.started,
      reused: repairResult.reused,
      skipped: repairResult.skipped,
      status: repairResult.status,
      reason: repairResult.reason,
      completedItemCount: repairResult.completedItemCount,
      active: repairResult.activeItem?.youtubeId || null,
    })}`);
  }
  lines.push("", "— Prophecy Ledger watchdog");
  return lines.join("\n");
}

export { analysisDebtCausesSql, analysisDebtSummarySql, buildWatchdogReceipt,
  classifyResendDelivery, currentAcquisitionSql, evaluate,
  effectiveDispositionCountsSql, formatIncidentNotice, healPaused, resumePaused, incidentConditions,
  incidentFingerprint, isExpectedFuseIncident, noticeIdempotencyKey,
  noticeDeliveryDisposition, noticeEventType, physicalMediaSql, planIncidentLifecycle, quarantinePaused,
  prepareQuarantineOperatorRequest, persistentNoticeFailureErrors, quarantineReadback,
  reconcileAcquisitionFailures,
  repair, runQuarantineOperatorMode, snapshotHash, snapshotNow, validateDailyAction,
  validateAnalysisDebtMetrics, validateOperationsStatus, validateQuarantineReceipt, writeState };

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(resolve(entry)).href; }
  catch { return false; }
}

if (isMainModule()) {
  loadEnvFile();
  if (QUARANTINE_MODE) {
    try { runQuarantineOperatorMode(); }
    catch (error) {
      console.error(`TRANSCRIPT_BATCH_QUARANTINE_FAILED ${String(error?.message || error).slice(0, 300)}`);
      process.exitCode = 2;
    }
  } else {
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      const prev = readState();
      const pre = snapshotNow();
      const preVerdict = evaluate(prev, pre);
      const action = [...new Set(preVerdict.actions)][0] || null;
      let actionResponse = null;
      let actionError = null;
      if (action && !DRY_RUN) {
        try {
          actionResponse = action === "repair_running_batch" ? repair(pre)
            : action === "quarantine_unavailable_item" ? quarantinePaused(pre)
            : action === "resume_paused_batch" ? resumePaused(pre)
            : healPaused(pre);
        }
        catch (error) { actionError = error; }
      }
      const post = snapshotNow();
      const verdict = evaluate(prev, post);
      const actionReceipt = validateDailyAction(pre, post, DRY_RUN ? null : action,
        actionResponse, actionError);
      if (!actionReceipt.ok) {
        verdict.alerts.push({ level: "error", code: "action_receipt_mismatch",
          detail: actionReceipt.errors.join(",") });
        verdict.healthy = false;
      }
      const report = formatReport(post, verdict, actionResponse);
      const lifecycle = runIncidentLifecycle(incidentConditions(post, verdict), report, post.at);
      const stem = post.at.replace(/[:.]/g, "-");
      const reportPath = join(OUT_DIR, `${stem}.txt`);
      const receiptPath = join(OUT_DIR, `${stem}.json`);
      const summary = buildWatchdogReceipt({ pre, post, verdict, actionReceipt, lifecycle, receiptPath });
      writeFileSync(reportPath, report + "\n");
      writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`);
      writeState({ ...post, batch: post.batch ? { ...post.batch, idempotency_key: undefined } : null,
        lastVerdict: { healthy: summary.healthy, progressed: summary.progressed,
          alertCodes: verdict.alerts.map((item) => item.code), receiptPath } });
      console.log(`BATCH_WATCHDOG_RECEIPT ${JSON.stringify(summary)}`);
      if (!summary.healthy) process.exitCode = 2;
    } catch (error) {
      console.error(`BATCH_WATCHDOG_FAILED ${String(error?.message || error).slice(0, 300)}`);
      process.exitCode = 2;
    }
  }
}
