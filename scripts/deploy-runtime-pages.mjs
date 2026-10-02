import { createHash } from "node:crypto";

export const PUBLIC_READBACK_PATHS = ["/", "/people/troy-black", "/api/people/troy-black",
  "/api/people/troy-black/sources"];
export const PROTECTED_REVIEW_PATHS = ["/review", "/api/review/queue", "/api/review/feedback",
  "/api/review/pending", "/api/review/archive/queue"];
const ACCESS_STATUSES = new Set([301, 302, 401, 403]);
// Live Pages preview propagation exceeded two minutes; keep a bounded three-minute margin.
const MAX_ATTEMPTS = 18;
const INTERVAL_MS = 10_000;
const POLL_WINDOW_MS = 180_000;
const FETCH_TIMEOUT_MS = 5_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function defaultFetch(url, timeoutMs) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

export function pagesAssetHash(body) {
  const bytes = Buffer.isBuffer(body) ? body
    : body instanceof Uint8Array ? Buffer.from(body)
      : Buffer.from(String(body || ""), "utf8");
  return { bodyBytes: bytes.length, bodySha256: sha256(bytes) };
}

function evidence(path, result, reasonCode = null) {
  const hashed = pagesAssetHash(result?.body);
  return { path, status: Number.isInteger(result?.status) ? result.status : null,
    bodyBytes: hashed.bodyBytes, bodySha256: hashed.bodySha256, reasonCode };
}

function safeErrorField(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(value) ? value : null;
}

function safePathField(value) {
  return typeof value === "string" && /^\/[A-Za-z0-9._~/-]{0,127}$/.test(value) ? value : null;
}

function pagesFailure(code, receipt, detail = {}) {
  const error = new Error(code);
  error.safeDetail = { source: "pages_propagation", contract: "pages-propagation-v1",
    attemptCount: receipt.attemptCount, maxAttempts: receipt.maxAttempts, ...detail };
  error.partialReceipts = { pagesPropagation: receipt };
  return error;
}

function validExpectedAssets(expectedAssets) {
  return Array.isArray(expectedAssets) && expectedAssets.length > 0
    && new Set(expectedAssets.map((asset) => asset.path)).size === expectedAssets.length
    && expectedAssets.every((asset) => asset.path?.startsWith("/")
      && /^[a-f0-9]{64}$/.test(asset.bodySha256 || ""));
}

async function readAttempt({ previewBase, stableBase, expectedAssets, fetcher, timeoutMs }) {
  const get = async (base, path) => {
    try {
      return { path, result: await fetcher(new URL(path, `${base}/`).href, timeoutMs) };
    } catch (error) {
      if (error && typeof error === "object") error.fetchPath = path;
      throw error;
    }
  };
  const [previewAssetsRaw, stableAssetsRaw, previewRoutesRaw, stableRoutesRaw, stableAccessRaw]
    = await Promise.all([
      Promise.all(expectedAssets.map((asset) => get(previewBase, asset.path))),
      Promise.all(expectedAssets.map((asset) => get(stableBase, asset.path))),
      Promise.all(PUBLIC_READBACK_PATHS.map((path) => get(previewBase, path))),
      Promise.all(PUBLIC_READBACK_PATHS.map((path) => get(stableBase, path))),
      Promise.all(PROTECTED_REVIEW_PATHS.map((path) => get(stableBase, path))),
    ]);
  const assets = (rows, prefix) => rows.map((row) => {
    const expected = expectedAssets.find((asset) => asset.path === row.path);
    const readback = evidence(row.path, row.result);
    readback.reasonCode = readback.status !== 200 ? `${prefix}_asset_http_invalid`
      : readback.bodySha256 !== expected.bodySha256 ? `${prefix}_asset_hash_mismatch` : null;
    return readback;
  });
  const routes = (rows, prefix) => rows.map((row) => {
    const readback = evidence(row.path, row.result);
    readback.reasonCode = readback.status === 200 ? null : `${prefix}_route_http_invalid`;
    return readback;
  });
  const previewAssets = assets(previewAssetsRaw, "preview");
  const stableAssets = assets(stableAssetsRaw, "stable");
  const previewRoutes = routes(previewRoutesRaw, "preview");
  const stableRoutes = routes(stableRoutesRaw, "stable");
  for (const path of PUBLIC_READBACK_PATHS) {
    const preview = previewRoutes.find((row) => row.path === path);
    const stable = stableRoutes.find((row) => row.path === path);
    if (preview.reasonCode === null && stable.reasonCode === null
        && preview.bodySha256 !== stable.bodySha256) {
      preview.reasonCode = "public_route_parity_mismatch";
      stable.reasonCode = "public_route_parity_mismatch";
    }
  }
  const stableAccess = stableAccessRaw.map((row) => {
    const readback = evidence(row.path, row.result);
    readback.reasonCode = ACCESS_STATUSES.has(readback.status) ? null : "stable_access_mismatch";
    return readback;
  });
  return { previewAssets, stableAssets, previewRoutes, stableRoutes, stableAccess };
}

export async function pollPagesPropagation({ previewBase, stableBase, expectedAssets,
  fetcher = defaultFetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = () => Date.now(), maxAttempts = MAX_ATTEMPTS, intervalMs = INTERVAL_MS,
  pollWindowMs = POLL_WINDOW_MS, fetchTimeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!previewBase || !stableBase || !validExpectedAssets(expectedAssets)
      || typeof fetcher !== "function" || typeof sleep !== "function" || typeof now !== "function"
      || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
      || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs >= 60_000
      || !Number.isInteger(pollWindowMs) || pollWindowMs < 1
      || pollWindowMs > POLL_WINDOW_MS
      || !Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs < 1
      || fetchTimeoutMs > FETCH_TIMEOUT_MS) {
    throw new Error("pages_poll_config_invalid");
  }
  const startedAtMs = now(); const deadlineAtMs = startedAtMs + pollWindowMs;
  const attempts = [];
  let fetchFailures = 0;
  let lastFetchError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1 && now() >= deadlineAtMs) break;
    let result;
    let fetchError = null;
    for (let fetchTry = 1; fetchTry <= 3; fetchTry += 1) {
      try {
        result = await readAttempt({ previewBase, stableBase, expectedAssets, fetcher,
          timeoutMs: Math.min(fetchTimeoutMs, Math.max(1, deadlineAtMs - now())) });
        fetchError = null;
        break;
      } catch (error) {
        fetchError = error;
        if (fetchTry < 3 && now() < deadlineAtMs) {
          await sleep(Math.min(1000, Math.max(0, deadlineAtMs - now())));
        }
      }
    }
    if (fetchError) {
      // Transient read trouble (DNS, CDN, local network) must not fail the deploy: record
      // it and keep polling like any other not-ready-yet attempt until the window ends.
      fetchFailures += 1;
      lastFetchError = { name: safeErrorField(fetchError?.name),
        code: safeErrorField(fetchError?.code), path: safePathField(fetchError?.fetchPath) };
    } else {
      const valid = Object.values(result).every((rows) => rows.every((row) => row.reasonCode === null));
      attempts.push({ attempt: attempts.length + 1, ...result, valid });
      if (valid) {
        const receipt = { contract: "pages-propagation-v1", status: "completed",
          attemptCount: attempts.length, maxAttempts, pollWindowMs,
          elapsedMs: Math.max(0, now() - startedAtMs), attempts, fetchFailures };
        validatePagesPropagationReceipt(receipt, { expectedAssets });
        return { receipt, deploymentAssets: result.previewAssets,
          stableAliasAssets: result.stableAssets, deploymentPublicRoutes: result.previewRoutes,
          publicRoutes: result.stableRoutes, stableAccess: result.stableAccess };
      }
    }
    if (attempt === maxAttempts || now() >= deadlineAtMs) break;
    const delay = Math.min(intervalMs, Math.max(0, deadlineAtMs - now()));
    if (delay > 0) await sleep(delay);
  }
  const receipt = { contract: "pages-propagation-v1", status: "failed",
    attemptCount: attempts.length, maxAttempts, pollWindowMs,
    elapsedMs: Math.max(0, now() - startedAtMs), attempts, fetchFailures };
  throw pagesFailure("pages_propagation_timeout", receipt,
    { finalAttempt: attempts.at(-1) || null, fetchFailures, lastFetchError });
}

export function validatePagesPropagationReceipt(receipt, { expectedAssets }) {
  const safeRow = (row) => row?.path?.startsWith("/") && Number.isInteger(row.status)
    && row.status >= 100 && row.status <= 599 && Number.isInteger(row.bodyBytes)
    && row.bodyBytes >= 0 && /^[a-f0-9]{64}$/.test(row.bodySha256 || "")
    && (row.reasonCode === null || /^[a-z0-9_]{1,64}$/.test(row.reasonCode || ""))
    && Object.keys(row).sort().join(",") === "bodyBytes,bodySha256,path,reasonCode,status";
  const pathsEqual = (rows, paths) => rows.length === paths.length
    && paths.every((path) => rows.filter((row) => row.path === path).length === 1);
  if (!validExpectedAssets(expectedAssets) || receipt?.contract !== "pages-propagation-v1"
      || receipt.status !== "completed" || !Number.isInteger(receipt.attemptCount)
      || receipt.attemptCount < 1 || !Number.isInteger(receipt.maxAttempts)
      || receipt.maxAttempts < receipt.attemptCount || receipt.maxAttempts > 20
      || !Number.isInteger(receipt.pollWindowMs) || receipt.pollWindowMs < 1
      || receipt.pollWindowMs > POLL_WINDOW_MS || !Number.isInteger(receipt.elapsedMs)
      || receipt.elapsedMs < 0 || receipt.elapsedMs > receipt.pollWindowMs
      || !Array.isArray(receipt.attempts)
      || receipt.attempts.length !== receipt.attemptCount) {
    throw new Error("pages_propagation_receipt_invalid");
  }
  for (const [index, attempt] of receipt.attempts.entries()) {
    const arrays = [attempt?.previewAssets, attempt?.stableAssets, attempt?.previewRoutes,
      attempt?.stableRoutes, attempt?.stableAccess];
    if (attempt?.attempt !== index + 1 || typeof attempt?.valid !== "boolean"
        || Object.keys(attempt).sort().join(",")
          !== "attempt,previewAssets,previewRoutes,stableAccess,stableAssets,stableRoutes,valid"
        || arrays.some((rows) => !Array.isArray(rows)
        || rows.some((row) => !safeRow(row)))
        || !pathsEqual(attempt.previewAssets, expectedAssets.map((asset) => asset.path))
        || !pathsEqual(attempt.stableAssets, expectedAssets.map((asset) => asset.path))
        || !pathsEqual(attempt.previewRoutes, PUBLIC_READBACK_PATHS)
        || !pathsEqual(attempt.stableRoutes, PUBLIC_READBACK_PATHS)
        || !pathsEqual(attempt.stableAccess, PROTECTED_REVIEW_PATHS)) {
      throw new Error("pages_propagation_receipt_invalid");
    }
  }
  const final = receipt.attempts.at(-1);
  const expectedByPath = new Map(expectedAssets.map((asset) => [asset.path, asset.bodySha256]));
  if (final.valid !== true || Object.values(final).filter(Array.isArray)
    .some((rows) => rows.some((row) => row.reasonCode !== null))
      || [...final.previewAssets, ...final.stableAssets].some((row) => row.status !== 200
        || row.bodySha256 !== expectedByPath.get(row.path))
      || [...final.previewRoutes, ...final.stableRoutes].some((row) => row.status !== 200)
      || PUBLIC_READBACK_PATHS.some((path) => final.previewRoutes.find((row) => row.path === path)
        .bodySha256 !== final.stableRoutes.find((row) => row.path === path).bodySha256)
      || final.stableAccess.some((row) => !ACCESS_STATUSES.has(row.status))) {
    throw new Error("pages_propagation_receipt_invalid");
  }
  return receipt;
}

function outputEvidence(result) {
  const stdout = Buffer.from(String(result?.stdout || ""));
  const stderr = Buffer.from(String(result?.stderr || ""));
  return { exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    stdoutBytes: stdout.length, stdoutSha256: sha256(stdout),
    stderrBytes: stderr.length, stderrSha256: sha256(stderr) };
}

export function reviewerSmokeReceipt(result) {
  const output = outputEvidence(result);
  const lines = String(result?.stdout || "").split(/\r?\n/);
  const markers = lines.filter((line) => line === "REVIEWER SMOKE PASSED");
  const summaries = lines.filter((line) => line.startsWith("REVIEWER_SMOKE_SUMMARY "));
  const exits = lines.filter((line) => line.startsWith("REVIEWER_SMOKE_EXIT "));
  let summary; let exit;
  try {
    summary = summaries.length === 1
      ? JSON.parse(summaries[0].slice("REVIEWER_SMOKE_SUMMARY ".length)) : null;
    exit = exits.length === 1
      ? JSON.parse(exits[0].slice("REVIEWER_SMOKE_EXIT ".length)) : null;
  } catch { summary = null; exit = null; }
  const valid = output.exitCode === 0 && markers.length === 1
    && summary?.contract === "reviewer-smoke-v1" && summary.status === "success"
    && Number.isInteger(summary.considered) && summary.considered > 0
    && summary.passed === summary.considered && summary.failed === 0
    && exit?.status === "success" && exit.exitCode === 0;
  if (!valid) {
    const receipt = { contract: "stable-reviewer-smoke-v1", status: "failed", ...output };
    const error = new Error("stable_reviewer_smoke_failed");
    error.safeDetail = { source: "stable_reviewer_smoke", ...output };
    error.partialReceipts = { reviewerSmoke: receipt };
    throw error;
  }
  return { contract: "stable-reviewer-smoke-v1", status: "completed", surface: "stable_alias",
    considered: summary.considered, passed: summary.passed, failed: summary.failed,
    warningCount: summary.warningCount, ...output };
}

export function validateReviewerSmokeReceipt(receipt) {
  if (receipt?.contract !== "stable-reviewer-smoke-v1" || receipt.status !== "completed"
      || receipt.surface !== "stable_alias" || !Number.isInteger(receipt.considered)
      || receipt.considered < 1 || receipt.passed !== receipt.considered || receipt.failed !== 0
      || !Number.isInteger(receipt.warningCount) || receipt.warningCount < 0
      || receipt.exitCode !== 0 || !Number.isInteger(receipt.stdoutBytes)
      || !/^[a-f0-9]{64}$/.test(receipt.stdoutSha256 || "")
      || !Number.isInteger(receipt.stderrBytes)
      || !/^[a-f0-9]{64}$/.test(receipt.stderrSha256 || "")) {
    throw new Error("stable_reviewer_smoke_receipt_invalid");
  }
  return receipt;
}

export function runStableReviewerSmoke({ execute, stableBase }) {
  if (typeof execute !== "function" || !stableBase) throw new Error("reviewer_smoke_config_invalid");
  return reviewerSmokeReceipt(execute("node",
    ["scripts/reviewer-smoke.mjs", "--base", stableBase]));
}
