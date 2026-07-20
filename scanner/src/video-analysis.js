import {
  compareVideoClaims, extractPublicVideoClaims, primaryVideoPrompt, tiebreakPublicVideoClaims,
  tiebreakerVideoPrompt, verifierVideoPrompt, verifyPublicVideoClaims,
} from "./ai.js";
import { sha256, stableId } from "./hash.js";
import {
  disputedVideoCandidateIds, latestCompletedVideoAttempt, nowIso, primaryVideoCandidates,
  recordVideoAnalysisFailure, recordVideoAnalysisSuccess, videoAttempt, videoChecks,
} from "./repository.js";

const PROMPT_VERSIONS = Object.freeze({
  primary: "video-primary-v4", verifier: "video-verifier-v4", tiebreaker: "video-tiebreaker-v4",
});

function timeoutMs(env) {
  const value = Number(env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 5_000 && value <= 110_000 ? value : 90_000;
}

function modelFor(env, stage) {
  if (stage === "primary") return env.GEMINI_PRIMARY_MODEL || "gemini-3.5-flash";
  if (stage === "verifier") return env.GEMINI_VERIFIER_MODEL || "gemini-3.1-pro-preview";
  return env.GEMINI_TIEBREAKER_MODEL || "gemini-3.1-flash-lite";
}

function gatewayOptions(env) {
  const useByok = env.AI_GATEWAY_BYOK === "1";
  return {
    gatewayAccountId: env.AI_GATEWAY_ACCOUNT_ID,
    gatewayId: env.AI_GATEWAY_ID || "default",
    gatewayToken: env.AI_GATEWAY_TOKEN,
    useByok,
    apiKey: useByok ? null : env.GEMINI_API_KEY,
  };
}

function videoUrl(youtubeId) {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

async function trustedVideo(env, envelope) {
  const item = await env.DB.prepare(`SELECT * FROM source_items
    WHERE source_item_id=?1 AND person_id=?2 AND platform='youtube' AND platform_item_id=?3
      AND canonical_url=?4`).bind(envelope.payload.sourceItemId, envelope.personId,
      envelope.payload.youtubeId, videoUrl(envelope.payload.youtubeId)).first();
  if (!item) throw new Error("trusted_source_item_mismatch");
  return item;
}

function rowClaim(row) {
  return {
    candidateId: row.candidate_id, quote: row.exact_quote,
    startSeconds: Number(row.start_seconds), endSeconds: Number(row.end_seconds),
    statementType: row.statement_type, atomicProposition: row.atomic_proposition,
    deadlineText: row.explicit_deadline_text, contextBefore: row.context_before,
    contextAfter: row.context_after, confidence: Number(row.confidence),
  };
}

async function attemptIdentity(envelope, job, stage) {
  return stableId("vaa", `${envelope.jobId}:${job.attempt_count}:${stage}`);
}

async function attemptRecord({
  envelope, job, stage, sourceItemId, parentAttemptId = null, model, prompt, gatewayId,
  startedAt, result = null, error = null,
}) {
  const attemptId = await attemptIdentity(envelope, job, stage);
  const requestSha256 = await sha256({
    provider: "google_gemini", transport: "cloudflare_ai_gateway",
    gatewayId, model, promptVersion: PROMPT_VERSIONS[stage], prompt,
    videoUrl: videoUrl(envelope.payload.youtubeId), store: false,
  });
  return {
    attemptId, runId: envelope.runId, jobId: envelope.jobId, sourceItemId, stage,
    parentAttemptId, modelName: result?.model || model, promptVersion: PROMPT_VERSIONS[stage],
    promptText: prompt, videoUrl: videoUrl(envelope.payload.youtubeId), requestSha256,
    gatewayId, gatewayLogId: result?.gatewayLogId || null,
    httpStatus: result?.httpStatus || null,
    interactionId: result?.interactionId || null, rawOutput: result?.raw || null,
    structuredOutput: result?.structured || null, status: error ? "failed" : "completed",
    errorCode: error ? (/^[a-z0-9_]+$/.test(error.message || "") ? error.message : "gemini_call_failed") : null,
    startedAt, completedAt: nowIso(),
  };
}

async function callAndRecordFailure(env, args, call) {
  try { return await call(); }
  catch (error) {
    await recordVideoAnalysisFailure(env.DB, await attemptRecord({ ...args, result: error.geminiResult || null, error }));
    throw error;
  }
}

function verifierDescriptor(envelope, primaryAttemptId) {
  return {
    type: "video_analysis_verify", stableKey: `youtube:${envelope.payload.youtubeId}:verify:${primaryAttemptId}`,
    payload: { ...envelope.payload, primaryAttemptId },
  };
}

function tiebreakerDescriptor(envelope, primaryAttemptId, verifierAttemptId, candidateIds) {
  return {
    type: "video_analysis_tiebreak", stableKey: `youtube:${envelope.payload.youtubeId}:tiebreak:${verifierAttemptId}`,
    payload: { ...envelope.payload, primaryAttemptId, verifierAttemptId, candidateIds },
  };
}

export async function processPrimaryVideoAnalysis(env, envelope, job) {
  const item = await trustedVideo(env, envelope);
  const existing = await latestCompletedVideoAttempt(env.DB, envelope.jobId);
  if (existing) {
    const candidates = await primaryVideoCandidates(env.DB, existing.attempt_id);
    return candidates.length ? [verifierDescriptor(envelope, existing.attempt_id)] : [];
  }
  const stage = "primary", model = modelFor(env, stage), prompt = primaryVideoPrompt(), startedAt = nowIso();
  const gateway = gatewayOptions(env);
  const args = { envelope, job, stage, sourceItemId: item.source_item_id, model, prompt, gatewayId: gateway.gatewayId, startedAt };
  const result = await callAndRecordFailure(env, args, () => extractPublicVideoClaims({
    ...gateway, model, videoUrl: item.canonical_url, timeoutMs: timeoutMs(env),
    fetcher: env.GEMINI_FETCH || fetch,
  }));
  const attempt = await attemptRecord({ ...args, result });
  const createdAt = nowIso();
  const candidates = await Promise.all(result.claims.map(async (claim, ordinal) => ({
    ...claim, candidateId: await stableId("vcc", `${attempt.attemptId}:${ordinal}`),
    sourceItemId: item.source_item_id, primaryAttemptId: attempt.attemptId, ordinal, createdAt,
  })));
  await recordVideoAnalysisSuccess(env.DB, { attempt, candidates });
  return candidates.length ? [verifierDescriptor(envelope, attempt.attemptId)] : [];
}

export async function processVerifierVideoAnalysis(env, envelope, job) {
  const item = await trustedVideo(env, envelope);
  const primary = await videoAttempt(env.DB, envelope.payload.primaryAttemptId, item.source_item_id);
  if (!primary || primary.stage !== "primary") throw new Error("primary_video_attempt_required");
  const existing = await latestCompletedVideoAttempt(env.DB, envelope.jobId);
  if (existing) {
    const disputed = await disputedVideoCandidateIds(env.DB, existing.attempt_id);
    return disputed.length ? [tiebreakerDescriptor(envelope, primary.attempt_id, existing.attempt_id, disputed)] : [];
  }
  const rows = await primaryVideoCandidates(env.DB, primary.attempt_id);
  if (!rows.length) throw new Error("primary_video_candidates_required");
  const candidates = rows.map(rowClaim);
  const stage = "verifier", model = modelFor(env, stage), prompt = verifierVideoPrompt(candidates), startedAt = nowIso();
  const gateway = gatewayOptions(env);
  const args = {
    envelope, job, stage, sourceItemId: item.source_item_id, parentAttemptId: primary.attempt_id,
    model, prompt, gatewayId: gateway.gatewayId, startedAt,
  };
  const result = await callAndRecordFailure(env, args, () => verifyPublicVideoClaims({
    ...gateway, model, videoUrl: item.canonical_url, candidates,
    timeoutMs: timeoutMs(env), fetcher: env.GEMINI_FETCH || fetch,
  }));
  const attempt = await attemptRecord({ ...args, result });
  const createdAt = nowIso();
  const checks = []; const agreements = []; const disputed = [];
  for (const check of result.checks) {
    const candidate = candidates.find((value) => value.candidateId === check.candidateId);
    const comparison = compareVideoClaims(candidate, check);
    const checkId = await stableId("vchk", `${attempt.attemptId}:${check.candidateId}`);
    const outcome = comparison.agrees ? "ai_cross_verified" : "tiebreaker_required";
    checks.push({ ...check, checkId, analysisAttemptId: attempt.attemptId, checkRole: "verifier", createdAt });
    agreements.push({
      ...comparison, agreementId: await stableId("vagr", `${checkId}:primary:${outcome}`),
      candidateId: check.candidateId, comparedCheckId: checkId, comparisonBasis: "primary", outcome, createdAt,
    });
    if (!comparison.agrees) disputed.push(check.candidateId);
  }
  await recordVideoAnalysisSuccess(env.DB, { attempt, checks, agreements });
  return disputed.length ? [tiebreakerDescriptor(envelope, primary.attempt_id, attempt.attemptId, disputed)] : [];
}

export async function processTiebreakerVideoAnalysis(env, envelope, job) {
  const item = await trustedVideo(env, envelope);
  const primary = await videoAttempt(env.DB, envelope.payload.primaryAttemptId, item.source_item_id);
  const verifier = await videoAttempt(env.DB, envelope.payload.verifierAttemptId, item.source_item_id);
  if (!primary || primary.stage !== "primary" || !verifier || verifier.stage !== "verifier" || verifier.parent_attempt_id !== primary.attempt_id) {
    throw new Error("video_attempt_chain_invalid");
  }
  if (await latestCompletedVideoAttempt(env.DB, envelope.jobId)) return [];
  const primaryRows = (await primaryVideoCandidates(env.DB, primary.attempt_id))
    .filter((row) => envelope.payload.candidateIds.includes(row.candidate_id));
  const verifierRows = await videoChecks(env.DB, verifier.attempt_id, envelope.payload.candidateIds);
  if (primaryRows.length !== envelope.payload.candidateIds.length || verifierRows.length !== primaryRows.length) throw new Error("video_dispute_set_invalid");
  const disputes = primaryRows.map((row) => ({
    candidateId: row.candidate_id, primary: rowClaim(row),
    verifier: rowClaim(verifierRows.find((check) => check.candidate_id === row.candidate_id)),
  }));
  const stage = "tiebreaker", model = modelFor(env, stage), prompt = tiebreakerVideoPrompt(disputes), startedAt = nowIso();
  const gateway = gatewayOptions(env);
  const args = {
    envelope, job, stage, sourceItemId: item.source_item_id, parentAttemptId: verifier.attempt_id,
    model, prompt, gatewayId: gateway.gatewayId, startedAt,
  };
  const result = await callAndRecordFailure(env, args, () => tiebreakPublicVideoClaims({
    ...gateway, model, videoUrl: item.canonical_url, candidates: disputes,
    timeoutMs: timeoutMs(env), fetcher: env.GEMINI_FETCH || fetch,
  }));
  const attempt = await attemptRecord({ ...args, result });
  const createdAt = nowIso();
  const checks = []; const agreements = []; const escalations = [];
  for (const check of result.checks) {
    const primaryClaim = disputes.find((value) => value.candidateId === check.candidateId).primary;
    const verifierClaim = disputes.find((value) => value.candidateId === check.candidateId).verifier;
    const primaryComparison = compareVideoClaims(primaryClaim, check);
    const verifierComparison = compareVideoClaims(verifierClaim, check);
    const primaryAgrees = ["primary", "both"].includes(check.supports) && primaryComparison.agrees;
    const verifierAgrees = ["verifier", "both"].includes(check.supports) && verifierComparison.agrees;
    const comparison = primaryAgrees ? primaryComparison : verifierAgrees ? verifierComparison : primaryComparison;
    const basis = primaryAgrees ? "primary" : verifierAgrees ? "verifier" : "primary";
    const outcome = primaryAgrees || verifierAgrees ? "ai_cross_verified" : "human_review_required";
    const checkId = await stableId("vchk", `${attempt.attemptId}:${check.candidateId}`);
    const previousCheck = verifierRows.find((row) => row.candidate_id === check.candidateId);
    const previousAgreement = await env.DB.prepare(`SELECT agreement_id FROM video_agreement_results
      WHERE compared_check_id=?1 ORDER BY created_at DESC,agreement_id DESC LIMIT 1`).bind(previousCheck.check_id).first();
    const agreementId = await stableId("vagr", `${checkId}:${basis}:${outcome}`);
    checks.push({ ...check, checkId, analysisAttemptId: attempt.attemptId, checkRole: "tiebreaker", createdAt });
    agreements.push({
      ...comparison, agrees: outcome === "ai_cross_verified", agreementId, candidateId: check.candidateId,
      comparedCheckId: checkId, supersedesAgreementId: previousAgreement?.agreement_id || null,
      comparisonBasis: basis, outcome, createdAt,
    });
    if (outcome === "human_review_required") escalations.push({
      eventId: await stableId("vesc", `${agreementId}:open`), candidateId: check.candidateId,
      agreementId, state: "open", reason: "AI passes did not reach deterministic agreement.", createdAt,
    });
  }
  await recordVideoAnalysisSuccess(env.DB, { attempt, checks, agreements, escalations });
  return [];
}
