import test from "node:test";
import assert from "node:assert/strict";
import {
  adversarialConsensusProposal, buildResearchWorkerTerminal, clampBaseline, formatReviewerFeedbackNotes, formatSendbackLessons, draftEligibility,
  extractPublishedDate, findPdfPage, locateExcerpt, orchestrateResearchWorker,
  outcomeSourceAcceptable, parseModelJson, priorSourceAcceptable,
  researchWorkerTerminalLines, sqlQuote, validateResearchWorkerTerminal,
} from "../scripts/research-lib.mjs";
import { callCloudflare } from "../scripts/research-providers.mjs";

test("Cloudflare adversarial inference is disabled before network access unless explicitly enabled", async () => {
  const prior = process.env.RESEARCH_CLOUDFLARE_ADVERSARIAL_ENABLED;
  delete process.env.RESEARCH_CLOUDFLARE_ADVERSARIAL_ENABLED;
  let networkCalls = 0;
  try {
    await assert.rejects(callCloudflare("test", { fetchImpl: async () => {
      networkCalls += 1;
      throw new Error("network must not be reached");
    } }), /cloudflare_adversarial_disabled_no_charge/);
    assert.equal(networkCalls, 0);
  } finally {
    if (prior === undefined) delete process.env.RESEARCH_CLOUDFLARE_ADVERSARIAL_ENABLED;
    else process.env.RESEARCH_CLOUDFLARE_ADVERSARIAL_ENABLED = prior;
  }
});

test("adversarial consensus requires a valid critic and resolving judge", () => {
  const primary = { outcomeStatus: "false", noveltyStatus: "widely_expected" };
  const critic = { outcomeStatus: "partial", noveltyStatus: "widely_expected",
    challenge: "Excerpt two narrows the timeframe and creates a material partial-outcome argument." };
  const judge = { consensusStatus: "resolved", outcomeStatus: "false",
    noveltyStatus: "widely_expected", baselineProbability: 0.9,
    reasoning: "Excerpt one fixes the deadline, while excerpt two shows the event occurred only afterward, resolving the critique." };
  const result = adversarialConsensusProposal({ primary, critic, judge });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.outcomeStatus, "false");
  assert.equal(adversarialConsensusProposal({ primary, critic,
    judge: { ...judge, consensusStatus: "unresolved" } }).reason,
  "adversarial_consensus_unresolved");
});

test("locateExcerpt returns the verbatim capture slice across whitespace differences", () => {
  const capture = "Intro.\n  Production   tumbled to\n4.86 million boepd in 2021, down from 5.06.\nOutro.";
  const hit = locateExcerpt(capture, "Production tumbled to 4.86 million boepd in 2021");
  assert.ok(hit);
  assert.equal(capture.slice(hit.start, hit.end), hit.excerpt);
  assert.match(hit.excerpt, /Production {3}tumbled to\n4\.86 million boepd in 2021/);
  assert.equal(locateExcerpt(capture, "words that are absent from this capture"), null);
  assert.equal(locateExcerpt(capture, "too short"), null);
});

test("findPdfPage reports the 1-indexed page containing the excerpt", () => {
  const pages = ["first page text", "the decline continues here", "third"];
  assert.equal(findPdfPage(pages, "decline   continues"), 2);
  assert.equal(findPdfPage(pages, "not present"), null);
});

test("extractPublishedDate reads machine assertions only", () => {
  assert.equal(extractPublishedDate(
    '<script type="application/ld+json">{"datePublished":"2021-12-29T15:10:00+00:00"}</script>'),
  "2021-12-29");
  assert.equal(extractPublishedDate(
    "<meta property=\"article:published_time\" content=\"2020-01-31T13:11:57+00:00\">"),
  "2020-01-31");
  assert.equal(extractPublishedDate("<p>Published January 5, 2020</p>"), null);
});

test("cutoff gates are strict and direction-aware", () => {
  assert.equal(priorSourceAcceptable("2020-09-09", "2020-09-10"), true);
  assert.equal(priorSourceAcceptable("2020-09-10", "2020-09-10"), false);
  assert.equal(priorSourceAcceptable(null, "2020-09-10"), false);
  assert.equal(outcomeSourceAcceptable("2021-12-29", "2020-09-10"), true);
  assert.equal(outcomeSourceAcceptable("2020-09-01", "2020-09-10"), false);
});

test("baseline clamps to the novelty floor", () => {
  assert.equal(clampBaseline("no_precursor_found", 0.02), 0.15);
  assert.equal(clampBaseline("widely_expected", 0.9), 0.9);
  assert.equal(clampBaseline("already_public", 2), 1);
  assert.equal(clampBaseline("not_assessed", 0.4), null);
});

test("draftEligibility fails closed", () => {
  const proposal = {
    outcomeStatus: "false", noveltyStatus: "no_precursor_found", baselineProbability: 0.2,
    reasoning: "Excerpt [2] shows production fell across the stated window, so the proposition is not supported.",
  };
  assert.equal(draftEligibility({ verifiedPrior: 1, verifiedOutcome: 1,
    deadline: "2021-12-31", today: "2026-07-21", proposal }).ok, true);
  assert.equal(draftEligibility({ verifiedPrior: 1, verifiedOutcome: 0,
    deadline: "2021-12-31", today: "2026-07-21", proposal }).reason,
  "resolved_needs_outcome_evidence");
  assert.equal(draftEligibility({ verifiedPrior: 0, verifiedOutcome: 1,
    deadline: "2021-12-31", today: "2026-07-21", proposal }).reason,
  "novelty_needs_prior_evidence");
  assert.equal(draftEligibility({ verifiedPrior: 1, verifiedOutcome: 1,
    deadline: "2030-12-31", today: "2026-07-21", proposal }).reason,
  "deadline_not_passed_for_resolved");
  assert.equal(draftEligibility({ verifiedPrior: 1, verifiedOutcome: 1,
    deadline: "2030-12-31", today: "2026-07-21",
    proposal: { ...proposal, outcomeStatus: "pending" } }).ok, true);
  assert.equal(draftEligibility({ verifiedPrior: 1, verifiedOutcome: 1,
    deadline: "2021-12-31", today: "2026-07-21",
    proposal: { ...proposal, reasoning: "too short" } }).reason,
  "proposal_reasoning_length");
});

test("parseModelJson tolerates fences and trailing prose", () => {
  assert.deepEqual(parseModelJson('```json\n[{"url":"https://a"}]\n```'), [{ url: "https://a" }]);
  assert.deepEqual(parseModelJson('Here you go: {"outcomeStatus":"false"} hope that helps'),
    { outcomeStatus: "false" });
  assert.equal(parseModelJson("no json at all"), null);
});

test("sqlQuote escapes and passes numbers through", () => {
  assert.equal(sqlQuote("it's"), "'it''s'");
  assert.equal(sqlQuote(42), "42");
  assert.equal(sqlQuote(null), "NULL");
});

test("formatSendbackLessons summarizes reviewer corrections", () => {
  const block = formatSendbackLessons([
    { rejected_outcome: "pending", disagreed_outcome: "true", lesson: "Excerpts already stated Charles became king." },
  ]);
  assert.match(block, /Draft said pending/);
  assert.match(block, /required true/);
  assert.match(block, /Charles became king/);
});

test("formatReviewerFeedbackNotes routes only claim-research categories without identity", () => {
  const block = formatReviewerFeedbackNotes([
    { category: "evidence_gap", message: "The cited result predates the deadline.", reviewer_id: "private" },
    { category: "ui_friction", message: "The button is hard to find." },
    { category: "ai_extraction_quality", message: "  The quote omits important   context.  " },
  ]);
  assert.match(block, /Evidence gap: The cited result predates the deadline/);
  assert.match(block, /AI candidate quality: The quote omits important context/);
  assert.doesNotMatch(block, /button|private|reviewer/i);
});

test("dry-run emits one non-mutating final per discovered claim and successful terminals", async () => {
  const emitted = [];
  const terminal = await orchestrateResearchWorker({
    discoverClaims: () => [{ claim_id: "claim_a" }, { claim_id: "claim_b" }],
    processClaim: () => { throw new Error("must not run"); },
    dryRun: true,
    onClaimFinal: (receipt) => emitted.push(receipt),
  });
  assert.deepEqual(emitted.map((item) => item.status), ["dry_run", "dry_run"]);
  assert.equal(terminal.summary.status, "dry_run");
  assert.equal(terminal.summary.discoveredCount, 2);
  assert.equal(terminal.summary.attemptedCount, 0);
  assert.equal(terminal.exit.exitCode, 0);
  assert.equal(validateResearchWorkerTerminal(terminal), true);
});

test("zero eligible claims still produces a deterministic successful terminal pair", async () => {
  const terminal = await orchestrateResearchWorker({
    discoverClaims: () => [], processClaim: () => { throw new Error("must not run"); },
  });
  assert.equal(terminal.summary.status, "zero_eligible");
  assert.equal(terminal.summary.discoveredCount, 0);
  assert.equal(terminal.exit.exitCode, 0);
  const lines = researchWorkerTerminalLines(terminal);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^RESEARCH_WORKER_SUMMARY \{"schemaVersion":1,"status":"zero_eligible"/);
  assert.equal(lines[1],
    'RESEARCH_WORKER_EXIT {"schemaVersion":1,"status":"success","exitCode":0,"summaryStatus":"zero_eligible"}');
});

test("successful batches count drafted and fail-closed manual work as completed", async () => {
  const results = new Map([
    ["claim_draft", { draft: true, prior: 2, outcome: 1, reason: null }],
    ["claim_manual", { draft: false, prior: 0, outcome: 0, reason: "verified_evidence_missing" }],
  ]);
  const terminal = await orchestrateResearchWorker({
    discoverClaims: () => [...results.keys()].map((claim_id) => ({ claim_id })),
    processClaim: (claim) => results.get(claim.claim_id),
  });
  assert.equal(terminal.summary.status, "success");
  assert.equal(terminal.summary.completedCount, 2);
  assert.equal(terminal.summary.draftedCount, 1);
  assert.equal(terminal.summary.manualReviewCount, 1);
  assert.equal(terminal.summary.failedCount, 0);
  assert.equal(terminal.exit.exitCode, 0);
});

test("claim exceptions finalize every claim, continue the batch, and exit nonzero", async () => {
  const emitted = [];
  const terminal = await orchestrateResearchWorker({
    discoverClaims: () => [{ claim_id: "claim_ok" }, { claim_id: "claim_bad" }],
    processClaim: (claim) => {
      if (claim.claim_id === "claim_bad") {
        throw Object.assign(new Error("provider failed"), { code: "provider_failed" });
      }
      return { draft: true, prior: 1, outcome: 1 };
    },
    onClaimFinal: (receipt) => emitted.push(receipt),
  });
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[1], {
    claimId: "claim_bad", status: "failed", errorCode: "provider_failed",
  });
  assert.equal(terminal.summary.status, "partial_failure");
  assert.equal(terminal.summary.completedCount, 1);
  assert.equal(terminal.summary.failedCount, 1);
  assert.equal(terminal.exit.exitCode, 1);
});

test("discovery failures produce terminal receipts and a meaningful nonzero exit", async () => {
  const terminal = await orchestrateResearchWorker({
    discoverClaims: () => { throw Object.assign(new Error("D1 unavailable"), { code: "d1_unavailable" }); },
    processClaim: () => ({}),
  });
  assert.equal(terminal.summary.mode, "discovery_failed");
  assert.equal(terminal.summary.fatalCode, "d1_unavailable");
  assert.equal(terminal.exit.exitCode, 1);
  assert.equal(researchWorkerTerminalLines(terminal).length, 2);
});

test("missing claim selection is an explicit nonzero terminal branch", async () => {
  const terminal = await orchestrateResearchWorker({
    discoverClaims: () => [{ claim_id: "claim_waiting" }],
    processClaim: () => { throw new Error("must not run"); },
    selectionAllowed: false,
  });
  assert.equal(terminal.summary.status, "selection_required");
  assert.equal(terminal.claimFinals[0].status, "not_started");
  assert.equal(terminal.claimFinals[0].reason, "selection_required");
  assert.equal(terminal.exit.exitCode, 1);
});

test("terminal validation rejects missing and duplicate claim-final receipts", () => {
  const incomplete = buildResearchWorkerTerminal({
    mode: "run", discoveredCount: 2,
    claimFinals: [{ claimId: "claim_a", status: "completed", draft: true }],
  });
  assert.throws(() => validateResearchWorkerTerminal(incomplete), /research_claim_finals_incomplete/);
  const duplicate = buildResearchWorkerTerminal({
    mode: "run", discoveredCount: 2,
    claimFinals: [
      { claimId: "claim_a", status: "completed", draft: true },
      { claimId: "claim_a", status: "failed", errorCode: "failed" },
    ],
  });
  assert.throws(() => validateResearchWorkerTerminal(duplicate), /research_claim_finals_invalid/);
});
