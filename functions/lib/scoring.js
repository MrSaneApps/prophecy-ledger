import { SCORE_ELIGIBLE_TYPES } from "./claims.js";

const RESOLVED = new Set(["true", "false", "partial"]);
const NOVELTY_ORDER = [
  "already_public", "widely_expected", "strong_signals", "emerging_signals", "no_precursor_found",
];

export function poissonBinomialTail(probabilities, hits) {
  if (!Number.isInteger(hits) || hits < 0) throw new TypeError("hits must be a non-negative integer");
  if (!Array.isArray(probabilities) || probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
    throw new TypeError("probabilities must be numbers from 0 to 1");
  }
  if (hits === 0) return 1;
  if (hits > probabilities.length) return 0;
  const distribution = new Array(probabilities.length + 1).fill(0);
  distribution[0] = 1;
  let used = 0;
  for (const probability of probabilities) {
    for (let count = used + 1; count >= 0; count -= 1) {
      const stay = (distribution[count] || 0) * (1 - probability);
      const rise = count > 0 ? (distribution[count - 1] || 0) * probability : 0;
      distribution[count] = stay + rise;
    }
    used += 1;
  }
  return distribution.slice(hits).reduce((sum, value) => sum + value, 0);
}

function leastNovel(statuses) {
  if (statuses.some((status) => status === "not_assessed" || !NOVELTY_ORDER.includes(status))) return "not_assessed";
  return statuses.reduce((least, status) =>
    NOVELTY_ORDER.indexOf(status) < NOVELTY_ORDER.indexOf(least) ? status : least);
}

export function clusterClaims(claims) {
  const groups = new Map();
  for (const claim of claims) {
    if (!SCORE_ELIGIBLE_TYPES.has(claim.statement_type)) continue;
    const key = claim.cluster_id || claim.claim_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  }
  return [...groups.entries()].map(([clusterId, members]) => {
    const outcomes = [...new Set(members.map((item) => item.outcome_status).filter((value) => RESOLVED.has(value)))];
    const unresolved = members.some((item) => !RESOLVED.has(item.outcome_status));
    const outcome = unresolved || outcomes.length !== 1 ? "undetermined" : outcomes[0];
    const noveltyStatus = leastNovel(members.map((item) => item.novelty_status));
    const baselines = members.map((item) => item.baseline_probability);
    const baselinesComplete = noveltyStatus !== "not_assessed" && baselines.every((value) => Number.isFinite(Number(value)));
    return {
      clusterId,
      members,
      outcome,
      strictHit: outcome === "true",
      noveltyStatus,
      baselineProbability: baselinesComplete ? Math.max(...baselines.map(Number)) : null,
      hasCriteria: members.every((item) => String(item.criteria || "").trim()),
    };
  });
}

function corpusNumbers(corpus) {
  const discovered = Number(corpus.discoveredVideos || 0);
  const reviewed = Number(corpus.reviewedVideos || 0);
  if (!Number.isInteger(discovered) || !Number.isInteger(reviewed) || discovered < 0 || reviewed < 0) {
    throw new RangeError("corpus counts must be non-negative integers");
  }
  if (reviewed > discovered) throw new RangeError("reviewed videos cannot exceed discovered videos");
  return { discovered, reviewed, coverage: discovered > 0 ? reviewed / discovered : 0 };
}

export function scoreClaims(claims, corpus = {}) {
  const clusters = clusterClaims(claims);
  const resolved = clusters.filter((cluster) => RESOLVED.has(cluster.outcome));
  const strictHits = resolved.filter((cluster) => cluster.strictHit).length;
  const partial = resolved.filter((cluster) => cluster.outcome === "partial").length;
  const probabilities = resolved.map((cluster) => cluster.baselineProbability);
  const baselinesComplete = probabilities.every((value) => Number.isFinite(value));
  const expectedHits = baselinesComplete ? probabilities.reduce((sum, value) => sum + value, 0) : null;
  const { discovered, reviewed, coverage } = corpusNumbers(corpus);
  const corpusFrozen = Boolean(corpus.corpusFrozenAt);
  const rubricFrozen = Boolean(corpus.rubricFrozenAt && corpus.rubricVersion);
  const pValue = baselinesComplete && resolved.length
    ? poissonBinomialTail(probabilities, strictHits) : null;
  const significant = resolved.length >= 30 && coverage >= 0.9 && corpusFrozen && rubricFrozen &&
    resolved.every((cluster) => cluster.hasCriteria) && baselinesComplete && pValue < 0.01;

  return {
    asOf: corpus.asOf || new Date().toISOString().slice(0, 10),
    catalogue: {
      discoveredVideos: discovered,
      reviewedVideos: reviewed,
      coverage,
      statementCount: claims.length,
      corpusLabel: corpus.corpusLabel || "Corpus not declared",
      corpusFrozenAt: corpus.corpusFrozenAt || null,
      rubricVersion: corpus.rubricVersion || null,
      rubricFrozenAt: corpus.rubricFrozenAt || null,
    },
    resolvedClusters: resolved.length,
    strictHits,
    partial,
    strictAccuracy: resolved.length ? strictHits / resolved.length : null,
    highInformationHits: resolved.filter((cluster) =>
      cluster.strictHit && cluster.noveltyStatus === "no_precursor_found" &&
      cluster.baselineProbability <= 0.25).length,
    expectedHits,
    predictiveAdvantage: expectedHits == null ? null : strictHits - expectedHits,
    predictiveAdvantageRate: expectedHits == null || !resolved.length
      ? null : (strictHits - expectedHits) / resolved.length,
    pValue,
    statisticalResult: significant
      ? "statistically above the documented baseline"
      : "insufficient sample",
    requirements: {
      independentResolvedClusters: { actual: resolved.length, required: 30 },
      corpusCoverage: { actual: coverage, required: 0.9 },
      corpusFrozen,
      rubricFrozen,
      baselinesComplete,
      criteriaComplete: resolved.every((cluster) => cluster.hasCriteria),
      pValueThreshold: 0.01,
      replicationRequiredForStrongerWording: true,
    },
  };
}
