#!/usr/bin/env node
/**
 * Closed-book draft-synthesis bakeoff on frozen evidence packets.
 * Compares LIVE NVIDIA free models vs cheap OpenRouter vs Gemini.
 * Does NOT write to D1. Does NOT change reviewer UI.
 *
 *   source ~/.config/nv/env
 *   node scripts/research-provider-bakeoff.mjs
 *   node scripts/research-provider-bakeoff.mjs --claim claim_51cbcb17013caa85fd2f059e
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  BAKEOFF_DRAFT_MODELS, callGemini, callNvidia, callOpenRouter,
} from "./research-providers.mjs";
import { formatSendbackLessons, parseModelJson } from "./research-lib.mjs";

const ARGS = process.argv.slice(2);
const CLAIM_FILTER = ARGS.flatMap((arg, i) => arg === "--claim" ? [ARGS[i + 1]] : []);
const OUT_DIR = "outputs/research-bakeoff";
mkdirSync(OUT_DIR, { recursive: true });

function wranglerJson(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "prophecy-ledger", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out)[0].results || [];
}

function q(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const EXPECTED = {
  // Charles: excerpts already state he became king — pending is a hard fail.
  "claim_51cbcb17013caa85fd2f059e": {
    title: "Succession of Prince Charles",
    acceptableOutcomes: ["true"],
    forbidOutcomes: ["pending", "undetermined"],
    notes: "Obvious public succession; excerpts settle true.",
  },
  "southeast-asia-oil-2021": {
    title: "Southeast Asia oil boom in 2021",
    acceptableOutcomes: ["false"],
    forbidOutcomes: ["true"],
    notes: "Seeded false / no boom.",
  },
  "claim_e339f8e0e654570867b45d50": {
    title: "Southeast Asia Oil Boom in 2021 (promoted)",
    acceptableOutcomes: ["false"],
    forbidOutcomes: ["true"],
    notes: "Same family as oil boom.",
  },
  "claim_743b73bfe201575d3e1119ae": {
    title: "Ecuador Government Branch Shutdown",
    acceptableOutcomes: ["false", "pending", "undetermined"],
    forbidOutcomes: [],
    notes: "Draft currently false; accept false or cautious pending.",
  },
};

function loadClaims() {
  const ids = CLAIM_FILTER.length ? CLAIM_FILTER : Object.keys(EXPECTED);
  const rows = [];
  for (const claimId of ids) {
    const claim = wranglerJson(
      `SELECT claim_id, title, exact_quote, source_date, deadline, statement_type,
        atomic_proposition, criteria FROM claims WHERE claim_id=${q(claimId)}`,
    )[0];
    if (!claim) {
      console.log(`skip missing claim ${claimId}`);
      continue;
    }
    const evidence = wranglerJson(
      `SELECT evidence_id, evidence_role, source_role, title, published_at,
        substr(COALESCE(supporting_excerpt, note, ''), 1, 400) excerpt
       FROM evidence WHERE claim_id=${q(claimId)}
       ORDER BY CASE evidence_role
         WHEN 'contemporaneous_public_information' THEN 0
         WHEN 'independent_outcome' THEN 1
         ELSE 2 END, created_at`,
    );
    let lessons = [];
    try {
      lessons = wranglerJson(
        `SELECT rejected_outcome, disagreed_outcome, lesson, rationale
         FROM research_sendbacks WHERE claim_id=${q(claimId)}
         ORDER BY created_at DESC LIMIT 6`,
      );
    } catch {
      lessons = [];
    }
    rows.push({ claim, evidence, lessons, expected: EXPECTED[claimId] || null });
  }
  return rows;
}

function buildDraftPrompt(claim, evidence, lessons) {
  const today = new Date().toISOString().slice(0, 10);
  const usable = evidence.filter((e) =>
    ["contemporaneous_public_information", "independent_outcome", "original_statement"].includes(e.evidence_role)
    && String(e.excerpt || "").trim().length > 20);
  const evidenceBlock = usable.map((item, index) => {
    const lane = item.evidence_role === "contemporaneous_public_information" ? "prior"
      : item.evidence_role === "independent_outcome" ? "outcome" : "original";
    return `[${index + 1}] (${lane}, published ${item.published_at || "n/a"}) "${String(item.excerpt).replace(/\s+/g, " ").trim()}" — ${item.title || item.evidence_id}`;
  }).join("\n");
  const lessonBlock = formatSendbackLessons(lessons, { limit: 6 });
  return `You draft a PENDING decision for two blinded human reviewers on a claim ledger.
Judge only the frozen proposition against the verified excerpts below. Cite only these excerpts.
Read each excerpt literally. If an excerpt states the predicted event occurred, choose true;
if it states it failed, choose false; if only part held, choose partial. Do NOT choose pending
when the excerpts already settle the proposition. Pending/undetermined only when excerpts do not
settle it, or the deadline has not passed.
Never mention the speaker's character, faith, or motives.
${lessonBlock ? `Human reviewer corrections from prior send-backs — do not repeat these mistakes:\n${lessonBlock}\n` : ""}
Proposition: ${claim.atomic_proposition}
Criteria: ${claim.criteria}
Statement date: ${claim.source_date}. Deadline: ${claim.deadline || "none"}. Today: ${today}.
Verified excerpts:
${evidenceBlock}
Respond with STRICT JSON only:
{"outcomeStatus":"true|false|partial|pending|undetermined|not_falsifiable",
 "noveltyStatus":"already_public|widely_expected|strong_signals|emerging_signals|no_precursor_found|not_assessed",
 "baselineProbability":0.0,
 "reasoning":"one neutral paragraph citing the numbered excerpts"}`;
}

async function callProvider(entry, prompt) {
  if (entry.provider === "nvidia") return callNvidia(prompt, { model: entry.model });
  if (entry.provider === "openrouter") return callOpenRouter(prompt, { model: entry.model, search: false });
  if (entry.provider === "gemini") return callGemini(prompt, { model: entry.model, search: false });
  throw new Error(`unknown provider ${entry.provider}`);
}

function scoreResult(expected, proposal) {
  const outcome = proposal?.outcomeStatus || null;
  const notes = [];
  let score = 0;
  if (!proposal) return { score: 0, notes: ["parse_failed"] };
  if (expected?.forbidOutcomes?.includes(outcome)) {
    notes.push(`forbidden_outcome:${outcome}`);
    score -= 3;
  }
  if (expected?.acceptableOutcomes?.length) {
    if (expected.acceptableOutcomes.includes(outcome)) {
      notes.push("acceptable_outcome");
      score += 3;
    } else {
      notes.push(`unexpected_outcome:${outcome}`);
      score -= 1;
    }
  } else if (outcome) {
    score += 1;
    notes.push("outcome_present");
  }
  const reasoning = String(proposal.reasoning || "");
  if (reasoning.length >= 40) score += 1;
  if (/\[[0-9]+\]/.test(reasoning)) {
    score += 1;
    notes.push("cites_excerpt_numbers");
  }
  if (outcome === "pending" && expected?.forbidOutcomes?.includes("pending")) {
    notes.push("pending_despite_settled_excerpts");
  }
  return { score, notes, outcome };
}

async function main() {
  const claims = loadClaims();
  console.log(`bakeoff claims: ${claims.length}; models: ${BAKEOFF_DRAFT_MODELS.length}`);
  const report = {
    startedAt: new Date().toISOString(),
    models: BAKEOFF_DRAFT_MODELS,
    results: [],
  };

  for (const row of claims) {
    const prompt = buildDraftPrompt(row.claim, row.evidence, row.lessons);
    console.log(`\n== ${row.claim.claim_id}: ${row.claim.title}`);
    for (const model of BAKEOFF_DRAFT_MODELS) {
      const entry = {
        claimId: row.claim.claim_id,
        label: model.label,
        provider: model.provider,
        model: model.model,
        tier: model.tier,
      };
      try {
        const raw = await callProvider(model, prompt);
        let proposal = null;
        try { proposal = parseModelJson(raw.text); } catch { proposal = null; }
        const scored = scoreResult(row.expected, proposal);
        Object.assign(entry, {
          ok: true,
          latencyMs: raw.latencyMs,
          costUsd: raw.costUsd,
          usage: raw.usage,
          proposal,
          score: scored.score,
          notes: scored.notes,
        });
        console.log(`  ${model.label}: ${scored.outcome || "?"} score=${scored.score} ${raw.latencyMs}ms ${scored.notes.join(",")}`);
      } catch (error) {
        entry.ok = false;
        entry.error = String(error).slice(0, 200);
        entry.score = -5;
        entry.notes = ["call_failed"];
        console.log(`  ${model.label}: FAIL ${entry.error}`);
      }
      report.results.push(entry);
      // Respect NVIDIA free ~40 RPM.
      await new Promise((r) => setTimeout(r, 1600));
    }
  }

  const byLabel = {};
  for (const row of report.results) {
    const bucket = byLabel[row.label] || (byLabel[row.label] = {
      label: row.label, provider: row.provider, model: row.model, tier: row.tier,
      score: 0, ok: 0, fail: 0, costUsd: 0, latencyMs: 0,
    });
    bucket.score += row.score || 0;
    bucket.latencyMs += row.latencyMs || 0;
    bucket.costUsd += Number(row.costUsd || 0);
    if (row.ok) bucket.ok += 1; else bucket.fail += 1;
  }
  const ranking = Object.values(byLabel).sort((a, b) => b.score - a.score || a.costUsd - b.costUsd || a.latencyMs - b.latencyMs);
  report.ranking = ranking;
  report.recommendation = ranking[0] || null;
  report.finishedAt = new Date().toISOString();

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const outPath = `${OUT_DIR}/${stamp}.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log("Ranking:");
  for (const row of ranking) {
    console.log(`  ${row.score.toString().padStart(3)}  ${row.label} (${row.tier}) ok=${row.ok} fail=${row.fail} cost=${row.costUsd}`);
  }
  if (report.recommendation) {
    console.log(`\nRECOMMENDATION: ${report.recommendation.label} → set RESEARCH_PROVIDER=${report.recommendation.provider} RESEARCH_NVIDIA_MODEL/OPENROUTER/GEMINI accordingly`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
