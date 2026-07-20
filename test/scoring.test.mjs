import test from "node:test";
import assert from "node:assert/strict";
import { clusterClaims, poissonBinomialTail, scoreClaims } from "../functions/lib/scoring.js";

let sequence = 0;
const row = (cluster, outcome, baseline = 0.5, extra = {}) => ({
  claim_id: `${cluster}_${sequence += 1}`, cluster_id: cluster, outcome_status: outcome,
  statement_type: "testable_prediction", baseline_probability: baseline,
  novelty_status: "emerging_signals", criteria: "Frozen criterion", ...extra,
});
const frozenCorpus = (extra = {}) => ({
  discoveredVideos: 100, reviewedVideos: 90, corpusFrozenAt: "2026-01-01",
  rubricVersion: "v1", rubricFrozenAt: "2026-01-01", ...extra,
});

test("Poisson-binomial tail matches known fair-coin probabilities", () => {
  assert.equal(poissonBinomialTail([0.5, 0.5], 1), 0.75);
  assert.equal(poissonBinomialTail([0.5, 0.5], 2), 0.25);
  assert.equal(poissonBinomialTail([0.2, 0.3], 2), 0.06);
});

test("final statement type determines eligibility and correlated repeats share one denominator", () => {
  const clusters = clusterClaims([
    row("same", "true"), row("same", "true"),
    row("symbolic", "false", 0.5, { statement_type: "symbolic_statement", score_eligible: 1 }),
    row("fact", "true", 0.5, { statement_type: "present_or_past_factual_claim", score_eligible: 0 }),
  ]);
  assert.deepEqual(clusters.map((item) => item.clusterId).sort(), ["fact", "same"]);
});

test("cluster uses least-novel classification and highest conservative baseline", () => {
  const [cluster] = clusterClaims([
    row("same", "true", 0.35, { novelty_status: "emerging_signals" }),
    row("same", "true", 0.75, { novelty_status: "widely_expected" }),
  ]);
  assert.equal(cluster.noveltyStatus, "widely_expected");
  assert.equal(cluster.baselineProbability, 0.75);
});

test("partial is a strict miss while pending and not-falsifiable are excluded", () => {
  const score = scoreClaims([
    row("hit", "true", 0.2, { novelty_status: "no_precursor_found" }),
    row("partial", "partial", 0.4), row("pending", "pending", null),
    row("nf", "not_falsifiable", null),
  ], frozenCorpus({ discoveredVideos: 5, reviewedVideos: 4, corpusLabel: "fixture" }));
  assert.equal(score.resolvedClusters, 2);
  assert.equal(score.strictHits, 1);
  assert.equal(score.partial, 1);
  assert.equal(score.strictAccuracy, 0.5);
});

test("invalid corpus counts fail instead of producing coverage above one", () => {
  assert.throws(() => scoreClaims([], { discoveredVideos: 2, reviewedVideos: 3 }), /cannot exceed/);
  assert.throws(() => scoreClaims([], { discoveredVideos: 2.5, reviewedVideos: 2 }), /integers/);
});

test("significance requires sample, coverage, and frozen corpus and rubric", () => {
  const claims = Array.from({ length: 30 }, (_, index) => row(`c${index}`, "true", 0.15));
  assert.equal(scoreClaims(claims, frozenCorpus({ corpusFrozenAt: null })).statisticalResult, "insufficient sample");
  assert.equal(scoreClaims(claims, frozenCorpus({ rubricFrozenAt: null })).statisticalResult, "insufficient sample");
  assert.equal(scoreClaims(claims, frozenCorpus({ reviewedVideos: 89 })).statisticalResult, "insufficient sample");
  const passing = scoreClaims(claims, frozenCorpus());
  assert.equal(passing.statisticalResult, "statistically above the documented baseline");
  assert.ok(passing.pValue < 0.01);
});

test("expected hits and predictive advantage remain inspectable", () => {
  const score = scoreClaims([row("a", "true", 0.25), row("b", "false", 0.75)], frozenCorpus({ discoveredVideos: 2, reviewedVideos: 2 }));
  assert.equal(score.expectedHits, 1);
  assert.equal(score.predictiveAdvantage, 0);
});
