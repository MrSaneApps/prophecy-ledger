import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeEnv } from "./helpers/d1.mjs";
import { analysisDebtCausesSql, analysisDebtSummarySql, buildWatchdogReceipt,
  classifyResendDelivery, currentAcquisitionSql, evaluate,
  effectiveDispositionCountsSql, formatIncidentNotice, incidentFingerprint,
  incidentConditions, isExpectedFuseIncident, noticeIdempotencyKey, physicalMediaSql,
  noticeDeliveryDisposition, noticeEventType, planIncidentLifecycle, reconcileAcquisitionFailures,
  persistentNoticeFailureErrors, prepareQuarantineOperatorRequest, runQuarantineOperatorMode,
  validateAnalysisDebtMetrics, validateDailyAction, validateOperationsStatus,
  validateQuarantineReceipt, writeState
} from "../scripts/batch-watchdog.mjs";

test("effective disposition counts do not collapse all pending rows into quarantined", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE transcript_batch_items (
      batch_item_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,status TEXT NOT NULL
    );
    CREATE TABLE effective_transcript_batch_item_dispositions (batch_item_id TEXT PRIMARY KEY);
    INSERT INTO transcript_batch_items VALUES
      ('target','batch','pending'),('next','batch','active'),
      ('later_a','batch','pending'),('later_b','batch','pending'),
      ('done','batch','completed');
    INSERT INTO effective_transcript_batch_item_dispositions VALUES ('target');`);
  const rows = db.prepare(effectiveDispositionCountsSql("'batch'"))
    .all().map((row) => [row.status, Number(row.n)]);
  assert.deepEqual(rows, [
    ["active", 1], ["completed", 1], ["pending", 2], ["quarantined", 1],
  ]);
});

test("watchdog state writer uses explicit IO and never references hidden dependencies", () => {
  const calls = [];
  writeState({ healthy: true }, {
    outputDir: "/safe/output",
    statePath: "/safe/output/state.json",
    mkdirSync: (...args) => calls.push(["mkdir", ...args]),
    writeFileSync: (...args) => calls.push(["write", ...args]),
  });
  assert.deepEqual(calls, [
    ["mkdir", "/safe/output", { recursive: true }],
    ["write", "/safe/output/state.json", '{\n  "healthy": true\n}\n'],
  ]);
});

function queueReceipt(overrides = {}) {
  const observedAt = "2026-08-02T03:00:00.000Z";
  const names = ["prophecy-ledger-ingestion", "prophecy-ledger-analysis",
    "prophecy-ledger-ingestion-dlq", "prophecy-ledger-analysis-dlq"];
  return { schemaVersion: 1, contract: "queue-operations-status-v1", healthy: true, observedAt,
    queues: names.map((queueName) => ({ queueName, status: "observed", backlogCount: 0,
      backlogBytes: 0, oldestMessageTimestamp: null, safeReasonCode: null, observedAt })),
    ...overrides };
}

function analysisDebt(overrides = {}) {
  return {
    failedSections: 0, failedVideos: 0,
    activeSections: 0, activeVideos: 0,
    inProgressSections: 0, inProgressVideos: 0,
    manualSections: 0, manualVideos: 0,
    supersededSections: 0, supersededVideos: 0,
    debtStateCounts: {
      successor_required: 0, successor_pending: 0, successor_retryable: 0,
      finalization_pending: 0, current_retryable: 0, manual_required: 0,
      superseded: 0,
    },
    safeCauseCounts: {},
    ...overrides,
  };
}

function snap({ status = "paused", pause_reason = "transcript_terminal_error", resume_after = "2020-01-01T00:00:00.000Z",
  completed = 105, item_count = 1097, youtube_id = "5n8QpgQXXaU" } = {}) {
  return {
    at: "2026-08-02T03:00:00.000Z",
    batch: {
      batch_id: "txb_test",
      status,
      pause_reason,
      resume_after,
      completed_item_count: completed,
      item_count,
      idempotency_key: "k",
      transition_count: 3,
    },
    byStatus: { active: 1, completed, pending: item_count - completed - 1, skipped: 0 },
    mediaToday: { used: 0, budget: 86400 },
    active: youtube_id ? { batch_item_id: "txbi_test", youtube_id, duration_seconds: 100,
      last_job_dispatched_at: "2026-08-02T02:00:00.000Z", dispatch_state: "sent" } : null,
    acquisitionFailures: [],
    analysisDebt: analysisDebt(),
    queueMetrics: queueReceipt(),
  };
}

test("paused terminal error with past resume_after queues auto-heal and stays warn-healthy", () => {
  const verdict = evaluate(null, snap());
  assert.equal(verdict.actions.includes("skip_and_resume_paused"), true);
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.alerts.some((a) => a.code === "batch_paused" && a.level === "warn"), true);
  assert.equal(verdict.alerts.some((a) => a.code === "auto_heal_queued"), true);
  assert.equal(verdict.alerts.every((a) => a.level !== "error"), true);
});

test("an injected Gemini billing blocker fails the watchdog without filesystem coupling", () => {
  const billingAlert = { level: "error", code: "gemini_no_charge_stale",
    detail: "The no-charge receipt is stale." };
  const verdict = evaluate(null,
    snap({ status: "running", pause_reason: null, resume_after: null }), { billingAlert });
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.alerts.some((alert) => alert.code === billingAlert.code), true);
});

test("paused terminal/retry_exhausted before resume_after still auto-heals via skip", () => {
  const verdict = evaluate(null, snap({
    pause_reason: "transcript_retry_exhausted",
    resume_after: "2099-01-01T00:00:00.000Z",
  }));
  assert.equal(verdict.actions.includes("skip_and_resume_paused"), true);
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.alerts.some((a) => a.code === "batch_paused" && a.level === "warn"), true);
  assert.equal(verdict.alerts.some((a) => a.code === "auto_heal_queued"), true);
});


test("daily media fuse past resume_after auto-resumes even if today media is still low", () => {
  // After UTC midnight: resume_after is past, today's used is near 0, but pause_reason is still daily_media_cap.
  const current = snap({
    pause_reason: "daily_media_cap",
    resume_after: "2020-01-01T00:00:05.000Z",
  });
  current.mediaToday = { used: 0, budget: 86400 };
  const verdict = evaluate(null, current);
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.actions.includes("resume_paused_batch"), true);
  assert.equal(verdict.alerts.some((a) => a.code === "auto_resume_queued"), true);
  assert.equal(verdict.alerts.some((a) => a.code === "daily_media_fuse_hold"), false);
});

test("daily media fuse with insufficient room for the next request stays warn-only", () => {
  const current = snap({
    pause_reason: "daily_media_cap",
    resume_after: "2099-01-01T00:00:05.000Z",
  });
  current.mediaToday = { used: 86334, budget: 86400 };
  const verdict = evaluate(null, current);
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.actions, []);
  assert.equal(verdict.alerts.some((a) => a.code === "daily_media_fuse_hold"), true);
});

test("exhausted daily media fuse is a healthy scheduled hold without an incident", () => {
  const current = snap({ pause_reason: "daily_media_cap",
    resume_after: "2099-08-03T00:00:05.000Z" });
  current.mediaToday = { used: 86400, budget: 86400 };
  const verdict = evaluate(null, current);
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.actions, []);
  assert.equal(verdict.alerts.some((alert) =>
    alert.code === "daily_media_fuse_hold" && alert.level === "warn"), true);
  assert.equal(verdict.alerts.some((alert) => alert.code === "batch_paused"), false);
  assert.deepEqual(incidentConditions(current, verdict), []);
});

test("existing daily media fuse incident recovers silently and stays suppressed", () => {
  const fuse = {
    incident_id: "binc_fuse", fingerprint_sha256: "f".repeat(64),
    incident_class: "batch_paused", safe_reason_code: "daily_media_cap",
    opening_notice_accepted: 1, opening_notice_delivered: 1, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0,
  };
  assert.equal(isExpectedFuseIncident(fuse), true);
  const recovery = planIncidentLifecycle([], [fuse]);
  assert.deepEqual(recovery.recovered.map((row) => row.incident_id), ["binc_fuse"]);
  assert.deepEqual(recovery.recoveryNotices, []);
  const repeated = planIncidentLifecycle([], [{ ...fuse, recovered: 1 }]);
  assert.deepEqual(repeated.recovered, []);
  assert.deepEqual(repeated.recoveryNotices, []);
});

test("paused for unknown reason does not auto-heal", () => {
  const verdict = evaluate(null, snap({ pause_reason: "manual_operator_hold" }));
  assert.equal(verdict.actions.includes("skip_and_resume_paused"), false);
  assert.equal(verdict.healthy, false);
});

test("non-fuse pause emails while current and recovers without another email", () => {
  const current = snap({ pause_reason: "manual_operator_hold" });
  const verdict = evaluate(null, current);
  assert.equal(verdict.alerts.some((alert) =>
    alert.code === "batch_paused" && alert.level === "error"), true);
  assert.equal(incidentConditions(current, verdict).length, 1);
  const incident = { incident_id: "binc_real", fingerprint_sha256: "e".repeat(64),
    incident_class: "batch_paused", safe_reason_code: "manual_operator_hold",
    opening_notice_accepted: 1, opening_notice_delivered: 1, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0 };
  const recovery = planIncidentLifecycle([], [incident]);
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.recoveryNotices.length, 0);
});

test("paused pristine source-unavailable lookup queues canonical quarantine", () => {
  const current = snap({ pause_reason: "youtube_data_api_video_not_found", youtube_id: null });
  current.active = null;
  current.quarantineTarget = {
    latest_pause_batch_item_id: "txbi_target", batch_item_id: "txbi_target",
    source_item_id: "src_target", youtube_id: "MissingVideo", status: "pending",
    run_id: null, duration_seconds: null, started_at: null, completed_at: null,
    artifact_count: 0,
  };
  const verdict = evaluate(null, current);
  assert.deepEqual(verdict.actions, ["quarantine_unavailable_item"]);
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.alerts.some((alert) =>
    alert.code === "auto_quarantine_queued" && alert.level === "warn"), true);
});

test("source-unavailable lookup with any unsafe target state remains blocked", () => {
  const current = snap({ pause_reason: "youtube_data_api_video_not_found", youtube_id: null });
  current.active = null;
  current.quarantineTarget = {
    latest_pause_batch_item_id: "txbi_target", batch_item_id: "txbi_target",
    source_item_id: "src_target", youtube_id: "MissingVideo", status: "pending",
    run_id: null, duration_seconds: null, started_at: null, completed_at: null,
    artifact_count: 1,
  };
  const verdict = evaluate(null, current);
  assert.deepEqual(verdict.actions, []);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.alerts.some((alert) =>
    alert.code === "batch_paused" && alert.level === "error"), true);
});

test("running batch without stall is healthy", () => {
  const verdict = evaluate(null, snap({ status: "running", pause_reason: null, resume_after: null }));
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.actions, []);
});

test("historical failed acquisition with a later artifact or completed item is not current", () => {
  const base = { batch_id: "txb_a", batch_status: "running", batch_item_id: "txbi_a",
    source_item_id: "src_a", item_status: "active", latest_pause_item_id: null,
    job_status: "failed", error_code: "gemini_http_500", transition_count: 2 };
  assert.deepEqual(reconcileAcquisitionFailures([
    { ...base, artifact_count: 1, completed_item_count: 0, disposition_count: 0 },
    { ...base, artifact_count: 0, completed_item_count: 1, disposition_count: 0 },
    { ...base, artifact_count: 0, completed_item_count: 0, disposition_count: 1 },
  ]), []);
  assert.equal(reconcileAcquisitionFailures([
    { ...base, artifact_count: 0, completed_item_count: 0, disposition_count: 0 },
  ]).length, 1);
  assert.deepEqual(reconcileAcquisitionFailures([
    { ...base, job_id: "job_later", job_status: "completed", error_code: null,
      artifact_count: 0, completed_item_count: 0, disposition_count: 0 },
    { ...base, job_id: "job_older", job_status: "failed",
      artifact_count: 0, completed_item_count: 0, disposition_count: 0 },
  ]), []);
});

test("analysis debt blocks health without being mislabeled as acquisition failure", () => {
  const current = snap({ status: "running", pause_reason: null, resume_after: null });
  current.analysisDebt = analysisDebt({ failedSections: 139, failedVideos: 78,
    activeSections: 139, activeVideos: 78,
    safeCauseCounts: { model_unavailable: 139 } });
  const verdict = evaluate(null, current);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.alerts.some((alert) => alert.code === "analysis_reconciliation_blocked"), true);
  assert.equal(verdict.alerts.some((alert) => alert.code === "current_acquisition_failure"), false);
});

test("missing analysis debt metrics block health", () => {
  const current = snap({ status: "running", pause_reason: null, resume_after: null });
  current.analysisDebt = null;
  const verdict = evaluate(null, current);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.alerts.some((alert) =>
    alert.code === "analysis_reconciliation_metrics_missing"), true);
});

test("missing queue metrics, non-empty DLQ, and stale backlog fail closed", () => {
  assert.equal(validateOperationsStatus(null, "2026-08-02T03:00:00.000Z")[0].code,
    "queue_metrics_missing");
  const status = queueReceipt();
  status.queues.find((queue) => queue.queueName.endsWith("ingestion-dlq")).backlogCount = 1;
  status.queues.find((queue) => queue.queueName === "prophecy-ledger-analysis").backlogCount = 2;
  status.queues.find((queue) => queue.queueName === "prophecy-ledger-analysis").oldestMessageTimestamp =
    "2026-08-01T20:00:00.000Z";
  const alerts = validateOperationsStatus(status, "2026-08-02T03:00:00.000Z");
  assert.equal(alerts.some((alert) => alert.code === "queue_dlq_nonzero"), true);
  assert.equal(alerts.some((alert) => alert.code === "queue_backlog_stale"), true);
});

test("completed batch remains blocked by downstream analysis debt or queue failure", () => {
  const current = snap({ status: "completed", pause_reason: null, resume_after: null });
  current.analysisDebt.failedSections = 1;
  current.analysisDebt.activeSections = 1;
  current.analysisDebt.activeVideos = 1;
  const verdict = evaluate(null, current);
  assert.equal(verdict.done, true);
  assert.equal(verdict.healthy, false);
});

test("analysis lineage debt summary preserves compatibility counts and excludes superseded history", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE analysis_section_lineage_v2 (
      debt_state TEXT NOT NULL,source_item_id TEXT NOT NULL,
      successor_error_code TEXT,successor_job_error_code TEXT,
      source_error_code TEXT,source_job_error_code TEXT
    );
    INSERT INTO analysis_section_lineage_v2 VALUES
      ('successor_required','video-a',NULL,NULL,'model_unavailable',NULL),
      ('successor_pending','video-a',NULL,NULL,'model_unavailable',NULL),
      ('manual_required','video-b',NULL,NULL,'human_gate',NULL),
      ('superseded','video-c',NULL,NULL,'historical_error',NULL);`);
  const summary = db.prepare(analysisDebtSummarySql()).get();
  assert.equal(Number(summary.failed_sections), 2);
  assert.equal(Number(summary.failed_videos), 2);
  assert.equal(Number(summary.active_sections), 1);
  assert.equal(Number(summary.in_progress_sections), 1);
  assert.equal(Number(summary.manual_sections), 1);
  assert.equal(Number(summary.superseded_sections), 1);
  assert.deepEqual(db.prepare(analysisDebtCausesSql()).all().map((row) =>
    [row.safe_cause_code, Number(row.count)]), [
    ["human_gate", 1], ["model_unavailable", 1],
  ]);
});

test("analysis lineage severity distinguishes active, manual, in-progress, and superseded states", () => {
  assert.deepEqual(validateAnalysisDebtMetrics(analysisDebt()), []);
  const active = validateAnalysisDebtMetrics(analysisDebt({
    failedSections: 1, failedVideos: 1, activeSections: 1, activeVideos: 1,
  }));
  assert.equal(active.some((alert) => alert.level === "error"
    && alert.code === "analysis_reconciliation_blocked"), true);
  const manual = validateAnalysisDebtMetrics(analysisDebt({
    failedSections: 1, failedVideos: 1, manualSections: 1, manualVideos: 1,
  }));
  assert.equal(manual.some((alert) => alert.level === "error"
    && alert.code === "analysis_reconciliation_manual_required"), true);
  const pending = validateAnalysisDebtMetrics(analysisDebt({
    inProgressSections: 1, inProgressVideos: 1,
  }));
  assert.deepEqual(pending.map(({ level, code }) => ({ level, code })), [{
    level: "warn", code: "analysis_reconciliation_in_progress",
  }]);
  const superseded = validateAnalysisDebtMetrics(analysisDebt({
    supersededSections: 1, supersededVideos: 1,
  }));
  assert.deepEqual(superseded.map(({ level, code }) => ({ level, code })), [{
    level: "info", code: "analysis_reconciliation_superseded",
  }]);
});

test("in-progress and superseded lineage receipts do not produce false watchdog failures", () => {
  for (const debt of [
    analysisDebt({ inProgressSections: 2, inProgressVideos: 1 }),
    analysisDebt({ supersededSections: 139, supersededVideos: 78 }),
  ]) {
    const current = snap({ status: "running", pause_reason: null, resume_after: null });
    current.analysisDebt = debt;
    const verdict = evaluate(null, current);
    assert.equal(verdict.healthy, true);
    assert.equal(verdict.alerts.some((alert) => alert.level === "error"), false);
  }
});

test("watchdog follows historical manual recovery through finalization to superseded", () => {
  const current = snap({ status: "running", pause_reason: null, resume_after: null });
  current.analysisDebt = analysisDebt({
    failedSections: 1, failedVideos: 1, manualSections: 1, manualVideos: 1,
    debtStateCounts: { ...analysisDebt().debtStateCounts, manual_required: 1 },
  });
  const manual = evaluate(null, current);
  assert.equal(manual.healthy, false);
  assert.equal(manual.alerts.some((alert) =>
    alert.code === "analysis_reconciliation_manual_required"), true);

  current.analysisDebt = analysisDebt({
    failedSections: 1, failedVideos: 1, activeSections: 1, activeVideos: 1,
    debtStateCounts: { ...analysisDebt().debtStateCounts, finalization_pending: 1 },
  });
  const finalization = evaluate(null, current);
  assert.equal(finalization.healthy, false);
  assert.equal(finalization.alerts.some((alert) =>
    alert.code === "analysis_reconciliation_blocked"), true);
  assert.equal(finalization.alerts.some((alert) =>
    alert.code === "analysis_reconciliation_manual_required"), false);

  current.analysisDebt = analysisDebt({
    supersededSections: 1, supersededVideos: 1,
    debtStateCounts: { ...analysisDebt().debtStateCounts, superseded: 1 },
  });
  const superseded = evaluate(null, current);
  assert.equal(superseded.healthy, true);
  assert.equal(superseded.alerts.some((alert) =>
    alert.code === "analysis_reconciliation_superseded"), true);
});

test("current acquisition SQL executes against isolated D1 and returns only the causal pause job", () => {
  const env = makeEnv();
  const db = env.DB.db;
  const batchId = `txb_${"a".repeat(32)}`;
  const itemId = `txbi_${"a".repeat(32)}_${"b".repeat(32)}`;
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
    VALUES ('src_watchdog','person_troy_black','youtube','watchdog-video','https://youtube.test/watchdog',?,?, 'available')`)
    .run("2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z");
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES ('run_watchdog','person_troy_black','manual','watchdog-test','failed',?)`)
    .run("2026-08-02T00:00:00.000Z");
  db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,completed_at,error_code)
    VALUES ('job_watchdog','run_watchdog','transcript_extract','watchdog','{}','failed',1,?,'gemini_http_500')`)
    .run("2026-08-02T01:00:00.000Z");
  db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,pause_reason,resume_after,created_at,started_at,paused_at,transition_count)
    VALUES (?,'watchdog-key','person_troy_black','paused',1,'transcript_terminal_error',?,?,?, ?,4)`)
    .run(batchId, "2026-08-03T00:00:00.000Z", "2026-08-02T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z", "2026-08-02T02:00:00.000Z");
  db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,ordinal,status,run_id,duration_seconds,started_at,dispatch_state)
    VALUES (?,?,'src_watchdog','watchdog-video',1,'active','run_watchdog',120,?,'sent')`)
    .run(itemId, batchId, "2026-08-02T00:00:00.000Z");
  db.prepare(`INSERT INTO transcript_batch_events
    (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
    VALUES ('event_pause',?,?,'batch_paused',?,?)`)
    .run(batchId, itemId, JSON.stringify({ jobId: "job_watchdog" }), "2026-08-02T02:00:00.000Z");
  const rows = db.prepare(currentAcquisitionSql(batchId)).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pause_job_id, "job_watchdog");
  assert.equal(reconcileAcquisitionFailures(rows)[0].causalId, "event_pause");
});

test("physical media SQL charges physical reservations plus cutover debit only", () => {
  const env = makeEnv();
  const db = env.DB.db;
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,first_discovered_at,last_seen_at,availability)
    VALUES ('src_media','person_troy_black','youtube','media-video','https://youtube.test/media',?,?, 'available')`)
    .run("2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z");
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES ('run_media','person_troy_black','manual','media-test','failed',?)`)
    .run("2026-08-03T00:00:00.000Z");
  db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,completed_at,error_code)
    VALUES ('job_media','run_media','transcript_extract','media','{}','failed',1,?,'gemini_http_500')`)
    .run("2026-08-03T00:01:00.000Z");
  db.prepare(`INSERT INTO gemini_media_reservations
    (reservation_id,media_day,run_id,job_id,source_item_id,chunk_index,job_attempt,start_seconds,end_seconds,reserved_seconds,budget_limit_seconds,created_at)
    VALUES ('logical_media','2026-08-03','run_media','job_media','src_media',0,1,0,100,100,86400,?)`)
    .run("2026-08-03T00:01:00.000Z");
  db.prepare(`INSERT INTO gemini_physical_day_debits
    (debit_id,media_day,reserved_seconds,reason,created_at)
    VALUES ('debit_media','2026-08-03',10,'legacy_cutover_fail_closed',?)`)
    .run("2026-08-03T00:01:00.000Z");
  db.prepare(`INSERT INTO gemini_physical_request_reservations
    (physical_request_id,logical_reservation_id,media_day,run_id,job_id,source_item_id,chunk_index,
     job_attempt,split_path,start_seconds,end_seconds,reserved_seconds,budget_limit_seconds,created_at)
    VALUES ('physical_media','logical_media','2026-08-03','run_media','job_media','src_media',0,
      1,'root',0,40,40,86400,?)`).run("2026-08-03T00:02:00.000Z");
  const row = db.prepare(physicalMediaSql("2026-08-03")).get();
  assert.deepEqual({ request: row.request_seconds, debit: row.debit_seconds }, { request: 40, debit: 10 });
  assert.deepEqual({ request: db.prepare(physicalMediaSql("2026-08-03", { ignoreLegacyCutover: true })).get().request_seconds,
    debit: db.prepare(physicalMediaSql("2026-08-03", { ignoreLegacyCutover: true })).get().debit_seconds },
    { request: 40, debit: 10 });
});

test("Resend acceptance stays pending until an official delivery event", () => {
  assert.deepEqual(classifyResendDelivery("sent"), { status: "pending", lastEvent: "sent" });
  assert.deepEqual(classifyResendDelivery("delivery_delayed"),
    { status: "pending", lastEvent: "delivery_delayed" });
  assert.deepEqual(classifyResendDelivery("delivered"),
    { status: "delivered", lastEvent: "delivered" });
  assert.deepEqual(classifyResendDelivery("bounced"), { status: "failed", lastEvent: "bounced" });
  assert.equal(noticeEventType("opening", classifyResendDelivery("sent").status), null);
  assert.equal(noticeEventType("opening", classifyResendDelivery("delivered").status),
    "opening_notice_delivered");
  assert.equal(noticeEventType("recovery", classifyResendDelivery("bounced").status),
    "recovery_notice_failed");
  assert.deepEqual(noticeDeliveryDisposition("opening", "pending"),
    { eventType: null, pending: true, blocking: false });
  assert.deepEqual(noticeDeliveryDisposition("recovery", "failed"),
    { eventType: "recovery_notice_failed", pending: false, blocking: false });
});

test("ordinary accepted-sent notice stays nonblocking while delivery remains incomplete", () => {
  const pre = snap({ status: "running", pause_reason: null, resume_after: null });
  const post = structuredClone(pre);
  const actionReceipt = validateDailyAction(pre, post, null, null);
  const pendingLifecycle = { opened: [], recovered: [], openingAccepted: ["binc_pending"],
    openingNotices: [], openingPending: ["binc_pending"], recoveryAccepted: [],
    recoveryNotices: [], recoveryPending: [], deliveryComplete: false, errors: [] };
  const receipt = buildWatchdogReceipt({ pre, post, verdict: evaluate(null, post), actionReceipt,
    lifecycle: pendingLifecycle, receiptPath: "/ignored/watchdog.json" });
  assert.equal(receipt.healthy, true, "provider sent state must not trigger a native failed run");
  assert.equal(receipt.incidents.deliveryComplete, false);
  assert.deepEqual(receipt.incidents.openingPending, ["binc_pending"]);
  assert.deepEqual(receipt.incidents.openingNotices, [],
    "pending provider state must never masquerade as confirmed delivery");
});

test("bounced notice remains a blocking lifecycle failure", () => {
  const pre = snap({ status: "running", pause_reason: null, resume_after: null });
  const post = structuredClone(pre);
  const actionReceipt = validateDailyAction(pre, post, null, null);
  const failedLifecycle = { opened: [], recovered: [], openingAccepted: [],
    openingNotices: [], openingPending: [], recoveryAccepted: [], recoveryNotices: [],
    recoveryPending: [], deliveryComplete: false, errors: ["opening_notice_failed:binc_bounced"] };
  const receipt = buildWatchdogReceipt({ pre, post, verdict: evaluate(null, post), actionReceipt,
    lifecycle: failedLifecycle, receiptPath: "/ignored/watchdog.json" });
  assert.equal(receipt.healthy, false);
  assert.equal(receipt.incidents.deliveryComplete, false);
  assert.deepEqual(persistentNoticeFailureErrors([{ incident_id: "binc_bounced",
    opening_notice_failed: 1, recovery_notice_failed: 0 }]),
  ["opening_notice_failed:binc_bounced"]);
});

test("failed recovery delivery is historical and cannot block a recovered pipeline", () => {
  assert.deepEqual(persistentNoticeFailureErrors([{ incident_id: "binc_recovered",
    opening_notice_failed: 0, recovery_notice_failed: 1 }]), []);
  const pre = snap({ status: "running", pause_reason: null, resume_after: null });
  const post = structuredClone(pre);
  const actionReceipt = validateDailyAction(pre, post, null, null);
  const receipt = buildWatchdogReceipt({ pre, post, verdict: evaluate(null, post), actionReceipt,
    lifecycle: { opened: [], recovered: ["binc_recovered"], openingAccepted: [],
      openingNotices: [], openingPending: [], recoveryAccepted: [], recoveryNotices: [],
      recoveryPending: [], deliveryComplete: true, errors: [] },
    receiptPath: "/ignored/watchdog.json" });
  assert.equal(receipt.healthy, true);
  assert.equal(receipt.incidents.deliveryComplete, true);
  assert.deepEqual(receipt.incidents.recovered, ["binc_recovered"]);
});

test("incident plan emits one opening and one recovery with deterministic notice keys", () => {
  const condition = { batchId: "txb_a", batchItemId: "txbi_a", incidentClass: "batch_paused",
    safeReasonCode: "transcript_terminal_error", causalId: "job_a", batchTransitionCount: 4 };
  condition.fingerprint = incidentFingerprint(condition);
  condition.incidentId = `binc_${condition.fingerprint.slice(0, 32)}`;
  const first = planIncidentLifecycle([condition], []);
  assert.equal(first.opened.length, 1);
  assert.equal(first.openingNotices.length, 1);
  assert.equal(noticeIdempotencyKey("opening", condition.fingerprint),
    `prophecy-ledger/opening/${condition.fingerprint}`);

  const accepted = { incident_id: condition.incidentId, fingerprint_sha256: condition.fingerprint,
    opening_notice_accepted: 1, opening_notice_delivered: 0, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0 };
  assert.equal(planIncidentLifecycle([condition], [accepted]).openingNotices.length, 0,
    "provider acceptance must prevent a duplicate POST while delivery readback is pending");

  const opened = { incident_id: condition.incidentId, fingerprint_sha256: condition.fingerprint,
    opening_notice_accepted: 1, opening_notice_delivered: 1, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0 };
  const repeated = planIncidentLifecycle([condition], [opened]);
  assert.equal(repeated.opened.length, 0);
  assert.equal(repeated.openingNotices.length, 0);
  const recovery = planIncidentLifecycle([], [opened]);
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.recoveryNotices.length, 0,
    "recovery is durable state, not a new owner email");
  assert.equal(noticeIdempotencyKey("recovery", condition.fingerprint),
    `prophecy-ledger/recovery/${condition.fingerprint}`);
  const closed = planIncidentLifecycle([], [{ ...opened, recovered: 1,
    recovery_notice_delivered: 1 }]);
  assert.equal(closed.recovered.length, 0);
  assert.equal(closed.recoveryNotices.length, 0);
});

test("unchanged global analysis debt keeps one incident across transcript transitions", () => {
  const first = {
    batchId: "txb_a", batchItemId: null,
    incidentClass: "analysis_reconciliation_blocked",
    safeReasonCode: "analysis_reconciliation_blocked", causalId: null,
    batchTransitionCount: 4, safeCount: 160,
  };
  first.fingerprint = incidentFingerprint(first);
  first.incidentId = `binc_${first.fingerprint.slice(0, 32)}`;
  const progressed = { ...first, batchTransitionCount: 5, safeCount: 161 };
  progressed.fingerprint = incidentFingerprint(progressed);
  progressed.incidentId = `binc_${progressed.fingerprint.slice(0, 32)}`;
  assert.equal(progressed.fingerprint, first.fingerprint);
  const existing = [{
    incident_id: first.incidentId, fingerprint_sha256: first.fingerprint,
    opening_notice_accepted: 1, opening_notice_delivered: 1, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0,
  }];
  const repeated = planIncidentLifecycle([progressed], existing);
  assert.equal(repeated.opened.length, 0);
  assert.equal(repeated.recovered.length, 0);
  assert.equal(repeated.openingNotices.length, 0);

  const acquisition = { batchId: "txb_a", batchItemId: "txbi_a",
    incidentClass: "batch_paused", safeReasonCode: "transcript_terminal_error",
    causalId: "job_a", batchTransitionCount: 4 };
  assert.notEqual(incidentFingerprint(acquisition),
    incidentFingerprint({ ...acquisition, batchTransitionCount: 5 }));
});

test("legacy open global incident is reused without opening or recovering during fingerprint cutover", () => {
  const condition = {
    batchId: "txb_a", batchItemId: null,
    incidentClass: "analysis_reconciliation_blocked",
    safeReasonCode: "analysis_reconciliation_blocked", causalId: null,
    batchTransitionCount: 9, safeCount: 161,
  };
  condition.fingerprint = incidentFingerprint(condition);
  condition.incidentId = `binc_${condition.fingerprint.slice(0, 32)}`;
  const legacyFingerprint = "a".repeat(64);
  const legacy = {
    incident_id: `binc_${legacyFingerprint.slice(0, 32)}`,
    fingerprint_sha256: legacyFingerprint,
    incident_class: condition.incidentClass,
    safe_reason_code: condition.safeReasonCode,
    opening_notice_accepted: 1, opening_notice_delivered: 1, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0,
  };
  const planned = planIncidentLifecycle([condition], [legacy]);
  assert.equal(planned.opened.length, 0);
  assert.equal(planned.recovered.length, 0);
  assert.equal(planned.openingNotices.length, 0);
  assert.equal(planned.recoveryNotices.length, 0);
});

test("recovered global condition opens one deterministic recurrence episode and reuses it", () => {
  const condition = {
    batchId: "txb_a", batchItemId: null,
    incidentClass: "analysis_reconciliation_blocked",
    safeReasonCode: "analysis_reconciliation_blocked", causalId: null,
    batchTransitionCount: 9, safeCount: 161,
  };
  condition.fingerprint = incidentFingerprint(condition);
  condition.incidentId = `binc_${condition.fingerprint.slice(0, 32)}`;
  const prior = {
    incident_id: condition.incidentId, fingerprint_sha256: condition.fingerprint,
    incident_class: condition.incidentClass, safe_reason_code: condition.safeReasonCode,
    opening_notice_accepted: 1, opening_notice_delivered: 1, opening_notice_failed: 0,
    recovered: 1, recovery_notice_accepted: 1, recovery_notice_delivered: 1,
    recovery_notice_failed: 0,
  };
  const recurrence = planIncidentLifecycle([condition], [prior]);
  assert.equal(recurrence.opened.length, 1);
  assert.equal(recurrence.recovered.length, 0);
  assert.equal(recurrence.openingNotices.length, 1);
  assert.notEqual(recurrence.opened[0].fingerprint, condition.fingerprint);
  const episode = {
    incident_id: recurrence.opened[0].incidentId,
    fingerprint_sha256: recurrence.opened[0].fingerprint,
    incident_class: condition.incidentClass, safe_reason_code: condition.safeReasonCode,
    opening_notice_accepted: 1, opening_notice_delivered: 1, opening_notice_failed: 0,
    recovered: 0, recovery_notice_accepted: 0, recovery_notice_delivered: 0,
    recovery_notice_failed: 0,
  };
  const repeated = planIncidentLifecycle([condition], [prior, episode]);
  assert.equal(repeated.opened.length, 0);
  assert.equal(repeated.recovered.length, 0);
  assert.equal(repeated.openingNotices.length, 0);
});

test("recovery notice names the exact recovered incident and every remaining blocker", () => {
  const recovered = { incident_id: "binc_recovered", incident_class: "batch_no_progress",
    safe_reason_code: "active_item_stale", batch_id: "txb_a", batch_item_id: "txbi_a",
    opened_at: "2026-08-02T00:00:00.000Z", safe_count: 12 };
  const text = formatIncidentNotice(recovered, "recovery", "watchdog report", [
    { incident_id: "binc_still_open", incident_class: "queue_dlq",
      safe_reason_code: "queue_dlq_nonzero" },
  ]);
  assert.match(text, /Recovered incident: binc_recovered/);
  assert.match(text, /Class: batch_no_progress/);
  assert.match(text, /Reason: active_item_stale/);
  assert.match(text, /Remaining blocking incidents: 1/);
  assert.match(text, /binc_still_open queue_dlq\/queue_dlq_nonzero/);
});

test("0044 incident history is append-only and one event type can be recorded once", () => {
  const env = makeEnv();
  const db = env.DB.db;
  db.prepare(`INSERT INTO batch_incidents
    (incident_id,fingerprint_sha256,fingerprint_version,incident_class,safe_reason_code,
     causal_id,batch_transition_count,safe_count,opened_at)
    VALUES ('binc_test',?,'batch-incident-v1','queue_dlq','queue_dlq_nonzero',NULL,NULL,2,?)`)
    .run("a".repeat(64), "2026-08-03T10:00:00.000Z");
  db.prepare(`INSERT INTO batch_incident_events
    (incident_event_id,incident_id,event_type,created_at)
    VALUES ('bine_open','binc_test','opened','2026-08-03T10:00:00.000Z')`).run();
  db.prepare(`INSERT INTO batch_incident_events
    (incident_event_id,incident_id,event_type,provider_message_id,created_at)
    VALUES ('bine_accepted','binc_test','opening_notice_accepted','resend_message_1',
      '2026-08-03T10:00:01.000Z')`).run();
  const acceptedOnly = db.prepare(
    "SELECT opening_notice_accepted,opening_notice_delivered FROM current_batch_incidents WHERE incident_id='binc_test'"
  ).get();
  assert.deepEqual({ accepted: acceptedOnly.opening_notice_accepted,
    delivered: acceptedOnly.opening_notice_delivered }, { accepted: 1, delivered: 0 });
  const verifiedEvent = noticeEventType("opening", classifyResendDelivery("delivered").status);
  db.prepare(`INSERT INTO batch_incident_events
    (incident_event_id,incident_id,event_type,provider_message_id,created_at)
    VALUES ('bine_delivered','binc_test',?,'resend_message_1','2026-08-03T10:00:02.000Z')`)
    .run(verifiedEvent);
  assert.throws(() => db.prepare(`INSERT INTO batch_incident_events
    (incident_event_id,incident_id,event_type,created_at)
    VALUES ('bine_open_again','binc_test','opened','2026-08-03T10:01:00.000Z')`).run(), /UNIQUE/);
  assert.throws(() => db.exec("UPDATE batch_incidents SET safe_count=3 WHERE incident_id='binc_test'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM batch_incident_events WHERE incident_id='binc_test'"), /append-only/);
  const row = db.prepare("SELECT * FROM current_batch_incidents WHERE incident_id='binc_test'").get();
  assert.equal(row.opening_notice_accepted, 1);
  assert.equal(row.opening_provider_message_id, "resend_message_1");
  assert.equal(row.opening_notice_delivered, 1);
  assert.equal(row.recovered, 0);
});

test("watchdog v2 receipt is derived from the fresh post-action snapshot", () => {
  const pre = snap({ status: "paused", completed: 105 });
  const post = snap({ status: "running", pause_reason: null, resume_after: null, completed: 105 });
  post.at = "2026-08-03T04:00:00.000Z";
  post.active.last_job_dispatched_at = "2026-08-03T03:59:00.000Z";
  post.batch.transition_count = 4;
  post.byStatus.completed = 105;
  post.byStatus.pending = 990;
  post.byStatus.quarantined = 1;
  const actionReceipt = validateDailyAction(pre, post, "skip_and_resume_paused", { skipped: true });
  const receipt = buildWatchdogReceipt({ pre, post, verdict: evaluate(null, post), actionReceipt,
    lifecycle: { opened: [], recovered: [], openingNotices: [], recoveryNotices: [], errors: [] },
    receiptPath: "/ignored/watchdog.json" });
  assert.equal(receipt.contract, "batch-watchdog-v2");
  assert.equal(receipt.counts.completed, 105);
  assert.equal(receipt.counts.actionablePending, 990);
  assert.equal(receipt.counts.disposed, 1);
  assert.notEqual(receipt.preActionSnapshotSha256, receipt.postActionSnapshotSha256);
  assert.equal(receipt.healthy, true);
});

test("daily quarantine action requires exact receipt, count, transition, and successor read-back", () => {
  const pre = snap({ status: "paused", pause_reason: "youtube_data_api_video_not_found", completed: 105 });
  pre.active = null;
  pre.byStatus = { completed: 105, pending: 991, quarantined: 1, skipped: 0 };
  const post = snap({ status: "running", pause_reason: null, resume_after: null, completed: 105 });
  post.batch.transition_count = 4;
  post.byStatus = { completed: 105, pending: 990, quarantined: 2, skipped: 0 };
  post.active = { batch_item_id: "txbi_successor", dispatch_state: "sent" };
  const response = { contract: "transcript-batch-quarantine-v1",
    transitionBefore: 3, transitionAfter: 4,
    successor: { batchItemId: "txbi_successor" } };
  assert.equal(validateDailyAction(pre, post, "quarantine_unavailable_item", response).ok, true);
  const badCount = structuredClone(post);
  badCount.byStatus.quarantined = 1;
  assert.equal(validateDailyAction(pre, badCount, "quarantine_unavailable_item", response).errors
    .includes("quarantined_count_did_not_advance"), true);
  const badSuccessor = structuredClone(post);
  badSuccessor.active.dispatch_state = "pending";
  assert.equal(validateDailyAction(pre, badSuccessor, "quarantine_unavailable_item", response).errors
    .includes("successor_dispatch_not_sent"), true);
});

function quarantineFixture() {
  const before = { batch: { batch_id: "txb_a", item_count: 3, completed_item_count: 1,
    transition_count: 4 }, quarantineTarget: { batch_item_id: "txbi_target",
    source_item_id: "source_target", youtube_id: "SafeVideo01" },
  preservation: { sha256: "preserved" } };
  const action = { contract: "transcript-batch-quarantine-v1", quarantined: true,
    dispositionId: "txbd_a", batchId: "txb_a", batchItemId: "txbi_target",
    reasonCode: "source_unavailable", observedErrorCode: "youtube_data_api_video_not_found",
    transitionBefore: 4, transitionAfter: 5,
    successor: { batchItemId: "txbi_successor" } };
  const after = {
    batch: { batch_id: "txb_a", status: "running", item_count: 3,
      completed_item_count: 1, transition_count: 5 },
    target: { batch_item_id: "txbi_target", source_item_id: "source_target",
      youtube_id: "SafeVideo01", status: "pending", run_id: null,
      duration_seconds: null, started_at: null, completed_at: null },
    disposition: { disposition_id: "txbd_a", batch_id: "txb_a", batch_item_id: "txbi_target",
      source_item_id: "source_target", successor_batch_item_id: "txbi_successor",
      reason_code: "source_unavailable", observed_error_code: "youtube_data_api_video_not_found",
      expected_transition_count: 4, applied_transition_count: 5 }, dispositionCount: 1, batchDispositionCount: 1,
    counts: { completed: 1, active: 1, pending: 0, quarantined: 1, skipped: 0 },
    successor: { batch_item_id: "txbi_successor", dispatch_state: "sent" },
    preservation: { sha256: "preserved" },
  };
  return { before, action, after };
}

test("quarantine receipt requires a fresh agreeing D1 read-back", () => {
  const fixture = quarantineFixture();
  assert.deepEqual(validateQuarantineReceipt(fixture.before, fixture.action, fixture.after,
    { batchId: "txb_a", batchItemId: "txbi_target", expectedTransitionCount: 4 }),
    { ok: true, errors: [] });
});

test("HTTP action receipt without preserved agreeing D1 state is rejected", () => {
  const fixture = quarantineFixture();
  fixture.after.successor.dispatch_state = "pending";
  fixture.after.preservation.sha256 = "changed";
  const result = validateQuarantineReceipt(fixture.before, fixture.action, fixture.after,
    { batchId: "txb_a", batchItemId: "txbi_target", expectedTransitionCount: 4 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("successor_not_dispatched"));
  assert.ok(result.errors.includes("preservation_hash_changed"));
});
test("quarantine receipt rejects redistributed counts that still sum to the batch total", () => {
  const fixture = quarantineFixture();
  fixture.after.counts = { completed: 1, active: 1, pending: 1, quarantined: 0, skipped: 0 };
  const result = validateQuarantineReceipt(fixture.before, fixture.action, fixture.after,
    { batchId: "txb_a", batchItemId: "txbi_target", expectedTransitionCount: 4 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("quarantined_count_disagrees"));
  assert.equal(result.errors.includes("effective_counts_do_not_sum"), false);
});


const OP_BATCH = `txb_${"a".repeat(32)}`;
const OP_ITEM = `txbi_${"b".repeat(32)}_${"c".repeat(32)}`;
const OP_SUCCESSOR = `txbi_${"d".repeat(32)}_${"e".repeat(32)}`;
const OP_DISPOSITION = `txbd_${"f".repeat(32)}`;

function operatorFixture(transitionCount = 32) {
  const preservation = { sha256: "1".repeat(64) };
  const before = { batch: { batch_id: OP_BATCH, idempotency_key: "exact-batch-operation-key",
    status: "paused", pause_reason: "youtube_data_api_video_not_found", item_count: 1097,
    completed_item_count: 160, transition_count: transitionCount },
  quarantineTarget: { latest_pause_batch_item_id: OP_ITEM, batch_item_id: OP_ITEM,
    source_item_id: "source_target", youtube_id: "SafeVideo01", status: "pending",
    run_id: null, duration_seconds: null, started_at: null, completed_at: null,
    artifact_count: 0 }, active: null,
  acquisitionFailures: [{ batchItemId: OP_ITEM, sourceItemId: "source_target" }],
  byStatus: { completed: 160, pending: 937 } };
  const action = { contract: "transcript-batch-quarantine-v1", quarantined: true,
    dispositionId: OP_DISPOSITION, batchId: OP_BATCH, batchItemId: OP_ITEM,
    reasonCode: "source_unavailable", observedErrorCode: "youtube_data_api_video_not_found",
    applied: true, reused: false,
    transitionBefore: transitionCount, transitionAfter: transitionCount + 1,
    successor: { batchItemId: OP_SUCCESSOR } };
  const after = { batch: { batch_id: OP_BATCH, status: "running", item_count: 1097,
    completed_item_count: 160, transition_count: transitionCount + 1 },
  target: { batch_item_id: OP_ITEM, source_item_id: "source_target", youtube_id: "SafeVideo01",
    status: "pending", run_id: null, duration_seconds: null, started_at: null,
    completed_at: null }, disposition: { disposition_id: OP_DISPOSITION, batch_id: OP_BATCH,
    batch_item_id: OP_ITEM, source_item_id: "source_target",
    successor_batch_item_id: OP_SUCCESSOR, reason_code: "source_unavailable",
    observed_error_code: "youtube_data_api_video_not_found",
    expected_transition_count: transitionCount, applied_transition_count: transitionCount + 1 },
  dispositionCount: 1, batchDispositionCount: 1, counts: { completed: 160, active: 1, pending: 935,
    quarantined: 1, skipped: 0 }, successor: { batch_item_id: OP_SUCCESSOR,
    youtube_id: "SafeVideo01", status: "active", dispatch_state: "sent" }, preservation };
  return { before, action, after, preservation };
}

test("quarantine operator rejects every ineligible snapshot before admin", () => {
  const variants = [
    ["missing transition", (f) => { delete f.before.batch.transition_count; }, 32,
      "transition_readback_missing"],
    ["stale transition", () => {}, 33, "transition_readback_mismatch"],
    ["running batch", (f) => { f.before.batch.status = "running"; }, 32,
      "batch_status_mismatch"],
    ["wrong pause", (f) => { f.before.batch.pause_reason = "other"; }, 32,
      "pause_reason_mismatch"],
    ["no pause target", (f) => { f.before.quarantineTarget = null; }, 32,
      "pause_target_readback_missing"],
    ["wrong target", (f) => { f.before.quarantineTarget.latest_pause_batch_item_id = OP_SUCCESSOR; },
      32, "pause_target_mismatch"],
    ["nonpristine", (f) => { f.before.quarantineTarget.run_id = "run_present"; }, 32,
      "target_run_id_not_null"],
    ["artifact", (f) => { f.before.quarantineTarget.artifact_count = 1; }, 32,
      "target_artifact_exists"],
    ["active", (f) => { f.before.active = { batch_item_id: OP_SUCCESSOR }; }, 32,
      "active_item_exists"],
    ["causal mismatch", (f) => { f.before.acquisitionFailures[0].sourceItemId = "other"; }, 32,
      "causal_source_mismatch"],
  ];
  for (const [name, mutate, expectedTransitionCount, errorCode] of variants) {
    const fixture = operatorFixture(); let adminCalls = 0;
    mutate(fixture);
    assert.throws(() => runQuarantineOperatorMode({ batchId: OP_BATCH, batchItemId: OP_ITEM,
      expectedTransitionCount, token: "fixture-secret",
      snapshotNow: () => structuredClone(fixture.before),
      preservationSnapshot: () => fixture.preservation,
      admin: () => { adminCalls += 1; return fixture.action; },
    }), new RegExp(errorCode), name);
    assert.equal(adminCalls, 0, name);
  }
});

test("matching transition binds one admin action and preserves safe post-readback fences", () => {
  const fixture = operatorFixture(); const calls = []; const persisted = []; const emitted = [];
  const receipt = runQuarantineOperatorMode({ batchId: OP_BATCH, batchItemId: OP_ITEM,
    expectedTransitionCount: 32, token: "fixture-secret",
    snapshotNow: () => structuredClone(fixture.before),
    preservationSnapshot: () => fixture.preservation,
    admin: (path, options) => { calls.push({ path, options }); return fixture.action; },
    quarantineReadback: () => fixture.after, persistReceipt: (value) => persisted.push(value),
    emitReceipt: (value) => emitted.push(value), nowIso: () => "2026-08-03T23:00:00.000Z",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], prepareQuarantineOperatorRequest(
    { ...fixture.before, preservation: fixture.preservation }, {
      batchId: OP_BATCH, batchItemId: OP_ITEM, expectedTransitionCount: 32 }));
  assert.equal(receipt.transitionBefore, 32);
  assert.equal(receipt.transitionAfter, 33);
  assert.equal(persisted.length, 1);
  assert.equal(emitted.length, 1);
  assert.equal(validateQuarantineReceipt({ ...fixture.before, preservation: fixture.preservation },
    fixture.action, fixture.after, { batchId: OP_BATCH, batchItemId: OP_ITEM,
      expectedTransitionCount: 32 }).ok, true);
  assert.doesNotMatch(JSON.stringify({ calls, receipt, persisted, emitted }), /fixture-secret/);
});

test("post-readback rejects independent transition and disposition mismatches", () => {
  const expected = { batchId: OP_BATCH, batchItemId: OP_ITEM, expectedTransitionCount: 32 };
  const cases = [
    ["action +2", (f) => { f.action.transitionAfter = 34; }, "action_transition_mismatch"],
    ["batch +2", (f) => { f.after.batch.transition_count = 34; }, "transition_readback_mismatch"],
    ["disposition batch", (f) => { f.after.disposition.batch_id = "other"; },
      "disposition_binding_mismatch"],
    ["disposition item", (f) => { f.after.disposition.batch_item_id = "other"; },
      "disposition_binding_mismatch"],
    ["disposition reason", (f) => { f.after.disposition.reason_code = "other"; },
      "disposition_binding_mismatch"],
    ["disposition observed", (f) => { f.after.disposition.observed_error_code = "other"; },
      "disposition_binding_mismatch"],
    ["disposition expected", (f) => { f.after.disposition.expected_transition_count = 31; },
      "disposition_binding_mismatch"],
    ["disposition applied", (f) => { f.after.disposition.applied_transition_count = 34; },
      "disposition_binding_mismatch"],
    ["disposition successor", (f) => { f.after.disposition.successor_batch_item_id = null; },
      "disposition_binding_mismatch"],
  ];
  for (const [name, mutate, errorCode] of cases) {
    const fixture = operatorFixture(); mutate(fixture);
    const result = validateQuarantineReceipt({ ...fixture.before,
      preservation: fixture.preservation }, fixture.action, fixture.after, expected);
    assert.equal(result.ok, false, name);
    assert.ok(result.errors.includes(errorCode), name);
  }
});
