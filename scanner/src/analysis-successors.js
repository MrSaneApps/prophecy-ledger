import { sha256, stableId } from "./hash.js";
import { nowIso } from "./repository.js";
import {
  CLAIM_EXTRACTION_PROMPT_VERSION,
  ensureTranscriptAnalysisPreparationRun,
  registerTranscriptAnalysisJobs,
  transcriptAnalysisPreparationEnvelope,
  transcriptAnalysisSectionEnvelope,
} from "./transcript.js";
import { queueForEnvelope } from "./job-start.js";

const SECTION_ID = /^txas_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:/-]{8,200}$/;
const DISPOSITION = "superseded_by_completed_successor";
const SUCCESSOR_DISPATCH_CLAIM_MS = 300_000;
const RETRYABLE_FAILURE =
  /network|timeout|upstream_429|upstream_5|ai_unavailable|queue|provider_429|provider_5|model_unavailable|ai_timeout_unconfirmed|invalid_json|invalid_candidates|invalid_payload/i;
const REPAIRED_FAILURE =
  /^D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_FOREIGNKEY\)$/;

function canRetry(errorCode) {
  return RETRYABLE_FAILURE.test(errorCode || "") || REPAIRED_FAILURE.test(errorCode || "");
}

function typedError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function mapLineage(row) {
  return {
    analysisSectionId: row.analysis_section_id,
    analysisRunId: row.analysis_run_id,
    sectionIndex: Number(row.section_index),
    inputSha256: row.input_sha256,
    baseOffset: Number(row.base_offset),
    approximateTimestampSeconds: Number(row.approximate_timestamp_seconds),
    sourceStatus: row.source_status,
    sourceAttemptCount: Number(row.source_attempt_count),
    sourceErrorCode: row.source_error_code,
    transcriptId: row.transcript_id,
    sourceItemId: row.source_item_id,
    transcriptSha256: row.transcript_sha256,
    sourcePromptVersion: row.source_prompt_version,
    sourcePromptGeneration: numberOrNull(row.source_prompt_generation),
    sourceJobId: row.source_job_id,
    sourceJobStatus: row.source_job_status,
    sourceJobAttemptCount: Number(row.source_job_attempt_count),
    sourceJobErrorCode: row.source_job_error_code,
    targetPromptVersion: row.target_prompt_version,
    targetPromptGeneration: Number(row.target_prompt_generation),
    successorAnalysisRunId: row.successor_analysis_run_id,
    successorAnalysisSectionId: row.successor_analysis_section_id,
    successorJobId: row.successor_job_id,
    successorStatus: row.successor_status,
    successorAttemptCount: numberOrNull(row.successor_attempt_count),
    successorErrorCode: row.successor_error_code,
    successorJobStatus: row.successor_job_status,
    successorJobAttemptCount: numberOrNull(row.successor_job_attempt_count),
    successorJobErrorCode: row.successor_job_error_code,
    dispositionId: row.disposition_id,
    debtState: row.debt_state,
  };
}

async function lineageRow(db, analysisSectionId) {
  return db.prepare("SELECT * FROM analysis_section_lineage_v2 WHERE analysis_section_id=?1")
    .bind(analysisSectionId).first();
}

export async function readTranscriptAnalysisSectionLineages(env, {
  analysisSectionIds,
} = {}) {
  if (!Array.isArray(analysisSectionIds) || analysisSectionIds.length < 1 ||
      analysisSectionIds.length > 25 ||
      new Set(analysisSectionIds).size !== analysisSectionIds.length ||
      analysisSectionIds.some((id) => !SECTION_ID.test(id || ""))) {
    throw typedError("invalid_analysis_section_ids");
  }
  const rows = await env.DB.prepare(`WITH requested AS (
      SELECT CAST(key AS INTEGER) ordinal,value analysis_section_id FROM json_each(?1)
    )
    SELECT requested.ordinal,requested.analysis_section_id requested_id,lineage.*
    FROM requested LEFT JOIN analysis_section_lineage_v2 lineage
      ON lineage.analysis_section_id=requested.analysis_section_id
    ORDER BY requested.ordinal`).bind(JSON.stringify(analysisSectionIds)).all();
  const results = rows.results || [];
  if (results.length !== analysisSectionIds.length ||
      results.some((row, index) => row.requested_id !== analysisSectionIds[index] ||
        row.analysis_section_id !== analysisSectionIds[index])) {
    throw typedError("analysis_section_lineage_readback_mismatch", 404);
  }
  return {
    schemaVersion: 1,
    contract: "analysis-section-lineages-v1",
    terminal: true,
    lineages: results.map(mapLineage),
  };
}

async function currentPrompt(db) {
  const prompt = await db.prepare(`SELECT prompt_version,generation
    FROM analysis_prompt_versions ORDER BY generation DESC LIMIT 1`).first();
  if (!prompt || prompt.prompt_version !== CLAIM_EXTRACTION_PROMPT_VERSION) {
    throw typedError("current_prompt_registry_mismatch", 503);
  }
  return { promptVersion: prompt.prompt_version, generation: Number(prompt.generation) };
}

async function historicalTargets(db, source, prompt, { unresolvedOnly = false, includeManual = false } = {}) {
  const rows = await db.prepare(`SELECT section_index,input_sha256,base_offset,
      approximate_timestamp_seconds,MIN(analysis_section_id) representative_section_id
    FROM analysis_section_lineage_v2
    WHERE transcript_id=?1 AND source_item_id=?2 AND transcript_sha256=?3
      AND target_prompt_version=?4
      AND source_prompt_generation IS NOT NULL
      AND source_prompt_generation<?5
      AND (debt_state IN ('successor_required','successor_pending','successor_retryable',
        'finalization_pending','superseded') OR (?7=1 AND debt_state='manual_required'))
      AND (?6=0 OR disposition_id IS NULL)
    GROUP BY section_index,input_sha256,base_offset,approximate_timestamp_seconds
    ORDER BY section_index,input_sha256,base_offset,approximate_timestamp_seconds`)
    .bind(source.transcript_id, source.source_item_id, source.transcript_sha256,
      prompt.promptVersion, prompt.generation, unresolvedOnly ? 1 : 0, includeManual ? 1 : 0).all();
  return rows.results || [];
}

function requireDistinctSectionIndexes(targets) {
  if (new Set(targets.map((target) => Number(target.section_index))).size !== targets.length) {
    throw typedError("historical_section_identity_collision", 409);
  }
}

async function storedSuccessorRun(db, analysisRunId) {
  const run = await db.prepare(`SELECT analysis_run_id,ingestion_run_id,transcript_id,
      source_item_id,transcript_sha256,prompt_version,section_count,status
    FROM transcript_analysis_runs WHERE analysis_run_id=?1`).bind(analysisRunId).first();
  if (!run) return null;
  const sections = await db.prepare(`SELECT analysis_section_id,section_index,input_sha256,
      base_offset,approximate_timestamp_seconds,status,attempt_count,error_code
    FROM transcript_analysis_sections WHERE analysis_run_id=?1
    ORDER BY section_index,input_sha256,base_offset,approximate_timestamp_seconds`)
    .bind(analysisRunId).all();
  return { run, sections: sections.results || [] };
}

function exactIdentity(row) {
  return [
    Number(row.section_index), row.input_sha256, Number(row.base_offset),
    Number(row.approximate_timestamp_seconds),
  ].join(":");
}

async function ensureSubsetSuccessorRun(env, source, prompt, actionId, at) {
  const preparation = await transcriptAnalysisPreparationEnvelope({
    transcriptId: source.transcript_id,
    sourceItemId: source.source_item_id,
    personId: source.person_id,
    transcriptSha256: source.transcript_sha256,
  });
  await ensureTranscriptAnalysisPreparationRun(env.DB, preparation, at);
  let stored = await storedSuccessorRun(env.DB, preparation.payload.analysisRunId);
  let created = false;
  if (!stored || stored.sections.length === 0) {
    const targets = await historicalTargets(env.DB, source, prompt, { unresolvedOnly: true });
    if (!targets.length) throw typedError("historical_successor_targets_missing", 409);
    requireDistinctSectionIndexes(targets);
    const sectionRows = [];
    for (const target of targets) {
      const analysisSectionId = await stableId("txas",
        `${preparation.payload.analysisRunId}:${Number(target.section_index)}:${target.input_sha256}`);
      sectionRows.push({
        analysisSectionId,
        analysisRunId: preparation.payload.analysisRunId,
        sectionIndex: Number(target.section_index),
        inputSha256: target.input_sha256,
        baseOffset: Number(target.base_offset),
        approximateTimestampSeconds: Number(target.approximate_timestamp_seconds),
        createdAt: at,
      });
    }
    const creation = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO transcript_analysis_runs
        (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
         prompt_version,section_count,status,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',?8)`)
        .bind(preparation.payload.analysisRunId, preparation.runId, source.transcript_id,
          source.source_item_id, source.transcript_sha256, prompt.promptVersion,
          sectionRows.length, at),
      env.DB.prepare(`INSERT OR IGNORE INTO transcript_analysis_sections
        (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
         approximate_timestamp_seconds,extraction_run_id,status,attempt_count,error_code,
         started_at,completed_at,created_at)
        SELECT json_extract(value,'$.analysisSectionId'),json_extract(value,'$.analysisRunId'),
          json_extract(value,'$.sectionIndex'),json_extract(value,'$.inputSha256'),
          json_extract(value,'$.baseOffset'),json_extract(value,'$.approximateTimestampSeconds'),
          NULL,'queued',0,NULL,NULL,NULL,json_extract(value,'$.createdAt')
        FROM json_each(?1)
        WHERE EXISTS (SELECT 1 FROM transcript_analysis_runs
          WHERE analysis_run_id=?2 AND ingestion_run_id=?3 AND transcript_id=?4
            AND source_item_id=?5 AND transcript_sha256=?6 AND section_count=?7
            AND prompt_version=?8)
          AND NOT EXISTS (SELECT 1 FROM transcript_analysis_sections
            WHERE analysis_run_id=?2)`)
        .bind(JSON.stringify(sectionRows), preparation.payload.analysisRunId, preparation.runId,
          source.transcript_id, source.source_item_id, source.transcript_sha256,
          sectionRows.length, prompt.promptVersion),
    ]);
    created = Boolean(creation[0].meta?.changes);
    stored = await storedSuccessorRun(env.DB, preparation.payload.analysisRunId);
  }
  const expectedTargets = await historicalTargets(env.DB, source, prompt,
    { includeManual: true });
  requireDistinctSectionIndexes(expectedTargets);
  const expectedIdentities = new Set(expectedTargets.map(exactIdentity));
  const storedIdentities = new Set((stored?.sections || []).map(exactIdentity));
  if (!stored || stored.run.ingestion_run_id !== preparation.runId ||
      stored.run.transcript_id !== source.transcript_id ||
      stored.run.source_item_id !== source.source_item_id ||
      stored.run.transcript_sha256 !== source.transcript_sha256 ||
      stored.run.prompt_version !== prompt.promptVersion ||
      Number(stored.run.section_count) !== stored.sections.length ||
      expectedIdentities.size !== storedIdentities.size ||
      [...expectedIdentities].some((identity) => !storedIdentities.has(identity))) {
    throw typedError("successor_run_binding_mismatch", 409);
  }
  const sourceIdentity = exactIdentity(source);
  if (!stored.sections.some((section) => exactIdentity(section) === sourceIdentity)) {
    throw typedError("source_successor_binding_missing", 409);
  }
  const envelopes = [];
  for (const section of stored.sections) {
    if (section.status !== "queued") continue;
    envelopes.push(await transcriptAnalysisSectionEnvelope({
      analysisRunId: stored.run.analysis_run_id,
      ingestionRunId: stored.run.ingestion_run_id,
      analysisSectionId: section.analysis_section_id,
      transcriptId: stored.run.transcript_id,
      sourceItemId: stored.run.source_item_id,
      personId: source.person_id,
      sectionIndex: Number(section.section_index),
      transcriptSha256: stored.run.transcript_sha256,
      inputSha256: section.input_sha256,
    }));
  }
  await registerTranscriptAnalysisJobs(env.DB, envelopes, at);
  const jobs = await env.DB.prepare(`SELECT job_id,stable_key,payload_json,status,error_code,
      claimed_at,lease_token FROM ingestion_jobs
    WHERE run_id=?1 AND job_type='transcript_extract'
      AND json_extract(payload_json,'$.phase')='analyze'
    ORDER BY json_extract(payload_json,'$.sectionIndex'),job_id`)
    .bind(stored.run.ingestion_run_id).all();
  const jobRows = jobs.results || [];
  if (jobRows.length !== stored.sections.length) {
    throw typedError("successor_job_binding_mismatch", 409);
  }
  const bySection = new Map(jobRows.map((job) => [
    JSON.parse(job.payload_json).analysisSectionId, job,
  ]));
  if (stored.sections.some((section) => !bySection.has(section.analysis_section_id))) {
    throw typedError("successor_job_binding_mismatch", 409);
  }
  const dispatch = await dispatchQueuedSuccessors(env, jobRows, actionId, at);
  return { ...stored, created, dispatch };
}

async function dispatchQueuedSuccessors(env, jobs, actionId, at) {
  let dispatchedCount = 0;
  let failedCount = 0;
  let inProgressCount = 0;
  const staleClaimBefore = new Date(Date.parse(at) - SUCCESSOR_DISPATCH_CLAIM_MS).toISOString();
  for (const job of jobs) {
    if (job.status !== "queued") continue;
    if (String(job.error_code || "").startsWith("stale_successor_dispatched:")) {
      dispatchedCount += 1;
      continue;
    }
    const claimToken = `stale_successor_${crypto.randomUUID()}`;
    const dispatching = `stale_successor_dispatching:${actionId}`;
    const pending = `stale_successor_dispatch_pending:${actionId}`;
    const claimed = await env.DB.prepare(`UPDATE ingestion_jobs
      SET claimed_at=?2,lease_token=?3,error_code=?4
      WHERE job_id=?1 AND status='queued' AND (
        (lease_token IS NULL
          AND (error_code IS NULL OR error_code LIKE 'stale_successor_dispatch_pending:%'))
        OR (claimed_at<=?5 AND error_code LIKE 'stale_successor_dispatching:%')
      )`)
      .bind(job.job_id, at, claimToken, dispatching, staleClaimBefore).run();
    if (!claimed.meta?.changes) {
      inProgressCount += 1;
      continue;
    }
    const payload = JSON.parse(job.payload_json);
    const envelope = {
      version: 1,
      jobId: job.job_id,
      runId: payload.analysisRunId
        ? (await env.DB.prepare("SELECT ingestion_run_id FROM transcript_analysis_runs WHERE analysis_run_id=?1")
          .bind(payload.analysisRunId).first()).ingestion_run_id
        : null,
      personId: (await env.DB.prepare(`SELECT person_id FROM ingestion_runs WHERE run_id=(
        SELECT ingestion_run_id FROM transcript_analysis_runs WHERE analysis_run_id=?1)`)
        .bind(payload.analysisRunId).first()).person_id,
      type: "transcript_extract",
      stableKey: job.stable_key,
      payload,
    };
    try {
      await queueForEnvelope(env, envelope).send(envelope);
      await env.DB.prepare(`UPDATE ingestion_jobs SET claimed_at=NULL,lease_token=NULL,error_code=?3
        WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
        .bind(job.job_id, claimToken, `stale_successor_dispatched:${actionId}`).run();
      dispatchedCount += 1;
    } catch {
      await env.DB.prepare(`UPDATE ingestion_jobs SET claimed_at=NULL,lease_token=NULL,error_code=?3
        WHERE job_id=?1 AND status='queued' AND lease_token=?2`)
        .bind(job.job_id, claimToken, pending).run();
      failedCount += 1;
    }
  }
  return { dispatchedCount, failedCount, inProgressCount };
}

async function finalizeDisposition(env, source, actionId, at) {
  const successorSectionId = source.successor_analysis_section_id;
  const linkId = await stableId("asln", `${source.analysis_section_id}:${successorSectionId}`);
  const dispositionId = await stableId("asdp",
    `${source.analysis_section_id}:${successorSectionId}:${DISPOSITION}`);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO analysis_section_successor_links
      (link_id,predecessor_section_id,successor_section_id,predecessor_prompt_version,
       successor_prompt_version,action_id,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7)`)
      .bind(linkId, source.analysis_section_id, successorSectionId,
        source.source_prompt_version, source.target_prompt_version, actionId, at),
    env.DB.prepare(`INSERT OR IGNORE INTO analysis_section_dispositions
      (disposition_id,predecessor_section_id,successor_section_id,link_id,
       disposition,action_id,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7)`)
      .bind(dispositionId, source.analysis_section_id, successorSectionId,
        linkId, DISPOSITION, actionId, at),
  ]);
  const readback = await lineageRow(env.DB, source.analysis_section_id);
  if (!readback || readback.disposition_id !== dispositionId ||
      readback.debt_state !== "superseded" ||
      readback.successor_analysis_section_id !== successorSectionId) {
    throw typedError("successor_disposition_readback_mismatch", 503);
  }
  return { readback, linkId, dispositionId };
}

function reconciliationReceipt(row, {
  actionId,
  keySha256,
  expectedAttemptCount,
  terminal = false,
  manualRequired = false,
  dispatched = false,
  reused = false,
  reason = null,
  observedAt,
} = {}) {
  return {
    schemaVersion: 1,
    contract: "analysis-stale-section-reconciliation-v1",
    actionId,
    idempotencyKeySha256: keySha256,
    sourceAnalysisSectionId: row?.analysis_section_id || null,
    expectedAttemptCount,
    sourcePromptVersion: row?.source_prompt_version || null,
    targetPromptVersion: row?.target_prompt_version || CLAIM_EXTRACTION_PROMPT_VERSION,
    successorAnalysisRunId: row?.successor_analysis_run_id || null,
    successorAnalysisSectionId: row?.successor_analysis_section_id || null,
    successorJobId: row?.successor_job_id || null,
    successorStatus: row?.successor_status || null,
    successorAttemptCount: numberOrNull(row?.successor_attempt_count),
    dispositionId: row?.disposition_id || null,
    terminal,
    manualRequired,
    dispatched,
    reused,
    reason,
    observedAt,
  };
}

export async function reconcileStaleTranscriptAnalysisSection(env, {
  analysisSectionId,
  expectedAttemptCount,
  idempotencyKey,
  at = nowIso(),
  retryCurrentSection,
} = {}) {
  if (!SECTION_ID.test(analysisSectionId || "")) {
    return { terminal: false, reason: "invalid_analysis_section_id" };
  }
  if (!Number.isInteger(expectedAttemptCount) || expectedAttemptCount < 1 ||
      expectedAttemptCount > 1_000) {
    return { terminal: false, reason: "invalid_expected_attempt_count" };
  }
  if (!IDEMPOTENCY_KEY.test(idempotencyKey || "")) {
    return { terminal: false, reason: "invalid_idempotency_key" };
  }
  const keySha256 = await sha256(idempotencyKey);
  const actionId = await stableId("asx",
    `${analysisSectionId}:${CLAIM_EXTRACTION_PROMPT_VERSION}`);
  let row = await lineageRow(env.DB, analysisSectionId);
  if (!row) {
    return { terminal: false, reason: "analysis_section_not_found" };
  }
  const receipt = (options) => reconciliationReceipt(row, {
    actionId, keySha256, expectedAttemptCount, observedAt: at, ...options,
  });
  if (Number(row.source_attempt_count) !== expectedAttemptCount) {
    return receipt({ reason: "attempt_count_changed" });
  }
  if (row.source_status !== "failed" || row.source_job_status !== "failed") {
    return receipt({ reason: "source_section_not_failed" });
  }
  if (row.source_prompt_generation === null ||
      Number(row.source_prompt_generation) >= Number(row.target_prompt_generation)) {
    return receipt({ reason: "current_prompt_requires_exact_reprocess" });
  }
  if (row.disposition_id) {
    return receipt({ terminal: true, reused: true, reason: "historical_section_superseded" });
  }
  const prompt = await currentPrompt(env.DB);
  const person = await env.DB.prepare(`SELECT person_id FROM ingestion_runs
    WHERE run_id=(SELECT ingestion_run_id FROM transcript_analysis_runs
      WHERE analysis_run_id=?1)`).bind(row.analysis_run_id).first();
  if (!person?.person_id) throw typedError("source_analysis_run_binding_missing", 409);
  const ensured = await ensureSubsetSuccessorRun(env,
    { ...row, person_id: person.person_id }, prompt, actionId, at);
  row = await lineageRow(env.DB, analysisSectionId);
  if (!row?.successor_analysis_section_id) {
    throw typedError("successor_lineage_readback_mismatch", 503);
  }
  if (ensured.dispatch.failedCount > 0) {
    return receipt({ reason: "queue_dispatch_failed", reused: !ensured.created });
  }
  if (row.successor_status === "completed" && row.successor_job_status === "completed") {
    const finalized = await finalizeDisposition(env, row, actionId, at);
    row = finalized.readback;
    return receipt({ terminal: true, reused: !ensured.created,
      reason: "historical_section_superseded" });
  }
  if (row.successor_status === "failed" || row.successor_job_status === "failed") {
    const attemptCount = Math.max(Number(row.successor_attempt_count || 0),
      Number(row.successor_job_attempt_count || 0));
    const retryable = attemptCount > 0 && attemptCount < 8 &&
      canRetry(row.successor_error_code) && canRetry(row.successor_job_error_code);
    if (!retryable || typeof retryCurrentSection !== "function") {
      return receipt({ terminal: true, manualRequired: true, reused: true,
        reason: "successor_manual_required" });
    }
    const retried = await retryCurrentSection({
      analysisSectionId: row.successor_analysis_section_id,
      expectedAttemptCount: attemptCount,
      idempotencyKey: `analysis-successor/${actionId}/${attemptCount}`,
      at,
    });
    row = await lineageRow(env.DB, analysisSectionId);
    if (!retried.dispatched) {
      if (retried.reason === "queue_dispatch_failed") {
        return receipt({ reason: "queue_dispatch_failed", reused: true });
      }
      return receipt({ terminal: true, manualRequired: true, reused: true,
        reason: "successor_manual_required" });
    }
    return receipt({ dispatched: true, reused: true, reason: "successor_pending" });
  }
  const dispatched = ensured.dispatch.dispatchedCount > 0 ||
    String(row.successor_job_error_code || "").startsWith("stale_successor_dispatched:") ||
    row.successor_job_status === "processing";
  return receipt({ dispatched, reused: !ensured.created, reason: "successor_pending" });
}
