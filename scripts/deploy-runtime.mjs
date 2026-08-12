#!/usr/bin/env node
// Canonical fail-closed runtime deployer; remote mutation requires explicit --apply.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFailureError, parseNpmCheckReceipt, validateWorkerArtifact, workerArtifactReceipt,
  workerDeployArgs } from "./deploy-runtime-receipts.mjs";
import { provisionDeploymentQueues, validateQueueProvisioningReceipt }
  from "./deploy-runtime-queues.mjs";
import { pollPagesPropagation, runStableReviewerSmoke, validatePagesPropagationReceipt,
  validateReviewerSmokeReceipt } from "./deploy-runtime-pages.mjs";
import { sqlQuote } from "./research-lib.mjs";
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_DIR = join(REPO_ROOT, "outputs", "deploy-runtime");
const SCANNER_BASE = "https://prophecy-ledger-scanner.stephanjoseph2007.workers.dev";
const PAGES_BASE = "https://prophecy-ledger.pages.dev";
const REQUIRED_QUEUES = ["prophecy-ledger-ingestion", "prophecy-ledger-analysis",
  "prophecy-ledger-ingestion-dlq", "prophecy-ledger-analysis-dlq"];
const ADMIN_POLL_MAX_ATTEMPTS = 6;
const ADMIN_POLL_INTERVAL_MS = 4_000;
const ADMIN_POLL_WINDOW_MS = 50_000;
const ADMIN_FETCH_TIMEOUT_MS = 5_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i;
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function parseDeployRuntimeArgs(args) {
  if (args.some((arg) => arg !== "--apply")) {
    throw new Error(`unknown_argument:${args.find((arg) => arg !== "--apply")}`);
  }
  if (args.filter((arg) => arg === "--apply").length > 1) throw new Error("duplicate_apply");
  return { apply: args.includes("--apply") };
}
function excluded(relativePath) {
  const parts = relativePath.split("/");
  if (parts.some((part) => [".git", "node_modules", ".wrangler", "outputs"].includes(part))) return true;
  const name = basename(relativePath);
  if ([".env", ".dev.vars", ".DS_Store"].includes(name)) return true;
  if ((name.startsWith(".env.") || name.startsWith(".dev.vars.")) && !name.endsWith(".example")) return true;
  return /(?:^|\/)(?:secrets?|private_keys?)(?:\/|$)/i.test(relativePath);
}
function category(relativePath) {
  if (relativePath.startsWith("migrations/") && relativePath.endsWith(".sql")) return "migration";
  if (relativePath.startsWith("test/")) return "test";
  if (relativePath.startsWith("public/")) return "public";
  if (/^(?:functions\/|scanner\/src\/|scripts\/)/.test(relativePath)
      || ["package.json", "package-lock.json", "wrangler.toml", "scanner/wrangler.toml"]
        .includes(relativePath)) return "runtime";
  return null;
}
function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function walk(root, directory = root, files = [], canonicalRoot = realpathSync(root)) {
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    const rel = relative(root, absolute).split(sep).join("/");
    if (excluded(rel)) continue;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`deployment_symlink_rejected:${rel}`);
    if (!contained(canonicalRoot, realpathSync(absolute))) {
      throw new Error(`deployment_path_escape:${rel}`);
    }
    if (stat.isDirectory()) walk(root, absolute, files, canonicalRoot);
    else if (stat.isFile() && category(rel)) files.push(rel);
  }
  return files;
}

export function buildDeploymentManifests(root = REPO_ROOT) {
  if (lstatSync(root).isSymbolicLink()) throw new Error("deployment_root_symlink_rejected");
  const files = walk(root).map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, category: category(path), bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length) throw new Error("deployment_source_manifest_empty");
  const subset = (kind) => files.filter((file) => file.category === kind);
  const hash = (entries) => sha256(Buffer.from(entries.map((entry) =>
    `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`).join("")));
  for (const kind of ["runtime", "public", "migration", "test"]) {
    if (!subset(kind).length) throw new Error(`deployment_${kind}_manifest_empty`);
  }
  return { files, sourceFingerprintSha256: hash(files), runtimeSha256: hash(subset("runtime")),
    pagesBundleSha256: hash(subset("public")), migrationManifestSha256: hash(subset("migration")),
    testSourceSha256: hash(subset("test")), counts: Object.fromEntries(
      ["runtime", "public", "migration", "test"].map((kind) => [kind, subset(kind).length])) };
}

export function stageDeploymentSnapshot(root = REPO_ROOT, outputRoot = OUTPUT_DIR) {
  const manifests = buildDeploymentManifests(root);
  mkdirSync(outputRoot, { recursive: true });
  const stageRoot = mkdtempSync(join(outputRoot, "stage-"));
  const canonicalRoot = realpathSync(root);
  for (const file of manifests.files) {
    const source = join(root, file.path); const destination = join(stageRoot, file.path);
    const sourceStat = lstatSync(source);
    if (sourceStat.isSymbolicLink()) throw new Error(`deployment_symlink_rejected:${file.path}`);
    if (!contained(canonicalRoot, realpathSync(source))) {
      throw new Error(`deployment_path_escape:${file.path}`);
    }
    const bytes = readFileSync(source);
    if (sha256(bytes) !== file.sha256) throw new Error("source_changed_during_snapshot");
    mkdirSync(resolve(destination, ".."), { recursive: true });
    writeFileSync(destination, bytes, { mode: sourceStat.mode & 0o777 });
  }
  const staged = buildDeploymentManifests(stageRoot);
  if (staged.sourceFingerprintSha256 !== manifests.sourceFingerprintSha256) {
    throw new Error("snapshot_copy_readback_mismatch");
  }
  return { root: stageRoot, manifests: staged };
}
export function parseWranglerOutput(text, type) {
  const entries = String(text || "").split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { throw new Error("wrangler_output_json_invalid"); }
  });
  const matches = entries.filter((entry) => entry.type === type && entry.version === 1);
  if (matches.length !== 1) throw new Error(`wrangler_${type}_receipt_missing`);
  const receipt = matches[0];
  if (type === "deploy" && (!UUID.test(receipt.version_id || "")
      || receipt.worker_name !== "prophecy-ledger-scanner")) {
    throw new Error("wrangler_worker_version_id_missing");
  }
  if (type === "pages-deploy" && (!UUID.test(receipt.deployment_id || "")
      || receipt.pages_project !== "prophecy-ledger" || !isPagesDeploymentUrl(receipt.url))) {
    throw new Error("wrangler_pages_deployment_id_missing");
  }
  return receipt;
}
export function workerDeploymentId(deployments, versionId) {
  const rows = Array.isArray(deployments) ? deployments : deployments?.deployments;
  const match = (rows || []).find((deployment) => Array.isArray(deployment.versions)
    && deployment.versions.some((version) => version.version_id === versionId));
  if (!UUID.test(match?.id || "")) throw new Error("worker_deployment_id_missing");
  return match.id;
}
function isPagesDeploymentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".prophecy-ledger.pages.dev")
      && url.hostname !== "prophecy-ledger.pages.dev";
  } catch { return false; }
}
export function pagesDeploymentRecord(deployments, deploymentId) {
  const match = (Array.isArray(deployments) ? deployments : []).find((entry) =>
    (entry.Id || entry.id || entry.deployment_id) === deploymentId);
  const url = match?.Deployment || match?.url || match?.deployment_url;
  if (!UUID.test(deploymentId || "") || !match || !isPagesDeploymentUrl(url)) {
    throw new Error("pages_deployment_readback_missing");
  }
  return { deploymentId, deploymentUrl: url };
}
export function expectedPagesAssets(manifests) {
  const assets = (manifests?.files || []).filter((file) => file.category === "public"
      && !["public/_headers", "public/_redirects"].includes(file.path))
    .map((file) => ({ path: file.path === "public/index.html" ? "/"
      : `/${file.path.slice("public/".length)}`, bodySha256: file.sha256 }));
  if (!assets.length) throw new Error("pages_expected_assets_missing");
  if (new Set(assets.map((asset) => asset.path)).size !== assets.length) {
    throw new Error("pages_expected_assets_duplicate_path");
  }
  return assets;
}

function command(commandName, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  const result = spawnSync(commandName, args, {
    cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function requireSuccess(result, code, machineOutput = "", partialReceipts = null) {
  if (result.exitCode !== 0) throw commandFailureError(code, result, machineOutput, partialReceipts);
  return result;
}

function migrationContinuity(root) {
  const names = readdirSync(join(root, "migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  const numbers = names.map((name) => Number(name.slice(0, 4)));
  if (numbers.length < 48 || numbers.some((number, index) => number !== index + 1)
      || names[46] !== "0047_operations_run_receipts.sql"
      || names[47] !== "0048_analysis_reprocess_outbox.sql") {
    throw new Error("migration_chain_invalid");
  }
  return names;
}

export function defaultPreflight(root = REPO_ROOT) {
  const migrations = migrationContinuity(root);
  const check = parseNpmCheckReceipt(command("npm", ["run", "check"], { cwd: root }));
  const outdir = mkdtempSync(join(tmpdir(), "prophecy-scanner-dry-build-"));
  requireSuccess(command("npx", ["wrangler", "deploy", "--config", "scanner/wrangler.toml",
    "--dry-run", "--outdir", outdir], { cwd: root }), "scanner_dry_build_failed");
  const scannerArtifact = workerArtifactReceipt(outdir);
  const gate = { contract: "deploy-runtime-gates-v1", terminal: true,
    tests: check.tests, passed: check.passed, failed: check.failed,
    migrationCount: migrations.length, importCheck: true, scannerDryBuild: true,
    outputSha256: check.outputSha256, scannerBundleSha256: scannerArtifact.bundleSha256 };
  return { ...gate, testReceiptSha256: sha256(Buffer.from(stableJson(gate))), scannerArtifact };
}

export function validateGateReceipt(gate, expectedMigrationCount = gate?.migrationCount) {
  if (gate?.contract !== "deploy-runtime-gates-v1" || gate?.terminal !== true
      || !Number.isInteger(gate.tests) || gate.tests < 1 || gate.passed !== gate.tests
      || gate.failed !== 0 || gate.migrationCount !== expectedMigrationCount || gate.importCheck !== true
      || gate.scannerDryBuild !== true || !/^[a-f0-9]{64}$/.test(gate.testReceiptSha256 || "")
      || !/^[a-f0-9]{64}$/.test(gate.scannerBundleSha256 || "")) {
    throw new Error("deploy_gate_receipt_incomplete");
  }
  return gate;
}

function parseD1(text) {
  const parsed = JSON.parse(text);
  return parsed.flatMap((entry) => entry.results || []);
}

function remoteD1(sql, cwd = REPO_ROOT) {
  return parseD1(requireSuccess(command("npx", ["wrangler", "d1", "execute", "prophecy-ledger",
    "--remote", "--json", "--command", sql], { cwd }), "remote_d1_read_failed").stdout);
}

function fetchJson(url, token, timeoutMs = 30_000) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }).then(async (response) => ({
    ok: response.ok, status: response.status, body: await response.text(),
  }));
}

function safeFailureField(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(value) ? value : null;
}

function healthReason(value) {
  if (value?.ok !== true) return "health_contract_invalid";
  if (value.scannerEnabled !== false || value.bindings?.d1 !== true
      || value.bindings?.artifacts !== true || value.bindings?.queue !== true) {
    return "health_config_invalid";
  }
  return null;
}

function operationsReason(value) {
  if (value?.contract !== "queue-operations-status-v1") {
    return "operations_contract_invalid";
  }
  if (value.healthy !== true) return "operations_health_invalid";
  if (!Array.isArray(value.queues) || value.queues.length !== REQUIRED_QUEUES.length) {
    return "operations_queue_receipt_invalid";
  }
  for (const queueName of REQUIRED_QUEUES) {
    const matches = value.queues.filter((queue) => queue?.queueName === queueName);
    if (matches.length !== 1 || !Number.isInteger(matches[0].backlogCount)
        || matches[0].backlogCount < 0 || !Number.isInteger(matches[0].backlogBytes)
        || matches[0].backlogBytes < 0) return "operations_queue_receipt_invalid";
  }
  return null;
}

function adminResponse(endpoint, result) {
  const body = String(result?.body || "");
  const bytes = Buffer.from(body);
  const httpOk = result?.ok === true && Number.isInteger(result?.status)
    && result.status >= 200 && result.status < 300;
  let value = null; let reasonCode = httpOk ? null : `${endpoint}_http_non_2xx`;
  if (httpOk) {
    try { value = JSON.parse(body); }
    catch { reasonCode = `${endpoint}_json_invalid`; }
  }
  if (!reasonCode) reasonCode = endpoint === "health" ? healthReason(value) : operationsReason(value);
  const valid = reasonCode === null;
  const safeValue = !valid ? null : endpoint === "health"
    ? { ok: value.ok, scannerEnabled: value.scannerEnabled,
      bindings: { d1: value.bindings?.d1, artifacts: value.bindings?.artifacts,
        queue: value.bindings?.queue } }
    : { contract: value.contract, healthy: value.healthy,
      queues: Array.isArray(value.queues) ? value.queues.map((queue) => ({
        queueName: queue?.queueName, backlogCount: queue?.backlogCount,
        backlogBytes: queue?.backlogBytes,
      })) : [] };
  return { value: safeValue, valid, evidence: { endpoint, status: Number.isInteger(result?.status)
    ? result.status : null, bodyBytes: bytes.length, bodySha256: sha256(bytes), valid,
  reasonCode } };
}

function propagationFailure(code, receipt, detail = {}) {
  const error = new Error(code);
  error.safeDetail = { source: "scanner_admin_propagation",
    contract: "scanner-admin-propagation-v1", attemptCount: receipt.attemptCount,
    maxAttempts: receipt.maxAttempts, ...detail };
  error.partialReceipts = { scannerAdminPropagation: receipt };
  return error;
}

export async function pollScannerAdminReadbacks({ token, fetcher = fetchJson,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = () => Date.now(), maxAttempts = ADMIN_POLL_MAX_ATTEMPTS,
  intervalMs = ADMIN_POLL_INTERVAL_MS, pollWindowMs = ADMIN_POLL_WINDOW_MS,
  fetchTimeoutMs = ADMIN_FETCH_TIMEOUT_MS, baseUrl = SCANNER_BASE } = {}) {
  if (!token) throw new Error("scanner_admin_token_missing");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
      || !Number.isInteger(intervalMs) || intervalMs < 0
      || !Number.isInteger(pollWindowMs) || pollWindowMs < 1 || pollWindowMs >= 60_000
      || !Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs < 1
      || typeof fetcher !== "function" || typeof sleep !== "function" || typeof now !== "function") {
    throw new Error("scanner_admin_poll_config_invalid");
  }
  const startedAtMs = now(); const deadlineAtMs = startedAtMs + pollWindowMs;
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = Math.max(1, deadlineAtMs - now());
    let results;
    try {
      results = await Promise.all([
        fetcher(`${baseUrl}/admin/health`, token, Math.min(fetchTimeoutMs, remainingMs)),
        fetcher(`${baseUrl}/admin/operations-status`, token,
          Math.min(fetchTimeoutMs, remainingMs)),
      ]);
    } catch (error) {
      attempts.push({ attempt, fetchFailure: {
        errorCode: safeFailureField(error?.code), errorName: safeFailureField(error?.name),
      } });
      if (attempt === maxAttempts || now() >= deadlineAtMs) break;
      const sleepMs = Math.min(intervalMs, Math.max(0, deadlineAtMs - now()));
      if (sleepMs > 0) await sleep(sleepMs);
      continue;
    }
    const health = adminResponse("health", results[0]);
    const operations = adminResponse("operations", results[1]);
    attempts.push({ attempt, health: health.evidence, operations: operations.evidence });
    if (health.valid && operations.valid) {
      const receipt = { contract: "scanner-admin-propagation-v1", status: "completed",
        attemptCount: attempt, maxAttempts, pollWindowMs,
        elapsedMs: Math.max(0, now() - startedAtMs), attempts };
      validateScannerAdminPropagationReceipt(receipt);
      return { health: health.value, operations: operations.value, receipt };
    }
    if (attempt === maxAttempts || now() >= deadlineAtMs) break;
    const sleepMs = Math.min(intervalMs, Math.max(0, deadlineAtMs - now()));
    if (sleepMs > 0) await sleep(sleepMs);
  }
  const receipt = { contract: "scanner-admin-propagation-v1", status: "failed",
    attemptCount: attempts.length, maxAttempts, pollWindowMs,
    elapsedMs: Math.max(0, now() - startedAtMs), attempts };
  throw propagationFailure("scanner_admin_propagation_timeout", receipt,
    { finalAttempt: attempts.at(-1) || null });
}

export function validateScannerAdminPropagationReceipt(receipt) {
  const safeEndpoint = (endpoint, name) => endpoint?.endpoint === name
    && Number.isInteger(endpoint.status) && endpoint.status >= 100 && endpoint.status <= 599
    && Number.isInteger(endpoint.bodyBytes) && endpoint.bodyBytes >= 0
    && /^[a-f0-9]{64}$/.test(endpoint.bodySha256 || "")
    && typeof endpoint.valid === "boolean"
    && (endpoint.reasonCode === null || /^[a-z0-9_]{1,64}$/.test(endpoint.reasonCode || ""))
    && Object.keys(endpoint).sort().join(",")
      === "bodyBytes,bodySha256,endpoint,reasonCode,status,valid";
  const safeFetchFailure = (failure) => failure
    && (failure.errorCode === null || safeFailureField(failure.errorCode) !== null)
    && (failure.errorName === null || safeFailureField(failure.errorName) !== null)
    && Object.keys(failure).sort().join(",") === "errorCode,errorName";
  const safeAttempt = (attempt, index) => attempt?.attempt === index + 1
    && ((safeFetchFailure(attempt.fetchFailure)
      && Object.keys(attempt).sort().join(",") === "attempt,fetchFailure")
      || (safeEndpoint(attempt.health, "health")
        && safeEndpoint(attempt.operations, "operations")
        && Object.keys(attempt).sort().join(",") === "attempt,health,operations"));
  if (receipt?.contract !== "scanner-admin-propagation-v1" || receipt.status !== "completed"
      || !Number.isInteger(receipt.attemptCount) || receipt.attemptCount < 1
      || !Number.isInteger(receipt.maxAttempts) || receipt.maxAttempts < receipt.attemptCount
      || !Number.isInteger(receipt.pollWindowMs) || receipt.pollWindowMs >= 60_000
      || !Number.isInteger(receipt.elapsedMs) || receipt.elapsedMs < 0 || receipt.elapsedMs >= 60_000
      || !Array.isArray(receipt.attempts) || receipt.attempts.length !== receipt.attemptCount
      || receipt.attempts.some((attempt, index) => !safeAttempt(attempt, index))) {
    throw new Error("scanner_admin_propagation_receipt_invalid");
  }
  const final = receipt.attempts.at(-1);
  if (final?.health?.valid !== true || final.health.reasonCode !== null
      || final.health.status < 200 || final.health.status >= 300
      || final?.operations?.valid !== true || final.operations.reasonCode !== null
      || final.operations.status < 200 || final.operations.status >= 300) {
    throw new Error("scanner_admin_propagation_receipt_invalid");
  }
  return receipt;
}

export function validatePostDeployReadbacks(readbacks, { pagesRequired, expectedAssets = [],
  expectedMigrationNames = readbacks?.migrationNames }) {
  if (!Array.isArray(readbacks?.migrationNames)
      || stableJson(readbacks.migrationNames) !== stableJson(expectedMigrationNames)) {
    throw new Error("d1_migration_readback_mismatch");
  }
  if (healthReason(readbacks.health) !== null) {
    throw new Error("scanner_admin_readback_invalid");
  }
  validateScannerAdminPropagationReceipt(readbacks.scannerAdminPropagation);
  validateQueueProvisioningReceipt(readbacks.queueProvisioning);
  if (operationsReason(readbacks.operations) !== null) throw new Error("queue_readback_incomplete");
  if (!expectedAssets.length) throw new Error("pages_expected_assets_missing");
  validatePagesPropagationReceipt(readbacks.pagesPropagation, { expectedAssets });
  validateReviewerSmokeReceipt(readbacks.reviewerSmoke);
  if (!UUID.test(readbacks.pagesDeploymentId || "")
      || !isPagesDeploymentUrl(readbacks.pagesDeploymentUrl)) throw new Error("pages_readback_missing");
  if (pagesRequired && readbacks.pagesChanged !== true) throw new Error("pages_readback_missing");
  return true;
}

export function validateAppliedDeployment(applied, manifests) {
  if (!UUID.test(applied?.workerVersionId || "")
      || !UUID.test(applied?.workerDeploymentId || "")
      || !UUID.test(applied?.pagesDeploymentId || "")) {
    throw new Error("deployment_ids_incomplete");
  }
  validatePostDeployReadbacks(applied.readbacks, { pagesRequired: Boolean(applied.pagesRequired),
    expectedAssets: expectedPagesAssets(manifests), expectedMigrationNames: manifests.files
      .filter((file) => file.category === "migration").map((file) => basename(file.path)).sort() });
  return applied;
}

async function defaultApplyRemote(context) {
  const stageRoot = context.stageRoot;
  let workerArgs = workerDeployArgs(context.gate.scannerArtifact,
    context.gate.scannerBundleSha256);
  requireSuccess(command("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote",
    "--config", "wrangler.toml"], { cwd: stageRoot }), "d1_migrations_apply_failed");
  const migrationRows = remoteD1("SELECT name FROM d1_migrations ORDER BY id", stageRoot);
  const migrationNames = migrationRows.map((row) => row.name);
  const latest = remoteD1(`SELECT pages_bundle_sha256,pages_deployment_id
    FROM runtime_deployment_receipts WHERE status='completed'
    ORDER BY created_at DESC,deployment_receipt_id DESC LIMIT 1`, stageRoot)[0] || null;
  const pagesRequired = latest?.pages_bundle_sha256 !== context.manifests.pagesBundleSha256
    || !UUID.test(latest?.pages_deployment_id || "");
  const mediaDay = new Date().toISOString().slice(0, 10);
  remoteD1(`INSERT OR IGNORE INTO gemini_physical_day_debits
    (debit_id,media_day,reserved_seconds,reason,created_at)
    VALUES (${sqlQuote(`gpd_runtime_cutover_${mediaDay}`)},${sqlQuote(mediaDay)},86400,
      'legacy_cutover_fail_closed',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, stageRoot);

  const queueProvisioning = provisionDeploymentQueues({ execute: (args) =>
    command("npx", args, { cwd: stageRoot }) });

  const temp = mkdtempSync(join(tmpdir(), "prophecy-runtime-deploy-"));
  const workerOutput = join(temp, "worker.jsonl");
  workerArgs = workerDeployArgs(context.gate.scannerArtifact, context.gate.scannerBundleSha256);
  const workerResult = command("npx", workerArgs, {
    cwd: stageRoot,
    env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: workerOutput },
  });
  requireSuccess(workerResult, "worker_deploy_failed",
    existsSync(workerOutput) ? readFileSync(workerOutput, "utf8") : "", { queueProvisioning });
  validateWorkerArtifact(context.gate.scannerArtifact, context.gate.scannerBundleSha256);
  const worker = parseWranglerOutput(readFileSync(workerOutput, "utf8"), "deploy");
  const deployments = JSON.parse(requireSuccess(command("npx", ["wrangler", "deployments", "list",
    "--config", "scanner/wrangler.toml", "--json"], { cwd: stageRoot }),
  "worker_deployment_readback_failed").stdout);
  const workerDeployment = workerDeploymentId(deployments, worker.version_id);
  let pages = null;
  if (pagesRequired) {
    const pagesOutput = join(temp, "pages.jsonl");
    requireSuccess(command("npx", ["wrangler", "pages", "deploy", "public",
      "--project-name", "prophecy-ledger", "--commit-dirty=true"], {
      cwd: stageRoot,
      env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: pagesOutput },
    }), "pages_deploy_failed");
    pages = parseWranglerOutput(readFileSync(pagesOutput, "utf8"), "pages-deploy");
  }
  const pagesId = pages?.deployment_id || latest?.pages_deployment_id;
  const listedPages = JSON.parse(requireSuccess(command("npx", ["wrangler", "pages", "deployment",
    "list", "--project-name", "prophecy-ledger", "--environment", "production", "--json"],
  { cwd: stageRoot }), "pages_deployment_list_failed").stdout);
  const pageRecord = pagesDeploymentRecord(listedPages, pagesId);
  if (pages && pageRecord.deploymentUrl !== pages.url) throw new Error("pages_deployment_url_mismatch");
  const token = process.env.SCANNER_ADMIN_TOKEN;
  if (!token) throw new Error("scanner_admin_token_missing");
  const scannerAdmin = await pollScannerAdminReadbacks({ token });
  const { health, operations } = scannerAdmin;
  const expectedAssets = expectedPagesAssets(context.manifests);
  const pagesReadback = await pollPagesPropagation({ previewBase: pageRecord.deploymentUrl,
    stableBase: PAGES_BASE, expectedAssets });
  const reviewerSmoke = runStableReviewerSmoke({ stableBase: PAGES_BASE,
    execute: (name, args) => command(name, args, { cwd: stageRoot }) });
  const readbacks = { migrationNames, health, operations,
    scannerAdminPropagation: scannerAdmin.receipt,
    queueProvisioning,
    pagesPropagation: pagesReadback.receipt, reviewerSmoke,
    deploymentPublicRoutes: pagesReadback.deploymentPublicRoutes,
    publicRoutes: pagesReadback.publicRoutes, pagesDeploymentId: pageRecord.deploymentId,
    pagesDeploymentUrl: pageRecord.deploymentUrl, pagesChanged: pagesRequired,
    deploymentAssets: pagesReadback.deploymentAssets,
    stableAliasAssets: pagesReadback.stableAliasAssets,
    stableAccess: pagesReadback.stableAccess };
  validatePostDeployReadbacks(readbacks, { pagesRequired, expectedAssets,
    expectedMigrationNames: migrationNames });
  return { workerVersionId: worker.version_id, workerDeploymentId: workerDeployment,
    pagesDeploymentId: pageRecord.deploymentId, pagesRequired, readbacks };
}

function localReceiptWriter(receipt) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = receipt.completedAt.replace(/[:.]/g, "-");
  const path = join(OUTPUT_DIR, `${stamp}-${receipt.status}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function persistCompletedReceipt(remote, receipt) {
  const id = `rdr_${sha256(Buffer.from(`${receipt.sourceFingerprintSha256}:${receipt.workerVersionId}:${receipt.pagesDeploymentId || "none"}`)).slice(0, 32)}`;
  remote.write(`INSERT OR IGNORE INTO runtime_deployment_receipts
    (deployment_receipt_id,source_fingerprint_sha256,migration_manifest_sha256,
     test_receipt_sha256,scanner_bundle_sha256,pages_bundle_sha256,worker_version_id,
     worker_deployment_id,pages_deployment_id,post_deploy_readback_sha256,status,created_at)
    VALUES (${sqlQuote(id)},${sqlQuote(receipt.sourceFingerprintSha256)},
      ${sqlQuote(receipt.migrationManifestSha256)},${sqlQuote(receipt.testReceiptSha256)},
      ${sqlQuote(receipt.scannerBundleSha256)},${sqlQuote(receipt.pagesBundleSha256)},
      ${sqlQuote(receipt.workerVersionId)},${sqlQuote(receipt.workerDeploymentId)},
      ${sqlQuote(receipt.pagesDeploymentId)},${sqlQuote(receipt.postDeployReadbackSha256)},
      'completed',${sqlQuote(receipt.completedAt)})`);
  const row = remote.read(`SELECT * FROM runtime_deployment_receipts
    WHERE deployment_receipt_id=${sqlQuote(id)}`)[0];
  if (!row || row.source_fingerprint_sha256 !== receipt.sourceFingerprintSha256
      || row.migration_manifest_sha256 !== receipt.migrationManifestSha256
      || row.test_receipt_sha256 !== receipt.testReceiptSha256
      || row.scanner_bundle_sha256 !== receipt.scannerBundleSha256
      || row.pages_bundle_sha256 !== receipt.pagesBundleSha256
      || row.worker_version_id !== receipt.workerVersionId
      || row.worker_deployment_id !== receipt.workerDeploymentId
      || (row.pages_deployment_id || null) !== (receipt.pagesDeploymentId || null)
      || row.post_deploy_readback_sha256 !== receipt.postDeployReadbackSha256) {
    throw new Error("deployment_receipt_d1_readback_mismatch");
  }
  return id;
}

export async function runDeployRuntime(options, dependencies = {}) {
  const nowIso = dependencies.nowIso || (() => new Date().toISOString());
  const writer = dependencies.writeLocalReceipt || localReceiptWriter;
  const startedAt = nowIso();
  let receipt;
  try {
    const staged = (dependencies.stageSnapshot || stageDeploymentSnapshot)(
      dependencies.root || REPO_ROOT);
    const manifests = staged.manifests;
    const gate = validateGateReceipt(await (dependencies.preflight || defaultPreflight)(
      staged.root), manifests.counts.migration);
    const afterGates = (dependencies.buildManifests || buildDeploymentManifests)(
      staged.root);
    if (afterGates.sourceFingerprintSha256 !== manifests.sourceFingerprintSha256) {
      throw new Error("source_changed_during_gates");
    }
    receipt = { contract: "deploy-runtime-v1", mode: options.apply ? "apply" : "plan",
      status: options.apply ? "applying" : "planned", startedAt, completedAt: nowIso(),
      sourceFingerprintSha256: manifests.sourceFingerprintSha256,
      migrationManifestSha256: manifests.migrationManifestSha256,
      testReceiptSha256: gate.testReceiptSha256,
      scannerBundleSha256: gate.scannerBundleSha256,
      pagesBundleSha256: manifests.pagesBundleSha256,
      fileCounts: manifests.counts, workerVersionId: null, workerDeploymentId: null,
      pagesDeploymentId: null, postDeployReadbackSha256: null, deploymentReceiptId: null,
      fatalCode: null };
    if (options.apply) {
      const applied = validateAppliedDeployment(
        await (dependencies.applyRemote || defaultApplyRemote)({ manifests, gate,
          stageRoot: staged.root }), manifests,
      );
      receipt.workerVersionId = applied.workerVersionId;
      receipt.workerDeploymentId = applied.workerDeploymentId;
      receipt.pagesDeploymentId = applied.pagesDeploymentId;
      receipt.postDeployReadbackSha256 = sha256(Buffer.from(stableJson(applied.readbacks)));
      receipt.completedAt = nowIso();
      receipt.status = "completed";
      if (dependencies.remoteReceipt) {
        receipt.deploymentReceiptId = persistCompletedReceipt(dependencies.remoteReceipt, receipt);
      } else {
        const remote = { write: (sql) => remoteD1(sql), read: remoteD1 };
        receipt.deploymentReceiptId = persistCompletedReceipt(remote, receipt);
      }
    }
  } catch (error) {
    receipt = { ...(receipt || { contract: "deploy-runtime-v1",
      mode: options.apply ? "apply" : "plan", startedAt }), status: "failed",
      completedAt: nowIso(), fatalCode: String(error?.message || "deploy_runtime_failed").slice(0, 120),
      failureDetail: error?.safeDetail || null, partialReceipts: error?.partialReceipts || null };
  }
  receipt.localReceiptPath = writer(receipt);
  const failed = receipt.status === "failed";
  return { receipt, exit: { schemaVersion: 1, status: failed ? "failure" : "success",
    exitCode: failed ? 1 : 0, receiptStatus: receipt.status } };
}

function emitTerminal(terminal) {
  console.log(`DEPLOY_RUNTIME_SUMMARY ${JSON.stringify(terminal.receipt)}`);
  console.log(`DEPLOY_RUNTIME_EXIT ${JSON.stringify(terminal.exit)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let terminal;
  try { terminal = await runDeployRuntime(parseDeployRuntimeArgs(process.argv.slice(2))); }
  catch (error) {
    terminal = { receipt: { contract: "deploy-runtime-v1", status: "failed",
      fatalCode: String(error?.message || "deploy_runtime_start_failed").slice(0, 120) },
    exit: { schemaVersion: 1, status: "failure", exitCode: 1, receiptStatus: "failed" } };
  }
  emitTerminal(terminal);
  process.exitCode = terminal.exit.exitCode;
}
