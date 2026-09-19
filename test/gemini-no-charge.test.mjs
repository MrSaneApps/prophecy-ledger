import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGeminiNoChargeReceipt } from "../scripts/gemini-no-charge.js";

test("missing no-charge receipt is a fail-closed billing risk", () => {
  const alert = evaluateGeminiNoChargeReceipt(null);
  assert.equal(alert.code, "gemini_no_charge_missing");
  assert.equal(alert.level, "error");
});

test("failed no-charge receipt names the billing risk", () => {
  const alert = evaluateGeminiNoChargeReceipt({
    contract: "gemini-no-charge-v1",
    ok: false,
    failures: ["gemini_project_relinked_to_paid_account"],
  });
  assert.equal(alert.code, "gemini_billing_risk");
  assert.match(alert.detail, /relinked/);
});

test("fresh healthy no-charge receipt is silent", () => {
  assert.equal(evaluateGeminiNoChargeReceipt({
    contract: "gemini-no-charge-v1",
    ok: true,
    failures: [],
  }, { now: 1_000, mtimeMs: 900 }), null);
});

test("stale no-charge receipt is a fail-closed billing risk", () => {
  const alert = evaluateGeminiNoChargeReceipt({
    contract: "gemini-no-charge-v1",
    ok: true,
    failures: [],
  }, { now: 40 * 60 * 60 * 1000, mtimeMs: 0 });
  assert.equal(alert.code, "gemini_no_charge_stale");
});
