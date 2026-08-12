import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { D1Shim, makeEnv, ROOT } from "./helpers/d1.mjs";
import { fetchHandler } from "../scanner/src/index.js";
import { sha256, stableId } from "../scanner/src/hash.js";
import { makeEnvelope, processEnvelope, processQueueBatch, startTranscriptCanary } from "../scanner/src/jobs.js";
import {
  addRevision, createRun, linkExactEmbedded, recordSourceMediaMetadata, registerJob, upsertSourceItem,
} from "../scanner/src/repository.js";
import {
  completeTranscriptBatchItem, pauseTranscriptBatch, repairLegacyStitchedTranscriptBatchItem,
  quarantinePendingTranscriptItem, resumeScheduledTranscriptBatch, resumeTranscriptBatch, startTranscriptBatch,
  skipActiveTranscriptItem, syncArchiveLinkedTranscriptBatch,
} from "../scanner/src/transcript-batch.js";
import {
  ensureTranscriptAnalysisPreparationRun, LEGACY_STITCH_ALGORITHM, stitchTranscript,
  CLAIM_EXTRACTION_PROMPT_VERSION, transcriptAnalysisPreparationEnvelope, TRANSCRIPT_PLAN_VERSION, transcriptPlan,
} from "../scanner/src/transcript.js";

const AT = "2026-07-20T10:00:00.000Z";
const NEXT_DAY = "2026-07-21T00:00:05.000Z";

const durationFetcher = (seconds = 60) => async () =>
  new Response(`<html><script>{"lengthSeconds":"${seconds}"}</script></html>`, { status: 200 });
const dataApiDurationFetcher = (seconds = 60, calls = []) => async (url) => {
  calls.push(url);
  return new Response(JSON.stringify({ items: [{ id: new URL(url).searchParams.get("id"),
    contentDetails: { duration: `PT${seconds}S` } }] }), { status: 200 });
};

function batchEnv() {
  const env = makeEnv();
  env.sent = [];
  env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body),
    sendBatch: async (messages) => env.sent.push(...messages.map((message) => message.body)) };
  env.ANALYSIS_QUEUE = { send: async (body) => env.sent.push(body),
    sendBatch: async (messages) => env.sent.push(...messages.map((message) => message.body)) };
  env.ANALYSIS_QUEUE = env.INGESTION_QUEUE;
  env.SCANNER_ADMIN_TOKEN = "admin-secret";
  env.SCAN_ENABLED = "0";
  env.TRANSCRIPT_BATCH_ENABLED = "0";
  env.TRANSCRIPT_BATCH_AUTO_ADVANCE = "0";
  return env;
}

function r2Memory() {
  const objects = new Map();
  return { objects, put: async (key, value) => objects.set(key, String(value)),
    get: async (key) => objects.has(key) ? { text: async () => objects.get(key) } : null };
}

function legacyTranscriptPlan(durationSeconds, chunkSeconds = 300, overlapSeconds = 0) {
  const requests = [];
  for (let start = 0; start < durationSeconds; start += chunkSeconds - overlapSeconds) {
    requests.push({ requestStart: start, requestEnd: Math.min(durationSeconds, start + chunkSeconds) });
  }
  return requests.map((request, index) => ({ index, ...request,
    canonicalStart: index ? (requests[index - 1].requestEnd + request.requestStart) / 2 : 0,
    canonicalEnd: index + 1 < requests.length
      ? (request.requestEnd + requests[index + 1].requestStart) / 2 : durationSeconds,
  }));
}

async function seedLinkedVideos(env, videos) {
  await createRun(env.DB, { runId: `run_seed_${videos[0].youtubeId}`, personId: "person_troy_black",
    triggerType: "manual", scope: `seed:${videos[0].youtubeId}`, createdAt: AT });
  const seeded = [];
  for (const [index, video] of videos.entries()) {
    const post = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "official_site",
      platformItemId: String(90_000 + index), canonicalUrl: `https://troyblackvideos.com/post-${video.youtubeId}/`, seenAt: AT });
    await addRevision(env.DB, post.source_item_id, { canonicalUrl: post.canonical_url,
      title: `Post ${video.youtubeId}`, description: "Public description.", publicationDate: video.date,
      embeddedPlatform: "youtube", embeddedItemId: video.youtubeId,
      embeddedUrl: `https://www.youtube.com/watch?v=${video.youtubeId}` },
    { runId: `run_seed_${videos[0].youtubeId}`, parserVersion: "test-v1", fetchedAt: AT });
    const source = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube",
      platformItemId: video.youtubeId, canonicalUrl: `https://www.youtube.com/watch?v=${video.youtubeId}`, seenAt: AT });
    await linkExactEmbedded(env.DB, post.source_item_id, source.source_item_id, AT);
    if (video.hasArtifact) env.DB.db.prepare(`INSERT INTO transcript_artifacts
      (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,provenance,created_at)
      VALUES (?,?,?,?,?,'en',0,'authorized_transcript',?)`).run(`tx_existing_${index}`, source.source_item_id,
      `private/existing-${index}.txt`, String(index + 1).repeat(64), 10, AT);
    seeded.push(source);
  }
  return seeded;
}

async function seedAnalysisPreparation(env, { youtubeId, transcript }) {
  const [source] = await seedLinkedVideos(env, [{ youtubeId, date: "2020-01-01" }]);
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
  const preparation = await transcriptAnalysisPreparationEnvelope({ transcriptId,
    sourceItemId: source.source_item_id, personId: "person_troy_black", transcriptSha256 });
  await ensureTranscriptAnalysisPreparationRun(env.DB, preparation, AT);
  await registerJob(env.DB, preparation, AT);
  return preparation;
}

async function seedArchiveLinks(env, sources, { duplicateFirst = false } = {}) {
  const runId = `run_archive_${crypto.randomUUID().replaceAll("-", "")}`;
  await createRun(env.DB, { runId, personId: "person_troy_black", triggerType: "manual",
    scope: `archive-test:${runId}`, createdAt: AT });
  const receiptId = `fprec_${crypto.randomUUID().replaceAll("-", "")}`;
  env.DB.db.prepare(`INSERT INTO first_party_archive_receipts
    (receipt_id,run_id,source_id,person_id,adapter,source_url,response_sha256,row_count,
     parser_version,fetched_at)
    VALUES (?,?,?,?, 'wptb_fulfilled_prophecy_v1',?, ?,?,'test-v1',?)`).run(receiptId, runId,
      "source_troy_archive", "person_troy_black",
      "https://troyblackvideos.com/prophecy-archive-all/", "a".repeat(64), sources.length, AT);
  for (const [index, source] of sources.entries()) {
    const revisionCount = duplicateFirst && index === 0 ? 2 : 1;
    const leadId = `fpal_test_${index}_${crypto.randomUUID().replaceAll("-", "")}`;
    env.DB.db.prepare(`INSERT INTO first_party_archive_leads
      (archive_lead_id,source_id,person_id,publisher_element_id,created_at)
      VALUES (?,?,? ,?,?)`).run(leadId, "source_troy_archive", "person_troy_black", `row-${index}`, AT);
    for (let revision = 0; revision < revisionCount; revision += 1) {
      const revisionId = `fprev_test_${index}_${revision}_${crypto.randomUUID().replaceAll("-", "")}`;
      const linkId = `fplink_test_${index}_${revision}_${crypto.randomUUID().replaceAll("-", "")}`;
      const workId = `fpwork_test_${index}_${revision}_${crypto.randomUUID().replaceAll("-", "")}`;
      env.DB.db.prepare(`INSERT INTO first_party_archive_lead_revisions
        (archive_revision_id,archive_lead_id,receipt_id,content_sha256,source_locator_y_index,
         description_text,date_shared_text,prophecy_text,claimed_result_text,claimed_evidence_text,
         parser_version,fetched_at)
        VALUES (?,?,?,?,?,'Description','2020-01-01','Claimed prophecy','Claimed result',
          'Claimed evidence','test-v1',?)`).run(revisionId, leadId, receiptId,
          String(index + revision + 1).repeat(64).slice(0, 64), index + 1, AT);
      env.DB.db.prepare(`INSERT INTO first_party_archive_revision_links
        (archive_link_id,archive_revision_id,link_role,ordinal,label,url,youtube_id,
         source_item_id,provenance)
        VALUES (?,?,'original_video',1,'Original video',?,?,?,
          'first_party_claimed_original')`).run(linkId, revisionId,
          `https://www.youtube.com/watch?v=${source.platform_item_id}`,
          source.platform_item_id, source.source_item_id);
      env.DB.db.prepare(`INSERT INTO archive_verification_work_items
        (archive_work_item_id,archive_revision_id,archive_video_link_id,status,created_at)
        VALUES (?,?,?,'ready',?)`).run(workId, revisionId, linkId, AT);
    }
  }
}

function preArchiveBatchEnv() {
  const env = batchEnv();
  env.DB = new D1Shim();
  for (const file of readdirSync(join(ROOT, "migrations"))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 19).sort()) {
    env.DB.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  return env;
}

async function seedLegacyStitch(env, { durationSeconds = 60, completeChunks = true } = {}) {
  env.ARTIFACTS = r2Memory();
  const sources = await seedLinkedVideos(env, [
    { youtubeId: "LegacyFix01", date: "2020-01-01" },
    { youtubeId: "LegacyFix02", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: `legacy-repair-${durationSeconds}`,
    at: AT, durationFetcher: durationFetcher(durationSeconds) });
  env.sent.length = 0;
  const item = env.DB.db.prepare("SELECT * FROM transcript_batch_items WHERE status='active'").get();
  env.DB.db.prepare("UPDATE ingestion_runs SET scope=? WHERE run_id=?")
    .run(`transcript:${item.source_item_id}:${durationSeconds}:batch:${item.batch_id}`, item.run_id);
  const plan = legacyTranscriptPlan(durationSeconds);
  const chunks = plan.map((window, index) => `Spoken section ${index + 1}.`);
  const storedChunkCount = completeChunks ? plan.length : Math.max(0, plan.length - 1);
  const hashes = [];
  for (let index = 0; index < storedChunkCount; index += 1) {
    const window = plan[index];
    const stableKey = `youtube:${item.youtube_id}:transcript:chunk:${index}`;
    const envelope = await makeEnvelope({ runId: item.run_id, personId: "person_troy_black",
      type: "transcript_extract", stableKey,
      payload: { phase: "chunk", chunkIndex: index, youtubeId: item.youtube_id,
        sourceItemId: item.source_item_id, durationSeconds, batchId: item.batch_id,
        batchItemId: item.batch_item_id } });
    await registerJob(env.DB, envelope, AT);
    env.DB.db.prepare("UPDATE ingestion_jobs SET status='completed',attempt_count=1,completed_at=? WHERE job_id=?")
      .run(AT, envelope.jobId);
    const reservationId = `gmr_${index}_${crypto.randomUUID().replaceAll("-", "")}`;
    const chunkAttemptId = `txc_${index}_${crypto.randomUUID().replaceAll("-", "")}`;
    const contentSha256 = await sha256(chunks[index]); hashes.push(contentSha256);
    const r2Key = `transcripts/chunks/test/${index}-${contentSha256}.txt`;
    await env.ARTIFACTS.put(r2Key, chunks[index]);
    env.DB.db.prepare(`INSERT INTO gemini_media_reservations
      (reservation_id,media_day,run_id,job_id,source_item_id,chunk_index,job_attempt,
       start_seconds,end_seconds,reserved_seconds,budget_limit_seconds,created_at)
      VALUES (?,?,?,?,?,?,1,?,?,?,?,?)`).run(reservationId, "2026-07-20", item.run_id,
        envelope.jobId, item.source_item_id, index, window.requestStart, window.requestEnd,
        window.requestEnd - window.requestStart, 28_800, AT);
    env.DB.db.prepare(`INSERT INTO transcript_chunk_attempts
      (chunk_attempt_id,reservation_id,run_id,job_id,source_item_id,chunk_index,
       start_seconds,end_seconds,overlap_seconds,provider,model_name,prompt_version,
       request_sha256,response_id,finish_reason,input_tokens,output_tokens,r2_key,
       content_sha256,byte_count,status,error_code,created_at)
      VALUES (?,?,?,?,?,?,?,?,0,'google_gemini','gemini-test','youtube-clip-text-v1',?,NULL,
        'STOP',1,1,?,?,?,'completed',NULL,?)`).run(chunkAttemptId, reservationId,
        item.run_id, envelope.jobId, item.source_item_id, index, window.requestStart,
        window.requestEnd, "b".repeat(64), r2Key, contentSha256,
        new TextEncoder().encode(chunks[index]).length, AT);
  }
  const stitched = completeChunks ? stitchTranscript(chunks, plan) : {
    text: "[CLIP 00:00:00-00:05:00 | GEMINI-GENERATED, NEEDS HUMAN CHECK]\nIncomplete.\n",
    cueCount: 0,
  };
  const contentSha256 = await sha256(stitched.text);
  const transcriptId = await stableId("tx", `${item.source_item_id}:${contentSha256}`);
  const r2Key = `transcripts/final/test/${contentSha256}.txt`;
  await env.ARTIFACTS.put(r2Key, stitched.text);
  env.DB.db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at)
    VALUES (?,?,?,?,?,'en',0,'gemini_generated_public_youtube_clipped_v1',NULL,?)`)
    .run(transcriptId, item.source_item_id, r2Key, contentSha256,
      new TextEncoder().encode(stitched.text).length, AT);
  const stitchEnvelope = await makeEnvelope({ runId: item.run_id, personId: "person_troy_black",
    type: "transcript_extract", stableKey: `youtube:${item.youtube_id}:transcript:stitch`,
    payload: { phase: "stitch", youtubeId: item.youtube_id, sourceItemId: item.source_item_id,
      durationSeconds, batchId: item.batch_id, batchItemId: item.batch_item_id } });
  await registerJob(env.DB, stitchEnvelope, AT);
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='failed',attempt_count=3,
    error_code='ai_unavailable',completed_at=? WHERE job_id=?`).run(AT, stitchEnvelope.jobId);
  env.DB.db.prepare(`INSERT INTO transcript_stitch_receipts
    (stitch_id,run_id,job_id,source_item_id,transcript_id,duration_seconds,chunk_count,
     overlap_seconds,cue_count,input_manifest_sha256,stitch_algorithm,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(await stableId("txs", `${stitchEnvelope.jobId}:${transcriptId}:${LEGACY_STITCH_ALGORITHM}`),
      item.run_id, stitchEnvelope.jobId, item.source_item_id, transcriptId, durationSeconds,
      plan.length, 0, stitched.cueCount, await sha256(hashes), LEGACY_STITCH_ALGORITHM, AT);
  env.DB.db.prepare(`UPDATE transcript_batches SET status='paused',pause_reason='transcript_retry_exhausted',
    resume_after=?,paused_at=?,transition_count=transition_count+1 WHERE batch_id=?`)
    .run(NEXT_DAY, AT, item.batch_id);
  return { started, item, transcriptId, r2Key, sources };
}

function queueMessage(body) {
  const state = { acked: 0, retried: 0, delay: null };
  return { state, body,
    ack: () => { state.acked += 1; },
    retry: ({ delaySeconds } = {}) => { state.retried += 1; state.delay = delaySeconds; } };
}

test("authenticated idempotent batch freezes exact-linked no-artifact videos oldest-first", async () => {
  const env = batchEnv(); env.YOUTUBE_DATA_API_KEY = "batch-data-api-secret"; const durationCalls = [];
  await seedLinkedVideos(env, [
    { youtubeId: "Newest00001", date: "2026-01-03" },
    { youtubeId: "Oldest00001", date: "2020-01-01" },
    { youtubeId: "SkipArt0001", date: "2019-01-01", hasArtifact: true },
    { youtubeId: "Middle00001", date: "2023-05-10" },
  ]);
  const request = () => new Request("https://scanner.example/admin/transcript-batch", { method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json",
      "idempotency-key": "troy-oldest-first-2026-07-20" }, body: JSON.stringify({ action: "start" }) });
  for (const body of ["{", "{}"] ) {
    const invalid = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
      method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json",
        "idempotency-key": "must-not-start" }, body }), env, { durationFetcher: durationFetcher() });
    assert.equal(invalid.status, 400);
  }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batches").get().count, 0);
  const unauthorized = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { "idempotency-key": "troy-oldest-first-2026-07-20" },
    body: JSON.stringify({ action: "start" }) }), env, { durationFetcher: durationFetcher() });
  assert.equal(unauthorized.status, 401);
  const first = await fetchHandler(request(), env, { durationFetcher: dataApiDurationFetcher(60, durationCalls) });
  assert.equal(first.status, 202);
  const rows = env.DB.db.prepare(`SELECT youtube_id,source_publication_date,ordinal,status
    FROM transcript_batch_items ORDER BY ordinal`).all();
  assert.deepEqual(rows.map((row) => row.youtube_id), ["Oldest00001", "Middle00001", "Newest00001"]);
  assert.deepEqual(rows.map((row) => row.ordinal), [1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.status), ["active", "pending", "pending"]);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.planVersion, TRANSCRIPT_PLAN_VERSION);
  assert.match(env.sent[0].stableKey,
    new RegExp(`:transcript:${TRANSCRIPT_PLAN_VERSION}:chunk:0$`));
  assert.equal(durationCalls.length, 1);
  assert.equal(new URL(durationCalls[0]).hostname, "www.googleapis.com");
  const receipt = env.DB.db.prepare("SELECT method,response_sha256 FROM source_media_metadata").get();
  assert.equal(receipt.method, "youtube_data_api_v3_content_details");
  assert.doesNotMatch(JSON.stringify(receipt), /batch-data-api-secret|googleapis\.com/);

  const duplicate = await fetchHandler(request(), env, { durationFetcher: async () => { throw new Error("must_not_refetch"); } });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).reused, true);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batches").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items").get().count, 3);
  assert.equal(env.sent.length, 1);
});

test("controller completes one item before activating exactly one next video", async () => {
  const env = batchEnv(); env.YOUTUBE_DATA_API_KEY = "batch-data-api-secret"; const durationCalls = [];
  await seedLinkedVideos(env, [
    { youtubeId: "Serial00001", date: "2020-01-01" },
    { youtubeId: "Serial00002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "serial-controller-2026-07-20",
    at: AT, durationFetcher: dataApiDurationFetcher(60, durationCalls) });
  assert.equal(started.started, true);
  const blockedCanary = await startTranscriptCanary(env, { youtubeId: "Serial00002",
    durationFetcher: async () => { throw new Error("must_not_fetch_while_batch_active"); } });
  assert.equal(blockedCanary.started, false);
  assert.equal(blockedCanary.reason, "transcript_batch_active");
  assert.equal(env.sent.length, 1);
  const first = env.DB.db.prepare("SELECT * FROM transcript_batch_items WHERE status='active'").get();
  const successors = await completeTranscriptBatchItem(env, { batchId: started.batchId,
    batchItemId: first.batch_item_id, at: "2026-07-20T10:05:00.000Z",
    durationFetcher: dataApiDurationFetcher(90, durationCalls) });
  assert.equal(successors.length, 1);
  assert.equal(successors[0].payload.youtubeId, "Serial00002");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='active'").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_batch_items WHERE batch_item_id=?").get(first.batch_item_id).status, "completed");
  assert.equal(durationCalls.length, 2);
  assert.equal(env.DB.db.prepare(`SELECT COUNT(*) count FROM source_media_metadata
    WHERE method='youtube_data_api_v3_content_details'`).get().count, 2);
  assert.throws(() => env.DB.db.exec(`UPDATE transcript_batch_items SET status='active',completed_at=NULL
    WHERE batch_item_id='${first.batch_item_id}'`), /UNIQUE constraint/);
});

test("successful stitch advances acquisition before isolated Workers AI analysis and analysis outage cannot pause it", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret"; env.ARTIFACTS = r2Memory();
  env.AI_MODEL = "local-model"; env.AI_FALLBACK_MODEL = "local-fallback";
  let aiCalls = 0;
  env.AI = { run: async () => { aiCalls += 1; throw new Error("ai_unavailable"); } };
  await seedLinkedVideos(env, [
    { youtubeId: "Stitch00001", date: "2020-01-01" },
    { youtubeId: "Stitch00002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "stitch-advance-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const firstChunk = env.sent.shift();
  const geminiFetcher = async () => new Response(JSON.stringify({ responseId: "response_batch_one",
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Complete spoken words." }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  await processEnvelope(env, firstChunk, { at: AT, geminiFetcher, durationFetcher: durationFetcher() });
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.phase, "stitch");
  await processEnvelope(env, env.sent.shift(), { at: "2026-07-20T10:01:00.000Z",
    geminiFetcher, durationFetcher: durationFetcher() });
  assert.equal(aiCalls, 0);
  assert.equal(env.sent.length, 2);
  assert.equal(env.sent[0].payload.phase, "chunk");
  assert.equal(env.sent[0].payload.youtubeId, "Stitch00002");
  assert.equal(env.sent[1].payload.phase, "prepare");
  assert.deepEqual(Object.keys(env.sent[1].payload).sort(), ["analysisRunId",
    "phase", "promptVersion", "sourceItemId", "transcriptId", "transcriptSha256"]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_analysis_sections").get().count, 0);
  assert.doesNotMatch(JSON.stringify(env.sent[1]), /Complete spoken words|transcripts\/final|r2_key/i);
  const preparation = env.sent.pop();
  await processEnvelope(env, preparation, { at: "2026-07-20T10:01:15.000Z" });
  assert.equal(env.sent.length, 2);
  assert.equal(env.sent[1].payload.phase, "analyze");
  assert.deepEqual(Object.keys(env.sent[1].payload).sort(), ["analysisRunId", "analysisSectionId",
    "inputSha256", "phase", "promptVersion", "sectionIndex", "sourceItemId",
    "transcriptId", "transcriptSha256"]);
  assert.doesNotMatch(JSON.stringify(env.sent[1]), /Complete spoken words|transcripts\/final|r2_key/i);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='completed'").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='active'").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT completed_item_count FROM transcript_batches WHERE batch_id=?").get(started.batchId).completed_item_count, 1);
  const analysis = env.sent.pop();
  const forged = structuredClone(analysis); forged.payload.inputSha256 = "f".repeat(64);
  await assert.rejects(() => processEnvelope(env, forged, { at: "2026-07-20T10:01:30.000Z" }),
    /invalid_transcript_analysis_binding/);
  assert.equal(aiCalls, 0);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const message = queueMessage(analysis);
    await processQueueBatch({ messages: [message] }, env, { at: `2026-07-20T10:0${attempt + 1}:00.000Z` });
    assert.equal(message.state.retried, attempt < 3 ? 1 : 0);
    assert.equal(message.state.acked, attempt === 3 ? 1 : 0);
  }
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_analysis_sections").get().status, "failed");
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_batches WHERE batch_id=?").get(started.batchId).status, "running");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_events WHERE event_type='batch_paused'").get().count, 0);
});

test("normal stitch refuses an R2 chunk whose bytes no longer match its immutable receipt", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret"; env.ARTIFACTS = r2Memory();
  await seedLinkedVideos(env, [{ youtubeId: "Corrupt0001", date: "2020-01-01" }]);
  await startTranscriptBatch(env, { idempotencyKey: "corrupt-stitch-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const chunk = env.sent.shift();
  const geminiFetcher = async () => new Response(JSON.stringify({ responseId: "response_corrupt",
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Original words." }] } }] }),
  { status: 200 });
  await processEnvelope(env, chunk, { at: AT, geminiFetcher, durationFetcher: durationFetcher() });
  const stitch = env.sent.shift();
  const stored = env.DB.db.prepare("SELECT r2_key FROM transcript_chunk_attempts WHERE status='completed'").get();
  await env.ARTIFACTS.put(stored.r2_key, "Changed after receipt.");
  await assert.rejects(() => processEnvelope(env, stitch, {
    at: "2026-07-20T10:01:00.000Z", durationFetcher: durationFetcher(),
  }), /transcript_chunk_hash_mismatch/);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_artifacts").get().count, 0);
});

test("analysis preparation accepts identical section hashes at different indexes", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const repeated = "[CLIP 00:00:00-00:05:00 | GEMINI-GENERATED, NEEDS HUMAN CHECK]\nRepeated words.";
  const preparation = await seedAnalysisPreparation(env, {
    youtubeId: "Repeat00001", transcript: `${repeated}\n\n${repeated}\n`,
  });
  await processEnvelope(env, preparation, { at: "2026-07-20T10:01:00.000Z" });
  const sections = env.DB.db.prepare(`SELECT section_index,input_sha256 FROM transcript_analysis_sections
    ORDER BY section_index`).all();
  assert.equal(sections.length, 2);
  assert.equal(sections[0].input_sha256, sections[1].input_sha256);
  assert.deepEqual(sections.map((row) => row.section_index), [0, 1]);
});

test("maximum-length analysis setup stays below the Workers Free 50-statement D1 cap", async () => {
  const env = batchEnv(); env.ARTIFACTS = r2Memory();
  const plan = transcriptPlan(43_200);
  const transcript = stitchTranscript(plan.map((window) => `Words for section ${window.index}.`), plan).text;
  const preparation = await seedAnalysisPreparation(env, {
    youtubeId: "LongVideo01", transcript,
  });
  env.DB.resetStatementCount();
  await processEnvelope(env, preparation, { at: "2026-07-20T10:01:00.000Z" });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_analysis_sections").get().count, 144);
  assert.equal(env.sent.filter((item) => item.payload.phase === "analyze").length, 144);
  assert.ok(env.DB.statementCount <= 20, `used ${env.DB.statementCount} D1 statements`);
});

test("daily cap pauses and acknowledges current work with no same-day or disabled redispatch", async () => {
  const env = batchEnv(); env.GEMINI_DAILY_MEDIA_SECONDS = "1";
  await seedLinkedVideos(env, [
    { youtubeId: "Budget00001", date: "2020-01-01" },
    { youtubeId: "Budget00002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "budget-pause-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const message = queueMessage(env.sent.shift());
  await processQueueBatch({ messages: [message] }, env, { at: AT,
    geminiFetcher: async () => { throw new Error("gemini_must_not_run"); } });
  assert.deepEqual(message.state, { acked: 1, retried: 0, delay: null });
  const paused = env.DB.db.prepare("SELECT status,pause_reason,resume_after FROM transcript_batches WHERE batch_id=?")
    .get(started.batchId);
  assert.deepEqual({ ...paused }, { status: "paused", pause_reason: "daily_media_cap", resume_after: NEXT_DAY });
  assert.equal(env.DB.db.prepare("SELECT error_code FROM ingestion_jobs WHERE run_id=?").get(started.activeItem.runId).error_code,
    "transcript_batch_paused");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='active'").get().count, 1);
  assert.equal(env.sent.length, 0);

  env.GEMINI_DAILY_MEDIA_SECONDS = "86400";
  let duplicateGeminiCalls = 0;
  const duplicate = queueMessage(message.body);
  await processQueueBatch({ messages: [duplicate] }, env, { at: "2026-07-20T12:00:00.000Z",
    geminiFetcher: async () => { duplicateGeminiCalls += 1; throw new Error("paused_batch_must_not_call_gemini"); } });
  assert.deepEqual(duplicate.state, { acked: 1, retried: 0, delay: null });
  assert.equal(duplicateGeminiCalls, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM gemini_media_reservations").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT attempt_count FROM ingestion_jobs WHERE job_id=?").get(message.body.jobId).attempt_count, 1);
  assert.equal(env.sent.length, 0);

  assert.deepEqual(await resumeScheduledTranscriptBatch(env, { at: NEXT_DAY }), { resumed: false, reason: "batch_disabled" });
  env.TRANSCRIPT_BATCH_ENABLED = "1";
  assert.equal((await resumeScheduledTranscriptBatch(env, { at: "2026-07-20T23:59:59.000Z" })).reason, "resume_not_ready");
  assert.equal(env.sent.length, 0);
  const resumed = await resumeScheduledTranscriptBatch(env, { at: NEXT_DAY });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.status, "running");
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].jobId, message.body.jobId);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='active'").get().count, 1);
});

test("Gemini 429 records a redacted failed attempt, pauses, acks, and dispatches no next video", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret";
  await seedLinkedVideos(env, [
    { youtubeId: "RateLim0001", date: "2020-01-01" },
    { youtubeId: "RateLim0002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "rate-limit-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const message = queueMessage(env.sent.shift());
  await processQueueBatch({ messages: [message] }, env, { at: AT,
    geminiFetcher: async () => new Response(JSON.stringify({ error: { message: "secret provider body" } }),
      { status: 429, headers: { "content-type": "application/json" } }) });
  assert.deepEqual(message.state, { acked: 1, retried: 0, delay: null });
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_batches WHERE batch_id=?").get(started.batchId).status, "paused");
  const attempt = env.DB.db.prepare("SELECT status,error_code,request_sha256 FROM transcript_chunk_attempts").get();
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.error_code, "gemini_http_429");
  assert.match(attempt.request_sha256, /^[a-f0-9]{64}$/);
  const event = env.DB.db.prepare("SELECT detail_json FROM transcript_batch_events WHERE event_type='batch_paused'").get();
  assert.deepEqual(JSON.parse(event.detail_json), { action: "transcript_batch_paused", reason: "gemini_429",
    mediaDay: "2026-07-20", jobId: message.body.jobId, httpStatus: 429 });
  assert.doesNotMatch(event.detail_json, /secret provider body|gemini-secret/);
  assert.throws(() => env.DB.db.exec("UPDATE transcript_batch_events SET detail_json='{}'"), /append-only/);
  assert.equal(env.sent.length, 0);
  let duplicateGeminiCalls = 0;
  const duplicate = queueMessage(message.body);
  await processQueueBatch({ messages: [duplicate] }, env, { at: "2026-07-20T20:00:00.000Z",
    geminiFetcher: async () => { duplicateGeminiCalls += 1; return new Response("{}", { status: 200 }); } });
  assert.deepEqual(duplicate.state, { acked: 1, retried: 0, delay: null });
  assert.equal(duplicateGeminiCalls, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM gemini_media_reservations").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_chunk_attempts").get().count, 1);
  assert.equal(env.sent.length, 0);
  env.TRANSCRIPT_BATCH_ENABLED = "1";
  assert.equal((await resumeScheduledTranscriptBatch(env, { at: "2026-07-20T20:00:00.000Z" })).reason, "resume_not_ready");
  assert.equal(env.sent.length, 0);
});



test("terminal chunk failure auto-advances to the next video when enabled", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret"; env.TRANSCRIPT_BATCH_AUTO_ADVANCE = "1";
  await seedLinkedVideos(env, [
    { youtubeId: "AutoAdv0001", date: "2020-01-01" },
    { youtubeId: "AutoAdv0002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "auto-advance-2026-08-02",
    at: AT, durationFetcher: durationFetcher() });
  assert.equal(started.status, "running", JSON.stringify(started));
  assert.equal(env.sent.length, 1, JSON.stringify(started));
  const message = queueMessage(env.sent.shift());
  await processQueueBatch({ messages: [message] }, env, { at: AT,
    durationFetcher: durationFetcher(),
    geminiFetcher: async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 403 }) });
  assert.equal(message.state.acked, 1);
  const items = env.DB.db.prepare(`SELECT youtube_id,status FROM transcript_batch_items
    WHERE batch_id=? ORDER BY ordinal`).all(started.batchId);
  assert.deepEqual(items.map((item) => [item.youtube_id, item.status]),
    [["AutoAdv0001", "skipped"], ["AutoAdv0002", "active"]]);
  const batch = env.DB.db.prepare("SELECT status,pause_reason FROM transcript_batches WHERE batch_id=?")
    .get(started.batchId);
  assert.equal(batch.status, "running");
  assert.equal(batch.pause_reason, null);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.youtubeId, "AutoAdv0002");
});

test("RECITATION-blocked chunk completes with placeholder and does not pause the batch", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret"; env.ARTIFACTS = r2Memory();
  await seedLinkedVideos(env, [{ youtubeId: "Recite00001", date: "2020-01-01" }]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "recitation-2026-08-02",
    at: AT, durationFetcher: durationFetcher(120) });
  assert.equal(started.status, "running", JSON.stringify(started));
  assert.equal(env.sent.length, 1, JSON.stringify(started));
  const message = queueMessage(env.sent.shift());
  await processQueueBatch({ messages: [message] }, env, { at: AT,
    geminiFetcher: async () => new Response(JSON.stringify({
      candidates: [{ finishReason: "RECITATION", content: { parts: [] } }],
    }), { status: 200 }) });
  assert.equal(message.state.acked, 1);
  assert.equal(message.state.retried, 0);
  const job = env.DB.db.prepare("SELECT status,error_code FROM ingestion_jobs WHERE job_id=?")
    .get(message.body.jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.error_code, null);
  const batch = env.DB.db.prepare("SELECT status,pause_reason FROM transcript_batches WHERE batch_id=?")
    .get(started.batchId);
  assert.deepEqual({ ...batch }, { status: "running", pause_reason: null });
  const attempt = env.DB.db.prepare("SELECT status,finish_reason,error_code FROM transcript_chunk_attempts ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.finish_reason, "STOP");
  assert.equal(attempt.error_code, null);
  assert.match(
    env.ARTIFACTS.objects.get([...env.ARTIFACTS.objects.keys()].at(-1)),
    /GEMINI BLOCKED RECITATION/,
  );
});

test("gemini_output_truncated is retryable and does not terminal-pause on first attempt", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret";
  await seedLinkedVideos(env, [{ youtubeId: "TruncVid001", date: "2020-01-01" }]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "truncate-retry-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const message = queueMessage(env.sent.shift());
  await processQueueBatch({ messages: [message] }, env, { at: AT,
    geminiFetcher: async () => new Response(JSON.stringify({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "partial" }] } }],
    }), { status: 200 }) });
  assert.equal(message.state.retried, 1);
  assert.equal(message.state.acked, 0);
  const job = env.DB.db.prepare("SELECT status,attempt_count,error_code FROM ingestion_jobs WHERE job_id=?")
    .get(message.body.jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.attempt_count, 1);
  assert.equal(job.error_code, "gemini_output_truncated");
  const batch = env.DB.db.prepare("SELECT status,pause_reason FROM transcript_batches WHERE batch_id=?")
    .get(started.batchId);
  assert.deepEqual({ ...batch }, { status: "running", pause_reason: null });
});

test("nonretryable transcript failure pauses batch and controlled resume requeues the failed job", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret";
  await seedLinkedVideos(env, [{ youtubeId: "BadReq00001", date: "2020-01-01" }]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "terminal-error-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const message = queueMessage(env.sent.shift());
  await processQueueBatch({ messages: [message] }, env, { at: AT,
    geminiFetcher: async () => new Response(JSON.stringify({ error: { message: "private provider detail" } }), { status: 403 }) });
  assert.deepEqual(message.state, { acked: 1, retried: 0, delay: null });
  assert.equal(env.DB.db.prepare("SELECT status FROM ingestion_jobs WHERE job_id=?").get(message.body.jobId).status, "failed");
  const paused = env.DB.db.prepare("SELECT status,pause_reason,resume_after FROM transcript_batches WHERE batch_id=?")
    .get(started.batchId);
  assert.deepEqual({ ...paused }, { status: "paused", pause_reason: "transcript_terminal_error", resume_after: NEXT_DAY });
  const event = env.DB.db.prepare("SELECT detail_json FROM transcript_batch_events WHERE event_type='batch_paused'").get();
  assert.doesNotMatch(event.detail_json, /private provider detail|gemini-secret|gemini_http_403/);
  env.TRANSCRIPT_BATCH_ENABLED = "1";
  const resumed = await resumeScheduledTranscriptBatch(env, { at: NEXT_DAY });
  assert.equal(resumed.resumed, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].jobId, message.body.jobId);
  const requeued = env.DB.db.prepare("SELECT status,attempt_count,error_code,completed_at FROM ingestion_jobs WHERE job_id=?")
    .get(message.body.jobId);
  assert.deepEqual({ ...requeued }, { status: "queued", attempt_count: 1, error_code: null, completed_at: null });
});

test("third transient transcript failure pauses batch and is recoverable on the next day", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret";
  await seedLinkedVideos(env, [{ youtubeId: "Transient01", date: "2020-01-01" }]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "retry-exhausted-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const body = env.sent.shift();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const message = queueMessage(body);
    await processQueueBatch({ messages: [message] }, env, { at: `2026-07-20T10:0${attempt}:00.000Z`,
      geminiFetcher: async () => new Response(JSON.stringify({ error: { message: "private transient detail" } }), { status: 503 }) });
    assert.equal(message.state.retried, attempt < 3 ? 1 : 0);
    assert.equal(message.state.acked, attempt === 3 ? 1 : 0);
  }
  assert.equal(env.DB.db.prepare("SELECT status,attempt_count FROM ingestion_jobs WHERE job_id=?").get(body.jobId).status, "failed");
  const batch = env.DB.db.prepare("SELECT status,pause_reason FROM transcript_batches WHERE batch_id=?").get(started.batchId);
  assert.deepEqual({ ...batch }, { status: "paused", pause_reason: "transcript_retry_exhausted" });
  const event = env.DB.db.prepare("SELECT detail_json FROM transcript_batch_events WHERE event_type='batch_paused'").get();
  assert.doesNotMatch(event.detail_json, /private transient detail|gemini_http_503/);
  assert.equal(env.sent.length, 0);
  env.TRANSCRIPT_BATCH_ENABLED = "1";
  const resumed = await resumeScheduledTranscriptBatch(env, { at: NEXT_DAY });
  assert.equal(resumed.resumed, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].jobId, body.jobId);
  assert.equal(env.DB.db.prepare("SELECT attempt_count FROM ingestion_jobs WHERE job_id=?").get(body.jobId).attempt_count, 3);
});

test("admin skip refuses invalid, running, and retryable active transcript items", async () => {
  const env = batchEnv();
  await seedLinkedVideos(env, [
    { youtubeId: "SkipGuard01", date: "2020-01-01" },
    { youtubeId: "SkipGuard02", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "skip-guard-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  assert.equal((await skipActiveTranscriptItem(env, { batchId: started.batchId })).reason, "batch_not_paused");
  const active = env.DB.db.prepare("SELECT batch_item_id FROM transcript_batch_items WHERE status='active'").get();
  await pauseTranscriptBatch(env, { batchId: started.batchId, batchItemId: active.batch_item_id,
    reason: "daily_media_cap", at: AT, resumeAfter: NEXT_DAY });
  const retryable = await skipActiveTranscriptItem(env, { batchId: started.batchId });
  assert.equal(retryable.reason, "active_item_not_failed");
  const invalid = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "skip_active_item", batchId: "not-a-batch" }),
  }), env);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).reason, "invalid_batch_id");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_events WHERE event_type='item_skipped'").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='active'").get().count, 1);
  assert.equal(env.sent.length, 1);
});

test("concurrent admin skip preserves failed history and dispatches exactly one balanced-v2 successor", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret";
  await seedLinkedVideos(env, [
    { youtubeId: "SkipFail001", date: "2020-01-01" },
    { youtubeId: "SkipNext002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "skip-failed-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const failedEnvelope = env.sent.shift();
  const failedMessage = queueMessage(failedEnvelope);
  await processQueueBatch({ messages: [failedMessage] }, env, { at: AT,
    geminiFetcher: async () => new Response(JSON.stringify({ error: { message: "private provider detail" } }),
      { status: 403 }) });
  const failedBefore = env.DB.db.prepare(`SELECT status,attempt_count,error_code,completed_at
    FROM ingestion_jobs WHERE job_id=?`).get(failedEnvelope.jobId);
  const request = () => new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ action: "skip_active_item", batchId: started.batchId }),
  });
  const responses = await Promise.all([
    fetchHandler(request(), env, { durationFetcher: durationFetcher() }),
    fetchHandler(request(), env, { durationFetcher: durationFetcher() }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(results.filter((result) => result.skipped).length, 1);
  assert.equal(results.filter((result) => !result.skipped).length, 1);
  assert.deepEqual({ ...env.DB.db.prepare(`SELECT status,attempt_count,error_code,completed_at
    FROM ingestion_jobs WHERE job_id=?`).get(failedEnvelope.jobId) }, { ...failedBefore });
  const items = env.DB.db.prepare(`SELECT batch_item_id,status,run_id FROM transcript_batch_items
    WHERE batch_id=? ORDER BY ordinal`).all(started.batchId);
  assert.deepEqual(items.map((item) => item.status), ["skipped", "active"]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_events WHERE event_type='item_skipped'").get().count, 1);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.youtubeId, "SkipNext002");
  assert.equal(env.sent[0].payload.planVersion, TRANSCRIPT_PLAN_VERSION);
  assert.match(env.sent[0].stableKey, new RegExp(`:${TRANSCRIPT_PLAN_VERSION}:chunk:0$`));
  const duplicate = await fetchHandler(request(), env, { durationFetcher: durationFetcher() });
  assert.equal(duplicate.status, 409);
  assert.equal(env.sent.length, 1);
  const successors = await completeTranscriptBatchItem(env, { batchId: started.batchId,
    batchItemId: items[1].batch_item_id, at: "2026-07-20T10:05:00.000Z",
    durationFetcher: durationFetcher() });
  assert.deepEqual(successors, []);
  const completed = await (await fetchHandler(new Request(
    `https://scanner.example/admin/transcript-batch?batchId=${started.batchId}`,
    { headers: { authorization: "Bearer admin-secret" } }), env)).json();
  assert.equal(completed.status, "completed");
  assert.equal(completed.itemCount, 2);
  assert.equal(completed.completedItemCount, 1);
  assert.deepEqual(completed.counts,
    { completed: 1, active: 0, pending: 0, quarantined: 0, skipped: 1 });
});

test("enabled scheduler never creates a batch and never redispatches a running active item", async () => {
  const config = readFileSync(join(ROOT, "scanner", "wrangler.toml"), "utf8");
  assert.match(config, /^SCAN_ENABLED = "0"$/m);
  // The owner-approved production conveyor is intentionally enabled. Safety is
  // enforced by the scheduler's no-create/no-duplicate-dispatch behavior below,
  // not by asserting a disabled deployment default.
  assert.match(config, /^TRANSCRIPT_BATCH_ENABLED = "1"$/m);
  const env = batchEnv(); env.TRANSCRIPT_BATCH_ENABLED = "1";
  assert.deepEqual(await resumeScheduledTranscriptBatch(env, { at: AT }), { resumed: false, reason: "no_open_batch" });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batches").get().count, 0);
  await seedLinkedVideos(env, [{ youtubeId: "Active00001", date: "2020-01-01" }]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "active-no-redispatch-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  assert.equal(env.sent.length, 1);
  const checked = await resumeScheduledTranscriptBatch(env, { at: "2026-07-20T10:01:00.000Z" });
  assert.equal(checked.repaired, false);
  assert.equal(checked.reason, "item_already_dispatched");
  assert.equal(checked.batchId, started.batchId);
  assert.equal(env.sent.length, 1);
});

test("batch claim guard leaves legacy non-batch deferred transcript recovery unchanged", async () => {
  const env = batchEnv(); env.GEMINI_API_KEY = "gemini-secret"; env.GEMINI_DAILY_MEDIA_SECONDS = "1";
  env.ARTIFACTS = r2Memory();
  await seedLinkedVideos(env, [{ youtubeId: "Legacy00001", date: "2020-01-01" }]);
  const started = await startTranscriptCanary(env, { youtubeId: "Legacy00001",
    expectedDurationSeconds: 60, durationFetcher: durationFetcher() });
  const first = env.sent.shift();
  await assert.rejects(() => processEnvelope(env, first, { at: AT,
    geminiFetcher: async () => { throw new Error("budget_must_block_before_gemini"); } }), /transcript_budget_deferred/);
  env.GEMINI_DAILY_MEDIA_SECONDS = "86400";
  let geminiCalls = 0;
  const recovered = await processEnvelope(env, first, { at: NEXT_DAY, geminiFetcher: async () => {
    geminiCalls += 1;
    return new Response(JSON.stringify({ responseId: "legacy_recovered",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Recovered transcript words." }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  } });
  assert.equal(recovered.status, "completed");
  assert.equal(geminiCalls, 1);
  assert.equal(started.batchId, undefined);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].payload.phase, "stitch");
});
