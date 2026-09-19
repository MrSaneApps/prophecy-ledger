import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pagesAssetHash, pollPagesPropagation, PROTECTED_REVIEW_PATHS, reviewerSmokeReceipt,
  runStableReviewerSmoke, validatePagesPropagationReceipt }
  from "../scripts/deploy-runtime-pages.mjs";
import { expectedPagesAssets } from "../scripts/deploy-runtime.mjs";

const PREVIEW = "https://preview.example";
const STABLE = "https://stable.example";
const ASSET_BODY = "exact deployed javascript";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ASSETS = [{ path: "/app.js", bodySha256: sha256(ASSET_BODY) }];
const CALLS_PER_ATTEMPT = 15;

function fakeFetcher(mode = "valid") {
  const calls = [];
  const fetcher = async (url) => {
    const parsed = new URL(url); const path = parsed.pathname;
    const attempt = Math.floor(calls.length / CALLS_PER_ATTEMPT) + 1;
    calls.push(url);
    if (mode === "persistent" || (mode === "404_then_valid" && attempt === 1)
        || (mode === "late_valid" && attempt <= 7)) {
      return { status: 404, body: "private-record-id fixture-secret" };
    }
    if (path === "/app.js") {
      const lag = mode === "asset_lag" && attempt === 1 && parsed.origin === STABLE;
      return { status: 200, body: lag ? "old asset" : ASSET_BODY };
    }
    if (PROTECTED_REVIEW_PATHS.includes(path)) {
      const lag = mode === "access_lag" && attempt === 1;
      return { status: lag ? 200 : 302, body: "access" };
    }
    const parityLag = mode === "parity_lag" && attempt === 1
      && parsed.origin === STABLE && path === "/api/people/troy-black";
    return { status: 200, body: parityLag ? "stale route" : `route:${path}` };
  };
  return { fetcher, calls };
}

async function poll(mode = "valid", overrides = {}) {
  const fake = fakeFetcher(mode); const sleeps = [];
  const result = await pollPagesPropagation({ previewBase: PREVIEW, stableBase: STABLE,
    expectedAssets: ASSETS, fetcher: fake.fetcher, now: () => 0,
    sleep: async (milliseconds) => sleeps.push(milliseconds), ...overrides });
  return { ...result, calls: fake.calls, sleeps };
}

test("preview receives public readbacks but never Access or reviewer smoke", async () => {
  const result = await poll();
  assert.equal(result.receipt.status, "completed");
  assert.equal(result.calls.length, CALLS_PER_ATTEMPT);
  assert.equal(result.calls.some((url) => url.startsWith(PREVIEW)
    && PROTECTED_REVIEW_PATHS.includes(new URL(url).pathname)), false);
  assert.deepEqual(result.calls.filter((url) => url.startsWith(STABLE)
    && PROTECTED_REVIEW_PATHS.includes(new URL(url).pathname)).map((url) => new URL(url).pathname),
  PROTECTED_REVIEW_PATHS);
});

test("index asset maps to canonical root and obsolete index path is never requested", async () => {
  const indexHash = sha256("index body");
  const assets = expectedPagesAssets({ files: [
    { path: "public/index.html", category: "public", sha256: indexHash },
    { path: "public/app.js", category: "public", sha256: ASSETS[0].bodySha256 },
  ] });
  assert.deepEqual(assets, [{ path: "/", bodySha256: indexHash }, ...ASSETS]);
  assert.equal(assets.some((asset) => asset.path === "/index.html"), false);
  assert.throws(() => expectedPagesAssets({ files: [
    { path: "public/index.html", category: "public", sha256: indexHash },
    { path: "public/index.html", category: "public", sha256: indexHash },
  ] }), /pages_expected_assets_duplicate_path/);

  const fake = fakeFetcher();
  await pollPagesPropagation({ previewBase: PREVIEW, stableBase: STABLE,
    expectedAssets: [{ path: "/", bodySha256: sha256("route:/") }], fetcher: fake.fetcher,
    now: () => 0, sleep: async () => {} });
  assert.equal(fake.calls.some((url) => new URL(url).pathname === "/index.html"), false);
});

test("poll retries a 404 preview race and completes on exact second attempt", async () => {
  const result = await poll("404_then_valid");
  assert.equal(result.receipt.attemptCount, 2);
  assert.equal(result.calls.length, CALLS_PER_ATTEMPT * 2);
  assert.deepEqual(result.sleeps, [10_000]);
});

test("default window accepts convergence after the former 50-second deadline", async () => {
  const fake = fakeFetcher("late_valid"); let clock = 0; const sleeps = [];
  const result = await pollPagesPropagation({ previewBase: PREVIEW, stableBase: STABLE,
    expectedAssets: ASSETS, fetcher: fake.fetcher, now: () => clock,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; } });
  assert.equal(result.receipt.attemptCount, 8);
  assert.equal(result.receipt.elapsedMs, 70_000);
  assert.ok(result.receipt.elapsedMs > 50_000);
  assert.ok(sleeps.every((milliseconds) => milliseconds < 60_000));
});

test("poll retries stable Access propagation lag", async () => {
  const result = await poll("access_lag");
  assert.equal(result.receipt.attemptCount, 2);
  assert.ok(result.receipt.attempts[0].stableAccess
    .every((row) => row.reasonCode === "stable_access_mismatch"));
});

test("poll retries exact asset hash and public-route parity lag", async (t) => {
  await t.test("asset hash", async () => {
    const result = await poll("asset_lag");
    assert.equal(result.receipt.attemptCount, 2);
    assert.equal(result.receipt.attempts[0].stableAssets[0].reasonCode,
      "stable_asset_hash_mismatch");
  });
  await t.test("route parity", async () => {
    const result = await poll("parity_lag");
    assert.equal(result.receipt.attemptCount, 2);
    assert.equal(result.receipt.attempts[0].stableRoutes[2].reasonCode,
      "public_route_parity_mismatch");
  });
});

test("persistent propagation failure stops at the exact bound without leaking bodies", async () => {
  const fake = fakeFetcher("persistent"); const sleeps = [];
  await assert.rejects(() => pollPagesPropagation({ previewBase: PREVIEW, stableBase: STABLE,
    expectedAssets: ASSETS, fetcher: fake.fetcher, now: () => 0, maxAttempts: 3,
    sleep: async (milliseconds) => sleeps.push(milliseconds) }), (error) => {
    assert.equal(error.message, "pages_propagation_timeout");
    assert.equal(error.safeDetail.attemptCount, 3);
    assert.equal(error.partialReceipts.pagesPropagation.attemptCount, 3);
    assert.doesNotMatch(JSON.stringify({ detail: error.safeDetail,
      partial: error.partialReceipts }), /fixture-secret|private-record-id/);
    return true;
  });
  assert.equal(fake.calls.length, CALLS_PER_ATTEMPT * 3);
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

test("deadline exhaustion stops before another fetch and preserves safe exact counts", async () => {
  const fake = fakeFetcher("persistent"); let clock = 0; const sleeps = [];
  await assert.rejects(() => pollPagesPropagation({ previewBase: PREVIEW, stableBase: STABLE,
    expectedAssets: ASSETS, fetcher: fake.fetcher, now: () => clock,
    pollWindowMs: 25_000, sleep: async (milliseconds) => {
      sleeps.push(milliseconds); clock += milliseconds;
    } }), (error) => {
    assert.equal(error.message, "pages_propagation_timeout");
    assert.equal(error.safeDetail.attemptCount, 3);
    assert.equal(error.partialReceipts.pagesPropagation.elapsedMs, 25_000);
    assert.doesNotMatch(JSON.stringify(error.partialReceipts),
      /fixture-secret|private-record-id/);
    return true;
  });
  assert.equal(fake.calls.length, CALLS_PER_ATTEMPT * 3);
  assert.deepEqual(sleeps, [10_000, 10_000, 5_000]);
});

test("receipt validator rejects reason-free forged hash and parity evidence", async () => {
  const result = await poll();
  const forged = structuredClone(result.receipt);
  forged.attempts[0].stableAssets[0].bodySha256 = "0".repeat(64);
  assert.throws(() => validatePagesPropagationReceipt(forged, { expectedAssets: ASSETS }),
    /pages_propagation_receipt_invalid/);
});

test("reviewer failure receipt contains output hashes and counts only", () => {
  assert.throws(() => reviewerSmokeReceipt({ exitCode: 1,
    stdout: "record-id-123 fixture-secret", stderr: "Bearer fixture-token" }), (error) => {
    const serialized = JSON.stringify({ detail: error.safeDetail, partial: error.partialReceipts });
    assert.match(serialized, /stdoutSha256|stderrSha256|stdoutBytes|stderrBytes/);
    assert.doesNotMatch(serialized, /record-id-123|fixture-secret|fixture-token|Bearer/);
    return true;
  });
});

test("canonical reviewer smoke runs exactly once against stable alias", () => {
  const calls = [];
  const summary = { schemaVersion: 1, contract: "reviewer-smoke-v1", status: "success",
    considered: 3, passed: 3, failed: 0, warningCount: 0, fatalCode: null };
  const exit = { schemaVersion: 1, status: "success", exitCode: 0 };
  const receipt = runStableReviewerSmoke({ stableBase: STABLE, execute: (name, args) => {
    calls.push({ name, args });
    return { exitCode: 0, stderr: "", stdout: `REVIEWER SMOKE PASSED\n`
      + `REVIEWER_SMOKE_SUMMARY ${JSON.stringify(summary)}\n`
      + `REVIEWER_SMOKE_EXIT ${JSON.stringify(exit)}\n` };
  } });
  assert.deepEqual(calls, [{ name: "node",
    args: ["scripts/reviewer-smoke.mjs", "--base", STABLE] }]);
  assert.equal(receipt.status, "completed");
  assert.equal(JSON.stringify(calls).includes(PREVIEW), false);
});

test("png bytes are hashed as binary, not UTF-8 text", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1, 2]);
  const hashed = pagesAssetHash(png);
  assert.equal(hashed.bodyBytes, png.length);
  assert.equal(hashed.bodySha256, sha256(png));
  assert.notEqual(hashed.bodySha256, sha256(Buffer.from(String(png))));
});
