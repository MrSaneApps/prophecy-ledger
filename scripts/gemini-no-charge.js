export const GEMINI_NO_CHARGE_CONTRACT = "gemini-no-charge-v1";
export const GEMINI_NO_CHARGE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function evaluateGeminiNoChargeReceipt(receipt, { now = Date.now(), mtimeMs = null } = {}) {
  if (!receipt || receipt.contract !== GEMINI_NO_CHARGE_CONTRACT) {
    return {
      level: "error",
      code: "gemini_no_charge_missing",
      detail: "No gemini-no-charge receipt. Run scripts/gemini-no-charge-check.sh on the Mini.",
    };
  }
  if (Number.isFinite(mtimeMs) && now - mtimeMs > GEMINI_NO_CHARGE_MAX_AGE_MS) {
    return {
      level: "error",
      code: "gemini_no_charge_stale",
      detail: "Gemini no-charge receipt is older than 36 hours.",
    };
  }
  if (receipt.ok !== true) {
    return {
      level: "error",
      code: "gemini_billing_risk",
      detail: `Gemini may be chargeable: ${(receipt.failures || []).join(",") || "unknown"}`,
    };
  }
  return null;
}
