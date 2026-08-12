#!/usr/bin/env node
/**
 * Post-deploy / pre-handoff reviewer smoke check.
 *
 * HARD RULE: after any Prophecy Ledger change that touches review UI, Functions,
 * migrations, or leases, this must pass before the session claims "done".
 * A green public homepage is not enough — a reviewer must be able to open work.
 *
 * Usage (repo root, env sourced):
 *   node scripts/reviewer-smoke.mjs
 *   node scripts/reviewer-smoke.mjs --base https://prophecy-ledger.pages.dev
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ARGS = process.argv.slice(2);
const baseIdx = ARGS.indexOf("--base");
const BASE = (baseIdx >= 0 ? ARGS[baseIdx + 1] : null)
  || process.env.REVIEWER_SMOKE_BASE
  || "https://prophecy-ledger.pages.dev";

const failures = [];
const warnings = [];
let passedChecks = 0;

function fail(msg) { failures.push(msg); console.error(`FAIL  ${msg}`); }
function warn(msg) { warnings.push(msg); console.warn(`WARN  ${msg}`); }
function ok(msg) { passedChecks += 1; console.log(`OK    ${msg}`); }

function emitTerminal(status, fatalCode = null) {
  const summary = { schemaVersion: 1, contract: "reviewer-smoke-v1", status,
    considered: passedChecks + failures.length, passed: passedChecks, failed: failures.length,
    warningCount: warnings.length, fatalCode };
  console.log(`REVIEWER_SMOKE_SUMMARY ${JSON.stringify(summary)}`);
  console.log(`REVIEWER_SMOKE_EXIT ${JSON.stringify({ schemaVersion: 1, status,
    exitCode: status === "success" ? 0 : 1 })}`);
}

function wranglerJson(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "prophecy-ledger", "--remote", "--json", "--command", sql],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(out)[0].results || [];
}

async function fetchStatus(path) {
  const response = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: { accept: "*/*" },
  });
  const body = await response.text();
  return { status: response.status, bytes: body.length, body };
}

function localRequiredFiles() {
  const required = [
    "public/review.js",
    "public/research.js",
    "public/archive-review.js",
    "public/styles.css",
    "functions/api/review/queue.js",
    "functions/api/review/[id].js",
    "functions/lib/review-workflow.js",
    "functions/lib/claims.js",
  ];
  for (const rel of required) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) fail(`missing required file ${rel}`);
    else ok(`local file ${rel}`);
  }
}

function localImportClosure() {
  const review = readFileSync(resolve(ROOT, "public/review.js"), "utf8");
  const imports = [...review.matchAll(/from\s+"\.\/([^"]+)"/g)].map((m) => m[1]);
  for (const name of imports) {
    if (!existsSync(resolve(ROOT, "public", name))) {
      fail(`review.js imports ./${name} but public/${name} is missing (CDN drift risk)`);
    } else {
      ok(`review.js import resolves ${name}`);
    }
  }
  for (const needle of [
    'fetch("/api/review/queue"',
    "verdict",
    "Send it back",
    "loadQueue",
  ]) {
    if (!review.includes(needle)) fail(`review.js missing expected workflow marker: ${needle}`);
  }
  ok("review.js workflow markers present");
}

function localLeaseGuards() {
  const workflow = readFileSync(resolve(ROOT, "functions/lib/review-workflow.js"), "utf8");
  const queue = readFileSync(resolve(ROOT, "functions/api/review/queue.js"), "utf8");
  const idRoute = readFileSync(resolve(ROOT, "functions/api/review/[id].js"), "utf8");

  if (workflow.includes("status IN ('submitted','released')")) {
    fail("candidateWorkItems still blacklists released assignments — reviewers cannot reopen work");
  } else {
    ok("released assignments are not permanently blacklisted");
  }

  if (workflow.includes("assigned_at=?1,\n        lease_expires_at=?2")
    || /SET status='leased',submitted_at=NULL,assigned_at=/.test(workflow)) {
    fail("tryLease renew still mutates assigned_at (blocked by identity trigger)");
  } else {
    ok("tryLease renew avoids mutating assigned_at");
  }

  if (queue.includes("if (!archiveAssignment) await leaseReviewWork")) {
    fail("queue still skips claim lease when archive lease succeeds");
  } else if (!queue.includes("await leaseReviewWork")) {
    fail("queue.js does not call leaseReviewWork");
  } else {
    ok("queue always attempts claim/candidate lease");
  }

  if (!idRoute.includes("input?.verdict")) {
    fail("review POST missing agree/disagree verdict derivation");
  } else {
    ok("agree/disagree verdict path present");
  }

  // HARD: APIs the reviewer UI depends on. Missing = deploy fails.
  for (const rel of [
    "functions/api/review/pending.js",
    "functions/api/review/feedback.js",
    "functions/api/review/scorecard.js",
    "functions/api/review/archive/queue.js",
    "functions/api/review/archive/[id].js",
  ]) {
    if (!existsSync(resolve(ROOT, rel))) fail(`missing required reviewer API ${rel}`);
    else ok(`local file ${rel}`);
  }

  if (!queue.includes("export async function onRequestPost")) {
    fail("queue.js missing POST lease switch — browsable claims cannot open");
  } else {
    ok("queue POST lease switch present");
  }

  const feedbackSrc = readFileSync(resolve(ROOT, "functions/api/review/feedback.js"), "utf8");
  if (!feedbackSrc.includes("export async function onRequestGet")) {
    fail("feedback.js missing GET — reviewers cannot see what they already sent");
  } else {
    ok("feedback GET history present");
  }
  if (!feedbackSrc.includes("export async function onRequestPost")) {
    fail("feedback.js missing POST");
  }

  const reviewSrc = readFileSync(resolve(ROOT, "public/review.js"), "utf8");
  for (const needle of [
    "feedbackId",
    "Your recent feedback",
    "decisionReceiptHtml",
    "sendbackRecorded",
    "Review id:",
  ]) {
    if (!reviewSrc.includes(needle)) fail(`review.js missing communicative UX marker: ${needle}`);
  }
  ok("review.js receipt + feedback history markers present");
}

async function liveAssets() {
  for (const path of ["/review.js", "/research.js", "/archive-review.js", "/styles.css"]) {
    const { status, bytes } = await fetchStatus(path);
    if (status !== 200 || bytes < 100) fail(`live ${path} -> ${status} (${bytes} bytes)`);
    else ok(`live ${path} -> ${status} (${bytes} bytes)`);
  }
  const review = await fetchStatus("/review.js");
  if (review.status === 200) {
    const body = review.body || "";
    if (!body.includes('from "./research.js"')) warn("live review.js no longer imports research.js");
    if (!body.includes("verdict")) fail("live review.js missing verdict flow");
    else ok("live review.js has verdict flow");
    if (!body.includes("Workspace did not load")) fail("live review.js missing loadQueue error recovery");
    if (!body.includes("fetchReviewJson")) fail("live review.js missing timed queue fetch");
  }
  // Access gate should challenge anonymous /review and /api/review/*
  for (const path of [
    "/review",
    "/api/review/queue",
    "/api/review/feedback",
    "/api/review/pending",
    "/api/review/archive/queue",
  ]) {
    const { status } = await fetchStatus(path);
    if (![301, 302, 401, 403].includes(status)) {
      fail(`expected Access challenge for ${path}, got ${status} (missing route often returns 404)`);
    } else {
      ok(`Access gate on ${path} -> ${status}`);
    }
  }

  const liveReview = await fetchStatus("/review.js");
  if (liveReview.status === 200) {
    for (const needle of ["Your recent feedback", "decisionReceiptHtml", "feedbackId"]) {
      if (!(liveReview.body || "").includes(needle)) {
        fail(`live review.js missing communicative marker: ${needle}`);
      }
    }
    ok("live review.js has feedback history + decision receipts");
  }
}

function remoteReviewerReadiness() {
  const readyClaims = wranglerJson(
    `SELECT COUNT(*) c FROM review_work_items
     WHERE status='ready' AND work_type='claim_adjudication'`,
  );
  const readyCount = Number(readyClaims[0]?.c || 0);
  if (readyCount < 1) fail("no ready claim_adjudication work items in D1");
  else ok(`${readyCount} ready claim work item(s)`);

  const drafts = wranglerJson(
    `SELECT COUNT(*) c FROM ai_draft_decisions`,
  );
  ok(`${Number(drafts[0]?.c || 0)} AI draft decision row(s)`);

  const liveLeases = wranglerJson(
    `SELECT COUNT(*) c FROM review_assignments
     WHERE status='leased' AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  ok(`${Number(liveLeases[0]?.c || 0)} currently live lease(s)`);

  // Regression: released rows must be renewable (count is informational).
  const released = wranglerJson(
    `SELECT COUNT(*) c FROM review_assignments WHERE status='released'`,
  );
  const releasedCount = Number(released[0]?.c || 0);
  if (releasedCount > 0) {
    ok(`${releasedCount} released assignment(s) present — renew path must work (code guard checked)`);
  }

  // Josh-known principal: if present, must have at least one openable leased claim OR renewable path.
  const josh = wranglerJson(
    `SELECT assignment.assignment_id,assignment.status,assignment.lease_expires_at,
       assignment.work_item_id,work.status AS work_status
     FROM review_assignments assignment
     JOIN review_work_items work ON work.work_item_id=assignment.work_item_id
     WHERE assignment.reviewer_id='reviewer_fef627c8da55314035feddefeb0117b822e15e9504071081289296a665512540'
     ORDER BY assignment.lease_expires_at DESC LIMIT 5`,
  );
  const joshLive = josh.filter((row) =>
    row.status === "leased" && String(row.lease_expires_at) > new Date().toISOString());
  const joshRenewable = josh.filter((row) => row.work_status === "ready" &&
    (row.status === "released" ||
      (row.status === "leased" && String(row.lease_expires_at) <= new Date().toISOString())));
  if (!joshLive.length && !joshRenewable.length) {
    fail("Joshua has no live leased assignment — reviewer cannot open work");
  } else if (joshLive.length) {
    ok(`Joshua live leases: ${joshLive.map((r) => r.work_item_id).join(", ")}`);
  } else {
    ok(`Joshua has ${joshRenewable.length} ready renewable assignment(s)`);
  }
}

async function main() {
  console.log(`Reviewer smoke check against ${BASE}`);
  localRequiredFiles();
  localImportClosure();
  localLeaseGuards();
  await liveAssets();
  remoteReviewerReadiness();

  console.log("");
  if (warnings.length) console.log(`${warnings.length} warning(s)`);
  if (failures.length) {
    console.error(`\nREVIEWER SMOKE FAILED (${failures.length})`);
    for (const item of failures) console.error(` - ${item}`);
    console.error("\nDo not tell the owner reviewers are unblocked until this is green.");
    emitTerminal("failed", "reviewer_checks_failed");
    process.exitCode = 1;
    return;
  }
  console.log("REVIEWER SMOKE PASSED");
  emitTerminal("success");
}

main().catch((error) => {
  fail("reviewer smoke crashed");
  console.error("REVIEWER SMOKE CRASHED", error?.name || "Error");
  emitTerminal("failed", "reviewer_smoke_crashed");
  process.exitCode = 1;
});
