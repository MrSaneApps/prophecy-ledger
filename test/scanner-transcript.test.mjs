import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv } from "./helpers/d1.mjs";
import { processEnvelope, scannerStatus, startTranscriptCanary, validateEnvelope } from "../scanner/src/jobs.js";
import { createRun, registerJob, reserveGeminiMedia, reserveGeminiPhysicalRequest, upsertSourceItem } from "../scanner/src/repository.js";
import { makeEnvelope } from "../scanner/src/jobs.js";
import { fetchHandler } from "../scanner/src/index.js";
import { sha256 } from "../scanner/src/hash.js";
import {
  extractTranscriptSection, fetchYouTubeDataApiDuration, fetchYouTubeDuration,
  parseYouTubeDataApiDuration, requestTranscriptChunk, requestTranscriptChunkWithSplit,
  MIN_TRANSCRIPT_WINDOW_SECONDS, SHORT_WINDOW_PLACEHOLDER, POLICY_BLOCKED_FINISH_REASONS,
  policyBlockedPlaceholder, stitchTranscript,
  TRANSCRIPT_PLAN_VERSION, transcriptPlan, transcriptSections,
} from "../scanner/src/transcript.js";

const durationFetcher = (seconds) => async () => new Response(`<html><script>{"lengthSeconds":"${seconds}"}</script></html>`, { status: 200 });

function r2Memory() {
  const objects = new Map();
  return {
    objects,
    put: async (key, value) => { objects.set(key, String(value)); },
    get: async (key) => objects.has(key) ? { text: async () => objects.get(key) } : null,
  };
}

function groundedTranscriptCandidate(transcript, quote) {
  const start = transcript.indexOf(quote);
  const support = (value) => {
    const supportStart = transcript.indexOf(value, start);
    return { value, supportQuote: value, supportStart, supportEnd: supportStart + value.length };
  };
  return { quote, start, end: start + quote.length, contextStart: start, contextEnd: start + quote.length,
    statementType: "present_or_past_factual_claim",
    atomicProposition: "Mayor Lee closed the north bridge at 9 AM on Friday because inspectors found cracks, using a signed city order.",
    deadlineText: null, sourceTimestampSeconds: 0,
    who: support("Mayor Lee"), what: support("closed the north bridge"),
    why: support("because inspectors found cracks"), where: support("north bridge"),
    when: support("9 AM on Friday"), how: support("using a signed city order"),
    evidenceTest: { publicEvidence: "The signed public city order and bridge closure log.",
      passCondition: "The records show the stated closure.", failCondition: "The records show no such closure." } };
}

test("five-minute transcript planning never exceeds five minutes and stitching labels every generated clip", () => {
  const plan = transcriptPlan(600, { chunkSeconds: 300, overlapSeconds: 0 });
  assert.deepEqual(plan, [
    { index: 0, canonicalStart: 0, canonicalEnd: 300, requestStart: 0, requestEnd: 300 },
    { index: 1, canonicalStart: 300, canonicalEnd: 600, requestStart: 300, requestEnd: 600 },
  ]);
  assert.equal(plan.every((window) => window.requestEnd - window.requestStart <= 300), true);
  const result = stitchTranscript(["Opening words", "Second-window words"], plan);
  assert.match(result.text, /^\[CLIP 00:00:00-00:05:00 \| GEMINI-GENERATED, NEEDS HUMAN CHECK\]/);
  assert.match(result.text, /\[CLIP 00:05:00-00:10:00 \| GEMINI-GENERATED, NEEDS HUMAN CHECK\]/);
  assert.match(result.text, /Opening words[\s\S]*Second-window words/);
  assert.equal(result.cueCount, 0);
});

test("balanced transcript planning covers modulo-one durations without one-second tails", () => {
  assert.deepEqual(transcriptPlan(301).map(({ requestStart, requestEnd }) => [requestStart, requestEnd]),
    [[0, 151], [151, 301]]);
  assert.deepEqual(transcriptPlan(601).map(({ requestStart, requestEnd }) => [requestStart, requestEnd]),
    [[0, 201], [201, 401], [401, 601]]);
  assert.deepEqual(transcriptPlan(901).map(({ requestStart, requestEnd }) => [requestStart, requestEnd]),
    [[0, 226], [226, 451], [451, 676], [676, 901]]);
});

test("balanced transcript plans are deterministic, bounded, and gapless across chunk boundaries", () => {
  for (const durationSeconds of [
    ...Array.from({ length: 7 }, (_, index) => 297 + index),
    ...Array.from({ length: 7 }, (_, index) => 597 + index),
    ...Array.from({ length: 7 }, (_, index) => 897 + index),
    43_200,
  ]) {
    const first = transcriptPlan(durationSeconds);
    assert.deepEqual(transcriptPlan(durationSeconds), first);
    assert.equal(first[0].requestStart, 0);
    assert.equal(first.at(-1).requestEnd, durationSeconds);
    assert.equal(first.every((window) => window.requestEnd - window.requestStart <= 300), true);
    assert.equal(first.every((window, index) => index === 0 ||
      first[index - 1].requestEnd === window.requestStart), true);
    const lengths = first.map((window) => window.requestEnd - window.requestStart);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1);
    if (durationSeconds > 300) assert.ok(Math.min(...lengths) > 1);
  }
});

test("balanced transcript overlap stays exact without exceeding the request limit", () => {
  for (let durationSeconds = 270; durationSeconds <= 910; durationSeconds += 1) {
    const plan = transcriptPlan(durationSeconds, { chunkSeconds: 300, overlapSeconds: 30 });
    assert.equal(plan[0].requestStart, 0);
    assert.equal(plan.at(-1).requestEnd, durationSeconds);
    assert.equal(plan.every((window) => window.requestEnd - window.requestStart <= 300), true);
    assert.equal(plan.every((window, index) => index === 0 ||
      plan[index - 1].requestEnd - window.requestStart === 30), true);
    assert.equal(plan.every((window, index) => index === 0 ||
      plan[index - 1].canonicalEnd === window.canonicalStart), true);
  }
});

test("one candidate rejected by persistence is audited without losing a valid sibling", async () => {
  const env = makeEnv();
  const firstQuote = "At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks, using a signed city order.";
  const secondQuote = `${firstQuote} Officials confirmed the same order later.`;
  const transcript = `[CLIP 00:00:00-00:05:00]\n${firstQuote}\n${secondQuote}`;
  const source = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube",
    platformItemId: "Persist0001", canonicalUrl: "https://www.youtube.com/watch?v=Persist0001" });
  const contentSha256 = await sha256(transcript); const transcriptId = "tx_persistence_sibling";
  env.DB.db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,verifier_principal,created_at)
    VALUES (?,?,?, ?,?,'en',0,'gemini_generated_public_youtube_clipped_v1',NULL,?)`)
    .run(transcriptId, source.source_item_id, "private/persistence-sibling.txt", contentSha256,
      new TextEncoder().encode(transcript).length, "2026-07-20T00:00:00.000Z");
  env.DB.db.exec(`CREATE TRIGGER test_reject_one_candidate
    BEFORE INSERT ON claim_candidates WHEN NEW.exact_quote='${firstQuote.replaceAll("'", "''")}'
    BEGIN SELECT RAISE(IGNORE); END`);
  const result = await extractTranscriptSection({
    run: async () => ({ response: JSON.stringify({ candidates: [
      groundedTranscriptCandidate(transcriptSections(transcript)[0].text, firstQuote),
      groundedTranscriptCandidate(transcriptSections(transcript)[0].text, secondQuote),
    ] }) }),
  }, { db: env.DB, transcriptId, sourceItemId: source.source_item_id, transcript,
    section: transcriptSections(transcript)[0], models: ["local-model"],
    createdAt: "2026-07-20T00:01:00.000Z" });
  assert.equal(result.candidateCount, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM claim_candidates WHERE extraction_run_id=?")
    .get(result.extractionRunId).count, 1);
  assert.equal(env.DB.db.prepare(`SELECT COUNT(*) count FROM candidate_admissibility_assessments assessment
    JOIN claim_candidates candidate ON candidate.candidate_id=assessment.candidate_id
    WHERE candidate.extraction_run_id=?`).get(result.extractionRunId).count, 1);
  const rejected = env.DB.db.prepare(`SELECT candidate_ordinal,error_code
    FROM extraction_candidate_persistence_rejections WHERE extraction_run_id=?`)
    .get(result.extractionRunId);
  assert.equal(rejected.candidate_ordinal, 0);
  assert.equal(rejected.error_code, "candidate_not_persisted");
  assert.throws(() => env.DB.db.prepare(`UPDATE extraction_candidate_persistence_rejections
    SET error_code='assessment_not_persisted' WHERE rejection_id=(
      SELECT rejection_id FROM extraction_candidate_persistence_rejections LIMIT 1
    )`).run(), /append-only/);
});

test("Gemini transcript request uses the documented clipping metadata and rejects truncated output", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ responseId: "response_one", candidates: [{ finishReason: "STOP",
      content: { parts: [{ text: "Exact words from the supplied clip." }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const window = transcriptPlan(360)[1];
  const result = await requestTranscriptChunk({ apiKey: "secret", videoUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0", window, fetcher });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-3\.5-flash-lite:generateContent$/);
  assert.deepEqual(calls[0].body.contents[0].parts[0].videoMetadata, { startOffset: "180s", endOffset: "360s" });
  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
  assert.match(calls[0].body.contents[0].parts[1].text, /plain text/i);
  assert.match(calls[0].body.contents[0].parts[1].text, /do not include timestamps/i);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "secret");
  assert.equal(result.finishReason, "STOP");
  assert.equal(result.text, "Exact words from the supplied clip.");

  let truncated = null;
  try {
    await requestTranscriptChunk({ apiKey: "secret", videoUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0", window,
      fetcher: async () => new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "WEBVTT" }] } }] }), { status: 200 }) });
  } catch (error) {
    truncated = error;
  }
  assert.equal(truncated?.message, "gemini_output_truncated");
  assert.equal(truncated?.retryable, true);

  let incomplete = null;
  try {
    await requestTranscriptChunk({ apiKey: "secret", videoUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0", window,
      fetcher: async () => new Response(JSON.stringify({ candidates: [{ finishReason: "OTHER", content: { parts: [{ text: "" }] } }] }), { status: 200 }) });
  } catch (error) {
    incomplete = error;
  }
  assert.equal(incomplete?.message, "gemini_incomplete_response");
  assert.equal(incomplete?.retryable, true);
});


test("truncated/incomplete transcript windows split instead of accepting runaway text", async () => {
  const calls = [];
  const reservations = []; const results = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    const start = body.contents[0].parts[0].videoMetadata.startOffset;
    const end = body.contents[0].parts[0].videoMetadata.endOffset;
    calls.push({ start, end });
    // Full 0-300 window: runaway MAX_TOKENS (mirrors KMr0tGfmvZs canary).
    if (start === "0s" && end === "300s") {
      return new Response(JSON.stringify({
        candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "loop ".repeat(5000) }] } }],
        usageMetadata: { promptTokenCount: 25000, candidatesTokenCount: 16380 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: `Spoken words for ${start}-${end}.` }] } }],
      usageMetadata: { promptTokenCount: 12000, candidatesTokenCount: 40 },
    }), { status: 200 });
  };
  const result = await requestTranscriptChunkWithSplit({
    apiKey: "secret",
    videoUrl: "https://www.youtube.com/watch?v=KMr0tGfmvZs",
    window: { requestStart: 0, requestEnd: 300 },
    fetcher,
    beforePhysicalRequest: async ({ splitPath, window }) => {
      reservations.push({ splitPath, start: window.requestStart, end: window.requestEnd });
      return `physical_${splitPath}`;
    },
    afterPhysicalRequest: async (receipt) => results.push(receipt),
  });
  assert.equal(calls.length, 3); // 1 failed full + 2 half successes
  assert.deepEqual(calls.map((c) => [c.start, c.end]), [["0s", "300s"], ["0s", "150s"], ["150s", "300s"]]);
  assert.match(result.text, /Spoken words for 0s-150s/);
  assert.match(result.text, /Spoken words for 150s-300s/);
  assert.equal(result.splitCount, 1);
  assert.equal(result.finishReason, "STOP");
  assert.deepEqual(reservations.map((item) => item.splitPath), ["root", "L", "R"]);
  assert.deepEqual(results.map((item) => [item.splitPath, item.status, item.safeCauseCode || null]), [
    ["root", "failed", "gemini_output_truncated"],
    ["L", "completed", null],
    ["R", "completed", null],
  ]);
});


test("RECITATION/SAFETY policy blocks return marked placeholders instead of failing the chunk", async () => {
  assert.equal(POLICY_BLOCKED_FINISH_REASONS.has("RECITATION"), true);
  let calls = 0;
  const result = await requestTranscriptChunk({
    apiKey: "secret",
    videoUrl: "https://www.youtube.com/watch?v=mjQd35WtGRs",
    window: { requestStart: 265, requestEnd: 530 },
    fetcher: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        candidates: [{ finishReason: "RECITATION", finishMessage: "blocked", content: { parts: [] } }],
        usageMetadata: { promptTokenCount: 24139 },
      }), { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.finishReason, "STOP");
  assert.equal(result.blockedReason, "RECITATION");
  assert.equal(result.policyBlocked, true);
  assert.equal(result.text, policyBlockedPlaceholder("RECITATION", { requestStart: 265, requestEnd: 530 }));
  const split = await requestTranscriptChunkWithSplit({
    apiKey: "secret",
    videoUrl: "https://www.youtube.com/watch?v=mjQd35WtGRs",
    window: { requestStart: 265, requestEnd: 530 },
    fetcher: async () => new Response(JSON.stringify({
      candidates: [{ finishReason: "RECITATION", content: { parts: [] } }],
    }), { status: 200 }),
  });
  assert.equal(split.policyBlocked, true);
  assert.equal(split.splitCount, 0);
});

test("windows shorter than MIN_TRANSCRIPT_WINDOW_SECONDS skip Gemini and do not call the API", async () => {
  let calls = 0; let reservations = 0;
  const result = await requestTranscriptChunk({
    apiKey: "secret",
    videoUrl: "https://www.youtube.com/watch?v=KsZHrXYp4LY",
    window: { requestStart: 900, requestEnd: 901 },
    fetcher: async () => { calls += 1; throw new Error("should_not_fetch"); },
    beforePhysicalRequest: async () => { reservations += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(reservations, 0);
  assert.equal(result.text, SHORT_WINDOW_PLACEHOLDER);
  assert.equal(result.finishReason, "STOP");
  assert.equal(result.blockedReason, "SHORT_WINDOW_SKIPPED");
  assert.ok(MIN_TRANSCRIPT_WINDOW_SECONDS >= 15);
});

test("YouTube duration lookup follows only bounded same-host HTTPS redirects", async () => {
  const calls = [];
  const result = await fetchYouTubeDuration({ youtubeId: "c3vf85nk1O0", fetcher: async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/watch?v=c3vf85nk1O0&app=desktop" } });
    return new Response('<html>{"lengthSeconds":"2554"}</html>', { status: 200 });
  } });
  assert.equal(result.durationSeconds, 2554);
  assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual"]);
  assert.match(calls[1].url, /^https:\/\/www\.youtube\.com\/watch\?/);

  await assert.rejects(() => fetchYouTubeDuration({ youtubeId: "c3vf85nk1O0", fetcher: async () =>
    new Response(null, { status: 302, headers: { location: "https://example.com/steal" } }) }), /youtube_duration_redirect_blocked/);
});

test("YouTube Data API duration lookup parses contentDetails without exposing its secret", async () => {
  const secret = "youtube-data-api-secret"; const calls = [];
  const payload = { items: [{ id: "c3vf85nk1O0", contentDetails: { duration: "PT42M34S" } }] };
  const result = await fetchYouTubeDataApiDuration({ youtubeId: "c3vf85nk1O0", apiKey: secret,
    fetcher: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload), { status: 200 }); } });
  assert.equal(result.durationSeconds, 2554);
  assert.match(result.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(parseYouTubeDataApiDuration("PT1H2M3S"), 3723);
  assert.equal(parseYouTubeDataApiDuration("PT90M"), 5400);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.origin + requestUrl.pathname, "https://www.googleapis.com/youtube/v3/videos");
  assert.equal(requestUrl.searchParams.get("part"), "contentDetails");
  assert.equal(requestUrl.searchParams.get("id"), "c3vf85nk1O0");
  assert.equal(requestUrl.searchParams.get("key"), secret);
  assert.equal(calls[0].init.headers.accept, "application/json");

  for (const [response, reason] of [
    [new Response(JSON.stringify({ items: [] }), { status: 200 }), "youtube_data_api_video_not_found"],
    [new Response(JSON.stringify({ items: [{ id: "c3vf85nk1O0", contentDetails: { duration: "PT0S" } }] }), { status: 200 }), "youtube_data_api_invalid_duration"],
    [new Response(JSON.stringify({ error: { message: `${secret} must stay private` } }), { status: 403 }), "youtube_data_api_http_403"],
  ]) {
    let failure;
    try {
      await fetchYouTubeDataApiDuration({ youtubeId: "c3vf85nk1O0", apiKey: secret,
        fetcher: async () => response });
    } catch (error) { failure = error; }
    assert.equal(failure?.message, reason);
    assert.doesNotMatch(String(failure?.stack || failure), new RegExp(secret));
    assert.doesNotMatch(String(failure?.stack || failure), /googleapis\.com\/youtube\/v3\/videos\?/);
  }
});

test("transcript canary prefers YouTube Data API and stores only safe duration provenance", async () => {
  const env = makeEnv(); env.sent = []; env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.SCANNER_ADMIN_TOKEN = "admin-secret"; env.YOUTUBE_DATA_API_KEY = "bound-youtube-secret";
  const source = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube",
    platformItemId: "c3vf85nk1O0", canonicalUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0" });
  const started = await startTranscriptCanary(env, { youtubeId: "c3vf85nk1O0", durationFetcher: async () =>
    new Response(JSON.stringify({ items: [{ id: "c3vf85nk1O0", contentDetails: { duration: "PT1M" } }] }), { status: 200 }) });
  assert.equal(started.started, true);
  assert.equal(started.durationSeconds, 60);
  assert.equal(started.durationProvenance, "youtube_data_api_v3_content_details");
  assert.equal(env.sent[0].payload.planVersion, TRANSCRIPT_PLAN_VERSION);
  assert.equal(env.sent[0].stableKey,
    `youtube:c3vf85nk1O0:transcript:${TRANSCRIPT_PLAN_VERSION}:chunk:0`);
  const unversioned = structuredClone(env.sent[0]);
  delete unversioned.payload.planVersion;
  assert.throws(() => validateEnvelope(unversioned), /invalid_transcript_plan_version/);
  const receipt = env.DB.db.prepare("SELECT * FROM source_media_metadata WHERE source_item_id=?").get(source.source_item_id);
  assert.equal(receipt.method, "youtube_data_api_v3_content_details");
  assert.doesNotMatch(JSON.stringify(receipt), /bound-youtube-secret|googleapis\.com/);
  const health = await fetchHandler(new Request("https://scanner.example/admin/health", {
    headers: { authorization: "Bearer admin-secret" } }), env);
  const healthBody = await health.json();
  assert.equal(healthBody.bindings.youtubeDataApi, true);
  assert.doesNotMatch(JSON.stringify(healthBody), /bound-youtube-secret/);
});

test("YouTube Data API failures stop transcript start without receipts or operator override", async () => {
  const env = makeEnv(); env.sent = []; env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.YOUTUBE_DATA_API_KEY = "bound-youtube-secret";
  await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube",
    platformItemId: "c3vf85nk1O0", canonicalUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0" });
  const result = await startTranscriptCanary(env, { youtubeId: "c3vf85nk1O0", expectedDurationSeconds: 60,
    durationFetcher: async () => new Response(JSON.stringify({ error: { message: "bound-youtube-secret" } }), { status: 403 }) });
  assert.deepEqual(result, { started: false, reason: "youtube_data_api_http_403" });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM source_media_metadata").get().count, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) count FROM ingestion_runs WHERE scope LIKE 'transcript:%'").get().count, 0);
  assert.equal(env.sent.length, 0);
});

test("the D1 trigger atomically refuses media reservations above the configured daily cap", async () => {
  const env = makeEnv();
  await createRun(env.DB, { runId: "run_budget", personId: "person_troy_black", triggerType: "canary", scope: "transcript:test" });
  const source = await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube", platformItemId: "c3vf85nk1O0",
    canonicalUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0" });
  const envelope = await makeEnvelope({ runId: "run_budget", type: "transcript_extract", stableKey: "chunk:0",
    payload: { phase: "chunk", chunkIndex: 0, youtubeId: "c3vf85nk1O0", sourceItemId: source.source_item_id, durationSeconds: 120 } });
  await registerJob(env.DB, envelope);
  const base = { mediaDay: "2026-07-20", runId: "run_budget", jobId: envelope.jobId, sourceItemId: source.source_item_id,
    chunkIndex: 0, jobAttempt: 1, startSeconds: 0, budgetLimitSeconds: 100, createdAt: "2026-07-20T00:00:00Z" };
  const results = await Promise.all([
    reserveGeminiMedia(env.DB, { ...base, reservationId: "reserve_one", endSeconds: 80 }),
    reserveGeminiMedia(env.DB, { ...base, reservationId: "reserve_two", jobAttempt: 2, endSeconds: 80 }),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(env.DB.db.prepare("SELECT SUM(reserved_seconds) total FROM gemini_media_reservations").get().total, 80);
  const logical = env.DB.db.prepare("SELECT * FROM gemini_media_reservations").get();
  const physicalBase = { logicalReservationId: logical.reservation_id, mediaDay: logical.media_day,
    runId: logical.run_id, jobId: logical.job_id, sourceItemId: logical.source_item_id,
    chunkIndex: Number(logical.chunk_index), jobAttempt: Number(logical.job_attempt),
    budgetLimitSeconds: 100, createdAt: logical.created_at };
  assert.equal(await reserveGeminiPhysicalRequest(env.DB, { ...physicalBase,
    physicalRequestId: "physical_root", splitPath: "root", startSeconds: 0, endSeconds: 80 }), true);
  assert.equal(await reserveGeminiPhysicalRequest(env.DB, { ...physicalBase,
    physicalRequestId: "physical_left", splitPath: "L", startSeconds: 0, endSeconds: 40 }), false);
  assert.equal(env.DB.db.prepare("SELECT SUM(reserved_seconds) total FROM gemini_physical_request_reservations").get().total, 80);
});

test("recursive physical transcript calls meter the UTC day observed at each fetch across midnight", async () => {
  const env = makeEnv(); env.sent = [];
  env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.ARTIFACTS = r2Memory(); env.GEMINI_API_KEY = "gemini-secret";
  await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube",
    platformItemId: "Midnight001", canonicalUrl: "https://www.youtube.com/watch?v=Midnight001" });
  const started = await startTranscriptCanary(env, { youtubeId: "Midnight001",
    expectedDurationSeconds: 60, durationFetcher: durationFetcher(60) });
  assert.equal(started.started, true);
  let providerCalls = 0;
  const geminiFetcher = async () => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return new Response(JSON.stringify({ responseId: "root", candidates: [{ finishReason: "MAX_TOKENS",
        content: { parts: [{ text: "partial must not be accepted" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ responseId: `child-${providerCalls}`,
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: `Child ${providerCalls} exact words.` }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  };
  const physicalTimes = ["2026-08-03T23:59:59.900Z", "2026-08-04T00:00:01.000Z",
    "2026-08-04T00:00:02.000Z"];
  await processEnvelope(env, env.sent.shift(), { geminiFetcher,
    at: "2026-08-03T23:59:58.000Z", physicalNow: () => physicalTimes.shift() });
  assert.equal(providerCalls, 3);
  assert.deepEqual(env.DB.db.prepare(`SELECT split_path,media_day FROM gemini_physical_request_reservations
    ORDER BY created_at`).all().map((row) => [row.split_path, row.media_day]), [
    ["root", "2026-08-03"], ["L", "2026-08-04"], ["R", "2026-08-04"],
  ]);
});

test("generic transcript canary acquires private chunks, stitches one artifact, and uses only in-house AI for claim analysis", async () => {
  const env = makeEnv(); env.sent = []; env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.ANALYSIS_QUEUE = { send: async (body) => env.sent.push(body) };
  env.ARTIFACTS = r2Memory(); env.GEMINI_API_KEY = "gemini-secret"; env.AI_MODEL = "local-model";
  env.AI_FALLBACK_MODEL = "local-fallback"; env.AI = { run: async (_model, input) => {
    const transcript = input.messages[1].content;
    const quote = "At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks, using a signed city order.";
    return { response: JSON.stringify({ candidates: transcript.includes(quote) ? [groundedTranscriptCandidate(transcript, quote)] : [] }) };
  } };
  env.DB.db.prepare(`INSERT INTO people (person_id,slug,display_name,corpus_label,created_at)
    VALUES ('person_example','example-person','Example Person','Test profile','2026-07-20T00:00:00Z')`).run();
  const source = await upsertSourceItem(env.DB, { personId: "person_example", platform: "youtube", platformItemId: "c3vf85nk1O0",
    canonicalUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0" });
  const started = await startTranscriptCanary(env, { personSlug: "example-person", youtubeId: "c3vf85nk1O0",
    expectedDurationSeconds: 360, durationFetcher: durationFetcher(360) });
  assert.equal(started.started, true); assert.equal(env.sent.length, 1);
  assert.equal(env.DB.db.prepare("SELECT duration_seconds FROM source_media_metadata WHERE source_item_id=?").get(source.source_item_id).duration_seconds, 360);
  const wrongAdapter = await makeEnvelope({ runId: started.runId, personId: "person_example", type: "archive_page", stableKey: "wrong-adapter", payload: { page: 1 } });
  assert.throws(() => validateEnvelope(wrongAdapter), /invalid_job_scope/);
  let geminiCalls = 0;
  const geminiFetcher = async (_url, init) => {
    geminiCalls += 1; const body = JSON.parse(init.body); const start = body.contents[0].parts[0].videoMetadata.startOffset;
    const text = start === "0s" ? "At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks, using a signed city order." :
      "Second exact words and the rest of this generated clip transcript.";
    return new Response(JSON.stringify({ responseId: `response_${geminiCalls}`, candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } }), { status: 200 });
  };
  const first = env.sent.shift(); await processEnvelope(env, first, { geminiFetcher });
  assert.equal(geminiCalls, 1);
  assert.equal((await processEnvelope(env, first, { geminiFetcher })).status, "duplicate_completed");
  assert.equal(geminiCalls, 1);
  while (env.sent.length) await processEnvelope(env, env.sent.shift(), { geminiFetcher });
  assert.equal(geminiCalls, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_chunk_attempts WHERE status='completed'").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM gemini_physical_request_reservations").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM gemini_physical_request_results WHERE status='completed'").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_artifacts WHERE source_item_id=?").get(source.source_item_id).count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM transcript_stitch_receipts").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM extraction_runs WHERE input_kind='verified_transcript'").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM extraction_runs WHERE transcript_quality='gemini_generated_needs_human_check'").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM text_ai_attempt_receipt_history WHERE status='completed'").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM text_ai_attempt_receipt_history WHERE status='started'").get().count, 2);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM candidate_admissibility_assessments WHERE decision='eligible'").get().count, 1);
  assert.equal(env.DB.db.prepare("SELECT status FROM transcript_attempts WHERE method='gemini_public_youtube_clipped'").get().status, "needs_human_check");
  const candidate = env.DB.db.prepare("SELECT exact_quote,quote_start,quote_end,source_timestamp_seconds FROM claim_candidates WHERE source_item_id=?").get(source.source_item_id);
  const finalKey = [...env.ARTIFACTS.objects.keys()].find((key) => key.startsWith("transcripts/final/person_example/"));
  assert.equal(env.ARTIFACTS.objects.get(finalKey).slice(candidate.quote_start, candidate.quote_end), candidate.exact_quote);
  assert.equal(candidate.source_timestamp_seconds, 0);
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claims WHERE person_id='person_example'").get().count, 0);
  assert.ok(finalKey);
  const status = await scannerStatus(env, started.runId);
  assert.equal(status.transcript.completedChunks, 2);
  assert.equal(status.transcript.artifact.durationSeconds, 360);
  assert.equal(status.transcript.candidates, 1);
  assert.equal("r2Key" in status.transcript.artifact, false);
});

test("duration mismatch fails before a run and an exhausted daily budget remains recoverable", async () => {
  const env = makeEnv(); env.sent = []; env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  env.ARTIFACTS = r2Memory(); env.GEMINI_API_KEY = "gemini-secret"; env.GEMINI_DAILY_MEDIA_SECONDS = "1";
  await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube", platformItemId: "c3vf85nk1O0",
    canonicalUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0" });
  const mismatch = await startTranscriptCanary(env, { youtubeId: "c3vf85nk1O0", expectedDurationSeconds: 59,
    durationFetcher: durationFetcher(60) });
  assert.deepEqual(mismatch, { started: false, reason: "video_duration_mismatch" });
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM ingestion_runs WHERE scope LIKE 'transcript:%'").get().count, 0);

  const started = await startTranscriptCanary(env, { youtubeId: "c3vf85nk1O0", expectedDurationSeconds: 60,
    durationFetcher: durationFetcher(60) });
  const first = env.sent.shift();
  await assert.rejects(() => processEnvelope(env, first, { geminiFetcher: async () => { throw new Error("must not call Gemini"); } }),
    /transcript_budget_deferred/);
  const deferred = env.DB.db.prepare("SELECT status,error_code,claimed_at FROM ingestion_jobs WHERE job_id=?").get(first.jobId);
  assert.equal(deferred.status, "queued"); assert.equal(deferred.error_code, "transcript_budget_deferred");
  const afterEligible = new Date(Date.parse(deferred.claimed_at) + 1000).toISOString();
  const status = await scannerStatus(env, started.runId, { now: afterEligible });
  assert.equal(status.recovery.recovered, 1);
  assert.equal(env.sent.length, 1);
});

test("authenticated transcript start labels operator duration when Cloudflare is redirected away from YouTube", async () => {
  const env = makeEnv(); env.sent = []; env.INGESTION_QUEUE = { send: async (body) => env.sent.push(body) };
  await upsertSourceItem(env.DB, { personId: "person_troy_black", platform: "youtube", platformItemId: "c3vf85nk1O0",
    canonicalUrl: "https://www.youtube.com/watch?v=c3vf85nk1O0" });
  const redirected = async () => new Response(null, { status: 302, headers: { location: "https://www.google.com/sorry/" } });
  const missing = await startTranscriptCanary(env, { youtubeId: "c3vf85nk1O0", durationFetcher: redirected });
  assert.deepEqual(missing, { started: false, reason: "youtube_duration_redirect_blocked" });
  const started = await startTranscriptCanary(env, { youtubeId: "c3vf85nk1O0", expectedDurationSeconds: 2554, durationFetcher: redirected });
  assert.equal(started.started, true);
  assert.equal(started.durationProvenance, "operator_supplied_authenticated");
  const metadata = env.DB.db.prepare("SELECT duration_seconds,method FROM source_media_metadata ORDER BY observed_at DESC LIMIT 1").get();
  assert.equal(metadata.duration_seconds, 2554);
  assert.equal(metadata.method, "operator_supplied_authenticated");
});
