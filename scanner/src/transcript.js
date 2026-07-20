import { extractTranscriptClaims } from "./ai.js";
import { sha256, stableId } from "./hash.js";
import { nowIso } from "./repository.js";

export const TRANSCRIPT_MODEL = "gemini-3.1-flash-lite";
export const TRANSCRIPT_PROMPT_VERSION = "youtube-clip-text-v1";
export const STITCH_ALGORITHM = "ordered-clip-text-v1";
export const CLAIM_EXTRACTION_PROMPT_VERSION = "transcript-claims-v5-grounded-5w1h-offset-repair";

function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const secs = Math.floor(seconds % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function transcriptPlan(durationSeconds, { chunkSeconds = 300, overlapSeconds = 0 } = {}) {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 43_200) throw new Error("invalid_video_duration");
  if (!Number.isInteger(chunkSeconds) || chunkSeconds < 60 || chunkSeconds > 300) throw new Error("invalid_chunk_seconds");
  if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > 30 || overlapSeconds >= chunkSeconds) throw new Error("invalid_overlap_seconds");
  const stride = chunkSeconds - overlapSeconds; const requests = [];
  for (let start = 0; start < durationSeconds; start += stride) requests.push({ requestStart: start, requestEnd: Math.min(durationSeconds, start + chunkSeconds) });
  return requests.map((request, index) => ({ index, ...request,
    canonicalStart: index ? (requests[index - 1].requestEnd + request.requestStart) / 2 : 0,
    canonicalEnd: index + 1 < requests.length ? (request.requestEnd + requests[index + 1].requestStart) / 2 : durationSeconds,
  }));
}

export function cleanTranscriptText(value) {
  const text = String(value || "").replace(/^```(?:text|plaintext)?\s*/i, "").replace(/```\s*$/i, "").replaceAll("\r", "").trim();
  if (!text) throw new Error("transcript_empty_output");
  if (text.length > 200_000) throw new Error("transcript_chunk_too_large");
  return text;
}

export function stitchTranscript(chunks, plan) {
  if (chunks.length !== plan.length) throw new Error("transcript_chunks_incomplete");
  const sections = chunks.map((chunk, index) => {
    const window = plan[index]; const body = cleanTranscriptText(chunk);
    return { index, approximateTimestamp: Math.floor(window.canonicalStart),
      text: `[CLIP ${formatTime(window.requestStart)}-${formatTime(window.requestEnd)} | GEMINI-GENERATED, NEEDS HUMAN CHECK]\n${body}` };
  });
  const text = `${sections.map((section) => section.text).join("\n\n")}\n`;
  return { sections, text, cueCount: 0 };
}

function responseText(payload) {
  return (payload?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
}

export async function requestTranscriptChunk({ apiKey, videoUrl, window, model = TRANSCRIPT_MODEL, fetcher = fetch, timeoutMs = 120_000 }) {
  if (!apiKey) throw new Error("gemini_key_required");
  const prompt = [
    "Transcribe every spoken word in this supplied clip from beginning to end.",
    "Return only the spoken transcript as plain text. Do not include timestamps, speaker guesses, notes, headings, markdown fences, summaries, paraphrases, interpretations, corrections, or omissions.",
    "Include ordinary encouragement, prayer, repetition, and filler because this is source acquisition, not claim analysis.",
  ].join(" ");
  const requestBody = { contents: [{ role: "user", parts: [
    { fileData: { fileUri: videoUrl, mimeType: "video/*" }, videoMetadata: { startOffset: `${window.requestStart}s`, endOffset: `${window.requestEnd}s` } },
    { text: prompt },
  ] }], generationConfig: { temperature: 0, maxOutputTokens: 16_384 } };
  const requestSha256 = await sha256(requestBody);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response; let payload;
  try {
    response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify(requestBody),
    });
    payload = await response.json().catch(() => null);
  } catch (cause) {
    const error = new Error(controller.signal.aborted ? "gemini_timeout" : "gemini_network_error");
    error.retryable = true; error.cause = cause; error.requestSha256 = requestSha256; throw error;
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const error = new Error(`gemini_http_${response.status}`); error.retryable = response.status === 429 || response.status >= 500;
    error.requestSha256 = requestSha256; error.responseId = payload?.responseId || null; throw error;
  }
  const finishReason = payload?.candidates?.[0]?.finishReason; const text = responseText(payload);
  if (finishReason !== "STOP" || !text) {
    const error = new Error(finishReason === "MAX_TOKENS" ? "gemini_output_truncated" : "gemini_incomplete_response");
    error.requestSha256 = requestSha256; error.responseId = payload?.responseId || null; throw error;
  }
  let cleaned;
  try { cleaned = cleanTranscriptText(text); } catch (error) {
    error.requestSha256 = requestSha256; error.responseId = payload?.responseId || null; throw error;
  }
  return { text: cleaned, requestSha256, responseId: payload?.responseId || null, finishReason,
    inputTokens: payload?.usageMetadata?.promptTokenCount ?? null, outputTokens: payload?.usageMetadata?.candidatesTokenCount ?? null };
}

export async function fetchYouTubeDuration({ youtubeId, fetcher = fetch, timeoutMs = 20_000 }) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId || "")) throw new Error("invalid_youtube_id");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response; let text; let currentUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== "https:" || !["www.youtube.com", "youtube.com"].includes(parsed.hostname)) throw new Error("youtube_duration_redirect_blocked");
      response = await fetcher(currentUrl, { signal: controller.signal,
        redirect: "manual", headers: { accept: "text/html", "user-agent": "ProphecyLedger/0.1 duration-metadata" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("youtube_duration_redirect_limit");
      const redirectUrl = new URL(location, currentUrl);
      console.info("youtube_duration_redirect", { fromHost: parsed.hostname, toHost: redirectUrl.hostname, status: response.status });
      currentUrl = redirectUrl.toString();
    }
    text = await response.text();
  } catch (cause) {
    if (["youtube_duration_redirect_blocked", "youtube_duration_redirect_limit"].includes(cause?.message)) throw cause;
    console.error("youtube_duration_fetch_failed", { name: cause?.name || "Error", message: cause?.message || "unknown" });
    const error = new Error(controller.signal.aborted ? "youtube_duration_timeout" : "youtube_duration_network_error");
    error.retryable = true; error.cause = cause; throw error;
  } finally { clearTimeout(timer); }
  if (!response.ok) { const error = new Error(`youtube_duration_http_${response.status}`); error.retryable = response.status === 429 || response.status >= 500; throw error; }
  if (new TextEncoder().encode(text).length > 2_500_000) throw new Error("youtube_duration_response_too_large");
  const match = text.match(/"lengthSeconds"\s*:\s*"(\d+)"/); const durationSeconds = Number(match?.[1]);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 43_200) throw new Error("youtube_duration_missing");
  return { durationSeconds, responseSha256: await sha256(text) };
}

export function parseYouTubeDataApiDuration(value) {
  if (typeof value !== "string" || value.length > 64) throw new Error("youtube_data_api_invalid_duration");
  const match = value.match(/^P(?:(\d{1,6})D)?T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?$/);
  if (!match || !match.slice(1).some((part) => part !== undefined)) {
    throw new Error("youtube_data_api_invalid_duration");
  }
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => BigInt(part || "0"));
  const total = days * 86_400n + hours * 3_600n + minutes * 60n + seconds;
  if (total < 1n || total > 43_200n) throw new Error("youtube_data_api_invalid_duration");
  return Number(total);
}

export async function fetchYouTubeDataApiDuration({ youtubeId, apiKey, fetcher = fetch, timeoutMs = 20_000 }) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId || "")) throw new Error("invalid_youtube_id");
  if (typeof apiKey !== "string" || !apiKey) throw new Error("youtube_data_api_key_required");
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/videos");
  endpoint.searchParams.set("part", "contentDetails");
  endpoint.searchParams.set("id", youtubeId);
  endpoint.searchParams.set("key", apiKey);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response; let text;
  try {
    response = await fetcher(endpoint.toString(), { signal: controller.signal,
      headers: { accept: "application/json" } });
    text = await response.text();
  } catch {
    const error = new Error(controller.signal.aborted ? "youtube_data_api_timeout" : "youtube_data_api_network_error");
    error.retryable = true; throw error;
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    const error = new Error(`youtube_data_api_http_${response.status}`);
    error.retryable = response.status === 429 || response.status >= 500; throw error;
  }
  if (new TextEncoder().encode(text).length > 256_000) throw new Error("youtube_data_api_response_too_large");
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("youtube_data_api_invalid_response"); }
  const item = Array.isArray(payload?.items) ? payload.items.find((entry) => entry?.id === youtubeId) : null;
  if (!item) throw new Error("youtube_data_api_video_not_found");
  const durationSeconds = parseYouTubeDataApiDuration(item?.contentDetails?.duration);
  return { durationSeconds, responseSha256: await sha256(payload) };
}

export function transcriptSections(text) {
  const matches = [...String(text).matchAll(/^\[CLIP (\d{2}):(\d{2}):(\d{2})-[^\n]+\]\n/gm)];
  return matches.map((match, index) => ({ index, baseOffset: match.index,
    approximateTimestamp: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
    text: text.slice(match.index, matches[index + 1]?.index ?? text.length).trimEnd() }));
}

export async function extractTranscriptSection(ai, { db, transcriptId, sourceItemId,
  transcript, section, models, timeoutMs = 45_000, createdAt = nowIso() }) {
  const inputSha256 = await sha256(section.text);
  const extractionRunId = await stableId("ext", `${transcriptId}:${inputSha256}:${CLAIM_EXTRACTION_PROMPT_VERSION}`);
  const existing = await db.prepare("SELECT status FROM extraction_runs WHERE extraction_run_id=?1")
    .bind(extractionRunId).first();
  if (existing?.status === "completed") return { extractionRunId, candidateCount: 0, reused: true };
  const result = await extractTranscriptClaims(ai, { transcript: section.text, models, timeoutMs });
  const extractionStatement = db.prepare(`INSERT INTO extraction_runs
      (extraction_run_id,source_item_id,transcript_id,input_kind,input_sha256,prompt_version,model_family,status,started_at,completed_at,
       transcript_quality,rejected_candidate_count,rejection_codes_json,corrected_offset_count)
      VALUES (?1,?2,?3,'verified_transcript',?4,?5,?6,'completed',?7,?7,
       'gemini_generated_needs_human_check',?8,?9,?10)
      ON CONFLICT(extraction_run_id) DO NOTHING`)
    .bind(extractionRunId, sourceItemId, transcriptId, inputSha256, CLAIM_EXTRACTION_PROMPT_VERSION,
      result.model, createdAt, result.rejectedCandidateCount,
      JSON.stringify(result.rejectionCodes), result.correctedOffsetCount);
  const candidates = []; const assessments = []; const persistence = [];
  for (const [ordinal, candidate] of result.assessments.entries()) {
    const globalStart = candidate.start + section.baseOffset; const globalEnd = candidate.end + section.baseOffset;
    if (transcript.slice(globalStart, globalEnd) !== candidate.quote) throw new Error("ai_quote_not_in_transcript_artifact");
    const candidateId = await stableId("cand", `${extractionRunId}:${ordinal}:${candidate.start}:${candidate.end}`);
    const assessmentId = await stableId("assessment", `${candidateId}:${CLAIM_EXTRACTION_PROMPT_VERSION}`);
    const ground = candidate.grounding;
    candidates.push({ candidateId, extractionRunId, sourceItemId, quote: candidate.quote,
      globalStart, globalEnd, sourceTimestampSeconds: section.approximateTimestamp,
      statementType: candidate.statementType, atomicProposition: candidate.atomicProposition,
      deadlineText: candidate.deadlineText, createdAt });
    assessments.push({ assessmentId, candidateId, gateVersion: CLAIM_EXTRACTION_PROMPT_VERSION,
      decision: candidate.decision, who: ground.who.value, what: ground.what.value,
      why: ground.why.value, where: ground.where.value, when: ground.when.value,
      how: ground.how.value, howSpecificity: candidate.howSpecificity,
      publicEvidence: candidate.evidenceTest.publicEvidence,
      passCondition: candidate.evidenceTest.passCondition,
      failCondition: candidate.evidenceTest.failCondition,
      groundingJson: JSON.stringify({ contextStart: candidate.contextStart + section.baseOffset,
        contextEnd: candidate.contextEnd + section.baseOffset,
        dimensions: Object.fromEntries(Object.entries(ground).map(([name, value]) => [name, {
          ...value,
          supportStart: value.supportStart === null ? null : value.supportStart + section.baseOffset,
          supportEnd: value.supportEnd === null ? null : value.supportEnd + section.baseOffset,
        }])) }), rejectionCodesJson: JSON.stringify(candidate.rejectionCodes),
      assessedBy: `workers-ai:${result.model}`, createdAt });
    persistence.push({ rejectionId: await stableId("txpr", `${extractionRunId}:${ordinal}`),
      extractionRunId, ordinal, candidateId, assessmentId, createdAt });
  }
  const statements = [extractionStatement];
  if (candidates.length) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO claim_candidates
        (candidate_id,extraction_run_id,source_item_id,candidate_kind,neutral_paraphrase,exact_quote,
         quote_start,quote_end,source_timestamp_seconds,proposed_statement_type,atomic_proposition_draft,
         explicit_deadline_text,requires_transcript,requires_human_review,created_at)
      SELECT json_extract(value,'$.candidateId'),json_extract(value,'$.extractionRunId'),
        json_extract(value,'$.sourceItemId'),'exact_transcript_claim',NULL,json_extract(value,'$.quote'),
        json_extract(value,'$.globalStart'),json_extract(value,'$.globalEnd'),
        json_extract(value,'$.sourceTimestampSeconds'),json_extract(value,'$.statementType'),
        json_extract(value,'$.atomicProposition'),json_extract(value,'$.deadlineText'),0,1,
        json_extract(value,'$.createdAt') FROM json_each(?1)`)
      .bind(JSON.stringify(candidates)));
  }
  for (const assessment of assessments) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO candidate_admissibility_assessments
        (assessment_id,candidate_id,gate_version,decision,who_text,what_text,why_text,
         where_text,when_text,how_text,how_specificity,public_evidence_text,pass_condition_text,
         fail_condition_text,grounding_json,rejection_codes_json,assessed_by,created_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18
        WHERE EXISTS (SELECT 1 FROM claim_candidates WHERE candidate_id=?2)`)
        .bind(assessment.assessmentId, assessment.candidateId, assessment.gateVersion,
          assessment.decision, assessment.who, assessment.what, assessment.why,
          assessment.where, assessment.when, assessment.how, assessment.howSpecificity,
          assessment.publicEvidence, assessment.passCondition, assessment.failCondition,
          assessment.groundingJson, assessment.rejectionCodesJson,
          assessment.assessedBy, assessment.createdAt));
  }
  if (persistence.length) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO extraction_candidate_persistence_rejections
        (rejection_id,extraction_run_id,candidate_ordinal,candidate_id,assessment_id,error_code,created_at)
      SELECT json_extract(value,'$.rejectionId'),json_extract(value,'$.extractionRunId'),
        json_extract(value,'$.ordinal'),json_extract(value,'$.candidateId'),
        json_extract(value,'$.assessmentId'),
        CASE WHEN candidate.candidate_id IS NULL THEN 'candidate_not_persisted'
          ELSE 'assessment_not_persisted' END,json_extract(value,'$.createdAt')
      FROM json_each(?1)
      LEFT JOIN claim_candidates candidate
        ON candidate.candidate_id=json_extract(value,'$.candidateId')
      LEFT JOIN candidate_admissibility_assessments assessment
        ON assessment.assessment_id=json_extract(value,'$.assessmentId')
      WHERE candidate.candidate_id IS NULL OR assessment.assessment_id IS NULL`)
      .bind(JSON.stringify(persistence)));
  }
  await db.batch(statements);
  const extraction = await db.prepare(`SELECT source_item_id,transcript_id,input_sha256,prompt_version,status
    FROM extraction_runs WHERE extraction_run_id=?1`).bind(extractionRunId).first();
  if (!extraction || extraction.source_item_id !== sourceItemId || extraction.transcript_id !== transcriptId ||
      extraction.input_sha256 !== inputSha256 || extraction.prompt_version !== CLAIM_EXTRACTION_PROMPT_VERSION ||
      extraction.status !== "completed") throw new Error("extraction_run_persistence_rejected");
  const stored = await db.prepare(`SELECT COUNT(*) candidate_count
    FROM claim_candidates candidate JOIN candidate_admissibility_assessments assessment
      ON assessment.candidate_id=candidate.candidate_id
    WHERE candidate.extraction_run_id=?1 AND assessment.gate_version=?2
      AND assessment.decision='eligible'`)
    .bind(extractionRunId, CLAIM_EXTRACTION_PROMPT_VERSION).first();
  return { extractionRunId, candidateCount: Number(stored?.candidate_count || 0), reused: false };
}

export async function extractSections(ai, options) {
  let candidateCount = 0;
  for (const section of transcriptSections(options.transcript)) {
    const result = await extractTranscriptSection(ai, { ...options, section });
    candidateCount += result.candidateCount;
  }
  return candidateCount;
}

function analysisEnvelope({ analysisRunId, ingestionRunId, analysisSectionId, transcriptId,
  sourceItemId, personId, sectionIndex, transcriptSha256, inputSha256 }) {
  const stableKey = `transcript:${transcriptId}:analysis:${sectionIndex}:${CLAIM_EXTRACTION_PROMPT_VERSION}`;
  return stableId("job", `${ingestionRunId}:transcript_extract:${stableKey}`).then((jobId) => ({
    version: 1, jobId, runId: ingestionRunId, personId, type: "transcript_extract", stableKey,
    payload: { phase: "analyze", analysisRunId, analysisSectionId, transcriptId,
      sourceItemId, sectionIndex, transcriptSha256, inputSha256,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION },
  }));
}

export async function transcriptAnalysisPreparationEnvelope({ transcriptId, sourceItemId,
  personId, transcriptSha256 }) {
  const analysisRunId = await stableId("txan", `${transcriptId}:${CLAIM_EXTRACTION_PROMPT_VERSION}`);
  const ingestionRunId = await stableId("runan", `${analysisRunId}:${sourceItemId}`);
  const stableKey = `transcript:${transcriptId}:analysis:prepare:${CLAIM_EXTRACTION_PROMPT_VERSION}`;
  const jobId = await stableId("job", `${ingestionRunId}:transcript_extract:${stableKey}`);
  return { version: 1, jobId, runId: ingestionRunId, personId, type: "transcript_extract", stableKey,
    payload: { phase: "prepare", analysisRunId, transcriptId, sourceItemId, transcriptSha256,
      promptVersion: CLAIM_EXTRACTION_PROMPT_VERSION } };
}

export async function ensureTranscriptAnalysisPreparationRun(db, envelope, at = nowIso()) {
  const scope = `transcript_analysis:${envelope.payload.analysisRunId}`;
  await db.prepare(`INSERT OR IGNORE INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES (?1,?2,'manual',?3,'queued',?4)`)
    .bind(envelope.runId, envelope.personId, scope, at).run();
  const run = await db.prepare(`SELECT person_id,trigger_type,scope FROM ingestion_runs
    WHERE run_id=?1`).bind(envelope.runId).first();
  if (!run || run.person_id !== envelope.personId || run.trigger_type !== "manual" || run.scope !== scope) {
    throw new Error("invalid_transcript_analysis_run_binding");
  }
}

export async function registerTranscriptAnalysisJobs(db, envelopes, at = nowIso()) {
  if (!envelopes.length) return;
  const runId = envelopes[0].runId;
  if (envelopes.some((envelope) => envelope.runId !== runId ||
      envelope.type !== "transcript_extract" || envelope.payload.phase !== "analyze")) {
    throw new Error("invalid_transcript_analysis_job_batch");
  }
  const rows = envelopes.map((envelope) => ({ jobId: envelope.jobId, runId: envelope.runId,
    jobType: envelope.type, stableKey: envelope.stableKey,
    payloadJson: JSON.stringify(envelope.payload) }));
  await db.prepare(`INSERT OR IGNORE INTO ingestion_jobs
      (job_id,run_id,job_type,stable_key,payload_json,status,claimed_at)
    SELECT json_extract(value,'$.jobId'),json_extract(value,'$.runId'),
      json_extract(value,'$.jobType'),json_extract(value,'$.stableKey'),
      json_extract(value,'$.payloadJson'),'queued',NULL
    FROM json_each(?1)`).bind(JSON.stringify(rows)).run();
  await db.prepare(`UPDATE ingestion_runs SET status='running',started_at=COALESCE(started_at,?2)
    WHERE run_id=?1 AND status='queued'`).bind(runId, at).run();
}

export async function refreshAnalysisRun(db, analysisRunId, at) {
  const counts = await db.prepare(`SELECT COUNT(*) section_count,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed_count,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed_count,
      SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END) open_count
    FROM transcript_analysis_sections WHERE analysis_run_id=?1`).bind(analysisRunId).first();
  const completed = Number(counts?.completed_count || 0); const failed = Number(counts?.failed_count || 0);
  const open = Number(counts?.open_count || 0); const total = Number(counts?.section_count || 0);
  const status = total > 0 && completed === total ? "completed" :
    open > 0 ? "running" : completed > 0 ? "partial" : "failed";
  await db.prepare(`UPDATE transcript_analysis_runs SET completed_section_count=?2,
      failed_section_count=?3,status=?4,completed_at=CASE WHEN ?4 IN ('completed','partial','failed') THEN ?5 ELSE NULL END
    WHERE analysis_run_id=?1`).bind(analysisRunId, completed, failed, status, at).run();
  return { status, completed, failed, open, total };
}

export async function prepareTranscriptAnalysis(env, { transcriptId, sourceItemId, personId,
  transcript, transcriptSha256, analysisRunId: suppliedAnalysisRunId = null,
  ingestionRunId: suppliedIngestionRunId = null, at = nowIso() }) {
  if (await sha256(transcript) !== transcriptSha256) throw new Error("transcript_content_hash_mismatch");
  const sections = transcriptSections(transcript);
  if (!sections.length) throw new Error("transcript_sections_missing");
  const analysisRunId = await stableId("txan", `${transcriptId}:${CLAIM_EXTRACTION_PROMPT_VERSION}`);
  const ingestionRunId = await stableId("runan", `${analysisRunId}:${sourceItemId}`);
  if ((suppliedAnalysisRunId && suppliedAnalysisRunId !== analysisRunId) ||
      (suppliedIngestionRunId && suppliedIngestionRunId !== ingestionRunId)) {
    throw new Error("invalid_transcript_analysis_binding");
  }
  const ingestion = await env.DB.prepare(`SELECT person_id,scope FROM ingestion_runs
    WHERE run_id=?1`).bind(ingestionRunId).first();
  if (!ingestion || ingestion.person_id !== personId ||
      ingestion.scope !== `transcript_analysis:${analysisRunId}`) {
    throw new Error("invalid_transcript_analysis_run_binding");
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,status,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',?8)`)
    .bind(analysisRunId, ingestionRunId, transcriptId, sourceItemId, transcriptSha256,
      CLAIM_EXTRACTION_PROMPT_VERSION, sections.length, at).run();
  const analysis = await env.DB.prepare(`SELECT ingestion_run_id,transcript_id,source_item_id,
      transcript_sha256,prompt_version,section_count FROM transcript_analysis_runs
    WHERE analysis_run_id=?1`).bind(analysisRunId).first();
  if (!analysis || analysis.ingestion_run_id !== ingestionRunId || analysis.transcript_id !== transcriptId ||
      analysis.source_item_id !== sourceItemId || analysis.transcript_sha256 !== transcriptSha256 ||
      analysis.prompt_version !== CLAIM_EXTRACTION_PROMPT_VERSION ||
      Number(analysis.section_count) !== sections.length) {
    throw new Error("invalid_transcript_analysis_binding");
  }
  const sectionRows = [];
  for (const section of sections) {
    const inputSha256 = await sha256(section.text);
    const analysisSectionId = await stableId("txas", `${analysisRunId}:${section.index}:${inputSha256}`);
    sectionRows.push({ analysisSectionId, analysisRunId, sectionIndex: section.index,
      inputSha256, baseOffset: section.baseOffset,
      approximateTimestampSeconds: section.approximateTimestamp, createdAt: at });
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO transcript_analysis_sections
      (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
       approximate_timestamp_seconds,extraction_run_id,status,attempt_count,error_code,
       started_at,completed_at,created_at)
    SELECT json_extract(value,'$.analysisSectionId'),json_extract(value,'$.analysisRunId'),
      json_extract(value,'$.sectionIndex'),json_extract(value,'$.inputSha256'),
      json_extract(value,'$.baseOffset'),json_extract(value,'$.approximateTimestampSeconds'),
      NULL,'queued',0,NULL,NULL,NULL,json_extract(value,'$.createdAt')
    FROM json_each(?1)`).bind(JSON.stringify(sectionRows)).run();
  const storedRows = await env.DB.prepare(`SELECT analysis_section_id,section_index,input_sha256,status
    FROM transcript_analysis_sections WHERE analysis_run_id=?1 ORDER BY section_index`)
    .bind(analysisRunId).all();
  const stored = storedRows.results || [];
  if (stored.length !== sectionRows.length || stored.some((row, index) =>
    row.analysis_section_id !== sectionRows[index].analysisSectionId ||
    Number(row.section_index) !== sectionRows[index].sectionIndex ||
    row.input_sha256 !== sectionRows[index].inputSha256)) {
    throw new Error("transcript_analysis_section_binding_failed");
  }
  const envelopes = [];
  for (const [index, row] of stored.entries()) {
    if (row.status === "queued") envelopes.push(await analysisEnvelope({ analysisRunId,
      ingestionRunId, analysisSectionId: row.analysis_section_id, transcriptId,
      sourceItemId, personId, sectionIndex: Number(row.section_index), transcriptSha256,
      inputSha256: sectionRows[index].inputSha256 }));
  }
  const state = await refreshAnalysisRun(env.DB, analysisRunId, at);
  if (state.status === "completed") {
    await env.DB.prepare(`UPDATE ingestion_runs SET status='complete',started_at=COALESCE(started_at,?2),
      completed_at=?2 WHERE run_id=?1 AND status IN ('queued','running')`).bind(ingestionRunId, at).run();
  }
  return { analysisRunId, ingestionRunId, envelopes, state };
}

export async function prepareTranscriptAnalysisFromArtifact(env, payload, {
  personId, ingestionRunId, at = nowIso(),
} = {}) {
  const row = await env.DB.prepare(`SELECT artifact.r2_key,artifact.content_sha256,
      artifact.byte_count,artifact.provenance,source.person_id
    FROM transcript_artifacts artifact JOIN source_items source
      ON source.source_item_id=artifact.source_item_id
    WHERE artifact.transcript_id=?1 AND artifact.source_item_id=?2`)
    .bind(payload.transcriptId, payload.sourceItemId).first();
  if (!row || row.person_id !== personId || row.content_sha256 !== payload.transcriptSha256 ||
      row.provenance !== "gemini_generated_public_youtube_clipped_v1") {
    throw new Error("invalid_transcript_analysis_binding");
  }
  const object = await env.ARTIFACTS.get(row.r2_key);
  if (!object) { const error = new Error("transcript_artifact_missing"); error.retryable = true; throw error; }
  const transcript = await object.text();
  if (await sha256(transcript) !== row.content_sha256 ||
      new TextEncoder().encode(transcript).length !== Number(row.byte_count)) {
    throw new Error("transcript_content_hash_mismatch");
  }
  return prepareTranscriptAnalysis(env, { transcriptId: payload.transcriptId,
    sourceItemId: payload.sourceItemId, personId, transcript,
    transcriptSha256: payload.transcriptSha256, analysisRunId: payload.analysisRunId,
    ingestionRunId, at });
}

export async function processTranscriptAnalysis(env, payload, { at = nowIso(), attemptCount = 1 } = {}) {
  const row = await env.DB.prepare(`SELECT section.*,analysis.transcript_id,analysis.source_item_id,
      analysis.transcript_sha256,analysis.prompt_version,artifact.r2_key,artifact.content_sha256,
      source.person_id
    FROM transcript_analysis_sections section
    JOIN transcript_analysis_runs analysis ON analysis.analysis_run_id=section.analysis_run_id
    JOIN transcript_artifacts artifact ON artifact.transcript_id=analysis.transcript_id
    JOIN source_items source ON source.source_item_id=analysis.source_item_id
    WHERE section.analysis_section_id=?1 AND section.analysis_run_id=?2
      AND section.section_index=?3 AND section.input_sha256=?4
      AND analysis.transcript_id=?5 AND analysis.source_item_id=?6
      AND analysis.transcript_sha256=?7 AND analysis.prompt_version=?8`)
    .bind(payload.analysisSectionId, payload.analysisRunId, payload.sectionIndex,
      payload.inputSha256, payload.transcriptId, payload.sourceItemId,
      payload.transcriptSha256, payload.promptVersion).first();
  if (!row || row.content_sha256 !== payload.transcriptSha256) throw new Error("invalid_transcript_analysis_binding");
  if (row.status === "completed") return { reused: true, candidateCount: 0 };
  const object = await env.ARTIFACTS.get(row.r2_key);
  if (!object) { const error = new Error("transcript_artifact_missing"); error.retryable = true; throw error; }
  const transcript = await object.text();
  if (await sha256(transcript) !== row.transcript_sha256) throw new Error("transcript_content_hash_mismatch");
  const section = transcriptSections(transcript)[Number(row.section_index)];
  if (!section || section.baseOffset !== Number(row.base_offset) ||
      section.approximateTimestamp !== Number(row.approximate_timestamp_seconds) ||
      await sha256(section.text) !== row.input_sha256) throw new Error("transcript_section_hash_mismatch");
  await env.DB.prepare(`UPDATE transcript_analysis_sections SET status='processing',
      attempt_count=?2,error_code=NULL,started_at=COALESCE(started_at,?3),completed_at=NULL
    WHERE analysis_section_id=?1 AND status IN ('queued','failed')`)
    .bind(payload.analysisSectionId, attemptCount, at).run();
  const result = await extractTranscriptSection(env.AI, { db: env.DB,
    transcriptId: row.transcript_id, sourceItemId: row.source_item_id, transcript, section,
    models: [env.AI_MODEL, env.AI_FALLBACK_MODEL],
    timeoutMs: Number(env.AI_TIMEOUT_MS) || 45_000, createdAt: at });
  await env.DB.prepare(`UPDATE transcript_analysis_sections SET status='completed',
      extraction_run_id=?2,error_code=NULL,completed_at=?3
    WHERE analysis_section_id=?1 AND status='processing'`)
    .bind(payload.analysisSectionId, result.extractionRunId, at).run();
  await refreshAnalysisRun(env.DB, payload.analysisRunId, at);
  return result;
}

export async function recordTranscriptAnalysisFailure(env, payload, { final, errorCode, at = nowIso() }) {
  await env.DB.prepare(`UPDATE transcript_analysis_sections SET status=?2,error_code=?3,
      completed_at=CASE WHEN ?2='failed' THEN ?4 ELSE NULL END
    WHERE analysis_section_id=?1 AND status<>'completed'`)
    .bind(payload.analysisSectionId, final ? "failed" : "queued", errorCode, at).run();
  return refreshAnalysisRun(env.DB, payload.analysisRunId, at);
}
