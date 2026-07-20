import { PDFDocument, StandardFonts } from "pdf-lib";
import { COLORS, Composer, titleCase } from "./profile-report-layout.js";

const REPORTABLE_OUTCOMES = new Set(["true", "false", "partial"]);

function reportDate(value) {
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.valueOf()) ? new Date("2026-07-19T12:00:00.000Z") : date;
}

function reportFilename(slug) {
  const safe = String(slug || "profile").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `prophecy-ledger-${safe || "profile"}-report.pdf`;
}

function firstDefined(object, keys, fallback = 0) {
  for (const key of keys) if (object?.[key] !== undefined && object[key] !== null) return object[key];
  return fallback;
}

function reportCoverage(profile) {
  const coverage = profile?.corpusCoverage || {};
  const counts = coverage.counts || coverage;
  const sourceAccess = firstDefined(coverage,
    ["sources", "sourceAccess", "source_access", "accessLimits", "access_limits"], []);
  return {
    postsFound: firstDefined(counts, ["postsFound", "posts_found", "sourceItems", "source_items"], 0),
    videosLinked: firstDefined(counts, ["videosLinked", "videos_linked"], 0),
    transcriptsAvailable: firstDefined(counts, ["transcriptsAvailable", "transcripts_available"], 0),
    possibleClaimsFound: firstDefined(counts, ["possibleClaimPosts", "possible_claim_posts", "possibleClaimsFound", "possible_claims_found"], 0),
    claimsCheckedByPeople: firstDefined(counts, ["claimsCheckedByPeople", "claims_checked_by_people", "humanReviewed", "human_reviewed"], 0),
    finalRatings: firstDefined(counts, ["finalRatings", "final_ratings", "publishedRatings", "published_ratings"], 0),
    scanStatus: firstDefined(coverage, ["scanStatus", "scan_status", "status"], "not_started"),
    lastScanAt: firstDefined(coverage, ["lastScanAt", "last_scan_at"], ""),
    statusMessage: firstDefined(coverage, ["statusMessage", "status_message", "publicNote", "public_note"], ""),
    sourceAccess: (Array.isArray(sourceAccess) ? sourceAccess : []).map((row) => ({
      name: row.name || row.sourceName || row.source_name || row.platform || "Public source",
      message: row.explanation || row.publicMessage || row.public_message || row.note || row.status || "No details available.",
    })),
  };
}

export function buildProfileReportModel(profile) {
  const findings = (profile?.claims || [])
    .filter((claim) => claim.visibility === "published" &&
      REPORTABLE_OUTCOMES.has(claim.outcome_status) && claim.publication_summary)
    .map((claim) => ({
      id: claim.claim_id,
      title: claim.title,
      sourceDate: claim.source_date,
      statementType: claim.statement_type,
      outcome: claim.outcome_status,
      novelty: claim.novelty_status,
      exactQuote: claim.exact_quote,
      summary: claim.publication_summary,
      sourceUrl: claim.source_url,
    }));
  const catalogue = (profile?.catalogueRecords || []).map((record) => ({
    id: record.claim_id,
    title: record.title,
    sourceDate: record.source_date,
    statementType: record.statement_type,
    recordStatus: record.record_status,
    sourceUrl: record.source_url,
  }));
  const research = (profile?.researchRecords || []).map((record) => ({
    id: record.id,
    title: record.title,
    exactArchivedQuote: record.exactArchivedQuote,
    sourceDate: record.sourceDate,
    originalSourceUrl: record.originalSourceUrl,
    quotationSourceUrl: record.quotationSourceUrl,
    statementType: record.statementType,
    headline: record.headline,
    evidenceStrength: record.evidenceStrength,
    testFraming: record.testFraming,
    currentEvidenceSummary: record.currentEvidenceSummary,
    priorPublicInformationSummary: record.priorPublicInformationSummary,
    corpusWarning: record.corpusWarning,
    missingGates: Array.isArray(record.missingGates) ? [...record.missingGates] : [],
    researchStatus: record.researchStatus,
    finalAdjudicationStatus: record.finalAdjudicationStatus,
    asOf: record.asOf,
    supportingReferences: (record.supportingReferences || []).map((reference) => ({
      id: reference.id,
      role: reference.role,
      title: reference.title,
      url: reference.url,
      publishedAt: reference.publishedAt,
      note: reference.note,
    })),
  }));
  const sources = (profile?.sources || []).map((source) => ({
    label: titleCase(source.source_type || "Source"),
    role: titleCase(source.source_role || "Unclassified"),
    identity: titleCase(source.identity_status || "Unverified"),
    availability: titleCase(source.availability || "Unknown"),
    url: source.url,
    note: source.note,
  }));
  return {
    schemaVersion: 2,
    filename: reportFilename(profile?.person?.slug),
    title: "Evidence report",
    subject: profile?.person?.displayName || "Profile",
    asOf: profile?.asOf || "2026-07-19",
    corpusLabel: profile?.completeness || "Selected claims, not a complete channel review",
    publicationScope: "This is a working report. A rating becomes final only when two independent reviewers agree.",
    findings,
    research,
    catalogue,
    sources,
    coverage: reportCoverage(profile),
    metrics: {
      catalogueRecords: catalogue.length,
      provisionalBriefs: research.length,
      publishedFindings: findings.length,
      scoreStatus: profile?.score?.significanceStatus || "insufficient_sample",
      strictAccuracy: profile?.score?.strictAccuracy ?? null,
    },
    missingGates: [
      "Check each original statement's exact timestamp and full context.",
      "Define what would count before judging what happened.",
      "Preserve reliable sources about the result and what was public beforehand.",
      "Get matching decisions from two independent, verified reviewers.",
    ],
    limitations: [
      "This report covers selected claims, not the speaker's complete channel or track record.",
      "The page titled All Fulfilled Prophecies selects claims described as fulfilled.",
      "A page written by the speaker can help locate claims, but it is not independent proof.",
      "The findings in this working report are not final true, false, or partly true ratings.",
      "The report reviews public statements, not anyone's faith, motives, character, or divine causation.",
    ],
  };
}

function renderCover(doc, model) {
  doc.addPage("EVIDENCE REPORT");
  doc.label("Working report", 22, COLORS.amber);
  doc.heading(model.subject, 1);
  doc.text("What was said. What was already public. What happened next.", {
    size: 17, font: doc.fonts.sansBold, color: COLORS.cyan, lineHeight: 21, after: 9,
  });
  doc.text(`Working report as of ${model.asOf}. No claim in this report has a final rating yet.`, {
    size: 10.5, color: COLORS.muted, after: 18,
  });
  doc.metricRow([
    { value: String(model.metrics.provisionalBriefs), label: "Claims examined" },
    { value: String(model.research.reduce((total, item) => total + item.supportingReferences.length, 0)), label: "Sources linked" },
    { value: String(model.metrics.publishedFindings), label: "Final ratings", color: COLORS.amber },
  ]);
  doc.label("Strongest evidence found so far", 9);
  if (model.research.length) {
    model.research.slice(0, 2).forEach((record, index) => {
      doc.panel(`${String(index + 1).padStart(2, "0")} / ${record.title}`, record.headline, {
        bodySize: 11.5, lineHeight: 16, after: 10,
        borderColor: index === 0 ? COLORS.cyan : COLORS.amber,
      });
    });
  } else {
    doc.panel("Working report", "Claims are listed, but their source reviews are not ready yet.", {
      borderColor: COLORS.amber,
    });
  }
}

function renderCoverage(doc, model) {
  const coverage = model.coverage;
  const status = ({
    queued: "Waiting to scan", running: "Scanning now", scanning: "Scanning now",
    complete: "Latest scan finished", complete_with_errors: "Scan finished with limits",
    partial: "Partly scanned", failed: "Scan needs attention", not_started: "Scan not started",
  })[String(coverage.scanStatus).toLowerCase()] || "Scan status unavailable";
  doc.addPage("PUBLIC SOURCE COVERAGE");
  const startPage = doc.pages.length;
  doc.label("Public record", 17);
  doc.heading("How much has actually been checked?", 1);
  doc.text("Posts, videos, transcripts, possible claims, human checks, and final ratings are counted separately. Only final ratings can affect a track record.", {
    size: 11, color: COLORS.muted, lineHeight: 16, after: 13,
  });
  doc.metricRow([
    { value: String(coverage.postsFound), label: "Posts found" },
    { value: String(coverage.videosLinked), label: "Videos linked" },
    { value: String(coverage.transcriptsAvailable), label: "Transcripts available" },
  ]);
  doc.metricRow([
    { value: String(coverage.possibleClaimsFound), label: "Possible claims found" },
    { value: String(coverage.claimsCheckedByPeople), label: "Checked by people" },
    { value: String(coverage.finalRatings), label: "Final ratings", color: COLORS.amber },
  ]);
  const access = coverage.sourceAccess.length
    ? coverage.sourceAccess.slice(0, 4).map((row) => `${row.name}: ${row.message}`).join("  |  ")
    : "The official website is counted first. Some social sites limit what can be counted without signing in; those limits are shown instead of guessed.";
  doc.panel(`${status} | Last checked: ${coverage.lastScanAt || "Date unavailable"}`,
    [coverage.statusMessage, access].filter(Boolean).join(" "), {
      borderColor: COLORS.amber, titleColor: COLORS.amber, bodySize: 9.5, lineHeight: 13,
    });
  return { startPage, endPage: doc.pages.length };
}

function renderMethodOverview(doc, model) {
  doc.addPage("HOW TO READ THIS REPORT");
  doc.label("Working report", 21, COLORS.amber);
  doc.heading("What this report shows", 1);
  doc.text("This report shows what was said, what happened, what was already publicly known, and what still needs checking. It does not give a final rating yet.", {
    size: 12, color: COLORS.muted, lineHeight: 17, after: 17,
  });
  doc.panel("What you can check",
    "The exact words found in the archive, links and dates, independent reporting about what happened, sources published before the claim, and the questions that remain open.", {
      borderColor: COLORS.cyan, bodySize: 11.5, lineHeight: 16,
    });
  doc.panel("What this report does not decide",
    "It does not judge faith, motives, character, prophetic status, fraud, or divine causation. These claims also do not count toward an accuracy score unless two independent reviewers agree on a final rating.", {
      borderColor: COLORS.rust, titleColor: COLORS.amber, bodySize: 11.5, lineHeight: 16,
    });
  doc.panel("Why this is not a complete track record",
    model.research[0]?.corpusWarning || model.limitations[0], {
      borderColor: COLORS.amber, titleColor: COLORS.amber, bodySize: 11.5, lineHeight: 16,
    });
}

function renderResearchBrief(doc, record, index) {
  doc.addPage(`CLAIM ${String(index + 1).padStart(2, "0")} / WORKING REPORT`);
  doc.label(`Claim ${String(index + 1).padStart(2, "0")} / still being checked`, 20, COLORS.amber);
  doc.heading(record.title, 1);
  doc.text(`Claim date: ${record.sourceDate} | Final rating: None yet`, {
    size: 8.5, font: doc.fonts.sansBold, color: COLORS.cyan, after: 14,
  });
  doc.quote(record.exactArchivedQuote);
  doc.panel("Strongest evidence found so far", record.headline, {
    borderColor: COLORS.amber, titleColor: COLORS.amber,
    bodyFont: doc.fonts.sansBold, bodySize: 13, lineHeight: 18, after: 23,
  });
  doc.heading("What happened", 2);
  doc.text(record.currentEvidenceSummary, {
    size: 10.5, color: COLORS.cream, lineHeight: 15, after: 14,
    sectionName: `CLAIM ${String(index + 1).padStart(2, "0")} / EVIDENCE`,
  });
  doc.ensure(105, `CLAIM ${String(index + 1).padStart(2, "0")} / WHAT WAS KNOWN`);
  doc.heading("What was already public", 2);
  doc.text(record.priorPublicInformationSummary, {
    size: 10.5, color: COLORS.cream, lineHeight: 15, after: 14,
    sectionName: `CLAIM ${String(index + 1).padStart(2, "0")} / WHAT WAS KNOWN`,
  });
  doc.ensure(105, `CLAIM ${String(index + 1).padStart(2, "0")} / WHAT WOULD COUNT`);
  doc.heading("How we are checking the claim", 2);
  doc.text(record.testFraming, {
    size: 10.5, color: COLORS.muted, lineHeight: 15, after: 14,
    sectionName: `CLAIM ${String(index + 1).padStart(2, "0")} / WHAT WOULD COUNT`,
  });
  doc.panel("No final rating yet",
    "WORKING REPORT. The information above has not received a final true, false, or partly true rating. It does not count toward a track-record score.", {
      borderColor: COLORS.rust, titleColor: COLORS.amber, bodySize: 10.5, lineHeight: 15,
      sectionName: `CLAIM ${String(index + 1).padStart(2, "0")} / STATUS`, after: 23,
    });
  doc.heading("What still needs checking", 2);
  record.missingGates.forEach((gate) => doc.bullet(gate, { color: COLORS.amber }));

  doc.addPage(`CLAIM ${String(index + 1).padStart(2, "0")} / SOURCES`);
  doc.label("Sources", 19);
  doc.heading(record.title, 2);
  doc.text("Sources are labeled so you can tell the original video, the speaker's own archive, independent reporting, and information published before the claim apart.", {
    size: 10, color: COLORS.muted, after: 13,
  });
  doc.panel("Before and after the claim",
    `The claim was made on ${record.sourceDate}. Earlier sources show what was already publicly known. Later sources help show what happened. The speaker's own archive is never treated as independent proof.`, {
      borderColor: COLORS.cyan, bodySize: 10.5, lineHeight: 15,
    });
  record.supportingReferences.forEach((reference) => doc.sourceCard(reference));
}

function renderFinalSections(doc, model) {
  doc.addPage("HOW A RATING BECOMES FINAL");
  doc.label("No final rating yet", 20, COLORS.amber);
  const publicationGates = doc.keepBulletSection("What still needs to happen", model.missingGates);
  doc.rule(24);
  doc.heading("How this works", 2);
  doc.text("We save the original statement, decide what would count before judging it, check reliable sources, and show what was already public. A rating becomes final only when two independent, verified reviewers agree on the claim, result, and sources.", {
    size: 10.5, color: COLORS.cream, lineHeight: 15, after: 13,
  });
  doc.text("We will not publish an overall track-record score until a broad, clearly defined group of videos has been reviewed. Repeated versions of the same prediction count once. This helps prevent cherry-picking.", {
    size: 10.5, color: COLORS.muted, lineHeight: 15, after: 17,
  });
  doc.heading("Limits", 2);
  model.limitations.forEach((item) => doc.bullet(item));
  return publicationGates;
}

export async function buildProfileReportPdf(profile) {
  const model = buildProfileReportModel(profile);
  const pdf = await PDFDocument.create();
  const fixedDate = reportDate(model.asOf);
  pdf.setTitle(`The Prophecy Ledger - ${model.subject}`);
  pdf.setAuthor("The Prophecy Ledger");
  pdf.setSubject("Public claim evidence report");
  pdf.setKeywords(["prophecy", "public claims", "evidence", "working report"]);
  pdf.setCreator("The Prophecy Ledger");
  pdf.setProducer("The Prophecy Ledger");
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  const fonts = {
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    serifBold: await pdf.embedFont(StandardFonts.TimesRomanBold),
  };
  const doc = new Composer(pdf, fonts);
  renderCover(doc, model);
  const coverage = renderCoverage(doc, model);
  renderMethodOverview(doc, model);
  model.research.forEach((record, index) => renderResearchBrief(doc, record, index));
  if (!model.research.length) {
    doc.addPage("CATALOGUE");
    doc.heading("Claims waiting for review", 1);
    model.catalogue.forEach((record) => doc.panel(record.title,
      `${record.sourceDate || "Date unavailable"} | ${titleCase(record.recordStatus)} | ${record.sourceUrl}`));
  }
  const publicationGates = renderFinalSections(doc, model);
  const footerLayout = doc.finish();
  return {
    bytes: await pdf.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: 50 }),
    filename: model.filename,
    model,
    layout: { coverage, publicationGates, ...footerLayout },
  };
}
