import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { buildProfileReportModel, buildProfileReportPdf } from "../functions/lib/profile-report.js";
import { onRequestGet as reportGet } from "../functions/api/people/[slug]/report.js";
import { context, makeEnv } from "./helpers/d1.mjs";

function reportProfile(overrides = {}) {
  return {
    asOf: "2026-07-19",
    person: { slug: "troy-black", displayName: "Troy Black" },
    completeness: "Provisional pilot - selected records, not a complete catalogue",
    corpusCoverage: {
      postsFound: 1114,
      videosLinked: 730,
      transcriptsAvailable: 21,
      possibleClaimPosts: 84,
      claimsCheckedByPeople: 2,
      finalRatings: 0,
      scanStatus: "complete_with_errors",
      lastScanAt: "2026-07-19",
      statusMessage: "The official website scan finished.",
      sources: [{ name: "Facebook", status: "blocked", itemsFound: 0, explanation: "Public access did not expose a complete list." }],
    },
    sources: [{
      source_type: "archive", source_role: "retrospective_fulfillment",
      identity_status: "candidate", availability: "available",
      url: "https://troyblackvideos.com/prophecy-archive-all/",
      note: "Speaker-authored discovery source, not independent outcome evidence.",
    }],
    catalogueRecords: [{
      claim_id: "draft-record", title: "Neutral catalogue record",
      source_date: "2021-01-01", source_url: "https://example.test/source",
      statement_type: "testable_prediction", record_status: "provisional_not_adjudicated",
    }],
    researchRecords: [{
      id: "draft-record", title: "Neutral catalogue record",
      exactArchivedQuote: "Exact attributed words", sourceDate: "2021-01-01",
      originalSourceUrl: "https://example.test/original",
      quotationSourceUrl: "https://example.test/archive",
      statementType: "testable_prediction",
      headline: "Material evidence is available for review",
      evidenceStrength: "material_provisional",
      testFraming: "Freeze the measurable criterion.",
      currentEvidenceSummary: "Independent evidence supports a factual research summary.",
      priorPublicInformationSummary: "Contemporaneous reporting existed before the claim.",
      corpusWarning: "The archive is outcome-selected and incomplete.",
      missingGates: ["Verify original context.", "Obtain two matching human reviews."],
      researchStatus: "provisional_research", finalAdjudicationStatus: "not_adjudicated",
      asOf: "2026-07-19",
      supportingReferences: [{
        id: "source-1", role: "independent_outcome", title: "Independent source",
        url: "https://example.test/evidence", publishedAt: "2021-02-01",
        note: "Independent factual context.",
      }],
    }],
    claims: [],
    score: { significanceStatus: "insufficient_sample", strictAccuracy: null },
    ...overrides,
  };
}

test("public report endpoint returns a named PDF attachment from the public projection", async () => {
  const env = makeEnv();
  const response = await reportGet(context({
    env, url: "https://ledger.example/api/people/troy-black/report", params: { slug: "troy-black" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"),
    'attachment; filename="prophecy-ledger-troy-black-report.pdf"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getTitle(), "The Prophecy Ledger - Troy Black");
  assert.ok(pdf.getPageCount() >= 6);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 960, height: 540 });
});

test("report model exposes neutral metadata without draft verdict or reviewer fields", () => {
  const profile = reportProfile({
    proposed_outcome: "false",
    reviewer_notes: "private reviewer reasoning",
    claims: [{
      visibility: "draft", outcome_status: "false", publication_summary: "private draft verdict",
      title: "Draft", claim_id: "draft", source_url: "https://example.test/draft",
    }],
  });
  const model = buildProfileReportModel(profile);
  assert.equal(model.findings.length, 0);
  assert.equal(model.catalogue.length, 1);
  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized, /private draft verdict|private reviewer reasoning|proposed_outcome|reviewer_notes/);
});

test("report model makes working evidence useful without converting it to a verdict", () => {
  const model = buildProfileReportModel(reportProfile());
  assert.equal(model.research.length, 1);
  assert.equal(model.research[0].headline, "Material evidence is available for review");
  assert.equal(model.research[0].finalAdjudicationStatus, "not_adjudicated");
  assert.equal(model.research[0].supportingReferences[0].role, "independent_outcome");
  assert.equal(model.metrics.provisionalBriefs, 1);
  assert.equal(model.metrics.publishedFindings, 0);
});

test("report model keeps the six public coverage counts separate from scoring", () => {
  const model = buildProfileReportModel(reportProfile());
  assert.deepEqual(model.coverage, {
    postsFound: 1114,
    videosLinked: 730,
    transcriptsAvailable: 21,
    possibleClaimsFound: 84,
    claimsCheckedByPeople: 2,
    finalRatings: 0,
    scanStatus: "complete_with_errors",
    lastScanAt: "2026-07-19",
    statusMessage: "The official website scan finished.",
    sourceAccess: [{ name: "Facebook", message: "Public access did not expose a complete list." }],
  });
  assert.equal(model.metrics.strictAccuracy, null);
  assert.equal(model.metrics.scoreStatus, "insufficient_sample");
});

test("report findings include only resolved, published, summarized claims", () => {
  const base = {
    claim_id: "finding", title: "Finding", exact_quote: "Original words",
    source_url: "https://example.test/finding", source_date: "2020-01-01",
    statement_type: "testable_prediction", novelty_status: "not_assessed",
    publication_summary: "The publication gates passed.",
  };
  const model = buildProfileReportModel(reportProfile({
    claims: [
      { ...base, visibility: "published", outcome_status: "false" },
      { ...base, claim_id: "pending", visibility: "published", outcome_status: "pending" },
      { ...base, claim_id: "draft", visibility: "draft", outcome_status: "true" },
      { ...base, claim_id: "no-summary", visibility: "published", outcome_status: "true", publication_summary: null },
    ],
  }));
  assert.deepEqual(model.findings.map((finding) => finding.id), ["finding"]);
  assert.equal(model.findings[0].outcome, "false");
});

test("published report findings survive a later unavailable-source fact without private material", () => {
  const model = buildProfileReportModel(reportProfile({
    sources: [{ source_type: "youtube", source_role: "first_party", identity_status: "confirmed",
      availability: "unavailable", url: "https://example.test/original", note: "Original link unavailable." }],
    claims: [{ claim_id: "preserved", title: "Preserved finding", exact_quote: "Archived exact words",
      source_url: "https://example.test/original", source_date: "2020-01-01",
      statement_type: "testable_prediction", novelty_status: "not_assessed", visibility: "published",
      outcome_status: "false", publication_summary: "Two matching human reviews published this finding." }],
    transcript_body: "private transcript", reviewer_notes: "private rationale",
  }));
  assert.deepEqual(model.findings.map((finding) => finding.id), ["preserved"]);
  assert.equal(model.sources[0].availability, "Unavailable");
  assert.doesNotMatch(JSON.stringify(model), /private transcript|private rationale|transcript_body|reviewer_notes/);
});

test("report byte output is stable for the same public profile", async () => {
  const profile = reportProfile();
  const first = await buildProfileReportPdf(profile);
  const second = await buildProfileReportPdf(profile);
  assert.equal(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes)), 0);
  assert.equal(first.filename, "prophecy-ledger-troy-black-report.pdf");
  assert.equal(first.layout.publicationGates.startPage, first.layout.publicationGates.endPage,
    "publication gate heading and bullets must stay together");
  assert.equal(first.layout.coverage.startPage, first.layout.coverage.endPage,
    "the public source coverage summary must stay on one page");
  assert.equal(first.layout.footerMark, "The Prophecy Ledger | Public preview");
  assert.doesNotMatch(first.layout.footerMark, /\.org|https?:\/\//,
    "a local preview must not invent a public domain");
});

test("report endpoint returns 404 for an unknown profile", async () => {
  const env = makeEnv();
  const response = await reportGet(context({
    env, url: "https://ledger.example/api/people/unknown/report", params: { slug: "unknown" },
  }));
  assert.equal(response.status, 404);
});
