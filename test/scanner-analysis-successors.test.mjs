import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers/d1.mjs";
import { fetchHandler } from "../scanner/src/index.js";
import { sha256, stableId } from "../scanner/src/hash.js";
import { makeEnvelope, processEnvelope,
  reconcileStaleTranscriptAnalysisSection } from "../scanner/src/jobs.js";
import { createRun, registerJob, upsertSourceItem } from "../scanner/src/repository.js";
import {
  CLAIM_EXTRACTION_PROMPT_VERSION,
  transcriptSections,
} from "../scanner/src/transcript.js";

const AT = "2026-08-04T00:00:00.000Z";
const CURRENT = "transcript-claims-v13-gemini-schema-http400-fallback";
const HISTORICAL = [
  "transcript-claims-v4-grounded-5w1h",
  "transcript-claims-v6-atomic-routing",
  "transcript-claims-v9-archive-quoted-checklist",
  "transcript-claims-v10-receipted-successor-routing",
  "transcript-claims-v11-gemini-gateway-abortable",
  "transcript-claims-v12-gemini-gateway-plain-fallback",
];

function r2Memory() {
  const objects = new Map();
  return {
    put: async (key, value) => objects.set(key, String(value)),
    get: async (key) => objects.has(key) ? { text: async () => objects.get(key) } : null,
  };
}

function analysisEnv() {
  const env = makeEnv();
  env.sent = [];
  env.ARTIFACTS = r2Memory();
  env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.ANALYSIS_QUEUE = { send: async (body) => env.sent.push(body) };
  env.SCANNER_ADMIN_TOKEN = "admin-secret";
  env.AI_MODEL = "test-model";
  env.AI_FALLBACK_MODEL = "test-fallback";
  env.AI = { run: async () => ({ response: JSON.stringify({ candidates: [] }) }) };
  return env;
}

async function seedHistoricalFixture(env, { collision = false } = {}) {
  const source = await upsertSourceItem(env.DB, {
    personId: "person_troy_black",
    platform: "youtube",
    platformItemId: collision ? "Collision01" : "Successor01",
    canonicalUrl: `https://www.youtube.com/watch?v=${collision ? "Collision01" : "Successor01"}`,
    seenAt: AT,
  });
  const transcript = [
    "[CLIP 00:00:00-00:05:00]\nFirst historical section.",
    "[CLIP 00:05:00-00:10:00]\nSecond historical section.",
  ].join("\n");
  const transcriptSha256 = await sha256(transcript);
  const transcriptId = await stableId("tx", `${source.source_item_id}:${transcriptSha256}`);
  const r2Key = `transcripts/final/person_troy_black/${source.source_item_id}/${transcriptSha256}.txt`;
  await env.ARTIFACTS.put(r2Key, transcript);
  env.DB.db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at)
    VALUES (?,?,?,?,?,'en',0,'gemini_generated_public_youtube_clipped_v1',NULL,?)`)
    .run(transcriptId, source.source_item_id, r2Key, transcriptSha256,
      new TextEncoder().encode(transcript).length, AT);
  const sections = transcriptSections(transcript);
  const identities = [];
  for (const section of sections) identities.push({
    ...section,
    inputSha256: await sha256(section.text),
  });
  const specs = collision
    ? [
      { promptVersion: HISTORICAL[0], section: identities[0], attemptCount: 2 },
      { promptVersion: HISTORICAL[1],
        section: { ...identities[0], inputSha256: "f".repeat(64), baseOffset: 99 },
        attemptCount: 2 },
    ]
    : [
      { promptVersion: HISTORICAL[0], section: identities[0], attemptCount: 2 },
      { promptVersion: HISTORICAL[1], section: identities[1], attemptCount: 2 },
      { promptVersion: HISTORICAL[2], section: identities[0], attemptCount: 8 },
      { promptVersion: HISTORICAL[3], section: identities[1], attemptCount: 8 },
      { promptVersion: HISTORICAL[4], section: identities[0], attemptCount: 3 },
      { promptVersion: HISTORICAL[5], section: identities[0], attemptCount: 3 },
    ];
  const sources = [];
  for (const spec of specs) {
    const analysisRunId = await stableId("txan", `${transcriptId}:${spec.promptVersion}`);
    const ingestionRunId = await stableId("runan", `${analysisRunId}:${source.source_item_id}`);
    await createRun(env.DB, {
      runId: ingestionRunId,
      personId: "person_troy_black",
      triggerType: "manual",
      scope: `transcript_analysis:${analysisRunId}`,
      createdAt: AT,
    });
    env.DB.db.prepare(`INSERT INTO transcript_analysis_runs
      (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
       prompt_version,section_count,completed_section_count,failed_section_count,status,created_at,completed_at)
      VALUES (?,?,?,?,?,?,1,0,1,'failed',?,?)`)
      .run(analysisRunId, ingestionRunId, transcriptId, source.source_item_id,
        transcriptSha256, spec.promptVersion, AT, AT);
    const analysisSectionId = await stableId("txas",
      `${analysisRunId}:${spec.section.index}:${spec.section.inputSha256}`);
    env.DB.db.prepare(`INSERT INTO transcript_analysis_sections
      (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
       approximate_timestamp_seconds,status,attempt_count,error_code,completed_at,created_at)
      VALUES (?,?,?,?,?,?,'failed',?,'invalid_json',?,?)`)
      .run(analysisSectionId, analysisRunId, spec.section.index, spec.section.inputSha256,
        spec.section.baseOffset, spec.section.approximateTimestamp, spec.attemptCount, AT, AT);
    const stableKey =
      `transcript:${transcriptId}:analysis:${spec.section.index}:${spec.promptVersion}`;
    const envelope = await makeEnvelope({
      runId: ingestionRunId,
      personId: "person_troy_black",
      type: "transcript_extract",
      stableKey,
      payload: {
        phase: "analyze",
        analysisRunId,
        analysisSectionId,
        transcriptId,
        sourceItemId: source.source_item_id,
        sectionIndex: spec.section.index,
        transcriptSha256,
        inputSha256: spec.section.inputSha256,
        promptVersion: spec.promptVersion,
      },
    });
    await registerJob(env.DB, envelope, AT);
    env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=?,
      completed_at=?,error_code='invalid_json' WHERE job_id=?`)
      .run(spec.attemptCount, AT, envelope.jobId);
    sources.push({ ...spec, analysisRunId, ingestionRunId, analysisSectionId, jobId: envelope.jobId });
  }
  return { source, transcriptId, transcriptSha256, sources };
}

function reconcileRequest(analysisSectionId, expectedAttemptCount, key) {
  return new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      action: "reconcile_stale_section",
      analysisSectionId,
      expectedAttemptCount,
    }),
  });
}

function lineageRequest(ids) {
  return new Request("https://scanner.example/admin/transcript-analysis", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "read_section_lineages", analysisSectionIds: ids }),
  });
}

function protectedCounts(env) {
  return {
    candidates: env.DB.db.prepare("SELECT COUNT(*) count FROM claim_candidates").get().count,
    reviews: env.DB.db.prepare("SELECT COUNT(*) count FROM moderator_reviews").get().count,
    workItems: env.DB.db.prepare("SELECT COUNT(*) count FROM review_work_items").get().count,
    decisions: env.DB.db.prepare("SELECT COUNT(*) count FROM candidate_review_decisions").get().count,
  };
}

function historicalRows(env) {
  return env.DB.db.prepare(`SELECT section.analysis_section_id,section.status,
      section.attempt_count,section.error_code,section.completed_at,job.status job_status,
      job.attempt_count job_attempt_count,job.error_code job_error_code
    FROM transcript_analysis_sections section
    JOIN transcript_analysis_runs run ON run.analysis_run_id=section.analysis_run_id
    JOIN analysis_prompt_versions version ON version.prompt_version=run.prompt_version
    JOIN ingestion_jobs job
      ON json_extract(job.payload_json,'$.analysisSectionId')=section.analysis_section_id
    WHERE version.generation<13 ORDER BY section.analysis_section_id`).all().map((row) => ({ ...row }));
}

async function markManualRequired(env, source) {
  const runId = await stableId("arr", `manual:${source.analysisSectionId}`);
  const itemReceiptId = await stableId("arir", `${runId}:${source.analysisSectionId}`);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO analysis_reconciliation_item_receipts
      (item_receipt_id,run_id,analysis_section_id,job_id,outcome,safe_reason_code,
       before_status,after_status,readback_at,created_at,source_prompt_version,target_prompt_version)
      VALUES (?1,?2,?3,?4,'manual_required','historical_manual_hold',
        'failed','failed',?5,?5,?6,?7)`)
      .bind(itemReceiptId, runId, source.analysisSectionId, source.jobId, AT,
        source.promptVersion, CURRENT),
    env.DB.prepare(`INSERT INTO analysis_reconciliation_runs
      (run_id,idempotency_sha256,limit_count,discovered_count,completed_count,
       manual_required_count,failed_count,status,started_at,completed_at)
      VALUES (?1,?2,1,1,0,1,0,'completed',?3,?3)`)
      .bind(runId, await sha256(`manual:${source.analysisSectionId}`), AT),
  ]);
}

test("v4 v6 v9 v10 v11 v12 failures create one exact sparse v13 run and finalize append-only", async () => {
  const env = analysisEnv();
  const fixture = await seedHistoricalFixture(env);
  const beforeHistorical = historicalRows(env);
  const beforeProtected = protectedCounts(env);
  const exhausted = fixture.sources[5];
  const firstResponse = await fetchHandler(reconcileRequest(
    exhausted.analysisSectionId, exhausted.attemptCount, "successor/main/v10"), env);
  assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  assert.equal(first.contract, "analysis-stale-section-reconciliation-v1");
  assert.equal(first.sourcePromptVersion, HISTORICAL[5]);
  assert.equal(first.targetPromptVersion, CURRENT);
  assert.equal(first.terminal, false);
  assert.equal(first.manualRequired, false);
  assert.equal(first.reason, "successor_pending");
  assert.equal(first.dispositionId, null);
  assert.match(first.successorAnalysisRunId, /^txan_[a-f0-9]{32}$/);
  assert.match(first.successorAnalysisSectionId, /^txas_[a-f0-9]{32}$/);
  assert.match(first.successorJobId, /^job_[a-f0-9]{32}$/);
  const run = env.DB.db.prepare(`SELECT analysis_run_id,section_count,prompt_version
    FROM transcript_analysis_runs WHERE transcript_id=? AND prompt_version=?`)
    .get(fixture.transcriptId, CURRENT);
  assert.equal(run.analysis_run_id, first.successorAnalysisRunId);
  assert.equal(run.section_count, 2);
  assert.equal(run.prompt_version, CLAIM_EXTRACTION_PROMPT_VERSION);
  assert.equal(env.DB.db.prepare(`SELECT COUNT(*) count FROM transcript_analysis_sections
    WHERE analysis_run_id=?`).get(run.analysis_run_id).count, 2);
  assert.equal(env.sent.length, 2);
  assert.deepEqual(historicalRows(env), beforeHistorical);
  assert.deepEqual(protectedCounts(env), beforeProtected);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_section_dispositions").get().count, 0);

  const v6 = fixture.sources[1];
  const reusedResponse = await fetchHandler(reconcileRequest(
    v6.analysisSectionId, v6.attemptCount, "successor/main/v6"), env);
  assert.equal(reusedResponse.status, 200);
  assert.equal((await reusedResponse.json()).successorAnalysisRunId, run.analysis_run_id);
  assert.equal(env.sent.length, 2);

  const targetEnvelope = env.sent.find((message) =>
    message.payload.analysisSectionId === first.successorAnalysisSectionId);
  assert.ok(targetEnvelope);
  await processEnvelope(env, targetEnvelope, { at: "2026-08-04T00:01:00.000Z" });
  const completedResponse = await fetchHandler(reconcileRequest(
    exhausted.analysisSectionId, exhausted.attemptCount, "successor/main/v10/final"), env);
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json();
  assert.equal(completed.terminal, true);
  assert.equal(completed.reason, "historical_section_superseded");
  assert.match(completed.dispositionId, /^asdp_[a-f0-9]{32}$/);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_section_successor_links").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_section_dispositions").get().count, 1);

  const replay = await (await fetchHandler(reconcileRequest(
    exhausted.analysisSectionId, exhausted.attemptCount, "successor/main/v10/replay"), env)).json();
  assert.equal(replay.actionId, completed.actionId);
  assert.equal(replay.dispositionId, completed.dispositionId);
  assert.equal(replay.terminal, true);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_section_dispositions").get().count, 1);
  assert.deepEqual(historicalRows(env), beforeHistorical);
  assert.deepEqual(protectedCounts(env), beforeProtected);

  const read = await (await fetchHandler(lineageRequest([
    v6.analysisSectionId, exhausted.analysisSectionId,
  ]), env)).json();
  assert.equal(read.contract, "analysis-section-lineages-v1");
  assert.deepEqual(read.lineages.map((row) => row.analysisSectionId),
    [v6.analysisSectionId, exhausted.analysisSectionId]);
  assert.equal(read.lineages[1].dispositionId, completed.dispositionId);
  assert.equal(read.lineages[1].debtState, "superseded");
});

test("retryable v13 successor uses canonical exact retry and deterministic failure stays manual", async () => {
  const env = analysisEnv();
  const fixture = await seedHistoricalFixture(env);
  const source = fixture.sources[0];
  const initial = await (await fetchHandler(reconcileRequest(
    source.analysisSectionId, source.attemptCount, "successor/retry/initial"), env)).json();
  const successorId = initial.successorAnalysisSectionId;
  const successorJobId = initial.successorJobId;
  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=1,
    error_code='ai_unavailable',completed_at=? WHERE analysis_section_id=?`).run(AT, successorId);
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=1,
    error_code='ai_unavailable',completed_at=? WHERE job_id=?`).run(AT, successorJobId);
  const sentBefore = env.sent.length;
  const retryResponse = await fetchHandler(reconcileRequest(
    source.analysisSectionId, source.attemptCount, "successor/retry/dispatch"), env);
  assert.equal(retryResponse.status, 200);
  const retry = await retryResponse.json();
  assert.equal(retry.reason, "successor_pending");
  assert.equal(retry.dispatched, true);
  assert.equal(retry.terminal, false);
  assert.equal(env.sent.length, sentBefore + 1);
  assert.equal(env.sent.at(-1).payload.analysisSectionId, successorId);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM analysis_reprocess_dispatch_outbox").get().count, 1);

  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=2,
    error_code='invalid_transcript_analysis_binding',completed_at=? WHERE analysis_section_id=?`).run(AT, successorId);
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=2,
    error_code='invalid_transcript_analysis_binding',completed_at=? WHERE job_id=?`).run(AT, successorJobId);
  const manual = await (await fetchHandler(reconcileRequest(
    source.analysisSectionId, source.attemptCount, "successor/retry/manual"), env)).json();
  assert.equal(manual.terminal, true);
  assert.equal(manual.manualRequired, true);
  assert.equal(manual.reason, "successor_manual_required");
  assert.equal(manual.dispositionId, null);
});

test("conflicting exact identities at one section index fail closed before v13 creation", async () => {
  const env = analysisEnv();
  const fixture = await seedHistoricalFixture(env, { collision: true });
  const before = historicalRows(env);
  const response = await fetchHandler(reconcileRequest(
    fixture.sources[0].analysisSectionId, fixture.sources[0].attemptCount,
    "successor/collision"), env);
  assert.equal(response.status, 409);
  const receipt = await response.json();
  assert.equal(receipt.contract, "analysis-stale-section-reconciliation-v1");
  assert.equal(receipt.terminal, false);
  assert.equal(receipt.reason, "historical_section_identity_collision");
  assert.equal(env.DB.db.prepare(`SELECT COUNT(*) count FROM transcript_analysis_runs
    WHERE transcript_id=? AND prompt_version=?`).get(fixture.transcriptId, CURRENT).count, 0);
  assert.equal(env.sent.length, 0);
  assert.deepEqual(historicalRows(env), before);
});

test("a historical manual receipt without a failed successor does not block recovery", async () => {
  const env = analysisEnv();
  const fixture = await seedHistoricalFixture(env);
  const active = fixture.sources[0];
  const held = fixture.sources[1];
  await markManualRequired(env, held);
  const heldBefore = env.DB.db.prepare(`SELECT debt_state,successor_analysis_section_id
    FROM analysis_section_lineage_v2 WHERE analysis_section_id=?`).get(held.analysisSectionId);
  assert.equal(heldBefore.debt_state, "successor_required");
  assert.equal(heldBefore.successor_analysis_section_id, null);

  const response = await fetchHandler(reconcileRequest(
    active.analysisSectionId, active.attemptCount, "successor/manual-filter"), env);
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.reason, "successor_pending");
  assert.equal(receipt.terminal, false);
  const run = env.DB.db.prepare(`SELECT section_count FROM transcript_analysis_runs
    WHERE transcript_id=? AND prompt_version=?`).get(fixture.transcriptId, CURRENT);
  assert.equal(run.section_count, 2);
  assert.equal(env.sent.length, 2);
  const heldAfter = env.DB.db.prepare(`SELECT debt_state,successor_analysis_section_id
    FROM analysis_section_lineage_v2 WHERE analysis_section_id=?`).get(held.analysisSectionId);
  assert.equal(heldAfter.debt_state, "successor_pending");
  assert.match(heldAfter.successor_analysis_section_id, /^txas_[a-f0-9]{32}$/);
});

test("a true manual failed successor stays held while a queued sibling redispatches", async () => {
  const env = analysisEnv();
  const fixture = await seedHistoricalFixture(env);
  const active = fixture.sources[0];
  const held = fixture.sources[1];
  const initialResponse = await fetchHandler(reconcileRequest(
    active.analysisSectionId, active.attemptCount, "successor/true-manual/initial"), env);
  assert.equal(initialResponse.status, 202);
  const activeLineage = env.DB.db.prepare(`SELECT successor_analysis_section_id,successor_job_id
    FROM analysis_section_lineage_v2 WHERE analysis_section_id=?`).get(active.analysisSectionId);
  const heldLineage = env.DB.db.prepare(`SELECT successor_analysis_section_id,successor_job_id
    FROM analysis_section_lineage_v2 WHERE analysis_section_id=?`).get(held.analysisSectionId);
  env.DB.db.prepare(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=2,
    error_code='invalid_transcript_analysis_binding',completed_at=? WHERE analysis_section_id=?`)
    .run(AT, heldLineage.successor_analysis_section_id);
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=2,
    error_code='invalid_transcript_analysis_binding',completed_at=? WHERE job_id=?`)
    .run(AT, heldLineage.successor_job_id);
  await markManualRequired(env, held);
  assert.equal(env.DB.db.prepare(`SELECT debt_state FROM analysis_section_lineage_v2
    WHERE analysis_section_id=?`).get(held.analysisSectionId).debt_state, "manual_required");

  env.DB.db.prepare(`UPDATE ingestion_jobs SET error_code='stale_successor_dispatch_pending:fixture',
    claimed_at=NULL,lease_token=NULL WHERE job_id=?`).run(activeLineage.successor_job_id);
  const sentBefore = env.sent.length;
  const response = await fetchHandler(reconcileRequest(
    active.analysisSectionId, active.attemptCount, "successor/true-manual/replay"), env);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.reason, "successor_pending");
  assert.equal(receipt.dispatched, true);
  assert.equal(env.sent.length, sentBefore + 1);
  assert.equal(env.sent.at(-1).payload.analysisSectionId,
    activeLineage.successor_analysis_section_id);
  const heldAfter = env.DB.db.prepare(`SELECT debt_state,successor_status,
      successor_attempt_count,successor_job_status,successor_job_attempt_count
    FROM analysis_section_lineage_v2 WHERE analysis_section_id=?`).get(held.analysisSectionId);
  assert.deepEqual({ ...heldAfter }, {
    debt_state: "manual_required", successor_status: "failed", successor_attempt_count: 2,
    successor_job_status: "failed", successor_job_attempt_count: 2,
  });
});

test("a stale pre-send successor claim is reclaimed once and a live claim is not duplicated", async () => {
  const env = analysisEnv();
  const fixture = await seedHistoricalFixture(env);
  const source = fixture.sources[0];
  const initial = await reconcileStaleTranscriptAnalysisSection(env, {
    analysisSectionId: source.analysisSectionId,
    expectedAttemptCount: source.attemptCount,
    idempotencyKey: "successor/crash/initial",
    at: AT,
  });
  assert.equal(initial.reason, "successor_pending");
  const successorJobId = initial.successorJobId;
  env.sent.length = 0;
  env.DB.db.prepare(`UPDATE ingestion_jobs SET claimed_at=?,lease_token='crashed-claim',
    error_code=? WHERE job_id=?`).run("2026-08-04T00:01:00.000Z",
    `stale_successor_dispatching:${initial.actionId}`, successorJobId);

  const live = await reconcileStaleTranscriptAnalysisSection(env, {
    analysisSectionId: source.analysisSectionId,
    expectedAttemptCount: source.attemptCount,
    idempotencyKey: "successor/crash/live",
    at: "2026-08-04T00:05:59.000Z",
  });
  assert.equal(live.reason, "successor_pending");
  assert.equal(env.sent.length, 0);
  assert.equal(env.DB.db.prepare("SELECT lease_token FROM ingestion_jobs WHERE job_id=?")
    .get(successorJobId).lease_token, "crashed-claim");

  const recovered = await reconcileStaleTranscriptAnalysisSection(env, {
    analysisSectionId: source.analysisSectionId,
    expectedAttemptCount: source.attemptCount,
    idempotencyKey: "successor/crash/recovered",
    at: "2026-08-04T00:06:01.000Z",
  });
  assert.equal(recovered.reason, "successor_pending");
  assert.equal(recovered.dispatched, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].jobId, successorJobId);
  const replay = await reconcileStaleTranscriptAnalysisSection(env, {
    analysisSectionId: source.analysisSectionId,
    expectedAttemptCount: source.attemptCount,
    idempotencyKey: "successor/crash/replay",
    at: "2026-08-04T00:12:00.000Z",
  });
  assert.equal(replay.reason, "successor_pending");
  assert.equal(env.sent.length, 1);
});
