import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeploymentManifests, expectedPagesAssets, pagesDeploymentRecord,
  parseDeployRuntimeArgs, parseWranglerOutput, pollScannerAdminReadbacks, REPO_ROOT, runDeployRuntime,
  stageDeploymentSnapshot, validateAppliedDeployment, validateGateReceipt,
  validatePostDeployReadbacks, validateScannerAdminPropagationReceipt, workerDeploymentId,
} from "../scripts/deploy-runtime.mjs";
import { parseNpmCheckReceipt, sanitizedCommandFailure, validateWorkerArtifact,
  workerArtifactReceipt, workerDeployArgs } from "../scripts/deploy-runtime-receipts.mjs";
import { parseWranglerQueueTable, provisionDeploymentQueues }
  from "../scripts/deploy-runtime-queues.mjs";
import { fetchHandler } from "../scanner/src/index.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ID_D = "44444444-4444-4444-8444-444444444444";
const QID_A = "0123456789abcdef0123456789abcdef";
const QID_B = "11111111111111111111111111111111";
const QID_C = "fedcba9876543210fedcba9876543210";
const QID_D = "dddddddddddddddddddddddddddddddd";
const HASH = "a".repeat(64);
const PAGES_URL = "https://33333333.prophecy-ledger.pages.dev";
const ASSETS = [{ path: "/", bodySha256: "f".repeat(64) }];
const ASSET_READBACKS = ASSETS.map((asset) => ({ ...asset, status: 200 }));
const pageRow = (path, bodySha256 = HASH, status = 200) => ({ path, status, bodyBytes: 10,
  bodySha256, reasonCode: null });
function pagesReceipt() {
  const routePaths = ["/", "/people/troy-black", "/api/people/troy-black",
    "/api/people/troy-black/sources"];
  const accessPaths = ["/review", "/api/review/queue", "/api/review/feedback",
    "/api/review/pending", "/api/review/archive/queue"];
  return { contract: "pages-propagation-v1", status: "completed", attemptCount: 1,
    maxAttempts: 18, pollWindowMs: 180_000, elapsedMs: 0, attempts: [{ attempt: 1,
      previewAssets: [pageRow("/", ASSETS[0].bodySha256)],
      stableAssets: [pageRow("/", ASSETS[0].bodySha256)],
      previewRoutes: routePaths.map((path) => pageRow(path)),
      stableRoutes: routePaths.map((path) => pageRow(path)),
      stableAccess: accessPaths.map((path) => pageRow(path, HASH, 302)), valid: true }] };
}

function gate(overrides = {}) {
  return { contract: "deploy-runtime-gates-v1", terminal: true, tests: 10, passed: 10,
    failed: 0, migrationCount: 48, importCheck: true, scannerDryBuild: true,
    testReceiptSha256: HASH, scannerBundleSha256: "b".repeat(64), ...overrides };
}

function manifests() {
  return { sourceFingerprintSha256: "c".repeat(64), migrationManifestSha256: "d".repeat(64),
    pagesBundleSha256: "e".repeat(64), counts: { runtime: 4, public: 1, migration: 48, test: 2 },
    files: [{ path: "public/index.html", category: "public", bytes: 12,
      sha256: ASSETS[0].bodySha256 }, ...Array.from({ length: 48 }, (_, index) => ({
      path: `migrations/${String(index + 1).padStart(4, "0")}_${index === 46
        ? "operations_run_receipts" : index === 47 ? "analysis_reprocess_outbox" : "migration"}.sql`, category: "migration", bytes: 1,
      sha256: HASH }))] };
}

function staged() { return { root: REPO_ROOT, manifests: manifests() }; }

function readbacks({ pages = false } = {}) {
  return { migrationNames: Array.from({ length: 48 }, (_, index) =>
    `${String(index + 1).padStart(4, "0")}_${index === 46 ? "operations_run_receipts" :
      index === 47 ? "analysis_reprocess_outbox" : "migration"}.sql`),
  queueProvisioning: { schemaVersion: 1, contract: "deploy-queue-provision-v1",
    status: "completed", targetCount: 2, createdCount: 0, reusedCount: 2,
    readBackCount: 2, preListCount: 4, postListCount: 4,
    preListSha256: HASH, postListSha256: HASH,
    preListRawPages: [{ page: 1, rawStdoutBytes: 100, rawStdoutSha256: HASH },
      { page: 2, rawStdoutBytes: 50, rawStdoutSha256: HASH }],
    postListRawPages: [{ page: 1, rawStdoutBytes: 100, rawStdoutSha256: HASH },
      { page: 2, rawStdoutBytes: 50, rawStdoutSha256: HASH }],
    items: [{ queueName: "prophecy-ledger-analysis", outcome: "reused", readBack: true },
    { queueName: "prophecy-ledger-analysis-dlq", outcome: "reused", readBack: true }] },
  health: { ok: true, scannerEnabled: false,
    bindings: { d1: true, artifacts: true, queue: true } },
  operations: { contract: "queue-operations-status-v1", healthy: true,
    queues: ["prophecy-ledger-ingestion", "prophecy-ledger-analysis",
      "prophecy-ledger-ingestion-dlq", "prophecy-ledger-analysis-dlq"]
      .map((queueName) => ({ queueName, backlogCount: 0, backlogBytes: 0 })) },
  scannerAdminPropagation: { contract: "scanner-admin-propagation-v1", status: "completed",
    attemptCount: 1, maxAttempts: 6, pollWindowMs: 50_000, elapsedMs: 0,
    attempts: [{ attempt: 1,
      health: { endpoint: "health", status: 200, bodyBytes: 20, bodySha256: HASH,
        valid: true, reasonCode: null },
      operations: { endpoint: "operations", status: 200, bodyBytes: 100,
        bodySha256: HASH, valid: true, reasonCode: null } }] },
  pagesPropagation: pagesReceipt(), reviewerSmoke: { contract: "stable-reviewer-smoke-v1",
    status: "completed", surface: "stable_alias", considered: 10, passed: 10, failed: 0,
    warningCount: 0, exitCode: 0, stdoutBytes: 100, stdoutSha256: HASH,
    stderrBytes: 0, stderrSha256: HASH },
  deploymentPublicRoutes: ["/", "/people/troy-black", "/api/people/troy-black",
    "/api/people/troy-black/sources"].map((path) => ({ path, status: 200, bodySha256: HASH })),
  publicRoutes: ["/", "/people/troy-black", "/api/people/troy-black",
    "/api/people/troy-black/sources"].map((path) => ({ path, status: 200, bodySha256: HASH })),
  pagesDeploymentId: ID_C, pagesDeploymentUrl: PAGES_URL, pagesChanged: pages,
  deploymentAssets: ASSET_READBACKS.map((asset) => ({ ...asset })),
  stableAliasAssets: ASSET_READBACKS.map((asset) => ({ ...asset })) };
}

const queue = (id, name) => ({ id, name, createdOn: "2026-08-03T12:00:00.000Z",
  modifiedOn: "2026-08-03T12:01:00.000Z", producers: 1, consumers: 1 });
const INGESTION_QUEUES = [queue(QID_A, "prophecy-ledger-ingestion"),
  queue(QID_C, "prophecy-ledger-ingestion-dlq")];
const ALL_QUEUES = [...INGESTION_QUEUES, queue(QID_B, "prophecy-ledger-analysis"),
  queue(QID_D, "prophecy-ledger-analysis-dlq")];
const CAPTURED_QUEUE_TABLE = `┌──────────────────────────────────┬───────────────────────────────┬──────────────────────────┬──────────────────────────┬───────────┬───────────┐
│ id                               │ name                          │ created_on               │ modified_on              │ producers │ consumers │
├──────────────────────────────────┼───────────────────────────────┼──────────────────────────┼──────────────────────────┼───────────┼───────────┤
│ 0123456789abcdef0123456789abcdef │ prophecy-ledger-ingestion     │ 2026-08-03T19:11:22.345Z │ 2026-08-03T21:20:01.234Z │ 1         │ 1         │
├──────────────────────────────────┼───────────────────────────────┼──────────────────────────┼──────────────────────────┼───────────┼───────────┤
│ fedcba9876543210fedcba9876543210 │ prophecy-ledger-ingestion-dlq │ 2026-08-03T19:11:23.456Z │ 2026-08-03T21:20:02.345Z │ 0         │ 0         │
├──────────────────────────────────┼───────────────────────────────┼──────────────────────────┼──────────────────────────┼───────────┼───────────┤
│ 11111111111111111111111111111111 │ prophecy-ledger-analysis      │ 2026-08-03T19:11:24.567Z │ 2026-08-03T21:20:03.456Z │ 1         │ 1         │
├──────────────────────────────────┼───────────────────────────────┼──────────────────────────┼──────────────────────────┼───────────┼───────────┤
│ dddddddddddddddddddddddddddddddd │ prophecy-ledger-analysis-dlq  │ 2026-08-03T19:11:25.678Z │ 2026-08-03T21:20:04.567Z │ 0         │ 0         │
└──────────────────────────────────┴───────────────────────────────┴──────────────────────────┴──────────────────────────┴───────────┴───────────┘`;
const CAPTURED_QUEUE_PAGE1 = `
 ⛅️ wrangler 4.104.0 (update available 4.118.0)
───────────────────────────────────────────────
${CAPTURED_QUEUE_TABLE}
`;
const CAPTURED_QUEUE_PAGE2 = `
 ⛅️ wrangler 4.104.0 (update available 4.118.0)
───────────────────────────────────────────────

`;

function queueTable(rows) {
  if (!rows.length) return "";
  const head = ["id", "name", "created_on", "modified_on", "producers", "consumers"];
  const body = rows.map((item) => [item.id, item.name, item.createdOn, item.modifiedOn,
    String(item.producers), String(item.consumers)]);
  const widths = head.map((value, index) => Math.max(value.length,
    ...body.map((cells) => cells[index].length)) + 2);
  const border = (left, joint, right) => left + widths.map((width) => "─".repeat(width)).join(joint) + right;
  const line = (cells) => "│" + cells.map((cell, index) => ` ${cell.padEnd(widths[index] - 2)} `).join("│") + "│";
  const data = body.flatMap((cells, index) => index === 0 ? [line(cells)]
    : [border("├", "┼", "┤"), line(cells)]);
  return [border("┌", "┬", "┐"), line(head), border("├", "┼", "┤"),
    ...data, border("└", "┴", "┘")].join("\n");
}

const framedQueueTable = (rows) => `
 ⛅️ wrangler 4.104.0 (update available 4.118.0)
───────────────────────────────────────────────
${queueTable(rows)}
`;

function queueExecutor({ pre, post, createFailure = null }) {
  const calls = []; let cycle = 0;
  return { calls, execute(args) {
    calls.push(args);
    if (args[1] === "queues" && args[2] === "list") {
      const page = Number(args.at(-1));
      if (page === 1) cycle += 1;
      const rows = cycle === 1 ? pre : post;
      return { exitCode: 0, stdout: page === 1 ? framedQueueTable(rows)
        : CAPTURED_QUEUE_PAGE2, stderr: "" };
    }
    if (args[1] === "queues" && args[2] === "create") {
      if (args[3] === createFailure) return { exitCode: 1, stdout: "",
        stderr: `could not create ${args[3]} token=fixture-secret` };
      return { exitCode: 0, stdout: "created", stderr: "" };
    }
    throw new Error(`unexpected:${args.join(" ")}`);
  } };
}

test("deploy runtime CLI is plan-only unless apply is explicit", () => {
  assert.deepEqual(parseDeployRuntimeArgs([]), { apply: false });
  assert.deepEqual(parseDeployRuntimeArgs(["--apply"]), { apply: true });
  assert.throws(() => parseDeployRuntimeArgs(["--deploy"]), /unknown_argument/);
  assert.throws(() => parseDeployRuntimeArgs(["--apply", "--apply"]), /duplicate_apply/);
});

test("npm gate accepts terminal TAP on stderr and requires a final counted import receipt", () => {
  const imports = "IMPORT_CHECK_EXIT " + JSON.stringify({ schemaVersion: 1,
    contract: "import-check-v1", status: "success", considered: 9, passed: 9,
    failed: 0, fatalCode: null, exitCode: 0 });
  const tap = "ℹ tests 314\nℹ pass 314\nℹ fail 0\nℹ duration_ms 1234.5\n";
  const receipt = parseNpmCheckReceipt({ exitCode: 0,
    stdout: `> npm run check:imports\n${imports}\n`, stderr: tap });
  assert.equal(receipt.tests, 314);
  assert.equal(receipt.importCount, 9);
  assert.throws(() => parseNpmCheckReceipt({ exitCode: 0,
    stdout: "> npm run check:imports\n", stderr: tap }), /import_receipt_missing/);
  assert.throws(() => parseNpmCheckReceipt({ exitCode: 0,
    stdout: `${imports}\n`, stderr: "ℹ tests 314\nℹ pass 314\nℹ fail 0\n" }),
  /test_summary_missing/);
});

test("import checker emits one terminal counted receipt after checking the real source set", () => {
  const result = spawnSync(process.execPath, ["scripts/import-check.mjs"],
    { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const markers = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("IMPORT_CHECK_EXIT "));
  assert.equal(markers.length, 1);
  const receipt = JSON.parse(markers[0].slice("IMPORT_CHECK_EXIT ".length));
  assert.equal(receipt.status, "success");
  assert.equal(receipt.passed, receipt.considered);
  assert.ok(receipt.considered > 0);
});

test("Worker apply reuses the exact hashed dry artifact and fails closed after mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "prophecy-worker-artifact-"));
  writeFileSync(join(directory, "index.js"), "export default {};\n");
  writeFileSync(join(directory, "index.js.map"), "{}\n");
  const artifact = workerArtifactReceipt(directory);
  const args = workerDeployArgs(artifact, artifact.bundleSha256);
  assert.deepEqual(args.slice(0, 5), ["wrangler", "deploy", artifact.entrypoint,
    "--no-bundle", "--config"]);
  assert.equal(validateWorkerArtifact(artifact, artifact.bundleSha256).bundleSha256,
    artifact.bundleSha256);
  writeFileSync(join(directory, "index.js"), "export default { changed: true };\n");
  assert.throws(() => validateWorkerArtifact(artifact, artifact.bundleSha256),
    /scanner_deploy_artifact_changed/);
});

test("source manifests are stable and include dirty or untracked runtime files without secret paths", () => {
  const first = buildDeploymentManifests(REPO_ROOT);
  const second = buildDeploymentManifests(REPO_ROOT);
  assert.equal(first.sourceFingerprintSha256, second.sourceFingerprintSha256);
  assert.equal(first.migrationManifestSha256, second.migrationManifestSha256);
  assert.ok(first.files.some((file) => file.path === "scripts/deploy-runtime.mjs"));
  assert.ok(first.files.some((file) => file.path === "migrations/0047_operations_run_receipts.sql"));
  assert.ok(first.files.some((file) => file.path === "migrations/0048_analysis_reprocess_outbox.sql"));
  assert.ok(first.files.every((file) => !/(?:node_modules|\.wrangler|outputs|\.dev\.vars)(?:\/|$)/.test(file.path)));
});

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "prophecy-deploy-source-"));
  for (const directory of ["public", "scripts", "migrations", "test"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "public/index.html"), "v1\n");
  writeFileSync(join(root, "scripts/runtime.mjs"), "export default 1;\n");
  writeFileSync(join(root, "migrations/0001_base.sql"), "SELECT 1;\n");
  writeFileSync(join(root, "test/runtime.test.mjs"), "export default 1;\n");
  return root;
}

test("snapshot rejects symlink escapes and remains stable when the live source changes", async () => {
  const escaped = sourceFixture();
  const outside = join(mkdtempSync(join(tmpdir(), "prophecy-secret-")), "outside.js");
  writeFileSync(outside, "private\n");
  symlinkSync(outside, join(escaped, "public/escape.js"));
  assert.throws(() => buildDeploymentManifests(escaped), /deployment_symlink_rejected/);

  const root = sourceFixture(); let stagedRoot;
  const terminal = await runDeployRuntime({ apply: false }, {
    root,
    stageSnapshot(source) {
      const result = stageDeploymentSnapshot(source);
      stagedRoot = result.root;
      return result;
    },
    preflight(snapshot) {
      assert.equal(snapshot, stagedRoot);
      writeFileSync(join(root, "public/index.html"), "v2\n");
      assert.equal(readFileSync(join(snapshot, "public/index.html"), "utf8"), "v1\n");
      return gate({ migrationCount: 1 });
    },
    nowIso: () => "2026-08-03T12:00:00Z",
    writeLocalReceipt: () => "/tmp/planned.json",
  });
  assert.equal(terminal.receipt.status, "planned");
});

test("deploy validator consumes the actual scanner handler health and queue schemas", async () => {
  const queue = { metrics: async () => ({ backlogCount: 0, backlogBytes: 0,
    oldestMessageTimestamp: null }) };
  const observations = new Map();
  const DB = { prepare(sql) { let values = [];
    return { bind(...bound) { values = bound; return this; },
      async run() {
        if (sql.includes("queue_observation_receipts")) observations.set(values[0], values);
        return { success: true };
      },
      async first() {
        if (sql === "SELECT 1 ok") return { ok: 1 };
        const stored = observations.get(values[0]);
        return stored ? { queue_name: stored[1], status: stored[2], backlog_count: stored[3],
          backlog_bytes: stored[4], oldest_message_at: stored[5], safe_reason_code: stored[6],
          observed_at: stored[7] } : null;
      } };
  } };
  const env = { DB, ARTIFACTS: {}, INGESTION_QUEUE: queue, ANALYSIS_QUEUE: queue,
    INGESTION_DLQ: queue, ANALYSIS_DLQ: queue, AI: {}, SCAN_ENABLED: "0",
    SCANNER_ADMIN_TOKEN: "fixture-token" };
  const request = (path) => new Request(`https://scanner.example${path}`,
    { headers: { authorization: "Bearer fixture-token" } });
  const health = await (await fetchHandler(request("/admin/health"), env)).json();
  const operations = await (await fetchHandler(request("/admin/operations-status"), env)).json();
  const actual = { ...readbacks(), health, operations };
  assert.equal(validatePostDeployReadbacks(actual,
    { pagesRequired: false, expectedAssets: ASSETS }), true);
  assert.equal(actual.health.bindings.queue, true);
  assert.equal(actual.operations.queues[0].queueName, "prophecy-ledger-ingestion");
});

function adminHttp(status, body) {
  return { ok: status >= 200 && status < 300, status,
    body: typeof body === "string" ? body : JSON.stringify(body) };
}

const ADMIN_HEALTH = { ok: true, scannerEnabled: false,
  bindings: { d1: true, artifacts: true, queue: true } };
const ADMIN_OPERATIONS = { contract: "queue-operations-status-v1", healthy: true,
  queues: ["prophecy-ledger-ingestion", "prophecy-ledger-analysis",
    "prophecy-ledger-ingestion-dlq", "prophecy-ledger-analysis-dlq"]
    .map((queueName) => ({ queueName, backlogCount: 0, backlogBytes: 0 })) };

test("scanner admin propagation poll accepts a bounded 404 then valid readback", async () => {
  const secret = "fixture-secret-0123456789abcdef0123456789abcdef";
  const responses = [adminHttp(404, secret), adminHttp(404, secret),
    adminHttp(200, { ...ADMIN_HEALTH, secret }),
    adminHttp(200, { ...ADMIN_OPERATIONS, secret,
      queueId: "0123456789abcdef0123456789abcdef" })];
  let call = 0; const sleeps = [];
  const result = await pollScannerAdminReadbacks({ token: secret,
    fetcher: async () => responses[call++], sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: () => 0, maxAttempts: 3, intervalMs: 1, pollWindowMs: 100, fetchTimeoutMs: 10,
    baseUrl: "https://scanner.example" });
  assert.equal(result.receipt.attemptCount, 2);
  assert.deepEqual(sleeps, [1]);
  assert.equal(result.receipt.attempts[0].health.reasonCode, "health_http_non_2xx");
  assert.equal(result.receipt.attempts[0].operations.reasonCode,
    "operations_http_non_2xx");
  assert.equal(result.health.ok, true);
  assert.equal(result.operations.contract, "queue-operations-status-v1");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /fixture-secret|0123456789abcdef0123456789abcdef/);
  assert.equal(validateScannerAdminPropagationReceipt(result.receipt), result.receipt);
});

test("scanner admin propagation retries a bounded fetch timeout before valid readback", async () => {
  const timeout = Object.assign(new Error("private network detail"), {
    name: "TimeoutError", code: "UND_ERR_CONNECT_TIMEOUT",
  });
  let call = 0; const sleeps = [];
  const result = await pollScannerAdminReadbacks({ token: "fixture-token",
    fetcher: async (url) => {
      call += 1;
      if (call <= 2) throw timeout;
      return adminHttp(200, url.endsWith("/admin/health") ? ADMIN_HEALTH : ADMIN_OPERATIONS);
    }, sleep: async (milliseconds) => sleeps.push(milliseconds), now: () => 0,
    maxAttempts: 3, intervalMs: 1, pollWindowMs: 100, fetchTimeoutMs: 10,
    baseUrl: "https://scanner.example" });
  assert.equal(result.receipt.attemptCount, 2);
  assert.deepEqual(sleeps, [1]);
  assert.deepEqual(result.receipt.attempts[0], { attempt: 1, fetchFailure: {
    errorCode: "UND_ERR_CONNECT_TIMEOUT", errorName: "TimeoutError",
  } });
  assert.equal(result.receipt.attempts[1].health.valid, true);
  assert.equal(result.receipt.attempts[1].operations.valid, true);
  assert.doesNotMatch(JSON.stringify(result), /private network detail/);
  assert.equal(validateScannerAdminPropagationReceipt(result.receipt), result.receipt);
});

test("persistent scanner admin fetch timeouts exhaust the bounded poll", async () => {
  let calls = 0; let clock = 0; const sleeps = [];
  await assert.rejects(() => pollScannerAdminReadbacks({ token: "fixture-token",
    fetcher: async () => {
      calls += 1;
      throw Object.assign(new Error("private network detail"), { name: "TimeoutError" });
    }, sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    now: () => clock, maxAttempts: 3, intervalMs: 2, pollWindowMs: 100,
    fetchTimeoutMs: 10, baseUrl: "https://scanner.example" }), (error) => {
    assert.equal(error.message, "scanner_admin_propagation_timeout");
    assert.equal(error.safeDetail.attemptCount, 3);
    assert.equal(error.partialReceipts.scannerAdminPropagation.attempts.length, 3);
    assert.doesNotMatch(JSON.stringify(error.partialReceipts), /private network detail/);
    return true;
  });
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [2, 2]);
});

test("scanner admin poll retries malformed JSON and contract mismatch without leaking bodies", async () => {
  const responses = [adminHttp(200, "{malformed fixture-secret"),
    adminHttp(200, { contract: "wrong-contract", raw: "fixture-secret" }),
    adminHttp(200, ADMIN_HEALTH), adminHttp(200, ADMIN_OPERATIONS)];
  let call = 0;
  const result = await pollScannerAdminReadbacks({ token: "fixture-token",
    fetcher: async () => responses[call++], sleep: async () => {}, now: () => 0,
    maxAttempts: 2, intervalMs: 0, pollWindowMs: 100, fetchTimeoutMs: 10 });
  assert.equal(result.receipt.attemptCount, 2);
  assert.equal(result.receipt.attempts[0].health.reasonCode, "health_json_invalid");
  assert.equal(result.receipt.attempts[0].operations.reasonCode,
    "operations_contract_invalid");
  assert.doesNotMatch(JSON.stringify(result.receipt), /malformed|wrong-contract|fixture-secret/);
});

test("scanner admin poll retries every downstream health and queue invariant", async (t) => {
  const firstQueue = ADMIN_OPERATIONS.queues[0];
  const cases = [
    ["unhealthy operations", ADMIN_HEALTH, { ...ADMIN_OPERATIONS, healthy: false },
      null, "operations_health_invalid"],
    ["missing queue", ADMIN_HEALTH,
      { ...ADMIN_OPERATIONS, queues: ADMIN_OPERATIONS.queues.slice(0, -1) },
      null, "operations_queue_receipt_invalid"],
    ["duplicate queue", ADMIN_HEALTH,
      { ...ADMIN_OPERATIONS, queues: [...ADMIN_OPERATIONS.queues, { ...firstQueue }] },
      null, "operations_queue_receipt_invalid"],
    ["negative queue count", ADMIN_HEALTH,
      { ...ADMIN_OPERATIONS, queues: [{ ...firstQueue, backlogCount: -1 },
        ...ADMIN_OPERATIONS.queues.slice(1)] }, null, "operations_queue_receipt_invalid"],
    ["noninteger queue bytes", ADMIN_HEALTH,
      { ...ADMIN_OPERATIONS, queues: [{ ...firstQueue, backlogBytes: 1.5 },
        ...ADMIN_OPERATIONS.queues.slice(1)] }, null, "operations_queue_receipt_invalid"],
    ["scanner remains enabled", { ...ADMIN_HEALTH, scannerEnabled: true }, ADMIN_OPERATIONS,
      "health_config_invalid", null],
    ["scanner binding missing", { ...ADMIN_HEALTH,
      bindings: { ...ADMIN_HEALTH.bindings, queue: false } }, ADMIN_OPERATIONS,
    "health_config_invalid", null],
  ];
  for (const [label, firstHealth, firstOperations, healthCode, operationsCode] of cases) {
    await t.test(label, async () => {
      const rawSecret = "fixture-secret-0123456789abcdef0123456789abcdef";
      const responses = [adminHttp(200, { ...firstHealth, rawSecret }),
        adminHttp(200, { ...firstOperations, rawSecret }),
        adminHttp(200, ADMIN_HEALTH), adminHttp(200, ADMIN_OPERATIONS)];
      let call = 0;
      const result = await pollScannerAdminReadbacks({ token: rawSecret,
        fetcher: async () => responses[call++], sleep: async () => {}, now: () => 0,
        maxAttempts: 2, intervalMs: 0, pollWindowMs: 100, fetchTimeoutMs: 10 });
      assert.equal(result.receipt.attemptCount, 2);
      assert.equal(result.receipt.attempts[0].health.reasonCode, healthCode);
      assert.equal(result.receipt.attempts[0].operations.reasonCode, operationsCode);
      assert.doesNotMatch(JSON.stringify(result),
        /fixture-secret|0123456789abcdef0123456789abcdef/);
    });
  }
});

test("persistent scanner admin propagation failure stops at the exact attempt bound", async () => {
  const raw = "fixture-secret-0123456789abcdef0123456789abcdef";
  let calls = 0; let clock = 0; const sleeps = [];
  await assert.rejects(async () => pollScannerAdminReadbacks({ token: "fixture-token",
    fetcher: async () => { calls += 1; return adminHttp(404, raw); },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
    now: () => clock, maxAttempts: 3, intervalMs: 2, pollWindowMs: 100,
    fetchTimeoutMs: 10 }), (error) => {
    assert.equal(error.message, "scanner_admin_propagation_timeout");
    assert.equal(error.safeDetail.attemptCount, 3);
    assert.equal(error.partialReceipts.scannerAdminPropagation.attempts.length, 3);
    const serialized = JSON.stringify({ detail: error.safeDetail,
      partial: error.partialReceipts });
    assert.doesNotMatch(serialized, /fixture-secret|0123456789abcdef0123456789abcdef/);
    return true;
  });
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [2, 2]);
});

test("persistent health and queue invariant mismatch exhausts with safe distinct reasons", async () => {
  const raw = "fixture-secret-0123456789abcdef0123456789abcdef";
  const badHealth = { ...ADMIN_HEALTH, scannerEnabled: true, raw };
  const badOperations = { ...ADMIN_OPERATIONS,
    queues: [...ADMIN_OPERATIONS.queues, { ...ADMIN_OPERATIONS.queues[0] }], raw };
  let calls = 0;
  await assert.rejects(async () => pollScannerAdminReadbacks({ token: raw,
    fetcher: async (url) => { calls += 1; return url.endsWith("/admin/health")
      ? adminHttp(200, badHealth) : adminHttp(200, badOperations); },
    sleep: async () => {}, now: () => 0, maxAttempts: 2, intervalMs: 0,
    pollWindowMs: 100, fetchTimeoutMs: 10 }), (error) => {
    assert.equal(error.message, "scanner_admin_propagation_timeout");
    assert.equal(error.safeDetail.finalAttempt.health.reasonCode, "health_config_invalid");
    assert.equal(error.safeDetail.finalAttempt.operations.reasonCode,
      "operations_queue_receipt_invalid");
    assert.equal(error.partialReceipts.scannerAdminPropagation.attemptCount, 2);
    assert.doesNotMatch(JSON.stringify(error.partialReceipts),
      /fixture-secret|0123456789abcdef0123456789abcdef/);
    return true;
  });
  assert.equal(calls, 4);
});

test("Wrangler JSONL requires exact structured Worker and Pages IDs", () => {
  const worker = parseWranglerOutput(`${JSON.stringify({ type: "wrangler-session", version: 1 })}\n${JSON.stringify({
    type: "deploy", version: 1, worker_name: "prophecy-ledger-scanner", version_id: ID_A })}\n`, "deploy");
  assert.equal(worker.version_id, ID_A);
  const pages = parseWranglerOutput(`${JSON.stringify({ type: "pages-deploy", version: 1,
    pages_project: "prophecy-ledger", deployment_id: ID_C, url: PAGES_URL })}\n`, "pages-deploy");
  assert.equal(pages.deployment_id, ID_C);
  assert.throws(() => parseWranglerOutput(`${JSON.stringify({ type: "deploy", version: 1,
    worker_name: "prophecy-ledger-scanner", version_id: null })}\n`, "deploy"), /version_id_missing/);
  assert.throws(() => parseWranglerOutput("Uploaded successfully\n", "deploy"), /output_json_invalid/);
  assert.equal(workerDeploymentId([{ id: ID_B, versions: [{ version_id: ID_A }] }], ID_A), ID_B);
  assert.throws(() => workerDeploymentId([], ID_A), /deployment_id_missing/);
  assert.deepEqual(pagesDeploymentRecord([{ Id: ID_C, Deployment: PAGES_URL }], ID_C),
    { deploymentId: ID_C, deploymentUrl: PAGES_URL });
});

test("captured Wrangler queue table accepts inter-row separators and 32-hex IDs", () => {
  const rows = parseWranglerQueueTable(CAPTURED_QUEUE_PAGE1);
  assert.deepEqual(rows.map(({ id, name, producers, consumers }) =>
    ({ id, name, producers, consumers })), [
    { id: QID_A, name: "prophecy-ledger-ingestion", producers: 1, consumers: 1 },
    { id: QID_C, name: "prophecy-ledger-ingestion-dlq", producers: 0, consumers: 0 },
    { id: QID_B, name: "prophecy-ledger-analysis", producers: 1, consumers: 1 },
    { id: QID_D, name: "prophecy-ledger-analysis-dlq", producers: 0, consumers: 0 },
  ]);
  assert.equal(parseWranglerQueueTable(CAPTURED_QUEUE_PAGE2).length, 0);
  const colored = CAPTURED_QUEUE_PAGE1.replace("wrangler 4.104.0",
    "\x1b[36mwrangler 4.104.0\x1b[0m");
  assert.equal(parseWranglerQueueTable(colored).length, 4);
  const noUpdateNotice = CAPTURED_QUEUE_PAGE1
    .replace(" (update available 4.118.0)", "")
    .replace("───────────────────────────────────────────────",
      "──────────────────────", 1);
  assert.equal(parseWranglerQueueTable(noUpdateNotice).length, 4);
});

test("persisted Wrangler captures retain exact bytes, hashes, and page contents", () => {
  const page1Path = join(REPO_ROOT,
    "outputs/deploy-runtime/2026-08-03T21-queue-prelist-page1.raw");
  const page2Path = join(REPO_ROOT,
    "outputs/deploy-runtime/2026-08-03T21-queue-prelist-page2.raw");
  if (!existsSync(page1Path) || !existsSync(page2Path)) {
    const stagedRows = parseWranglerQueueTable(CAPTURED_QUEUE_PAGE1);
    assert.equal(stagedRows.length, 4);
    assert.deepEqual(stagedRows.map((item) => item.name), [
      "prophecy-ledger-ingestion", "prophecy-ledger-ingestion-dlq",
      "prophecy-ledger-analysis", "prophecy-ledger-analysis-dlq",
    ]);
    assert.deepEqual(parseWranglerQueueTable(CAPTURED_QUEUE_PAGE2), []);
    return;
  }
  const page1 = readFileSync(page1Path);
  const page2 = readFileSync(page2Path);
  assert.equal(page1.length, 3_772);
  assert.equal(createHash("sha256").update(page1).digest("hex"),
    "b91ce2e35af5d90f3412e04fe8f5712bce69887e91c8e6881892d3a703b40275");
  assert.equal(page2.length, 196);
  assert.equal(createHash("sha256").update(page2).digest("hex"),
    "eec645dd374d3507a19bb73b1c19b7516b10d31b14b2a74df33d5239d51f438f");
  assert.deepEqual(parseWranglerQueueTable(page1.toString()).map((item) => item.name), [
    "prophecy-ledger-ingestion", "prophecy-ledger-ingestion-dlq",
    "sanecite-intake", "sanecite-saas-jobs",
  ]);
  assert.deepEqual(parseWranglerQueueTable(page2.toString()), []);
});

test("queue table requires exact cell padding and real UTC calendar dates", () => {
  const removedPadding = CAPTURED_QUEUE_PAGE1.replace("│ id ", "│id");
  assert.throws(() => parseWranglerQueueTable(removedPadding), /queue_list_receipt_invalid/);
  const impossible = CAPTURED_QUEUE_PAGE1.replace("2026-08-03T19:11:22.345Z",
    "2026-02-30T19:11:22.345Z");
  assert.throws(() => parseWranglerQueueTable(impossible), /queue_list_receipt_invalid/);
  const nonLeap = CAPTURED_QUEUE_PAGE1.replace("2026-08-03T19:11:22.345Z",
    "2025-02-29T19:11:22.345Z");
  assert.throws(() => parseWranglerQueueTable(nonLeap), /queue_list_receipt_invalid/);
  const leapDay = CAPTURED_QUEUE_PAGE1.replace("2026-08-03T19:11:22.345Z",
    "2024-02-29T19:11:22.345Z");
  const parsed = parseWranglerQueueTable(leapDay);
  assert.equal(parsed[0].createdOn, "2024-02-29T19:11:22.345Z");
  assert.equal(parsed[0].modifiedOn, "2026-08-03T21:20:01.234Z");
});

test("Wrangler queue preamble rejects missing, duplicate, extra, and trailing framing", () => {
  assert.throws(() => parseWranglerQueueTable(`${CAPTURED_QUEUE_TABLE}\n`),
    /queue_list_preamble_invalid/);
  const malformed = CAPTURED_QUEUE_PAGE1.replace("wrangler 4.104.0", "Wrangler 4.104.0");
  assert.throws(() => parseWranglerQueueTable(malformed), /queue_list_preamble_invalid/);
  const shortSeparator = CAPTURED_QUEUE_PAGE1.replace(
    "───────────────────────────────────────────────", "───────────────");
  assert.throws(() => parseWranglerQueueTable(shortSeparator), /queue_list_preamble_invalid/);
  const extra = CAPTURED_QUEUE_PAGE1.replace("───────────────────────────────────────────────\n┌",
    "───────────────────────────────────────────────\nextra\n┌");
  assert.throws(() => parseWranglerQueueTable(extra), /queue_list_preamble_invalid/);
  const duplicate = CAPTURED_QUEUE_PAGE1.replace("───────────────────────────────────────────────\n┌",
    "───────────────────────────────────────────────\n ⛅️ wrangler 4.104.0 (update available 4.118.0)\n───────────────────────────────────────────────\n┌");
  assert.throws(() => parseWranglerQueueTable(duplicate), /queue_list_preamble_invalid/);
  const multiple = CAPTURED_QUEUE_PAGE1.replace(`${CAPTURED_QUEUE_TABLE}\n`,
    `${CAPTURED_QUEUE_TABLE}\n${CAPTURED_QUEUE_TABLE}\n`);
  assert.throws(() => parseWranglerQueueTable(multiple), /queue_list_multiple_tables/);
  const trailing = CAPTURED_QUEUE_PAGE1.replace(`${CAPTURED_QUEUE_TABLE}\n`,
    `${CAPTURED_QUEUE_TABLE}\ntrailing\n`);
  assert.throws(() => parseWranglerQueueTable(trailing), /queue_list_trailing_text/);
  const inside = CAPTURED_QUEUE_PAGE1.replace("│ 0123456789abcdef",
    " ⛅️ wrangler 4.104.0\n│ 0123456789abcdef");
  assert.throws(() => parseWranglerQueueTable(inside), /queue_list_banner_inside_table/);
});

test("queue provisioning creates only missing queues and requires strict post-list IDs", () => {
  const fake = queueExecutor({ pre: INGESTION_QUEUES, post: ALL_QUEUES });
  assert.deepEqual(parseWranglerQueueTable(framedQueueTable(ALL_QUEUES)), ALL_QUEUES);
  const receipt = provisionDeploymentQueues(fake);
  assert.equal(receipt.createdCount, 2);
  assert.equal(receipt.reusedCount, 0);
  assert.equal(receipt.readBackCount, 2);
  assert.deepEqual(fake.calls.filter((args) => args[2] === "create").map((args) => args[3]),
    ["prophecy-ledger-analysis", "prophecy-ledger-analysis-dlq"]);
  assert.ok(receipt.items.every((item) => item.outcome === "created" && item.readBack));
  assert.deepEqual(receipt.preListRawPages.map((page) => page.page), [1, 2]);
  assert.ok(receipt.preListRawPages.every((page) => page.rawStdoutBytes > 0
    && /^[a-f0-9]{64}$/.test(page.rawStdoutSha256)));
  assert.equal("rawStdout" in receipt.preListRawPages[0], false);
  const serialized = JSON.stringify(receipt);
  for (const id of [QID_A, QID_B, QID_C, QID_D]) assert.doesNotMatch(serialized, new RegExp(id));
  assert.doesNotMatch(serialized, /[┌│└]|wrangler 4\.104\.0|"(?:rawStdout|stdout|stderr)"\s*:/);
  assert.deepEqual(receipt.items, [
    { queueName: "prophecy-ledger-analysis", outcome: "created", readBack: true },
    { queueName: "prophecy-ledger-analysis-dlq", outcome: "created", readBack: true },
  ]);
});

test("queue provisioning reuses existing queues without create calls", () => {
  const fake = queueExecutor({ pre: ALL_QUEUES, post: ALL_QUEUES });
  const receipt = provisionDeploymentQueues(fake);
  assert.equal(receipt.createdCount, 0);
  assert.equal(receipt.reusedCount, 2);
  assert.equal(fake.calls.filter((args) => args[2] === "create").length, 0);
});

test("empty stdout page terminates each strict queue-list pagination pass", () => {
  const fake = queueExecutor({ pre: ALL_QUEUES, post: ALL_QUEUES });
  provisionDeploymentQueues(fake);
  assert.deepEqual(fake.calls.filter((args) => args[2] === "list")
    .map((args) => Number(args.at(-1))), [1, 2, 1, 2]);
});

test("queue create failure is sanitized and blocks downstream deploy", async () => {
  const fake = queueExecutor({ pre: INGESTION_QUEUES, post: ALL_QUEUES,
    createFailure: "prophecy-ledger-analysis" });
  let downstreamDeploys = 0;
  const terminal = await runDeployRuntime({ apply: true }, {
    stageSnapshot: staged, buildManifests: manifests, preflight: () => gate(),
    nowIso: () => "2026-08-03T12:00:00Z",
    applyRemote: async () => {
      provisionDeploymentQueues(fake); downstreamDeploys += 1;
      throw new Error("downstream_should_not_run");
    },
    writeLocalReceipt: () => "/tmp/queue-failed.json",
  });
  assert.equal(downstreamDeploys, 0);
  assert.equal(terminal.receipt.fatalCode, "queue_create_failed");
  assert.deepEqual(terminal.receipt.failureDetail, {
    source: "queue_command_failure", exitCode: 1, signal: null,
    errorCode: null, errorName: null, stdoutBytes: 0,
    stdoutSha256: createHash("sha256").update("").digest("hex"),
    stderrBytes: Buffer.byteLength("could not create prophecy-ledger-analysis token=fixture-secret"),
    stderrSha256: createHash("sha256")
      .update("could not create prophecy-ledger-analysis token=fixture-secret").digest("hex"),
  });
  const serialized = JSON.stringify(terminal.receipt);
  assert.doesNotMatch(serialized, /fixture-secret|could not create|[┌│└]|"(?:rawStdout|stdout|stderr)"\s*:/);
  const failureEvidence = JSON.stringify({ failureDetail: terminal.receipt.failureDetail,
    partialReceipts: terminal.receipt.partialReceipts });
  for (const id of [QID_A, QID_B, QID_C, QID_D]) {
    assert.doesNotMatch(failureEvidence, new RegExp(id));
  }
  assert.equal(terminal.receipt.partialReceipts.queueProvisioning.status, "failed");
});

test("nonzero queue-list failure keeps only hashes and command metadata", async () => {
  let downstreamDeploys = 0;
  const terminal = await runDeployRuntime({ apply: true }, {
    stageSnapshot: staged, buildManifests: manifests, preflight: () => gate(),
    nowIso: () => "2026-08-03T12:00:00Z",
    applyRemote: async () => {
      provisionDeploymentQueues({ execute: () => ({ exitCode: 1,
        signal: "SIGTERM", error: { code: "EIO", name: "QueueListError" },
        stdout: CAPTURED_QUEUE_PAGE1, stderr: `${CAPTURED_QUEUE_TABLE}\nfixture-secret` }) });
      downstreamDeploys += 1;
    },
    writeLocalReceipt: () => "/tmp/queue-list-failed.json",
  });
  assert.equal(downstreamDeploys, 0);
  assert.equal(terminal.receipt.fatalCode, "queue_prelist_failed");
  assert.deepEqual(terminal.receipt.failureDetail, {
    source: "queue_command_failure", exitCode: 1, signal: "SIGTERM",
    errorCode: "EIO", errorName: "QueueListError",
    stdoutBytes: Buffer.byteLength(CAPTURED_QUEUE_PAGE1),
    stdoutSha256: createHash("sha256").update(CAPTURED_QUEUE_PAGE1).digest("hex"),
    stderrBytes: Buffer.byteLength(`${CAPTURED_QUEUE_TABLE}\nfixture-secret`),
    stderrSha256: createHash("sha256").update(`${CAPTURED_QUEUE_TABLE}\nfixture-secret`).digest("hex"),
  });
  const serialized = JSON.stringify(terminal.receipt);
  assert.doesNotMatch(serialized, /fixture-secret|[┌│└]|wrangler 4\.104\.0|"(?:rawStdout|stdout|stderr)"\s*:/);
  const failureEvidence = JSON.stringify({ failureDetail: terminal.receipt.failureDetail,
    partialReceipts: terminal.receipt.partialReceipts });
  for (const id of [QID_A, QID_B, QID_C, QID_D]) {
    assert.doesNotMatch(failureEvidence, new RegExp(id));
  }
  const evidence = terminal.receipt.partialReceipts.queueProvisioning.preListRawPages[0];
  assert.equal(evidence.rawStdoutBytes, Buffer.byteLength(CAPTURED_QUEUE_PAGE1));
  assert.equal(evidence.rawStdoutSha256,
    createHash("sha256").update(CAPTURED_QUEUE_PAGE1).digest("hex"));
});

test("incomplete or ambiguous queue post-list blocks before any downstream deploy", () => {
  const incomplete = queueExecutor({ pre: INGESTION_QUEUES,
    post: [...INGESTION_QUEUES, queue(QID_B, "prophecy-ledger-analysis")] });
  assert.throws(() => provisionDeploymentQueues(incomplete), /queue_postlist_incomplete/);
  assert.equal(incomplete.calls.some((args) => args[2] === "deploy"), false);
  const malformed = framedQueueTable(ALL_QUEUES).replace("│ id ", "│ queue_id ");
  assert.throws(() => parseWranglerQueueTable(malformed), /queue_list_receipt_invalid/);
});

test("malformed separator placement fails with safe parser phase and blocks deploy", async () => {
  const lines = CAPTURED_QUEUE_PAGE1.split("\n");
  lines.splice(lines.findIndex((line, index) => index > 6 && line.startsWith("├")), 1);
  const malformed = lines.join("\n");
  let downstreamDeploys = 0;
  const terminal = await runDeployRuntime({ apply: true }, {
    stageSnapshot: staged, buildManifests: manifests, preflight: () => gate(),
    nowIso: () => "2026-08-03T12:00:00Z",
    applyRemote: async () => {
      provisionDeploymentQueues({ execute: () =>
        ({ exitCode: 0, stdout: malformed, stderr: "token=fixture-secret" }) });
      downstreamDeploys += 1;
    },
    writeLocalReceipt: () => "/tmp/queue-parser-failed.json",
  });
  assert.equal(downstreamDeploys, 0);
  assert.equal(terminal.receipt.fatalCode, "queue_list_separator_invalid");
  assert.deepEqual(terminal.receipt.failureDetail, { source: "queue_table_parser",
    phase: "prelist", causeCode: "queue_list_separator_invalid" });
  assert.doesNotMatch(JSON.stringify(terminal.receipt), /fixture-secret/);
  const rawEvidence = terminal.receipt.partialReceipts.queueProvisioning.preListRawPages[0];
  assert.equal(rawEvidence.rawStdoutBytes, Buffer.byteLength(malformed));
  assert.equal(rawEvidence.rawStdoutSha256,
    createHash("sha256").update(Buffer.from(malformed)).digest("hex"));
  assert.equal("rawStdout" in rawEvidence, false);
  assert.throws(() => parseWranglerQueueTable(CAPTURED_QUEUE_PAGE1.replace(
    QID_A, QID_A.toUpperCase())), /queue_list_receipt_invalid/);
});

test("Wrangler machine failure is preferred and secrets are removed", () => {
  const detail = sanitizedCommandFailure({ exitCode: 1,
    stderr: "fallback token=fixture-secret" }, [
    JSON.stringify({ type: "wrangler-session", version: 1 }),
    JSON.stringify({ type: "command-failed", version: 1, code: 10092,
      message: "Queue prophecy-ledger-analysis missing; Bearer fixture-secret" }),
  ].join("\n"));
  assert.equal(detail.source, "wrangler_machine_jsonl");
  assert.match(detail.message, /Queue prophecy-ledger-analysis missing/);
  assert.doesNotMatch(detail.message, /fixture-secret/);
});

test("gate and post-deploy receipts fail closed on missing terminal evidence", () => {
  assert.equal(validateGateReceipt(gate()).terminal, true);
  assert.throws(() => validateGateReceipt(gate({ terminal: false })), /receipt_incomplete/);
  assert.equal(validatePostDeployReadbacks(readbacks(),
    { pagesRequired: false, expectedAssets: ASSETS }), true);
  const missingQueue = readbacks(); missingQueue.operations.queues.pop();
  assert.throws(() => validatePostDeployReadbacks(missingQueue,
    { pagesRequired: false, expectedAssets: ASSETS }),
    /queue_readback_incomplete/);
  const incompleteProvision = readbacks(); incompleteProvision.queueProvisioning.items.pop();
  assert.throws(() => validatePostDeployReadbacks(incompleteProvision,
    { pagesRequired: false, expectedAssets: ASSETS }), /queue_provision_receipt_incomplete/);
  const leakedQueueId = readbacks();
  leakedQueueId.queueProvisioning.items[0].queueId = QID_B;
  assert.throws(() => validatePostDeployReadbacks(leakedQueueId,
    { pagesRequired: false, expectedAssets: ASSETS }), /queue_provision_receipt_incomplete/);
  const missingRawEvidence = readbacks();
  missingRawEvidence.queueProvisioning.preListRawPages = [];
  assert.throws(() => validatePostDeployReadbacks(missingRawEvidence,
    { pagesRequired: false, expectedAssets: ASSETS }), /queue_provision_receipt_incomplete/);
  assert.throws(() => validateAppliedDeployment({ workerVersionId: null,
    workerDeploymentId: ID_B, pagesRequired: false, readbacks: readbacks() }, manifests()),
  /deployment_ids_incomplete/);
});

test("default plan mode writes a terminal local receipt and never invokes remote apply", async () => {
  let applyCalls = 0; const written = [];
  const terminal = await runDeployRuntime({ apply: false }, {
    stageSnapshot: staged, buildManifests: manifests, preflight: () => gate(),
    nowIso: () => "2026-08-03T12:00:00Z",
    applyRemote: async () => { applyCalls += 1; throw new Error("must_not_run"); },
    writeLocalReceipt: (receipt) => { written.push(receipt); return "/tmp/planned.json"; },
  });
  assert.equal(applyCalls, 0);
  assert.equal(terminal.receipt.status, "planned");
  assert.equal(terminal.receipt.workerVersionId, null);
  assert.equal(terminal.exit.exitCode, 0);
  assert.equal(written.length, 1);
});

test("missing gate marker blocks before remote apply", async () => {
  let applyCalls = 0;
  const terminal = await runDeployRuntime({ apply: true }, {
    stageSnapshot: staged, buildManifests: manifests,
    preflight: () => gate({ terminal: false }),
    nowIso: () => "2026-08-03T12:00:00Z",
    applyRemote: async () => { applyCalls += 1; },
    writeLocalReceipt: () => "/tmp/failed.json",
  });
  assert.equal(applyCalls, 0);
  assert.equal(terminal.receipt.status, "failed");
  assert.equal(terminal.receipt.fatalCode, "deploy_gate_receipt_incomplete");
  assert.equal(terminal.exit.exitCode, 1);
});

test("a simulated apply persists 0047 only after complete IDs and read-backs", async () => {
  const calls = []; const rb = readbacks({ pages: true });
  const remoteReceipt = {
    write(sql) { calls.push("receipt-write"); this.sql = sql; },
    read() { calls.push("receipt-read"); return [{ source_fingerprint_sha256: "c".repeat(64),
      migration_manifest_sha256: "d".repeat(64), test_receipt_sha256: HASH,
      scanner_bundle_sha256: "b".repeat(64), pages_bundle_sha256: "e".repeat(64),
      worker_version_id: ID_A, worker_deployment_id: ID_B,
      pages_deployment_id: ID_C,
      post_deploy_readback_sha256: this.postHash }]; },
  };
  const terminal = await runDeployRuntime({ apply: true }, {
    stageSnapshot: staged, buildManifests: manifests,
    preflight: () => { calls.push("gates"); return gate(); },
    nowIso: () => "2026-08-03T12:00:00Z",
    applyRemote: async () => { calls.push("apply"); return { workerVersionId: ID_A,
      workerDeploymentId: ID_B, pagesDeploymentId: ID_C, pagesRequired: true, readbacks: rb }; },
    remoteReceipt: { write(sql) { remoteReceipt.write(sql); }, read(sql) {
      remoteReceipt.postHash = terminalHash(rb); return remoteReceipt.read(sql); } },
    writeLocalReceipt: () => "/tmp/completed.json",
  });
  assert.equal(terminal.receipt.status, "completed");
  assert.deepEqual(calls, ["gates", "apply", "receipt-write", "receipt-read"]);
  assert.match(remoteReceipt.sql, /runtime_deployment_receipts/);
  assert.equal(terminal.exit.exitCode, 0);
});

function terminalHash(value) {
  const sort = (item) => Array.isArray(item) ? `[${item.map(sort).join(",")}]`
    : item && typeof item === "object" ? `{${Object.keys(item).sort()
      .map((key) => `${JSON.stringify(key)}:${sort(item[key])}`).join(",")}}` : JSON.stringify(item);
  return createHash("sha256").update(Buffer.from(sort(value))).digest("hex");
}
