// Pure helpers for the auto-research worker. No network, no filesystem —
// everything here is unit-tested and enforces the fail-closed doctrine:
// excerpts are exact substrings of captures, prior sources must carry a
// page-verified publish date strictly before the claim cutoff, and a draft
// decision exists only when verified evidence supports one.

export function normalizeWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// Locate `hint` in `captureText` ignoring whitespace differences, returning
// the EXACT original substring and its span, or null. The stored excerpt is
// always verbatim capture text, never the hint.
export function locateExcerpt(captureText, hint) {
  const text = String(captureText ?? "");
  const needle = normalizeWhitespace(hint).toLowerCase();
  if (needle.length < 12 || needle.length > 600) return null;
  const map = [];
  let normalized = "";
  let lastWasSpace = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (!lastWasSpace) { normalized += " "; map.push(index); lastWasSpace = true; }
    } else {
      normalized += char.toLowerCase();
      map.push(index);
      lastWasSpace = false;
    }
  }
  const at = normalized.indexOf(needle);
  if (at < 0) return null;
  const start = map[at];
  const endIndex = map[at + needle.length - 1];
  const excerpt = text.slice(start, endIndex + 1);
  return { excerpt, start, end: endIndex + 1 };
}

// Find the 1-indexed PDF page containing the excerpt (pages = pdftotext
// output split on form-feed).
export function findPdfPage(pages, excerpt) {
  const needle = normalizeWhitespace(excerpt).toLowerCase();
  for (let index = 0; index < pages.length; index += 1) {
    if (normalizeWhitespace(pages[index]).toLowerCase().includes(needle)) return index + 1;
  }
  return null;
}

// Extract a page-asserted publish date (ISO yyyy-mm-dd) from HTML metadata.
// Only machine-readable assertions count; body text never does.
export function extractPublishedDate(html) {
  const text = String(html ?? "");
  const candidates = [];
  for (const match of text.matchAll(/"datePublished"\s*:\s*"([^"]+)"/g)) candidates.push(match[1]);
  for (const match of text.matchAll(
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/gi)) {
    candidates.push(match[1]);
  }
  for (const match of text.matchAll(
    /<meta[^>]+name=["'](?:date|publish-date|publication_date)["'][^>]+content=["']([^"']+)["']/gi)) {
    candidates.push(match[1]);
  }
  for (const raw of candidates) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

export function priorSourceAcceptable(publishedAt, cutoffDate) {
  if (!publishedAt || !cutoffDate) return false;
  return publishedAt < cutoffDate; // ISO date strings compare lexicographically.
}

export function outcomeSourceAcceptable(publishedAt, sourceDate) {
  if (!publishedAt || !sourceDate) return false;
  return publishedAt > sourceDate;
}

export const BASELINE_FLOORS = Object.freeze({
  already_public: 0.95,
  widely_expected: 0.75,
  strong_signals: 0.55,
  emerging_signals: 0.35,
  no_precursor_found: 0.15,
});

export function clampBaseline(noveltyStatus, proposed) {
  if (noveltyStatus === "not_assessed") return null;
  const floor = BASELINE_FLOORS[noveltyStatus];
  if (floor == null) return null;
  const value = Number(proposed);
  if (!Number.isFinite(value)) return floor;
  return Math.min(1, Math.max(floor, value));
}

const OUTCOMES = new Set(["true", "false", "partial", "pending", "undetermined", "not_falsifiable"]);
const RESOLVED = new Set(["true", "false", "partial"]);
const NOVELTY = new Set([
  "already_public", "widely_expected", "strong_signals", "emerging_signals",
  "no_precursor_found", "not_assessed",
]);

// The fail-closed gate: a draft may exist only when the verified record can
// carry it. Anything else stays awaiting manual research, with the reason.
export function formatSendbackLessons(sendbacks = [], { limit = 12 } = {}) {
  const rows = (Array.isArray(sendbacks) ? sendbacks : []).slice(0, limit);
  if (!rows.length) return "";
  return rows.map((row, index) => {
    const rejected = row.rejected_outcome || row.rejectedOutcome || "?";
    const wanted = row.disagreed_outcome || row.disagreedOutcome || "?";
    const lesson = String(row.lesson || row.rationale || "").trim().slice(0, 280);
    return `${index + 1}. Draft said ${rejected}; reviewer required ${wanted}. Lesson: ${lesson}`;
  }).join("\n");
}

export function formatReviewerFeedbackNotes(feedback = [], { limit = 8 } = {}) {
  const allowed = new Set(["ai_extraction_quality", "evidence_gap"]);
  const rows = (Array.isArray(feedback) ? feedback : [])
    .filter((row) => allowed.has(row.category)).slice(0, limit);
  return rows.map((row, index) => {
    const label = row.category === "evidence_gap" ? "Evidence gap" : "AI candidate quality";
    const message = String(row.message || "").trim().replace(/\s+/g, " ").slice(0, 500);
    return `${index + 1}. ${label}: ${message}`;
  }).filter((line) => !line.endsWith(": ")).join("\n");
}

export function draftEligibility({ verifiedPrior, verifiedOutcome, deadline, today, proposal }) {
  if (!proposal || !OUTCOMES.has(proposal.outcomeStatus)) {
    return { ok: false, reason: "proposal_outcome_invalid" };
  }
  if (!NOVELTY.has(proposal.noveltyStatus)) {
    return { ok: false, reason: "proposal_novelty_invalid" };
  }
  const reasoning = normalizeWhitespace(proposal.reasoning);
  if (reasoning.length < 40 || reasoning.length > 3800) {
    return { ok: false, reason: "proposal_reasoning_length" };
  }
  if (RESOLVED.has(proposal.outcomeStatus)) {
    if (verifiedOutcome < 1) return { ok: false, reason: "resolved_needs_outcome_evidence" };
    if (deadline && today && today <= deadline) {
      return { ok: false, reason: "deadline_not_passed_for_resolved" };
    }
  }
  if (proposal.noveltyStatus !== "not_assessed" && verifiedPrior < 1) {
    return { ok: false, reason: "novelty_needs_prior_evidence" };
  }
  return { ok: true };
}

export function sqlQuote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Parse a Gemini JSON reply that may arrive fenced or with prose around it.
export function parseModelJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const slice = body.slice(start);
  for (let end = slice.length; end > 1; end -= 1) {
    try { return JSON.parse(slice.slice(0, end)); } catch { /* keep trimming */ }
  }
  return null;
}

function terminalCounts(claimFinals) {
  return {
    attemptedCount: claimFinals.filter((item) =>
      item.status === "completed" || item.status === "failed").length,
    completedCount: claimFinals.filter((item) => item.status === "completed").length,
    draftedCount: claimFinals.filter((item) => item.status === "completed" && item.draft).length,
    manualReviewCount: claimFinals.filter((item) => item.status === "completed" && !item.draft).length,
    failedCount: claimFinals.filter((item) => item.status === "failed").length,
    notStartedCount: claimFinals.filter((item) =>
      item.status === "dry_run" || item.status === "not_started").length,
  };
}

export function buildResearchWorkerTerminal({
  mode, discoveredCount, claimFinals = [], fatalCode = null,
}) {
  const counts = terminalCounts(claimFinals);
  const failed = Boolean(fatalCode) || counts.failedCount > 0 || mode === "selection_required";
  const status = fatalCode ? "failed"
    : mode === "dry_run" ? "dry_run"
      : mode === "zero_eligible" ? "zero_eligible"
        : mode === "selection_required" ? "selection_required"
          : counts.failedCount > 0 && counts.completedCount > 0 ? "partial_failure"
            : counts.failedCount > 0 ? "failed" : "success";
  const summary = {
    schemaVersion: 1,
    status,
    mode,
    discoveredCount,
    ...counts,
    fatalCode,
  };
  const exit = {
    schemaVersion: 1,
    status: failed ? "failure" : "success",
    exitCode: failed ? 1 : 0,
    summaryStatus: status,
  };
  return { claimFinals, summary, exit };
}

function errorCode(error, fallback) {
  const code = String(error?.code || "").trim();
  return /^[a-z0-9_-]{1,80}$/i.test(code) ? code : fallback;
}

function finalClaimId(claim, index) {
  return String(claim?.claim_id || claim?.claimId || `claim_${index + 1}`);
}

export async function orchestrateResearchWorker({
  discoverClaims, processClaim, dryRun = false, selectionAllowed = true,
  onDiscovered = () => {}, onClaimFinal = () => {},
}) {
  let claims;
  try {
    claims = await discoverClaims();
    if (!Array.isArray(claims)) throw Object.assign(new Error("claims_not_array"), {
      code: "claims_not_array",
    });
    await onDiscovered(claims);
  } catch (error) {
    return buildResearchWorkerTerminal({
      mode: "discovery_failed", discoveredCount: 0, claimFinals: [],
      fatalCode: errorCode(error, "discovery_failed"),
    });
  }

  const claimFinals = [];
  const recordFinal = async (receipt) => {
    claimFinals.push(receipt);
    await onClaimFinal(receipt);
  };
  if (dryRun) {
    for (const [index, claim] of claims.entries()) {
      await recordFinal({ claimId: finalClaimId(claim, index), status: "dry_run" });
    }
    return buildResearchWorkerTerminal({
      mode: "dry_run", discoveredCount: claims.length, claimFinals,
    });
  }
  if (!claims.length) {
    return buildResearchWorkerTerminal({
      mode: "zero_eligible", discoveredCount: 0, claimFinals,
    });
  }
  if (!selectionAllowed) {
    for (const [index, claim] of claims.entries()) {
      await recordFinal({
        claimId: finalClaimId(claim, index), status: "not_started",
        reason: "selection_required",
      });
    }
    return buildResearchWorkerTerminal({
      mode: "selection_required", discoveredCount: claims.length, claimFinals,
    });
  }

  for (const [index, claim] of claims.entries()) {
    const claimId = finalClaimId(claim, index);
    try {
      const result = await processClaim(claim);
      await recordFinal({
        claimId,
        status: "completed",
        draft: Boolean(result?.draft),
        prior: Number(result?.prior || 0),
        outcome: Number(result?.outcome || 0),
        reason: result?.reason || null,
      });
    } catch (error) {
      await recordFinal({
        claimId, status: "failed",
        errorCode: errorCode(error, "research_claim_failed"),
      });
    }
  }
  return buildResearchWorkerTerminal({
    mode: "run", discoveredCount: claims.length, claimFinals,
  });
}

export function validateResearchWorkerTerminal(terminal) {
  const { summary, exit, claimFinals } = terminal || {};
  if (!summary || !exit || !Array.isArray(claimFinals)) {
    throw new Error("research_terminal_shape_invalid");
  }
  if (summary.schemaVersion !== 1 || exit.schemaVersion !== 1) {
    throw new Error("research_terminal_version_invalid");
  }
  const ids = claimFinals.map((item) => item.claimId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error("research_claim_finals_invalid");
  }
  const terminalWithoutKnownClaims = ["zero_eligible", "discovery_failed"].includes(summary.mode);
  if (!terminalWithoutKnownClaims && claimFinals.length !== summary.discoveredCount) {
    throw new Error("research_claim_finals_incomplete");
  }
  const counts = terminalCounts(claimFinals);
  for (const [key, value] of Object.entries(counts)) {
    if (summary[key] !== value) throw new Error(`research_terminal_${key}_invalid`);
  }
  if (![0, 1].includes(exit.exitCode)
      || (exit.exitCode === 0) !== (exit.status === "success")) {
    throw new Error("research_exit_invalid");
  }
  return true;
}

export function researchWorkerTerminalLines(terminal) {
  validateResearchWorkerTerminal(terminal);
  return [
    `RESEARCH_WORKER_SUMMARY ${JSON.stringify(terminal.summary)}`,
    `RESEARCH_WORKER_EXIT ${JSON.stringify(terminal.exit)}`,
  ];
}
