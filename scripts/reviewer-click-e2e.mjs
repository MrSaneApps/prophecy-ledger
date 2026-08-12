#!/usr/bin/env node
/**
 * Durable reviewer click E2E for Prophecy Ledger.
 *
 * Modes:
 *   local (default) — loopback REVIEW_DEMO_MODE + x-demo-reviewer-token via Playwright headers
 *   live            — reuse an already Access-authenticated Mini Brave tab (no new tabs, no OTP)
 *
 * Usage (on Mini):
 *   npm run e2e:reviewer
 *   npm run e2e:reviewer -- --mode live
 *   npm run e2e:reviewer -- --mode local --base http://127.0.0.1:8788
 *
 * Live mutations:
 *   Queue load/audit/lease requires ALLOW_LIVE_QUEUE=1.
 *   Feedback requires ALLOW_LIVE_FEEDBACK=1.
 *   Accept/Send-back requires ALLOW_LIVE_SUBMIT=1 (local defaults allow both writes).
 */
import { chromium } from "/opt/homebrew/lib/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}
const MODE = flag("mode", "local"); // local | live
const BASE = (flag("base") || process.env.REVIEWER_CLICK_BASE ||
  (MODE === "live" ? "https://prophecy-ledger.pages.dev" : "http://127.0.0.1:8788")).replace(/\/$/, "");
const OUT = resolve(flag("out") || `outputs/visual-audit-reviewer-click-${new Date().toISOString().slice(0, 10)}`);
const ALLOW_LIVE_SUBMIT = process.env.ALLOW_LIVE_SUBMIT === "1" || MODE === "local";
const ALLOW_LIVE_FEEDBACK = process.env.ALLOW_LIVE_FEEDBACK === "1" || MODE === "local";
const ALLOW_LIVE_QUEUE = process.env.ALLOW_LIVE_QUEUE === "1" || MODE === "local";
const DEMO_TOKEN = process.env.DEMO_REVIEWER_TOKEN || flag("token");
mkdirSync(OUT, { recursive: true });

const findings = [];
const note = (severity, where, detail) => {
  findings.push({ severity, where, detail, at: new Date().toISOString() });
  console.log(`${severity.toUpperCase().padEnd(5)} [${where}] ${detail}`);
};
const shot = async (page, name) => {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log("SHOT", path);
};

function loadDevVars() {
  const path = resolve(".dev.vars");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

async function assertLocalServer() {
  try {
    const res = await fetch(`${BASE}/review`, { redirect: "manual" });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function runLocal() {
  const vars = loadDevVars();
  const token = DEMO_TOKEN || vars.DEMO_REVIEWER_1_TOKEN || "demo-token-one-7f3a";
  if (!token) {
    note("fail", "config", "Missing demo token. Copy .dev.vars.example → .dev.vars or pass --token");
    return 2;
  }
  if (!(await assertLocalServer())) {
    note("fail", "server", `${BASE} not reachable. Start: npm run dev:review`);
    return 2;
  }

  let browser;
  try {
    browser = await chromium.launch({ executablePath: BRAVE, headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "x-demo-reviewer-token": token },
  });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/review`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    await shot(page, "01-queue");

    const principal = (await page.textContent("#reviewer-principal").catch(() => "")) || "";
    if (!principal || /sign in|loading|checking session/i.test(principal)) {
      note("fail", "auth", `Principal not ready: "${principal}"`);
      return 1;
    }
    note("ok", "auth", principal.slice(0, 120));

    // Feedback communicative path
    const panel = page.locator("#feedback-panel");
    if (await panel.count()) {
      await panel.evaluate((el) => { el.open = true; });
      await page.waitForTimeout(400);
      await page.fill('#feedback-form textarea[name="message"]',
        `Durable click E2E feedback ${new Date().toISOString()}`);
      await page.click('#feedback-form button[type="submit"]');
      await page.waitForTimeout(2500);
      const status = (await page.textContent("#feedback-status").catch(() => "")) || "";
      const receipt = (await page.textContent("#feedback-receipt").catch(() => "")) || "";
      if (/Saved\. Receipt|Receipt:/i.test(status + receipt)) {
        note("ok", "feedback", (status || receipt).slice(0, 160));
      } else {
        note("fail", "feedback", `No receipt. status=${status.slice(0, 160)}`);
      }
      await shot(page, "02-feedback");
    } else {
      note("warn", "feedback", "feedback-panel missing");
    }

    // Open claim work
    let claim = page.locator(
      '#review-queue [data-assignment-id][data-work-type="claim_adjudication"]',
    ).first();
    if (!(await claim.count())) {
      claim = page.locator("#review-queue [data-lease-work-item]").first();
    }
    if (!(await claim.count())) {
      note("fail", "queue", "No claim/lease row to open — seed local D1 / run migrations");
      await shot(page, "03-empty-queue");
      return 1;
    }
    await claim.click();
    await page.waitForTimeout(2500);
    await shot(page, "03-claim-open");

    const agree = page.locator('input[name="verdict"][value="agree"]');
    if (!(await agree.count())) {
      note("fail", "claim", "Accept/Send-back form missing after open");
      return 1;
    }
    note("ok", "claim", "Accept/Send-back controls visible");

    if (!ALLOW_LIVE_SUBMIT) {
      note("ok", "submit", "Skipped adjudication (ALLOW_LIVE_SUBMIT!=1)");
      return findings.some((f) => f.severity === "fail") ? 1 : 0;
    }

    const disagree = page.locator('input[name="verdict"][value="disagree"]');
    await disagree.check();
    await page.selectOption('select[name="disagreeOutcome"]', "undetermined");
    await page.fill('textarea[name="rationale"]',
      "Durable click E2E: the local fixture lacks the complete cited record required for acceptance.");
    await page.click('#review-form button[type="submit"]');
    await page.waitForTimeout(4000);
    await shot(page, "04-receipt");
    const body = (await page.textContent("body")) || "";
    const reviewId = (body.match(/review_[a-f0-9-]+/i) || [])[0];
    if (reviewId || /Sent back\. Review|Research lesson recorded/i.test(body)) {
      note("ok", "receipt", reviewId || "decision receipt visible");
    } else {
      note("fail", "receipt", "No review receipt after Send-back");
    }
    if (/Open next case/i.test(body)) note("ok", "ux", "Open next case present (no auto-wipe)");
    return findings.some((f) => f.severity === "fail") ? 1 : 0;
  } finally {
    await context.close();
    await browser.close();
    writeFileSync(`${OUT}/findings.json`, JSON.stringify({ mode: MODE, base: BASE, findings }, null, 2));
  }
}

/** Live mode: AppleScript against existing Mini Brave — reuse tabs only. */
async function runLive() {
  if (!ALLOW_LIVE_QUEUE) {
    note("fail", "authorization",
      "Live /review loads audit, reconciliation, and lease state. Set ALLOW_LIVE_QUEUE=1 to authorize that mutation.");
    writeFileSync(`${OUT}/findings.json`, JSON.stringify({ mode: MODE, findings }, null, 2));
    return 2;
  }
  const script = `
tell application "Brave Browser"
  if (count of windows) = 0 then return "NO_WINDOWS"
  set found to false
  set idx to 0
  repeat with t in tabs of front window
    set idx to idx + 1
    set u to URL of t as string
    if u starts with "${BASE}/review" then
      set active tab index of front window to idx
      set found to true
      exit repeat
    end if
  end repeat
  if found is false then
    -- Reuse front tab navigation; do NOT make a new tab
    set URL of active tab of front window to "${BASE}/review"
    delay 5
  else
    delay 2
  end if
  set t to active tab of front window
  set u to URL of t as string
  if u contains "cloudflareaccess.com" then return "NEED_ACCESS_LOGIN " & u
  set js to read POSIX file "/tmp/pl-reviewer-live-click.js" as «class utf8»
  execute t javascript js
  return "started"
end tell
`;
  writeFileSync("/tmp/pl-reviewer-live-click.js", `(() => {
  window.__PL_CLICK = null;
  window.__PL_CLICK_RUN = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findings = [];
  const note = (s, w, d) => findings.push({ severity: s, where: w, detail: d });
  const text = (sel) => ((document.querySelector(sel) || {}).textContent || "").trim();
  (async () => {
    try {
      if (/cloudflareaccess\\.com/.test(location.href)) {
        note("fail", "auth", "Access login required");
        window.__PL_CLICK = JSON.stringify({ findings, url: location.href });
        return;
      }
      await sleep(1500);
      const principal = text("#reviewer-principal");
      if (!principal || /sign in|loading|checking session/i.test(principal)) {
        note("fail", "auth", "Principal not ready: " + JSON.stringify(principal));
        window.__PL_CLICK = JSON.stringify({ findings, url: location.href });
        return;
      }
      note("ok", "auth", principal.slice(0, 120));
      note("ok", "queue", (text("#queue-status") || "").slice(0, 200));

      const panel = document.querySelector("#feedback-panel");
      if (panel) {
        panel.open = true;
        await sleep(500);
        const form = document.querySelector("#feedback-form");
        const ta = form && form.querySelector('textarea[name="message"]');
        if (!${ALLOW_LIVE_FEEDBACK ? "true" : "false"}) {
          note("ok", "feedback", "Panel visible; production write skipped (set ALLOW_LIVE_FEEDBACK=1 to mutate prod)");
        } else if (ta) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          setter.call(ta, "Live durable click E2E feedback " + new Date().toISOString());
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          if (form.requestSubmit) form.requestSubmit();
          await sleep(3500);
          const status = text("#feedback-status");
          const receipt = text("#feedback-receipt");
          if (/Saved\\. Receipt|Receipt:/i.test(status + receipt)) note("ok", "feedback", status.slice(0, 160) || receipt.slice(0, 160));
          else note("fail", "feedback", "status=" + status.slice(0, 160));
        } else note("fail", "feedback", "Feedback form missing textarea");
      } else note("fail", "feedback", "No feedback panel");

      const claim = document.querySelector('#review-queue [data-assignment-id][data-work-type="claim_adjudication"]')
        || document.querySelector("#review-queue [data-lease-work-item]");
      if (!claim) {
        note("fail", "claim", "No openable claim row");
      } else {
        claim.click();
        await sleep(3000);
        const hasAgree = !!document.querySelector('input[name="verdict"][value="agree"]');
        if (hasAgree) note("ok", "claim", "Accept/Send-back visible");
        else note("fail", "claim", "Opened work without Accept controls: " + text("#review-private").slice(0, 160));
        if (${ALLOW_LIVE_SUBMIT ? "true" : "false"} && hasAgree) {
          document.querySelector('input[name="verdict"][value="agree"]').checked = true;
          document.querySelector('input[name="verdict"][value="agree"]').dispatchEvent(new Event("change", { bubbles: true }));
          const ta = document.querySelector('#review-form textarea[name="rationale"]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
          setter.call(ta, "Live durable click E2E accept " + new Date().toISOString());
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          const form = document.querySelector("#review-form");
          if (form.requestSubmit) form.requestSubmit();
          await sleep(4500);
          const body = document.body.innerText || "";
          const id = (body.match(/review_[a-f0-9-]+/i) || [])[0];
          if (id) note("ok", "receipt", id);
          else note("fail", "receipt", "No review id after submit");
        } else {
          note("ok", "submit", "Adjudication skipped (set ALLOW_LIVE_SUBMIT=1 to mutate prod)");
        }
      }
      window.__PL_CLICK = JSON.stringify({ url: location.href, findings, snip: (document.body.innerText || "").slice(0, 500) }, null, 2);
    } catch (e) {
      window.__PL_CLICK = JSON.stringify({ error: String(e), findings });
    } finally {
      window.__PL_CLICK_RUN = false;
    }
  })();
  return "started";
})()`);

  writeFileSync("/tmp/pl-reviewer-live.applescript", script);
  const start = spawn("osascript", ["/tmp/pl-reviewer-live.applescript"], { encoding: "utf8" });
  let out = "";
  for await (const chunk of start.stdout) out += chunk;
  for await (const chunk of start.stderr) out += chunk;
  await new Promise((r) => start.on("close", r));
  console.log("osascript:", out.trim());
  if (/NEED_ACCESS_LOGIN/.test(out)) {
    note("fail", "auth", "Mini Brave needs Access login first. Open /review, complete OTP once, re-run.");
    writeFileSync(`${OUT}/findings.json`, JSON.stringify({ mode: MODE, findings }, null, 2));
    return 2;
  }
  if (/NO_WINDOWS/.test(out)) {
    note("fail", "brave", "Brave has no windows on Mini");
    return 2;
  }

  // Poll result
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = spawn("osascript", ["-e",
      'tell application "Brave Browser" to execute (active tab of front window) javascript "window.__PL_CLICK || (window.__PL_CLICK_RUN ? \\"pending\\" : \\"none\\")"'],
      { encoding: "utf8" });
    let res = "";
    for await (const chunk of poll.stdout) res += chunk;
    await new Promise((r) => poll.on("close", r));
    res = res.trim();
    if (res && res !== "pending" && res !== "none" && res !== "missing value") {
      writeFileSync(`${OUT}/findings.json`, res);
      console.log(res.slice(0, 2000));
      try {
        const d = JSON.parse(res);
        if (d.error) note("fail", "browser", d.error);
        for (const f of d.findings || []) note(f.severity, f.where, f.detail);
        if (d.error) return 1;
        return (d.findings || []).some((f) => f.severity === "fail") ? 1 : 0;
      } catch {
        note("fail", "parse", res.slice(0, 200));
        return 1;
      }
    }
    console.log("poll", i + 1, res);
  }
  note("fail", "timeout", "Live click did not finish");
  return 1;
}

const code = MODE === "live" ? await runLive() : await runLocal();
console.log(code === 0 ? "REVIEWER_CLICK_E2E_PASSED" : "REVIEWER_CLICK_E2E_FAILED");
process.exit(code);
