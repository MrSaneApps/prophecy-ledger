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

test("same-key restart repairs a committed batch with no activated item exactly once", async () => {
  const env = batchEnv(); env.YOUTUBE_DATA_API_KEY = "batch-data-api-secret";
  const [source] = await seedLinkedVideos(env, [{ youtubeId: "CrashOne001", date: "2020-01-01" }]);
  const key = "repair-created-batch-2026-07-20";
  const batchId = await stableId("txb", `transcript-batch-v1:${key}`);
  const itemId = `txbi_${batchId.slice(4)}_${source.source_item_id.slice(4)}`;
  env.DB.db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,created_at,started_at)
    VALUES (?,?,?,'running',1,?,?)`).run(batchId, key, "person_troy_black", AT, AT);
  env.DB.db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,source_publication_date,ordinal,status)
    VALUES (?,?,?,?,?,1,'pending')`).run(itemId, batchId, source.source_item_id, "CrashOne001", "2020-01-01");
  const repaired = await startTranscriptBatch(env, { idempotencyKey: key, at: AT,
    durationFetcher: dataApiDurationFetcher() });
  assert.equal(repaired.reused, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM ingestion_jobs").get().count, 1);
  await startTranscriptBatch(env, { idempotencyKey: key, at: "2026-07-20T10:01:00.000Z",
    durationFetcher: async () => { throw new Error("must_not_refetch"); } });
  assert.equal(env.sent.length, 1);
});

test("same-key restart repairs an active item missing its first job exactly once", async () => {
  const env = batchEnv();
  const [source] = await seedLinkedVideos(env, [{ youtubeId: "CrashTwo001", date: "2020-01-01" }]);
  const key = "repair-active-item-2026-07-20";
  const batchId = await stableId("txb", `transcript-batch-v1:${key}`);
  const itemId = `txbi_${batchId.slice(4)}_${source.source_item_id.slice(4)}`;
  const runId = await stableId("runtxb", `${batchId}:${itemId}:60`);
  env.DB.db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,created_at,started_at)
    VALUES (?,?,?,'running',1,?,?)`).run(batchId, key, "person_troy_black", AT, AT);
  env.DB.db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES (?,?,'manual',?,'queued',?)`).run(runId, "person_troy_black",
      `transcript:${source.source_item_id}:60:batch:${batchId}`, AT);
  env.DB.db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,source_publication_date,ordinal,status,run_id,duration_seconds,started_at)
    VALUES (?,?,?,?,?,1,'active',?,60,?)`).run(itemId, batchId, source.source_item_id, "CrashTwo001", "2020-01-01", runId, AT);
  await startTranscriptBatch(env, { idempotencyKey: key, at: AT, durationFetcher: durationFetcher() });
  assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM ingestion_jobs").get().count, 1);
  await startTranscriptBatch(env, { idempotencyKey: key, at: "2026-07-20T10:01:00.000Z" });
  assert.equal(env.sent.length, 1);
});

test("duration failure on resume reports the renewed pause and records every transition", async () => {
  const env = batchEnv(); env.YOUTUBE_DATA_API_KEY = "batch-data-api-secret";
  await seedLinkedVideos(env, [{ youtubeId: "DurFail0001", date: "2020-01-01" }]);
  const key = "duration-failure-resume-2026-07-20";
  const hosts = []; const fail = async (url) => { hosts.push(new URL(url).hostname);
    return new Response(JSON.stringify({ error: { message: "batch-data-api-secret must stay private" } }), { status: 403 }); };
  const started = await startTranscriptBatch(env, { idempotencyKey: key, at: AT, durationFetcher: fail });
  assert.equal(started.started, false);
  assert.equal(started.reason, "youtube_data_api_http_403");
  const resumed = await resumeTranscriptBatch(env, { idempotencyKey: key, at: AT, durationFetcher: fail });
  assert.equal(resumed.resumed, false);
  assert.equal(resumed.reason, "youtube_data_api_http_403");
  assert.equal(resumed.status, "paused");
  const events = env.DB.db.prepare(`SELECT event_id,event_type FROM transcript_batch_events
    WHERE batch_id=? AND event_type IN ('batch_paused','batch_resumed') ORDER BY rowid`).all(started.batchId);
  assert.deepEqual(events.map((row) => row.event_type), ["batch_paused", "batch_resumed", "batch_paused"]);
  assert.equal(new Set(events.map((row) => row.event_id)).size, 3);
  assert.deepEqual(hosts, ["www.googleapis.com", "www.googleapis.com"]);
  assert.doesNotMatch(JSON.stringify(env.DB.db.prepare("SELECT detail_json FROM transcript_batch_events").all()),
    /batch-data-api-secret|googleapis\.com/);
  env.TRANSCRIPT_BATCH_ENABLED = "1";
  const scheduled = await resumeScheduledTranscriptBatch(env, { at: AT,
    durationFetcher: dataApiDurationFetcher() });
  assert.equal(scheduled.resumed, true);
  assert.equal(env.DB.db.prepare(`SELECT method FROM source_media_metadata
    ORDER BY observed_at DESC LIMIT 1`).get().method, "youtube_data_api_v3_content_details");
});

async function pausedPhysicalFuseBatch() {
  const env = batchEnv(); env.GEMINI_DAILY_MEDIA_SECONDS = "60";
  const [source] = await seedLinkedVideos(env, [{ youtubeId: "ResumeFuse1", date: "2020-01-01" }]);
  const key = "resume-physical-fuse-2026-07-20";
  const started = await startTranscriptBatch(env, { idempotencyKey: key, at: AT, durationFetcher: durationFetcher() });
  const active = env.DB.db.prepare(`SELECT item.*,job.job_id FROM transcript_batch_items item
    JOIN ingestion_jobs job ON job.run_id=item.run_id WHERE item.batch_id=? AND item.status='active'`).get(started.batchId);
  env.DB.db.prepare(`INSERT INTO gemini_media_reservations
    (reservation_id,media_day,run_id,job_id,source_item_id,chunk_index,job_attempt,start_seconds,
     end_seconds,reserved_seconds,budget_limit_seconds,created_at)
    VALUES ('resume_logical','2026-07-20',?,?,?,0,1,0,40,40,60,?)`)
    .run(active.run_id, active.job_id, source.source_item_id, AT);
  env.DB.db.prepare(`INSERT INTO gemini_physical_request_reservations
    (physical_request_id,logical_reservation_id,media_day,run_id,job_id,source_item_id,chunk_index,
     job_attempt,split_path,start_seconds,end_seconds,reserved_seconds,budget_limit_seconds,created_at)
    VALUES ('resume_physical','resume_logical','2026-07-20',?,?,?,0,1,'root',0,40,40,60,?)`)
    .run(active.run_id, active.job_id, source.source_item_id, AT);
  env.DB.db.prepare(`INSERT INTO gemini_physical_day_debits
    (debit_id,media_day,reserved_seconds,reason,created_at)
    VALUES ('resume_debit','2026-07-20',20,'legacy_cutover_fail_closed',?)`).run(AT);
  await pauseTranscriptBatch(env, { batchId: started.batchId, batchItemId: active.batch_item_id,
    reason: "daily_media_cap", at: "2026-07-20T11:00:00.000Z", resumeAfter: "2026-07-20T11:30:00.000Z" });
  env.sent.length = 0;
  return { env, key, started, active };
}

test("direct and scheduled resume preserve every durable row when the UTC physical media fuse is exhausted", async () => {
  const { env, key, started, active } = await pausedPhysicalFuseBatch();
  const before = {
    batch: env.DB.db.prepare("SELECT status,pause_reason,resume_after,transition_count FROM transcript_batches WHERE batch_id=?").get(started.batchId),
    item: env.DB.db.prepare("SELECT status,dispatch_state,dispatch_claimed_at FROM transcript_batch_items WHERE batch_item_id=?").get(active.batch_item_id),
    job: env.DB.db.prepare("SELECT status,claimed_at,lease_token,error_code,completed_at FROM ingestion_jobs WHERE job_id=?").get(active.job_id),
    events: env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_events WHERE batch_id=?").get(started.batchId).count,
  };
  const direct = await resumeTranscriptBatch(env, { idempotencyKey: key, at: "2026-07-20T12:00:00.000Z" });
  assert.deepEqual({ resumed: direct.resumed, reason: direct.reason, mediaDay: direct.mediaDay,
    mediaSeconds: direct.mediaSeconds, mediaLimitSeconds: direct.mediaLimitSeconds, status: direct.status },
  { resumed: false, reason: "media_fuse_exhausted", mediaDay: "2026-07-20",
    mediaSeconds: 60, mediaLimitSeconds: 60, status: "paused" });
  env.TRANSCRIPT_BATCH_ENABLED = "1";
  const scheduled = await resumeScheduledTranscriptBatch(env, { at: "2026-07-20T12:01:00.000Z" });
  assert.equal(scheduled.reason, "media_fuse_exhausted");
  assert.deepEqual(env.DB.db.prepare("SELECT status,pause_reason,resume_after,transition_count FROM transcript_batches WHERE batch_id=?").get(started.batchId), before.batch);
  assert.deepEqual(env.DB.db.prepare("SELECT status,dispatch_state,dispatch_claimed_at FROM transcript_batch_items WHERE batch_item_id=?").get(active.batch_item_id), before.item);
  assert.deepEqual(env.DB.db.prepare("SELECT status,claimed_at,lease_token,error_code,completed_at FROM ingestion_jobs WHERE job_id=?").get(active.job_id), before.job);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_events WHERE batch_id=?").get(started.batchId).count, before.events);
  assert.equal(env.sent.length, 0);
});

test("scheduled resume ignores the prior UTC day's exhausted fuse and dispatches on a zero-use day", async () => {
  const { env, started } = await pausedPhysicalFuseBatch();
  const transitionBefore = env.DB.db.prepare("SELECT transition_count FROM transcript_batches WHERE batch_id=?").get(started.batchId).transition_count;
  env.TRANSCRIPT_BATCH_ENABLED = "1";
  const nextDay = await resumeScheduledTranscriptBatch(env, { at: "2026-07-21T00:00:05.000Z" });
  assert.equal(nextDay.resumed, true);
  assert.equal(nextDay.status, "running");
  assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT transition_count FROM transcript_batches WHERE batch_id=?").get(started.batchId).transition_count,
    Number(transitionBefore) + 1);
});

test("pending unavailable source is quarantined once, preserves history, and dispatches one successor", async () => {
  const env = batchEnv(); env.YOUTUBE_DATA_API_KEY = "batch-data-api-secret";
  await seedLinkedVideos(env, [
    { youtubeId: "PrivGone001", date: "2020-01-01" },
    { youtubeId: "Successor01", date: "2020-01-02" },
    { youtubeId: "LaterPending", date: "2020-01-03" },
  ]);
  const key = "quarantine-unavailable-2026-08-03";
  const started = await startTranscriptBatch(env, { idempotencyKey: key, at: AT,
    durationFetcher: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }) });
  assert.equal(started.status, "paused");
  assert.equal(started.reason, "youtube_data_api_video_not_found");
  const target = env.DB.db.prepare(`SELECT * FROM transcript_batch_items
    WHERE youtube_id='PrivGone001'`).get();
  const targetBefore = { ...target };
  const historyTables = ["claims", "evidence", "review_work_items", "review_assignments",
    "moderator_reviews", "claim_revisions", "publication_evaluations", "review_audit_events"];
  const historyBefore = Object.fromEntries(historyTables.map((name) =>
    [name, env.DB.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));

  assert.equal((await quarantinePendingTranscriptItem(env, {
    batchId: started.batchId, batchItemId: target.batch_item_id,
    idempotencyKey: "wrong-quarantine-key", expectedTransitionCount: started.transitionCount,
    reasonCode: "source_unavailable", observedErrorCode: "youtube_data_api_video_not_found",
  })).reason, "idempotency_key_mismatch");
  assert.equal((await quarantinePendingTranscriptItem(env, {
    batchId: started.batchId, batchItemId: target.batch_item_id, idempotencyKey: key,
    expectedTransitionCount: started.transitionCount + 1, reasonCode: "source_unavailable",
    observedErrorCode: "youtube_data_api_video_not_found",
  })).reason, "transition_mismatch");
  assert.equal((await quarantinePendingTranscriptItem(env, {
    batchId: started.batchId, batchItemId: target.batch_item_id, idempotencyKey: key,
    expectedTransitionCount: started.transitionCount, reasonCode: "private_video",
    observedErrorCode: "youtube_data_api_video_not_found",
  })).reason, "invalid_disposition_reason");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_item_dispositions").get().count, 0);

  const body = { action: "quarantine_pending_item", batchId: started.batchId,
    batchItemId: target.batch_item_id, expectedTransitionCount: started.transitionCount,
    reasonCode: "source_unavailable", observedErrorCode: "youtube_data_api_video_not_found" };
  const unauthorized = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  }), env, { durationFetcher: dataApiDurationFetcher(60) });
  assert.equal(unauthorized.status, 401);
  const appliedResponse = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json",
      "idempotency-key": key }, body: JSON.stringify(body),
  }), env, { durationFetcher: dataApiDurationFetcher(60) });
  assert.equal(appliedResponse.status, 200, await appliedResponse.clone().text());
  const applied = await appliedResponse.json();
  assert.equal(applied.contract, "transcript-batch-quarantine-v1");
  assert.equal(applied.applied, true);
  assert.equal(applied.reused, false);
  assert.equal(applied.dispatched, true);
  assert.equal(applied.youtubeId, "PrivGone001");
  assert.equal(applied.successor.youtubeId, "Successor01");
  assert.equal(applied.successor.dispatchState, "sent");
  assert.deepEqual(applied.counts, { completed: 0, active: 1, pending: 1, quarantined: 1, skipped: 0 });
  assert.equal(applied.completedItemCount, 0);
  assert.equal(applied.transitionAfter, applied.transitionBefore + 1);
  assert.deepEqual({ ...env.DB.db.prepare("SELECT * FROM transcript_batch_items WHERE batch_item_id=?")
    .get(target.batch_item_id) }, targetBefore);
  assert.equal(env.sent.length, 1);

  const replayResponse = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json",
      "idempotency-key": key }, body: JSON.stringify(body),
  }), env, { durationFetcher: async () => { throw new Error("replay_must_not_refetch"); } });
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.dispositionId, applied.dispositionId);
  assert.equal(replay.applied, false);
  assert.equal(replay.reused, true);
  assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_item_dispositions").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT transition_count FROM transcript_batches WHERE batch_id=?")
    .get(started.batchId).transition_count, applied.transitionAfter);
  const historyAfter = Object.fromEntries(historyTables.map((name) =>
    [name, env.DB.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  assert.deepEqual(historyAfter, historyBefore);
  assert.deepEqual(env.DB.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a quarantined final pending item completes the batch without becoming completed", async () => {
  const env = batchEnv(); env.YOUTUBE_DATA_API_KEY = "batch-data-api-secret";
  await seedLinkedVideos(env, [{ youtubeId: "PrivGone002", date: "2020-01-01" }]);
  const key = "quarantine-final-item-2026-08-03";
  const started = await startTranscriptBatch(env, { idempotencyKey: key, at: AT,
    durationFetcher: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }) });
  const target = env.DB.db.prepare("SELECT * FROM transcript_batch_items").get();
  const result = await quarantinePendingTranscriptItem(env, {
    batchId: started.batchId, batchItemId: target.batch_item_id, idempotencyKey: key,
    expectedTransitionCount: started.transitionCount, reasonCode: "source_unavailable",
    observedErrorCode: "youtube_data_api_video_not_found", at: AT,
  });
  assert.equal(result.quarantined, true);
  assert.equal(result.status, "completed");
  assert.equal(result.completedItemCount, 0);
  assert.equal(result.successor, null);
  assert.deepEqual(result.counts, { completed: 0, active: 0, pending: 0, quarantined: 1, skipped: 0 });
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_batch_items").get().status, "pending");
});

test("batch reuses an exact official duration receipt but ignores older provenance under the binding", async () => {
  const env = batchEnv(); env.YOUTUBE_DATA_API_KEY = "batch-data-api-secret";
  const [source] = await seedLinkedVideos(env, [{ youtubeId: "Receipt0001", date: "2020-01-01" }]);
  await recordSourceMediaMetadata(env.DB, { sourceItemId: source.source_item_id, durationSeconds: 90,
    responseSha256: "a".repeat(64), method: "youtube_public_html_length_seconds", observedAt: AT });
  let calls = 0;
  const first = await startTranscriptBatch(env, { idempotencyKey: "official-receipt-fetch-2026-07-20", at: AT,
    durationFetcher: async (url) => { calls += 1; return dataApiDurationFetcher(75)(url); } });
  assert.equal(first.activeItem.durationSeconds, 75);
  assert.equal(calls, 1);
  const env2 = batchEnv(); env2.YOUTUBE_DATA_API_KEY = "batch-data-api-secret";
  const [source2] = await seedLinkedVideos(env2, [{ youtubeId: "Receipt0002", date: "2020-01-01" }]);
  await recordSourceMediaMetadata(env2.DB, { sourceItemId: source2.source_item_id, durationSeconds: 80,
    responseSha256: "b".repeat(64), method: "youtube_data_api_v3_content_details", observedAt: AT });
  const reused = await startTranscriptBatch(env2, { idempotencyKey: "official-receipt-reuse-2026-07-20", at: AT,
    durationFetcher: async () => { throw new Error("official_receipt_must_be_reused"); } });
  assert.equal(reused.activeItem.durationSeconds, 80);
});

test("different-key concurrent starts produce one batch and a controlled conflict", async () => {
  const env = batchEnv();
  await seedLinkedVideos(env, [{ youtubeId: "RaceStart01", date: "2020-01-01" }]);
  const results = await Promise.all([
    startTranscriptBatch(env, { idempotencyKey: "race-start-alpha-2026-07-20", at: AT, durationFetcher: durationFetcher() }),
    startTranscriptBatch(env, { idempotencyKey: "race-start-beta-2026-07-20", at: AT, durationFetcher: durationFetcher() }),
  ]);
  assert.equal(results.filter((result) => result.started).length, 1);
  assert.equal(results.filter((result) => result.reason === "active_batch_exists").length, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batches").get().count, 1);
  assert.equal(env.sent.length, 1);
});

test("scheduler redispatches one expired active lease and relational binding rejects forged batch envelopes", async () => {
  const env = batchEnv(); env.TRANSCRIPT_BATCH_ENABLED = "1";
  await seedLinkedVideos(env, [{ youtubeId: "LeaseFix001", date: "2020-01-01" }]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "expired-lease-repair-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const body = env.sent.shift();
  env.DB.db.prepare(`UPDATE ingestion_jobs SET status='processing',attempt_count=1,claimed_at=?,lease_token='lost'
    WHERE job_id=?`).run("2026-07-20T10:01:00.000Z", body.jobId);
  const repaired = await resumeScheduledTranscriptBatch(env, { at: "2026-07-20T10:20:01.000Z" });
  assert.equal(repaired.repaired, true);
  assert.equal(env.sent.length, 1);
  const forged = structuredClone(body);
  forged.payload.youtubeId = "Forged00001";
  await assert.rejects(() => processEnvelope(env, forged, { at: "2026-07-20T10:21:00.000Z" }),
    /invalid_transcript_batch_binding/);
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_batches WHERE batch_id=?").get(started.batchId).status, "running");
});

test("manual archive sync appends missing videos without rewriting ordinals and priority activation dedupes revisions", async () => {
  const env = batchEnv();
  await seedLinkedVideos(env, [
    { youtubeId: "Ordinary001", date: "2020-01-01" },
    { youtubeId: "Ordinary002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "archive-priority-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const initial = env.DB.db.prepare(`SELECT batch_item_id,source_item_id,ordinal,status
    FROM transcript_batch_items ORDER BY ordinal`).all();
  const [archiveSource] = await seedLinkedVideos(env, [
    { youtubeId: "Archive0001", date: "2025-01-01" },
  ]);
  await seedArchiveLinks(env, [archiveSource], { duplicateFirst: true });
  const unauthorized = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "sync_archive_items", batchId: started.batchId }),
  }), env);
  assert.equal(unauthorized.status, 401);
  const synced = await syncArchiveLinkedTranscriptBatch(env, { batchId: started.batchId, at: AT });
  assert.deepEqual({ synced: synced.synced, reused: synced.reused,
    appendedItemCount: synced.appendedItemCount }, { synced: true, reused: false, appendedItemCount: 1 });
  const after = env.DB.db.prepare(`SELECT batch_item_id,source_item_id,ordinal,status
    FROM transcript_batch_items ORDER BY ordinal`).all();
  assert.deepEqual(after.slice(0, 2).map((row) => [row.batch_item_id, row.source_item_id, row.ordinal]),
    initial.map((row) => [row.batch_item_id, row.source_item_id, row.ordinal]));
  assert.equal(after[2].ordinal, 3);
  assert.equal(after[2].source_item_id, archiveSource.source_item_id);
  assert.throws(() => env.DB.db.prepare("UPDATE transcript_batch_items SET ordinal=99 WHERE batch_item_id=?")
    .run(initial[1].batch_item_id), /identity is immutable/);
  assert.equal((await syncArchiveLinkedTranscriptBatch(env, { batchId: started.batchId })).appendedItemCount, 0);
  const current = env.DB.db.prepare("SELECT batch_item_id FROM transcript_batch_items WHERE status='active'").get();
  const successors = await completeTranscriptBatchItem(env, { batchId: started.batchId,
    batchItemId: current.batch_item_id, at: "2026-07-20T10:02:00.000Z",
    durationFetcher: durationFetcher() });
  assert.equal(successors.length, 1);
  assert.equal(successors[0].payload.youtubeId, "Archive0001");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='active'").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_repair_events WHERE event_type='archive_items_appended'").get().count, 1);
});

test("archive sync bulk-appends more than 48 missing videos under the Free D1 statement cap", async () => {
  const env = batchEnv();
  await seedLinkedVideos(env, [{ youtubeId: "Ordinary003", date: "2020-01-01" }]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "archive-bulk-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const archiveVideos = Array.from({ length: 60 }, (_, index) => ({
    youtubeId: `Archive${String(index).padStart(4, "0")}`, date: "2025-01-01",
  }));
  const sources = await seedLinkedVideos(env, archiveVideos);
  await seedArchiveLinks(env, sources);
  env.DB.resetStatementCount();
  const synced = await syncArchiveLinkedTranscriptBatch(env, { batchId: started.batchId, at: AT });
  assert.equal(synced.appendedItemCount, 60);
  assert.ok(env.DB.statementCount <= 10, `used ${env.DB.statementCount} D1 statements`);
  const ordinals = env.DB.db.prepare(`SELECT MIN(ordinal) minimum,MAX(ordinal) maximum
    FROM transcript_batch_items WHERE source_item_id IN (
      SELECT source_item_id FROM source_items WHERE platform_item_id LIKE 'Archive%'
    )`).get();
  assert.deepEqual([ordinals.minimum, ordinals.maximum], [2, 61]);
});

test("archive priority selection falls back to original ordinal before migration 0020 exists", async () => {
  const env = preArchiveBatchEnv();
  await seedLinkedVideos(env, [
    { youtubeId: "Fallback001", date: "2020-01-01" },
    { youtubeId: "Fallback002", date: "2020-01-02" },
  ]);
  const started = await startTranscriptBatch(env, { idempotencyKey: "pre-archive-fallback-2026-07-20",
    at: AT, durationFetcher: durationFetcher() });
  const first = env.DB.db.prepare("SELECT batch_item_id FROM transcript_batch_items WHERE status='active'").get();
  const successors = await completeTranscriptBatchItem(env, { batchId: started.batchId,
    batchItemId: first.batch_item_id, at: "2026-07-20T10:02:00.000Z",
    durationFetcher: durationFetcher() });
  assert.equal(successors[0].payload.youtubeId, "Fallback002");
});

test("manual legacy stitch repair verifies receipts, advances once, and queues only private-safe section jobs", async () => {
  const env = batchEnv();
  const legacy = await seedLegacyStitch(env, { durationSeconds: 60 });
  const body = { action: "repair_legacy_stitch", batchId: legacy.started.batchId,
    batchItemId: legacy.item.batch_item_id };
  const unauthorized = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, { durationFetcher: durationFetcher() });
  assert.equal(unauthorized.status, 401);
  const response = await fetchHandler(new Request("https://scanner.example/admin/transcript-batch", {
    method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, { durationFetcher: durationFetcher() });
  assert.equal(response.status, 200);
  const repaired = await response.json();
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.reused, false);
  assert.equal(repaired.acquisitionAdvanced, true);
  assert.equal(repaired.activeItemCount, 1);
  assert.equal(repaired.queuedAnalysisSectionCount, 0);
  assert.equal(repaired.analysisPreparationQueued, true);
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_batch_items WHERE batch_item_id=?")
    .get(legacy.item.batch_item_id).status, "completed");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_items WHERE status='active'").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_analysis_sections WHERE status='queued'").get().count, 0);
  assert.equal(env.sent.length, 2);
  assert.equal(env.sent[0].payload.phase, "chunk");
  assert.equal(env.sent[1].payload.phase, "prepare");
  const preparation = env.sent.pop();
  await processEnvelope(env, preparation, { at: "2026-07-20T10:05:30.000Z" });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_analysis_sections WHERE status='queued'").get().count, 1);
  assert.equal(env.sent[1].payload.phase, "analyze");
  assert.deepEqual(Object.keys(env.sent[1].payload).sort(), ["analysisRunId", "analysisSectionId",
    "inputSha256", "phase", "promptVersion", "sectionIndex", "sourceItemId",
    "transcriptId", "transcriptSha256"]);
  assert.doesNotMatch(JSON.stringify({ repaired, queued: env.sent }),
    /Spoken section|transcripts\/final|r2_key|admin-secret|gemini-secret/i);
  const sentCount = env.sent.length;
  const duplicate = await repairLegacyStitchedTranscriptBatchItem(env, {
    batchId: legacy.started.batchId, batchItemId: legacy.item.batch_item_id,
    at: "2026-07-20T10:06:00.000Z", durationFetcher: async () => { throw new Error("must_not_repeat"); },
  });
  assert.deepEqual(duplicate, { repaired: true, reused: true,
    batchId: legacy.started.batchId, batchItemId: legacy.item.batch_item_id });
  assert.equal(env.sent.length, sentCount);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM transcript_batch_repair_events WHERE event_type='legacy_stitch_repaired'").get().count, 1);
});

test("legacy stitch repair refuses incomplete chunks and forged private artifacts", async () => {
  const incompleteEnv = batchEnv();
  const incomplete = await seedLegacyStitch(incompleteEnv, { durationSeconds: 301, completeChunks: false });
  const refusedIncomplete = await repairLegacyStitchedTranscriptBatchItem(incompleteEnv, {
    batchId: incomplete.started.batchId, batchItemId: incomplete.item.batch_item_id,
    at: "2026-07-20T10:05:00.000Z", durationFetcher: durationFetcher(),
  });
  assert.deepEqual({ repaired: refusedIncomplete.repaired, reason: refusedIncomplete.reason },
    { repaired: false, reason: "legacy_stitch_chunks_incomplete" });
  assert.equal(incompleteEnv.DB.db.prepare("SELECT status FROM transcript_batch_items WHERE batch_item_id=?")
    .get(incomplete.item.batch_item_id).status, "active");
  assert.equal(incompleteEnv.sent.length, 0);

  const forgedEnv = batchEnv();
  const forged = await seedLegacyStitch(forgedEnv, { durationSeconds: 60 });
  await forgedEnv.ARTIFACTS.put(forged.r2Key, "Forged private transcript body.");
  const refusedForged = await repairLegacyStitchedTranscriptBatchItem(forgedEnv, {
    batchId: forged.started.batchId, batchItemId: forged.item.batch_item_id,
    at: "2026-07-20T10:05:00.000Z", durationFetcher: durationFetcher(),
  });
  assert.deepEqual({ repaired: refusedForged.repaired, reason: refusedForged.reason },
    { repaired: false, reason: "legacy_stitch_content_hash_mismatch" });
  assert.equal(forgedEnv.DB.db.prepare("SELECT status FROM transcript_batch_items WHERE batch_item_id=?")
    .get(forged.item.batch_item_id).status, "active");
  assert.equal(forgedEnv.sent.length, 0);
});
