import { createHash } from "node:crypto";

const EXPECTED_QUEUES = new Set([
  "prophecy-ledger-ingestion", "prophecy-ledger-analysis",
  "prophecy-ledger-ingestion-dlq", "prophecy-ledger-analysis-dlq",
]);

export const ACTIVE_ANALYSIS_DEBT_STATES = new Set([
  "successor_required", "successor_retryable", "finalization_pending", "current_retryable",
]);

export function analysisDebtSummarySql() {
  const count = (states) => `COALESCE(SUM(CASE WHEN debt_state IN (${states.map((state) => `'${state}'`).join(",")}) THEN 1 ELSE 0 END),0)`;
  const videos = (states) => `COUNT(DISTINCT CASE WHEN debt_state IN (${states.map((state) => `'${state}'`).join(",")}) THEN source_item_id END)`;
  const active = [...ACTIVE_ANALYSIS_DEBT_STATES];
  const blocking = [...active, "manual_required"];
  return `SELECT
    ${count(blocking)} failed_sections,
    ${videos(blocking)} failed_videos,
    ${count(active)} active_sections,
    ${videos(active)} active_videos,
    ${count(["successor_pending"])} in_progress_sections,
    ${videos(["successor_pending"])} in_progress_videos,
    ${count(["manual_required"])} manual_sections,
    ${videos(["manual_required"])} manual_videos,
    ${count(["superseded"])} superseded_sections,
    ${videos(["superseded"])} superseded_videos,
    ${count(["successor_required"])} successor_required_count,
    ${count(["successor_pending"])} successor_pending_count,
    ${count(["successor_retryable"])} successor_retryable_count,
    ${count(["finalization_pending"])} finalization_pending_count,
    ${count(["current_retryable"])} current_retryable_count,
    ${count(["manual_required"])} manual_required_count,
    ${count(["superseded"])} superseded_count
  FROM analysis_section_lineage_v2`;
}

export function analysisDebtCausesSql() {
  return `SELECT COALESCE(successor_error_code,successor_job_error_code,
      source_error_code,source_job_error_code,'unknown_analysis_failure') safe_cause_code,
    COUNT(*) count
  FROM analysis_section_lineage_v2
  WHERE debt_state IN ('successor_required','successor_retryable','finalization_pending',
    'current_retryable','manual_required')
  GROUP BY safe_cause_code ORDER BY safe_cause_code`;
}

export function validateAnalysisDebtMetrics(debt) {
  const fields = ["failedSections", "failedVideos", "activeSections", "activeVideos",
    "inProgressSections", "inProgressVideos", "manualSections", "manualVideos",
    "supersededSections", "supersededVideos"];
  if (!debt || fields.some((field) => !Number.isInteger(debt[field]) || debt[field] < 0)
      || debt.failedSections !== debt.activeSections + debt.manualSections) {
    return [{ level: "error", code: "analysis_reconciliation_metrics_missing",
      detail: "Analysis lineage debt metrics are missing, invalid, or internally inconsistent." }];
  }
  const alerts = [];
  if (debt.activeSections > 0 || debt.activeVideos > 0) {
    alerts.push({ level: "error", code: "analysis_reconciliation_blocked",
      detail: `Active analysis debt sections=${debt.activeSections} videos=${debt.activeVideos}.` });
  }
  if (debt.manualSections > 0 || debt.manualVideos > 0) {
    alerts.push({ level: "error", code: "analysis_reconciliation_manual_required",
      detail: `Manual analysis debt sections=${debt.manualSections} videos=${debt.manualVideos}.` });
  }
  if (debt.inProgressSections > 0 || debt.inProgressVideos > 0) {
    alerts.push({ level: "warn", code: "analysis_reconciliation_in_progress",
      detail: `Analysis successors in progress sections=${debt.inProgressSections} videos=${debt.inProgressVideos}.` });
  }
  if (debt.supersededSections > 0 || debt.supersededVideos > 0) {
    alerts.push({ level: "info", code: "analysis_reconciliation_superseded",
      detail: `Superseded historical failures sections=${debt.supersededSections} videos=${debt.supersededVideos}.` });
  }
  return alerts;
}

export function sqlLiteral(value, pattern, label) {
  const text = String(value || "");
  if (!pattern.test(text)) throw new Error(`invalid_${label}`);
  return `'${text}'`;
}

export function classifyResendDelivery(lastEvent) {
  const event = String(lastEvent || "").toLowerCase();
  if (["delivered", "opened", "clicked", "complained"].includes(event)) {
    return { status: "delivered", lastEvent: event };
  }
  if (["bounced", "failed", "suppressed", "canceled"].includes(event)) {
    return { status: "failed", lastEvent: event };
  }
  return { status: "pending", lastEvent: event || null };
}

export function noticeDeliveryDisposition(kind, deliveryStatus) {
  if (!["opening", "recovery"].includes(kind)) throw new Error("invalid_notice_kind");
  if (deliveryStatus === "delivered") {
    return { eventType: `${kind}_notice_delivered`, pending: false, blocking: false };
  }
  if (deliveryStatus === "failed") {
    return { eventType: `${kind}_notice_failed`, pending: false,
      blocking: kind === "opening" };
  }
  return { eventType: null, pending: true, blocking: false };
}

export function noticeEventType(kind, deliveryStatus) {
  return noticeDeliveryDisposition(kind, deliveryStatus).eventType;
}

export function isExpectedFuseIncident(incident) {
  return String(incident?.safeReasonCode || incident?.safe_reason_code || "") ===
    "daily_media_cap";
}

export function persistentNoticeFailureErrors(incidents = []) {
  return incidents.flatMap((incident) => [
    ...(incident.opening_notice_failed ? [`opening_notice_failed:${incident.incident_id}`] : []),
  ]);
}

export function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function reconcileAcquisitionFailures(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.batch_item_id)) return false;
    seen.add(row.batch_item_id);
    const currentItem = row.item_status === "active" ||
      (row.batch_status === "paused" && row.batch_item_id === row.latest_pause_item_id);
    const unresolved = Number(row.artifact_count || 0) === 0 &&
      Number(row.completed_item_count || 0) === 0 && Number(row.disposition_count || 0) === 0;
    const causal = row.batch_status === "paused"
      ? Boolean(row.pause_reason) && row.batch_item_id === row.latest_pause_item_id &&
        (!row.pause_job_id || row.job_id === row.pause_job_id)
      : row.job_status === "failed";
    return currentItem && unresolved && causal;
  }).map((row) => ({
    batchId: row.batch_id, batchItemId: row.batch_item_id, sourceItemId: row.source_item_id,
    itemStatus: row.item_status, safeReasonCode: row.pause_reason || row.error_code || "acquisition_failed",
    causalId: row.pause_event_id || row.job_id || null,
    transitionCount: Number(row.transition_count || 0),
  }));
}

export function currentAcquisitionSql(batchId) {
  const batchSql = sqlLiteral(batchId, /^txb_[a-f0-9]{32}$/, "batch_id");
  return `WITH latest_pause AS (
      SELECT event_id,batch_item_id,json_extract(detail_json,'$.jobId') pause_job_id
      FROM transcript_batch_events
      WHERE batch_id=${batchSql} AND event_type='batch_paused'
      ORDER BY created_at DESC,event_id DESC LIMIT 1
    )
    SELECT batch.batch_id,batch.status batch_status,batch.pause_reason,batch.transition_count,
      item.batch_item_id,item.source_item_id,item.status item_status,
      pause.event_id pause_event_id,pause.batch_item_id latest_pause_item_id,pause.pause_job_id,
      job.job_id,job.status job_status,job.error_code,
      (SELECT COUNT(*) FROM transcript_artifacts artifact
        WHERE artifact.source_item_id=item.source_item_id) artifact_count,
      CASE WHEN item.status='completed' THEN 1 ELSE 0 END completed_item_count,
      (SELECT COUNT(*) FROM transcript_batch_item_dispositions disposition
        WHERE disposition.batch_id=item.batch_id AND disposition.batch_item_id=item.batch_item_id) disposition_count
    FROM transcript_batches batch
    JOIN transcript_batch_items item ON item.batch_id=batch.batch_id
    LEFT JOIN latest_pause pause ON 1=1
    LEFT JOIN ingestion_jobs job ON job.run_id=item.run_id AND job.job_type='transcript_extract'
    WHERE batch.batch_id=${batchSql}
      AND (item.status='active' OR item.batch_item_id=pause.batch_item_id)
    ORDER BY item.batch_item_id,
      CASE WHEN pause.pause_job_id IS NOT NULL AND job.job_id=pause.pause_job_id THEN 0 ELSE 1 END,
      job.completed_at DESC,job.job_id DESC`;
}

export function physicalMediaSql(day, { ignoreLegacyCutover = false } = {}) {
  const daySql = sqlLiteral(day, /^\d{4}-\d{2}-\d{2}$/, "media_day");
  const debitWhere = ignoreLegacyCutover
    ? `${daySql} AND NOT (reason = 'legacy_cutover_fail_closed' AND reserved_seconds >= 86400)`
    : daySql;
  return `SELECT
    (SELECT COALESCE(SUM(reserved_seconds),0)
      FROM gemini_physical_request_reservations WHERE media_day=${daySql}) AS request_seconds,
    (SELECT COALESCE(SUM(reserved_seconds),0)
      FROM gemini_physical_day_debits WHERE media_day=${debitWhere}) AS debit_seconds`;
}

export function hoursBetween(a, b) {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000;
}

export function validateOperationsStatus(status, at) {
  const alerts = [];
  if (status?.contract !== "queue-operations-status-v1" || !Array.isArray(status?.queues)) {
    return [{ level: "error", code: "queue_metrics_missing",
      detail: "Canonical operations queue receipt is missing or invalid." }];
  }
  const byName = new Map(status.queues.map((queue) => [queue.queueName, queue]));
  for (const queueName of EXPECTED_QUEUES) {
    const queue = byName.get(queueName);
    if (!queue || queue.status !== "observed" || !Number.isInteger(queue.backlogCount) ||
        queue.backlogCount < 0) {
      alerts.push({ level: "error", code: "queue_metrics_unavailable",
        detail: `${queueName} has no valid observed metrics.` });
      continue;
    }
    const backlog = Number(queue.backlogCount);
    if (queueName.endsWith("-dlq") && backlog > 0) {
      alerts.push({ level: "error", code: "queue_dlq_nonzero",
        detail: `${queueName} backlog=${backlog}.` });
      continue;
    }
    if (backlog > 0) {
      const oldest = Date.parse(queue.oldestMessageTimestamp || "");
      if (!Number.isFinite(oldest)) {
        alerts.push({ level: "error", code: "queue_metrics_unavailable",
          detail: `${queueName} backlog has no valid oldest-message timestamp.` });
        continue;
      }
      const maxHours = queueName === "prophecy-ledger-analysis" ? 6 : 2;
      const ageHours = hoursBetween(new Date(oldest).toISOString(), at);
      if (ageHours >= maxHours) alerts.push({ level: "error", code: "queue_backlog_stale",
        detail: `${queueName} oldest message is ${ageHours.toFixed(1)}h old (limit ${maxHours}h).` });
    }
  }
  return alerts;
}

export function validateQuarantineReceipt(before, action, after, expected = {}) {
  const errors = [];
  const { batchId, batchItemId, expectedTransitionCount } = expected;
  const transitionAfter = Number.isInteger(expectedTransitionCount)
    ? expectedTransitionCount + 1 : null;
  const beforeTarget = before?.quarantineTarget;
  const expectedSuccessor = action?.successor?.batchItemId || null;
  if (action?.contract !== "transcript-batch-quarantine-v1" || !action?.quarantined) errors.push("action_receipt_invalid");
  if (!before?.batch || !after?.batch) errors.push("batch_readback_missing");
  if (!batchId || !batchItemId || !Number.isInteger(expectedTransitionCount)) errors.push("expected_fence_missing");
  if (action?.batchId !== batchId || action?.batchItemId !== batchItemId) errors.push("action_binding_mismatch");
  if (action?.reasonCode !== "source_unavailable"
      || action?.observedErrorCode !== "youtube_data_api_video_not_found") {
    errors.push("action_reason_mismatch");
  }
  if (action?.transitionBefore !== expectedTransitionCount
      || action?.transitionAfter !== transitionAfter) errors.push("action_transition_mismatch");
  if (after?.batch?.batch_id !== batchId) errors.push("batch_readback_mismatch");
  if (!after?.disposition || after.disposition.disposition_id !== action?.dispositionId) errors.push("disposition_readback_mismatch");
  if (after?.disposition?.batch_id !== batchId
      || after?.disposition?.batch_item_id !== batchItemId
      || after?.disposition?.source_item_id !== beforeTarget?.source_item_id
      || after?.disposition?.reason_code !== "source_unavailable"
      || after?.disposition?.observed_error_code !== "youtube_data_api_video_not_found"
      || Number(after?.disposition?.expected_transition_count) !== expectedTransitionCount
      || Number(after?.disposition?.applied_transition_count) !== transitionAfter
      || (after?.disposition?.successor_batch_item_id || null) !== expectedSuccessor) {
    errors.push("disposition_binding_mismatch");
  }
  if (after?.dispositionCount !== 1) errors.push("disposition_count_mismatch");
  if (after?.target?.batch_item_id !== batchItemId || after?.target?.status !== "pending") errors.push("target_not_preserved_pending");
  if (after?.target?.source_item_id !== beforeTarget?.source_item_id
      || after?.target?.youtube_id !== beforeTarget?.youtube_id) errors.push("target_identity_changed");
  if (after?.target?.run_id != null || after?.target?.duration_seconds != null ||
      after?.target?.started_at != null || after?.target?.completed_at != null) errors.push("target_acquisition_fields_changed");
  if (Number(after?.batch?.completed_item_count) !== Number(before?.batch?.completed_item_count)) errors.push("completed_count_changed");
  if (Number(after?.batch?.item_count) !== Number(before?.batch?.item_count)) errors.push("item_count_changed");
  if (Number(after?.batch?.transition_count) !== transitionAfter) errors.push("transition_readback_mismatch");
  if (!["running", "completed"].includes(after?.batch?.status)) errors.push("batch_not_running_or_completed");
  const countKeys = ["active", "completed", "pending", "quarantined", "skipped"];
  if (Object.keys(after?.counts || {}).sort().join(",") !== countKeys.sort().join(",")
      || countKeys.some((key) => !Number.isInteger(after?.counts?.[key])
        || after.counts[key] < 0)) errors.push("effective_counts_invalid");
  const countTotal = countKeys.reduce((sum, key) => sum + Number(after?.counts?.[key] || 0), 0);
  if (countTotal !== Number(after?.batch?.item_count)) errors.push("effective_counts_do_not_sum");
  if (Number(after?.counts?.completed || 0) !== Number(after?.batch?.completed_item_count)) errors.push("completed_count_disagrees");
  if (!Number.isInteger(after?.batchDispositionCount) || after.batchDispositionCount < 1) {
    errors.push("batch_disposition_count_invalid");
  } else if (Number(after?.counts?.quarantined || 0) !== after.batchDispositionCount) {
    errors.push("quarantined_count_disagrees");
  }
  if (expectedSuccessor) {
    if (after?.successor?.batch_item_id !== expectedSuccessor) errors.push("successor_readback_mismatch");
    if (after?.successor?.dispatch_state !== "sent") errors.push("successor_not_dispatched");
  } else if (after?.successor) errors.push("unexpected_successor");
  if (before?.preservation?.sha256 !== after?.preservation?.sha256) errors.push("preservation_hash_changed");
  return { ok: errors.length === 0, errors };
}

export function prepareQuarantineOperatorRequest(before, { batchId, batchItemId,
  expectedTransitionCount }) {
  sqlLiteral(batchId, /^txb_[a-f0-9]{32}$/, "batch_id");
  sqlLiteral(batchItemId, /^txbi_[a-f0-9]{32}_[a-f0-9]{32}$/, "batch_item_id");
  if (!Number.isInteger(expectedTransitionCount) || expectedTransitionCount < 0) {
    throw new Error("invalid_transition_count");
  }
  if (!before?.batch) throw new Error("batch_readback_missing");
  if (before.batch.batch_id !== batchId) throw new Error("batch_readback_mismatch");
  if (before.batch.status !== "paused") throw new Error("batch_status_mismatch");
  if (before.batch.pause_reason !== "youtube_data_api_video_not_found") {
    throw new Error("pause_reason_mismatch");
  }
  if (!Number.isInteger(before.batch.transition_count) || before.batch.transition_count < 0) {
    throw new Error("transition_readback_missing");
  }
  if (before.batch.transition_count !== expectedTransitionCount) {
    throw new Error("transition_readback_mismatch");
  }
  if (!before.batch.idempotency_key) throw new Error("idempotency_key_readback_missing");
  const target = before.quarantineTarget;
  if (!target) throw new Error("pause_target_readback_missing");
  if (target.latest_pause_batch_item_id !== batchItemId
      || target.batch_item_id !== batchItemId) throw new Error("pause_target_mismatch");
  if (target.status !== "pending") throw new Error("target_status_mismatch");
  for (const field of ["run_id", "duration_seconds", "started_at", "completed_at"]) {
    if (!Object.hasOwn(target, field)) throw new Error(`target_${field}_readback_missing`);
    if (target[field] !== null) throw new Error(`target_${field}_not_null`);
  }
  if (!target.source_item_id || !target.youtube_id) throw new Error("target_identity_missing");
  if (!Number.isInteger(target.artifact_count)) throw new Error("artifact_readback_missing");
  if (target.artifact_count !== 0) throw new Error("target_artifact_exists");
  if (!Object.hasOwn(before, "active")) throw new Error("active_readback_missing");
  if (before.active !== null) throw new Error("active_item_exists");
  const causal = Array.isArray(before.acquisitionFailures) ? before.acquisitionFailures[0] : null;
  if (causal?.batchItemId && causal.batchItemId !== batchItemId) {
    throw new Error("causal_item_mismatch");
  }
  if (causal?.sourceItemId && causal.sourceItemId !== target.source_item_id) {
    throw new Error("causal_source_mismatch");
  }
  return { path: "/admin/transcript-batch", options: {
    method: "POST", idempotencyKey: before.batch.idempotency_key,
    body: { action: "quarantine_pending_item", batchId, batchItemId,
      expectedTransitionCount, reasonCode: "source_unavailable",
      observedErrorCode: "youtube_data_api_video_not_found" },
  } };
}

export function safeCode(value, fallback = "unknown_batch_failure") {
  const code = String(value || "");
  return /^[a-z0-9_]{1,120}$/.test(code) ? code : fallback;
}

function acquisitionIncidentClass(incidentClass) {
  return ["batch_paused", "batch_no_progress", "action_receipt_mismatch"]
    .includes(incidentClass);
}

export function incidentFingerprint(condition) {
  const acquisitionScoped = acquisitionIncidentClass(condition.incidentClass);
  return sha256(["batch-incident-v1",
    acquisitionScoped ? (condition.batchId || null) : null,
    acquisitionScoped ? (condition.batchItemId || null) : null,
    condition.incidentClass, condition.safeReasonCode,
    acquisitionScoped ? (condition.causalId || null) : null,
    acquisitionScoped ? (condition.batchTransitionCount ?? null) : null]);
}

export function incidentIdFor(fingerprint) {
  return `binc_${fingerprint.slice(0, 32)}`;
}

export function incidentEventId(incidentId, eventType) {
  return `bine_${sha256(`${incidentId}:${eventType}`).slice(0, 32)}`;
}

export function noticeIdempotencyKey(kind, fingerprint) {
  return `prophecy-ledger/${kind}/${fingerprint}`;
}

function globalIncidentKey(value) {
  const incidentClass = value.incidentClass || value.incident_class;
  const safeReasonCode = value.safeReasonCode || value.safe_reason_code;
  return acquisitionIncidentClass(incidentClass) ? null : `${incidentClass}\0${safeReasonCode}`;
}

export function planIncidentLifecycle(conditions, existing) {
  const byFingerprint = new Map(existing.map((row) => [row.fingerprint_sha256, row]));
  const globalExisting = new Map();
  for (const row of existing) {
    const key = globalIncidentKey(row);
    if (!key) continue;
    if (!globalExisting.has(key)) globalExisting.set(key, []);
    globalExisting.get(key).push(row);
  }
  const resolvedConditions = conditions.map((condition) => {
    const key = globalIncidentKey(condition);
    const exact = byFingerprint.get(condition.fingerprint);
    if (exact && !exact.recovered) return condition;
    if (!key) return condition;
    const semanticRows = globalExisting.get(key) || [];
    const open = semanticRows.find((row) => !row.recovered);
    if (open) {
      return { ...condition, fingerprint: open.fingerprint_sha256,
        incidentId: open.incident_id };
    }
    if (!byFingerprint.has(condition.fingerprint)) return condition;
    const fingerprint = sha256(["batch-incident-episode-v1", condition.fingerprint,
      semanticRows.length + 1]);
    return { ...condition, fingerprint, incidentId: incidentIdFor(fingerprint) };
  });
  const current = new Set(resolvedConditions.map((condition) => condition.fingerprint));
  const opened = resolvedConditions.filter((condition) => !byFingerprint.has(condition.fingerprint));
  const recovered = existing.filter((row) => !row.recovered && !current.has(row.fingerprint_sha256));
  const effective = [...existing, ...opened.map((condition) => ({
    incident_id: condition.incidentId, fingerprint_sha256: condition.fingerprint,
    incident_class: condition.incidentClass, safe_reason_code: condition.safeReasonCode,
    opening_notice_accepted: 0, opening_notice_delivered: 0, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0,
  }))];
  const openingNotices = effective.filter((row) => current.has(row.fingerprint_sha256) &&
    !row.opening_notice_accepted && !row.opening_notice_delivered && !row.opening_notice_failed);
  // Owner email is reserved for current error-level alerts. Recovery remains an
  // append-only incident event and is visible in the watchdog receipt, but it
  // must not create a new email or block a now-healthy pipeline.
  return { opened, recovered, openingNotices, recoveryNotices: [] };
}

export function snapshotHash(snapshot) {
  const batch = snapshot.batch ? { ...snapshot.batch, idempotency_key: undefined } : null;
  return sha256({ batch, byStatus: snapshot.byStatus, mediaToday: snapshot.mediaToday,
    active: snapshot.active, acquisitionFailures: snapshot.acquisitionFailures,
    analysisDebt: snapshot.analysisDebt, queueMetrics: snapshot.queueMetrics });
}

export function validateDailyAction(pre, post, action, response, error = null) {
  if (!action) return { contract: "batch-watchdog-action-v1", action: null, ok: true };
  const errors = [];
  if (error) errors.push("action_call_failed");
  if (!pre.batch || !post.batch || pre.batch.batch_id !== post.batch.batch_id) errors.push("batch_readback_mismatch");
  if (action === "skip_and_resume_paused" && !["running", "completed"].includes(post.batch?.status)) errors.push("paused_batch_not_healed");
  if (action === "skip_and_resume_paused" && !response?.skipped && post.batch?.status !== "completed") errors.push("skip_receipt_missing");
  if (action === "skip_and_resume_paused" && post.batch?.status === "running" &&
      post.active?.dispatch_state !== "sent") errors.push("successor_dispatch_not_sent");
  if (action === "skip_and_resume_paused" && Number(post.batch?.transition_count) <=
      Number(pre.batch?.transition_count)) errors.push("transition_did_not_advance");
  if (action === "skip_and_resume_paused" && Number(post.batch?.completed_item_count) !==
      Number(pre.batch?.completed_item_count)) errors.push("completed_count_changed_during_skip");
  if (action === "repair_running_batch" && post.batch?.status === "running" &&
      post.active?.dispatch_state !== "sent") errors.push("repair_dispatch_not_sent");
  if (action === "resume_paused_batch" && !["running", "completed"].includes(post.batch?.status)) {
    errors.push("paused_batch_not_resumed");
  }
  if (action === "resume_paused_batch" && !response?.resumed && post.batch?.status !== "completed") {
    errors.push("resume_receipt_missing");
  }
  if (action === "resume_paused_batch" && Number(post.batch?.transition_count) <=
      Number(pre.batch?.transition_count) && post.batch?.status === "running") {
    errors.push("transition_did_not_advance");
  }
  if (action === "quarantine_unavailable_item") {
    if (response?.contract !== "transcript-batch-quarantine-v1") errors.push("quarantine_receipt_missing");
    if (!["running", "completed"].includes(post.batch?.status)) errors.push("paused_batch_not_quarantined");
    if (Number(response?.transitionBefore) !== Number(pre.batch?.transition_count) ||
        Number(response?.transitionAfter) !== Number(post.batch?.transition_count)) {
      errors.push("quarantine_transition_mismatch");
    }
    if (Number(post.batch?.completed_item_count) !== Number(pre.batch?.completed_item_count)) {
      errors.push("completed_count_changed_during_quarantine");
    }
    if (Number(post.byStatus?.quarantined || 0) !== Number(pre.byStatus?.quarantined || 0) + 1) {
      errors.push("quarantined_count_did_not_advance");
    }
    if (post.batch?.status === "running" &&
        (post.active?.batch_item_id !== response?.successor?.batchItemId ||
         post.active?.dispatch_state !== "sent")) errors.push("successor_dispatch_not_sent");
  }
  return { contract: "batch-watchdog-action-v1", action, ok: errors.length === 0,
    errors, batchId: post.batch?.batch_id || pre.batch?.batch_id || null,
    statusBefore: pre.batch?.status || null, statusAfter: post.batch?.status || null,
    transitionBefore: pre.batch?.transition_count ?? null,
    transitionAfter: post.batch?.transition_count ?? null };
}

export function formatIncidentNotice(incident, kind, report, remaining = []) {
  const recovery = kind === "recovery";
  const lines = [
    recovery ? "Prophecy Ledger incident recovery" : "Prophecy Ledger incident alert", "",
    `${recovery ? "Recovered incident" : "Incident"}: ${incident.incident_id}`,
    `Class: ${incident.incident_class}`, `Reason: ${incident.safe_reason_code}`,
    `Batch: ${incident.batch_id || "none"}`, `Item: ${incident.batch_item_id || "none"}`,
    `Opened: ${incident.opened_at || "unknown"}`,
    `Safe completed count: ${incident.safe_count ?? "unknown"}`, "",
    `Remaining blocking incidents: ${remaining.length}`,
  ];
  for (const blocker of remaining) {
    lines.push(`- ${blocker.incident_id} ${blocker.incident_class}/${blocker.safe_reason_code}`);
  }
  lines.push("", "Current watchdog receipt:", report);
  return lines.join("\n");
}
