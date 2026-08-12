import { sha256, stableId } from "./hash.js";
export { persistOperationReceipt } from "./operation-receipts.js";
import { nowIso, reconcileRun, recordQueueObservation, registerJob } from "./repository.js";
import { ensureTranscriptAnalysisPreparationRun, refreshAnalysisRun,
  transcriptAnalysisPreparationEnvelope, CLAIM_EXTRACTION_PROMPT_VERSION } from "./transcript.js";
import { queueForEnvelope, validateEnvelope } from "./job-start.js";
import {
  readTranscriptAnalysisSectionLineages,
  reconcileStaleTranscriptAnalysisSection as reconcileStaleSection,
} from "./analysis-successors.js";

export { readTranscriptAnalysisSectionLineages };

export async function reprocessTranscriptAnalysis(env, { transcriptId, at = nowIso() } = {}) {
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(transcriptId || "")) {
    return { started: false, reason: "invalid_transcript_id" };
  }
  const artifact = await env.DB.prepare(`SELECT artifact.transcript_id,artifact.source_item_id,
      artifact.content_sha256,artifact.provenance,source.person_id
    FROM transcript_artifacts artifact
    JOIN source_items source ON source.source_item_id=artifact.source_item_id
    WHERE artifact.transcript_id=?1`).bind(transcriptId).first();
  if (!artifact || artifact.provenance !== "gemini_generated_public_youtube_clipped_v1") {
    return { started: false, reason: "trusted_transcript_not_found" };
  }
  const envelope = await transcriptAnalysisPreparationEnvelope({ transcriptId: artifact.transcript_id,
    sourceItemId: artifact.source_item_id, personId: artifact.person_id,
    transcriptSha256: artifact.content_sha256 });
  await ensureTranscriptAnalysisPreparationRun(env.DB, envelope, at);
  const job = await registerJob(env.DB, envelope, at);
  if (job.run_id !== envelope.runId || job.job_type !== envelope.type ||
      job.stable_key !== envelope.stableKey || job.payload_json !== JSON.stringify(envelope.payload)) {
    throw new Error("invalid_transcript_analysis_binding");
  }
  if (job.status === "completed") {
    const retry = await retryFailedTranscriptAnalysisSections(env, envelope, at);
    if (retry.retried > 0) {
      return { started: true, reused: false, runId: envelope.runId,
        analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
        promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: "queued", ...retry };
    }
    if (retry.dispatchFailed > 0) {
      return { started: false, runId: envelope.runId,
        analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
        promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION,
        reason: "queue_dispatch_failed", ...retry };
    }
    return { started: true, reused: true, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: job.status, ...retry };
  }
  if (job.status !== "queued") {
    return { started: true, reused: true, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: job.status };
  }
  const reservation = `analysis_dispatch_${crypto.randomUUID()}`;
  const reserved = await env.DB.prepare(`UPDATE ingestion_jobs SET
      lease_token=?2,error_code='admin_analysis_reprocess_dispatching'
    WHERE job_id=?1 AND status='queued'
      AND (error_code IS NULL OR error_code='admin_analysis_reprocess_dispatch_pending')`)
    .bind(envelope.jobId, reservation).run();
  if (!reserved.meta?.changes) {
    return { started: true, reused: true, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: "queued" };
  }
  try {
    await queueForEnvelope(env, envelope).send(envelope);
    await env.DB.prepare(`UPDATE ingestion_jobs SET lease_token=NULL,
        error_code='admin_analysis_reprocess_dispatched'
      WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
      .bind(envelope.jobId, reservation).run();
  } catch {
    await env.DB.prepare(`UPDATE ingestion_jobs SET lease_token=NULL,
        error_code='admin_analysis_reprocess_dispatch_pending'
      WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
      .bind(envelope.jobId, reservation).run();
    return { started: false, runId: envelope.runId,
      analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, reason: "queue_dispatch_failed" };
  }
  return { started: true, reused: false, runId: envelope.runId,
    analysisRunId: envelope.payload.analysisRunId, firstJobId: envelope.jobId,
    promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION, status: "queued" };
}

const RETRYABLE_ANALYSIS_FAILURE = /network|timeout|upstream_429|upstream_5|ai_unavailable|queue|provider_429|provider_5|model_unavailable|ai_timeout_unconfirmed|invalid_json|invalid_candidates|invalid_payload/i;
const REPAIRED_ANALYSIS_FAILURE =
  /^D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_FOREIGNKEY\)$/;

export function analysisFailureCanRetry(errorCode) {
  return RETRYABLE_ANALYSIS_FAILURE.test(errorCode || "") ||
    REPAIRED_ANALYSIS_FAILURE.test(errorCode || "");
}

async function transcriptAnalysisSectionRow(db, analysisSectionId) {
  const rows = await db.prepare(`SELECT section.analysis_section_id,section.analysis_run_id,
      section.status section_status,section.attempt_count section_attempt_count,
      section.error_code section_error_code,section.completed_at section_completed_at,
      analysis.ingestion_run_id,analysis.prompt_version,job.job_id,job.status job_status,
      job.attempt_count job_attempt_count,job.error_code job_error_code,
      job.completed_at job_completed_at,job.claimed_at,job.lease_token,job.run_id,
      job.job_type,job.stable_key,job.payload_json,run.person_id
    FROM transcript_analysis_sections section
    JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
    JOIN ingestion_jobs job ON job.run_id=analysis.ingestion_run_id
      AND job.job_type='transcript_extract'
      AND json_extract(job.payload_json,'$.phase')='analyze'
      AND json_extract(job.payload_json,'$.analysisRunId')=section.analysis_run_id
      AND json_extract(job.payload_json,'$.analysisSectionId')=section.analysis_section_id
    JOIN ingestion_runs run ON run.run_id=job.run_id
    WHERE section.analysis_section_id=?1`).bind(analysisSectionId).all();
  return (rows.results || []).length === 1 ? rows.results[0] : null;
}

function sectionReadback(row, observedAt) {
  return row ? {
    sectionStatus: row.section_status,
    sectionAttemptCount: Number(row.section_attempt_count),
    jobStatus: row.job_status,
    jobAttemptCount: Number(row.job_attempt_count),
    observedAt,
  } : null;
}

function statusReadError(code, status = 400) {
  const error = new Error(code); error.code = code; error.status = status; return error;
}

export async function readTranscriptAnalysisSectionStatuses(env, {
  analysisSectionIds,
} = {}) {
  if (!Array.isArray(analysisSectionIds) || analysisSectionIds.length < 1 ||
      analysisSectionIds.length > 25 ||
      new Set(analysisSectionIds).size !== analysisSectionIds.length ||
      analysisSectionIds.some((id) => !/^txas_[a-f0-9]{32}$/.test(id || ""))) {
    throw statusReadError("invalid_analysis_section_ids");
  }
  const rows = await env.DB.prepare(`WITH requested AS (
      SELECT CAST(key AS INTEGER) ordinal,value analysis_section_id FROM json_each(?1)
    )
    SELECT requested.ordinal,requested.analysis_section_id requested_id,
      section.analysis_section_id,section.status,section.error_code,
      section.attempt_count,section.completed_at,job.job_id,job.status job_status,
      job.attempt_count job_attempt_count,job.error_code job_error_code
    FROM requested
    LEFT JOIN transcript_analysis_sections section
      ON section.analysis_section_id=requested.analysis_section_id
    LEFT JOIN transcript_analysis_runs analysis
      ON analysis.analysis_run_id=section.analysis_run_id
    LEFT JOIN ingestion_jobs job ON job.run_id=analysis.ingestion_run_id
      AND job.job_type='transcript_extract'
      AND json_extract(job.payload_json,'$.phase')='analyze'
      AND json_extract(job.payload_json,'$.analysisRunId')=section.analysis_run_id
      AND json_extract(job.payload_json,'$.analysisSectionId')=section.analysis_section_id
    ORDER BY requested.ordinal`).bind(JSON.stringify(analysisSectionIds)).all();
  const results = rows.results || [];
  if (results.length !== analysisSectionIds.length ||
      results.some((row, index) => row.requested_id !== analysisSectionIds[index] ||
        row.analysis_section_id !== analysisSectionIds[index] || !row.job_id)) {
    throw statusReadError("analysis_section_status_readback_mismatch", 404);
  }
  return { schemaVersion: 1, contract: "analysis-section-statuses-v1", terminal: true,
    sections: results.map((row) => ({
      analysisSectionId: row.analysis_section_id, status: row.status,
      errorCode: row.error_code, attemptCount: Number(row.attempt_count),
      completedAt: row.completed_at, jobId: row.job_id, jobStatus: row.job_status,
      jobAttemptCount: Number(row.job_attempt_count), jobErrorCode: row.job_error_code,
    })) };
}

export async function reprocessTranscriptAnalysisSection(env, { analysisSectionId,
  expectedAttemptCount, idempotencyKey, at = nowIso() } = {}) {
  if (!/^txas_[a-f0-9]{32}$/.test(analysisSectionId || "")) {
    return { dispatched: false, reason: "invalid_analysis_section_id" };
  }
  if (!Number.isInteger(expectedAttemptCount) || expectedAttemptCount < 1 || expectedAttemptCount >= 8) {
    return { dispatched: false, reason: "invalid_expected_attempt_count" };
  }
  if (!/^[A-Za-z0-9._:/-]{8,200}$/.test(idempotencyKey || "")) {
    return { dispatched: false, reason: "invalid_idempotency_key" };
  }
  const keySha256 = await sha256(idempotencyKey);
  const actionId = await stableId("asr", `${analysisSectionId}:${expectedAttemptCount}:${keySha256}`);
  const marker = `analysis_reprocess_outbox_sent:${actionId}`;
  const pendingMarker = `analysis_reprocess_outbox_pending:${actionId}`;
  const receipt = (row, { reused = false, dispatched = true, reason = null } = {}) => ({
    schemaVersion: 1, contract: "analysis-section-reprocess-v1", actionId,
    idempotencyKeySha256: keySha256, analysisSectionId,
    jobId: row?.job_id || null, expectedAttemptCount, dispatched, reused, reason,
    readback: sectionReadback(row, at),
  });
  const before = await transcriptAnalysisSectionRow(env.DB, analysisSectionId);
  if (!before) return { dispatched: false, reason: "analysis_section_not_found" };
  if (before.prompt_version !== CLAIM_EXTRACTION_PROMPT_VERSION) {
    return receipt(before, { dispatched: false, reason: "stale_prompt_requires_successor" });
  }
  const envelope = validateEnvelope({ version: 1, jobId: before.job_id, runId: before.run_id,
    personId: before.person_id, type: before.job_type, stableKey: before.stable_key,
    payload: JSON.parse(before.payload_json) });
  let outbox = await env.DB.prepare(`SELECT * FROM analysis_reprocess_dispatch_outbox
    WHERE action_id=?1`).bind(actionId).first();
  if (!outbox) {
    if (Number(before.section_attempt_count) !== expectedAttemptCount) {
      return receipt(before, { dispatched: false, reason: "attempt_count_changed" });
    }
    if (before.section_status !== "failed" || before.job_status !== "failed" ||
        Number(before.job_attempt_count) >= 8 || !analysisFailureCanRetry(before.section_error_code) ||
        !analysisFailureCanRetry(before.job_error_code)) {
      return receipt(before, { dispatched: false, reason: "section_not_retryable" });
    }
    const reserved = await env.DB.prepare(`INSERT OR IGNORE INTO analysis_reprocess_dispatch_outbox
        (action_id,idempotency_key_sha256,analysis_section_id,job_id,expected_attempt_count,
         envelope_json,status,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,'pending',?7)`)
        .bind(actionId, keySha256, analysisSectionId, before.job_id, expectedAttemptCount,
          JSON.stringify(envelope), at).run();
    if (!reserved.meta?.changes) {
      outbox = await env.DB.prepare(`SELECT * FROM analysis_reprocess_dispatch_outbox
        WHERE action_id=?1`).bind(actionId).first();
      if (!outbox) {
        const current = await transcriptAnalysisSectionRow(env.DB, analysisSectionId);
        return receipt(current || before, { dispatched: false, reason: "section_state_changed" });
      }
    } else {
      await refreshAnalysisRun(env.DB, before.analysis_run_id, at);
      await env.DB.prepare(`UPDATE ingestion_runs SET status='running',completed_at=NULL
        WHERE run_id=?1`).bind(before.run_id).run();
    }
    outbox = await env.DB.prepare(`SELECT * FROM analysis_reprocess_dispatch_outbox
      WHERE action_id=?1`).bind(actionId).first();
  }
  if (!outbox || outbox.idempotency_key_sha256 !== keySha256 ||
      outbox.analysis_section_id !== analysisSectionId || outbox.job_id !== before.job_id ||
      Number(outbox.expected_attempt_count) !== expectedAttemptCount ||
      outbox.envelope_json !== JSON.stringify(envelope)) {
    return receipt(before, { dispatched: false, reason: "action_readback_mismatch" });
  }
  const currentBeforeDispatch = await transcriptAnalysisSectionRow(env.DB, analysisSectionId);
  if (["processing","completed"].includes(currentBeforeDispatch?.job_status) &&
      Number(currentBeforeDispatch?.job_attempt_count) >= expectedAttemptCount + 1) {
    if (outbox.status !== "sent") {
      await env.DB.prepare(`UPDATE analysis_reprocess_dispatch_outbox
        SET status='sent',claim_token=NULL,claimed_at=NULL,sent_at=?2
        WHERE action_id=?1 AND status<>'sent'`).bind(actionId, at).run();
    }
    return receipt(currentBeforeDispatch, { reused: true });
  }
  if (outbox.status === "sent") return receipt(currentBeforeDispatch || before, { reused: true });
  const staleBefore = new Date(Date.parse(at) - 300_000).toISOString();
  const claimToken = `section_reprocess_${crypto.randomUUID()}`;
  const claimed = await env.DB.prepare(`UPDATE analysis_reprocess_dispatch_outbox
    SET status='dispatching',claim_token=?2,claimed_at=?3,
        dispatch_attempt_count=dispatch_attempt_count+1
    WHERE action_id=?1 AND (status='pending' OR (status='dispatching' AND claimed_at<=?4))`)
    .bind(actionId, claimToken, at, staleBefore).run();
  if (!claimed.meta?.changes) {
    return receipt(currentBeforeDispatch || before, { dispatched: false, reason: "action_in_progress" });
  }
  try { await queueForEnvelope(env, envelope).send(envelope); }
  catch {
    await env.DB.prepare(`UPDATE analysis_reprocess_dispatch_outbox
      SET status='pending',claim_token=NULL,claimed_at=NULL
      WHERE action_id=?1 AND status='dispatching' AND claim_token=?2`)
      .bind(actionId, claimToken).run();
    const pendingReadback = await transcriptAnalysisSectionRow(env.DB, analysisSectionId);
    return receipt(pendingReadback || before, { dispatched: false, reason: "queue_dispatch_failed" });
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE analysis_reprocess_dispatch_outbox
      SET status='sent',claim_token=NULL,claimed_at=NULL,sent_at=?3
      WHERE action_id=?1 AND status='dispatching' AND claim_token=?2`)
      .bind(actionId, claimToken, at),
    env.DB.prepare(`UPDATE ingestion_jobs SET claimed_at=NULL,lease_token=NULL,error_code=?3
      WHERE job_id=?1 AND status='queued' AND error_code=?2`)
      .bind(before.job_id, pendingMarker, marker),
  ]);
  const readback = await transcriptAnalysisSectionRow(env.DB, analysisSectionId);
  if (!readback || !["queued","processing","completed"].includes(readback.section_status) ||
      !["queued","processing","completed"].includes(readback.job_status)) {
    return receipt(readback || before, { dispatched: false, reason: "action_readback_mismatch" });
  }
  return receipt(readback);
}

export async function reconcileStaleTranscriptAnalysisSection(env, options = {}) {
  return reconcileStaleSection(env, {
    ...options,
    retryCurrentSection: (retry) => reprocessTranscriptAnalysisSection(env, retry),
  });
}

const QUEUE_BINDINGS = [
  ["prophecy-ledger-ingestion", "INGESTION_QUEUE"],
  ["prophecy-ledger-analysis", "ANALYSIS_QUEUE"],
  ["prophecy-ledger-ingestion-dlq", "INGESTION_DLQ"],
  ["prophecy-ledger-analysis-dlq", "ANALYSIS_DLQ"],
];

function oldestMessageAt(value, backlogCount) {
  if (backlogCount === 0) return null;
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value || ""));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export async function queueOperationsStatus(env, { at = nowIso() } = {}) {
  const observations = await Promise.all(QUEUE_BINDINGS.map(async ([queueName, bindingName]) => {
    const binding = env[bindingName];
    if (!binding || typeof binding.metrics !== "function") {
      return { queueName, status: "unavailable", backlogCount: null, backlogBytes: null,
        oldestMessageTimestamp: null, safeReasonCode: "queue_binding_missing", observedAt: at };
    }
    try {
      const metrics = await binding.metrics();
      const backlogCount = Number(metrics?.backlogCount);
      const backlogBytes = Number(metrics?.backlogBytes);
      const oldest = oldestMessageAt(metrics?.oldestMessageTimestamp, backlogCount);
      if (!Number.isInteger(backlogCount) || backlogCount < 0 ||
          !Number.isInteger(backlogBytes) || backlogBytes < 0 ||
          (backlogCount > 0 && !oldest)) {
        return { queueName, status: "unavailable", backlogCount: null, backlogBytes: null,
          oldestMessageTimestamp: null, safeReasonCode: "queue_metrics_invalid", observedAt: at };
      }
      return { queueName, status: "observed", backlogCount, backlogBytes,
        oldestMessageTimestamp: oldest, safeReasonCode: null, observedAt: at };
    } catch {
      return { queueName, status: "unavailable", backlogCount: null, backlogBytes: null,
        oldestMessageTimestamp: null, safeReasonCode: "queue_metrics_unavailable", observedAt: at };
    }
  }));
  for (const observation of observations) {
    const observationId = await stableId("qobs", `${observation.queueName}:${at}`);
    await recordQueueObservation(env.DB, { observationId, queueName: observation.queueName,
      status: observation.status, backlogCount: observation.backlogCount,
      backlogBytes: observation.backlogBytes,
      oldestMessageAt: observation.oldestMessageTimestamp,
      safeReasonCode: observation.safeReasonCode, observedAt: at });
  }
  return { schemaVersion: 1, contract: "queue-operations-status-v1", observedAt: at,
    healthy: observations.every((observation) => observation.status === "observed"),
    queues: observations };
}

async function retryFailedTranscriptAnalysisSections(env, preparation, at) {
  const rows = await env.DB.prepare(`SELECT section.analysis_section_id,section.error_code section_error_code,
      section.completed_at section_completed_at,job.job_id,job.attempt_count,
      job.error_code job_error_code,
      job.completed_at job_completed_at,job.run_id,job.job_type,job.stable_key,job.payload_json,
      run.person_id
    FROM transcript_analysis_sections section
    JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
    JOIN ingestion_jobs job ON job.run_id=analysis.ingestion_run_id
      AND json_extract(job.payload_json,'$.analysisSectionId')=section.analysis_section_id
    JOIN ingestion_runs run ON run.run_id=job.run_id
    WHERE section.analysis_run_id=?1 AND analysis.prompt_version=?2
      AND section.status='failed' AND job.status='failed'
      AND job.job_type='transcript_extract' AND job.attempt_count<8
      AND json_extract(job.payload_json,'$.phase')='analyze'
    ORDER BY section.section_index LIMIT 8`)
    .bind(preparation.payload.analysisRunId, CLAIM_EXTRACTION_PROMPT_VERSION).all();
  const retryable = (rows.results || []).filter((row) =>
    analysisFailureCanRetry(row.section_error_code) &&
    analysisFailureCanRetry(row.job_error_code));
  const reserved = [];
  for (const row of retryable) {
    const reservation = `analysis_retry_${crypto.randomUUID()}`;
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE ingestion_jobs SET status='queued',claimed_at=NULL,
          lease_token=?2,completed_at=NULL
        WHERE job_id=?1 AND status='failed' AND error_code=?3`)
        .bind(row.job_id, reservation, row.job_error_code),
      env.DB.prepare(`UPDATE transcript_analysis_sections SET status='queued',completed_at=NULL,
          error_code=?3
        WHERE analysis_section_id=?1 AND status='failed' AND error_code=?3
          AND EXISTS (SELECT 1 FROM ingestion_jobs WHERE job_id=?2 AND status='queued'
            AND lease_token=?4 AND error_code=?5)`)
        .bind(row.analysis_section_id, row.job_id, row.section_error_code, reservation,
          row.job_error_code),
    ]);
    if (results[0].meta?.changes && results[1].meta?.changes) {
      reserved.push({ ...row, reservation, envelope: {
        version: 1, jobId: row.job_id, runId: row.run_id, personId: row.person_id,
        type: row.job_type, stableKey: row.stable_key, payload: JSON.parse(row.payload_json),
      } });
    } else if (results[0].meta?.changes) {
      await env.DB.prepare(`UPDATE ingestion_jobs SET status='failed',lease_token=NULL,
          completed_at=?3,error_code=?4
        WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
        .bind(row.job_id, reservation, row.job_completed_at, row.job_error_code).run();
    }
  }
  if (!reserved.length) return { eligibleFailed: retryable.length, retried: 0, dispatchFailed: 0 };
  await refreshAnalysisRun(env.DB, preparation.payload.analysisRunId, at);
  await env.DB.prepare(`UPDATE ingestion_runs SET status='running',completed_at=NULL
    WHERE run_id=?1`).bind(preparation.runId).run();
  let retried = 0; let dispatchFailed = 0;
  for (const item of reserved) {
    try {
      await queueForEnvelope(env, item.envelope).send(item.envelope);
      await env.DB.prepare(`UPDATE ingestion_jobs SET claimed_at=NULL,lease_token=NULL
        WHERE job_id=?1 AND status='queued' AND lease_token=?2
          AND error_code=?3`)
        .bind(item.job_id, item.reservation, item.job_error_code).run();
      retried += 1;
    } catch {
      await env.DB.batch([
        env.DB.prepare(`UPDATE ingestion_jobs SET status='failed',claimed_at=NULL,lease_token=NULL,
            completed_at=?3,error_code=?4
          WHERE job_id=?1 AND status='queued' AND lease_token=?2
            AND error_code=?4`)
          .bind(item.job_id, item.reservation, item.job_completed_at, item.job_error_code),
        env.DB.prepare(`UPDATE transcript_analysis_sections SET status='failed',completed_at=?3,
            error_code=?4
          WHERE analysis_section_id=?1 AND status='queued'
            AND error_code=?4
            AND EXISTS (SELECT 1 FROM ingestion_jobs WHERE job_id=?2 AND status='failed')`)
          .bind(item.analysis_section_id, item.job_id,
            item.section_completed_at, item.section_error_code),
      ]);
      dispatchFailed += 1;
    }
  }
  await refreshAnalysisRun(env.DB, preparation.payload.analysisRunId, at);
  if (dispatchFailed && !retried) await reconcileRun(env.DB, preparation.runId, at);
  return { eligibleFailed: retryable.length, retried, dispatchFailed };
}
