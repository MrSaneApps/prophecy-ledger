import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/d1.mjs";
import { onRequest as securityMiddleware } from "../functions/_middleware.js";
import {
  archiveDecisionPayload, archiveDecisionReadiness, candidateDecisionPayload,
  promotedCandidateAtGlance, promotionReadiness,
} from "../public/review.js";

const shell = readFileSync(join(ROOT, "public", "index.html"), "utf8");
const app = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const review = readFileSync(join(ROOT, "public", "review.js"), "utf8");
const archiveReview = readFileSync(join(ROOT, "public", "archive-review.js"), "utf8");
const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
const biblical = readFileSync(join(ROOT, "public", "biblical-prophecy.js"), "utf8");
const biblicalCss = readFileSync(join(ROOT, "public", "biblical-prophecy.css"), "utf8");
const headers = readFileSync(join(ROOT, "public", "_headers"), "utf8");
const robots = readFileSync(join(ROOT, "public", "robots.txt"), "utf8");
const redirects = readFileSync(join(ROOT, "public", "_redirects"), "utf8");
const intake = readFileSync(join(ROOT, "functions", "api", "intake.js"), "utf8");
const pagesConfig = readFileSync(join(ROOT, "wrangler.toml"), "utf8");

test("static shell has semantic landmarks, skip navigation, and live form status", () => {
  assert.match(shell, /<header[\s>]/);
  assert.match(shell, /<nav[^>]+aria-label="Primary navigation"/);
  assert.match(shell, /<main id="content"/);
  assert.match(shell, /class="skip-link"/);
  assert.match(app, /role="status" aria-live="polite"/);
  assert.match(app, /<article class="claim-brief"/);
  assert.match(app, /aria-labelledby="brief-title-/);
  assert.match(shell, /href="\/privacy">Privacy<\/a>/);
  assert.match(shell, /href="https:\/\/github\.com\/MrSaneApps\/prophecy-ledger" rel="noreferrer">Source<\/a>/);
  assert.match(app, /function renderPrivacy\(\)/);
  assert.match(app, /if \(path === "\/privacy"\) return renderPrivacy\(\)/);
  assert.match(redirects, /^\/privacy \/ 200$/m);
});

test("public static projection contains neutral catalogue metadata but no draft verdict", () => {
  assert.match(app, /Final decision/);
  assert.match(app, /<dd>None yet<\/dd>/);
  assert.match(app, /Claim review/i);
  assert.doesNotMatch(app, /proposal:|proposes false|outcome proposed|Strong public signals existed/);
  assert.doesNotMatch(app, /name="reviewerId"|Draft state/);
  assert.match(shell, />Reviewer sign in</);
  assert.match(review, /Reviewer workspace/);
  assert.match(review, /fetch\("\/api\/review\/queue"/);
  assert.doesNotMatch(review, /x-demo-reviewer-token|credential.*password|typed name/i);
});

test("reviewer workspace handles all three queue work types and the complete statement taxonomy", () => {
  assert.match(review, /archive_lead_verification/);
  assert.match(review, /candidate_verification/);
  assert.match(review, /claim_adjudication/);
  assert.match(review, /Archive checks/);
  assert.match(review, /Verify candidates/);
  assert.match(review, /Review claims/);
  assert.match(review, /bundle\.subject/);
  assert.match(review, /priorInformationReceipts/);
  assert.match(review, /originalSourceVerified/);
  assert.match(review, /decision.*promote/s);
  assert.match(review, /decision.*reject/s);
  assert.match(review, /workType = "claim_adjudication"/);
  assert.match(review, /name="reasonCode"/);
  assert.match(review, /context_changes_meaning/);
  assert.match(review, /generic_advice_or_commentary/);
  assert.match(review, /missing_essential_context/);
  assert.match(review, /invented_causality_or_mechanism/);
  assert.match(review, /name="deadline"[^>]+type="date"/);
  for (const type of [
    "testable_prediction", "present_or_past_factual_claim", "conditional_prediction",
    "symbolic_statement", "general_encouragement", "theological_claim", "personal_interpretation",
  ]) assert.match(review, new RegExp(type));
});

test("archive review keeps first-party assertions separate and checks exactly one source version", () => {
  assert.match(review, /from "\.\/archive-review\.js"/);
  assert.match(archiveReview, /Not independent evidence/);
  assert.match(archiveReview, /One source version under review/);
  assert.match(archiveReview, /Do not combine wording from the other videos/);
  assert.match(archiveReview, /Speaker-claimed result · not independently verified/);
  assert.match(archiveReview, /Speaker-claimed evidence · not independent evidence/);
  assert.match(archiveReview, /All original-video links in this archive version/);
  assert.match(archiveReview, /Speaker-linked follow-ups · not independent evidence/);
  assert.match(archiveReview, /were not explicitly labeled as prophecy sources/);
  assert.match(archiveReview, /never merged into the source under review/);
  assert.match(archiveReview, /Preserved archive snapshots/);
  assert.match(archiveReview, /cannot create a claim, promotion, fulfillment rating, or publication/);
  for (const decision of [
    "source_supported", "archive_mismatch", "not_testable", "source_unavailable",
  ]) assert.match(archiveReview, new RegExp(`value="${decision}"`));
});

const completeArchiveCheck = {
  decision: "source_supported", sourceAvailable: true, contextVerified: true,
  exactSourceVerified: true, testable: true,
  exactSourceQuote: "The named institution will publish a result this year.",
  sourceTimestampSeconds: "75",
  who: "The named institution", whoSourceBasis: "the named institution",
  what: "will publish a result", whatSourceBasis: "will publish a result",
  why: "because the vote passed", whySourceBasis: "because the vote passed",
  where: "in the public register", whereSourceBasis: "in the public register",
  when: "this year", whenSourceBasis: "this year",
  how: "", howSourceBasis: "",
  publicEvidenceNote: "The dated independent public register.",
  passConditionNote: "A matching result appears during the stated year.",
  failConditionNote: "No matching result appears by the end of the stated year.",
  rationale: "Every required field is grounded in this one checked source version.",
};

test("archive source-supported readiness requires exact 5W1H support and optional How stays open", () => {
  assert.deepEqual(archiveDecisionReadiness(completeArchiveCheck), { ok: true, missing: [] });
  const missingWhy = archiveDecisionReadiness({ ...completeArchiveCheck, why: "Not stated" });
  assert.equal(missingWhy.ok, false);
  assert.ok(missingWhy.missing.includes("why"));
  const statedHow = archiveDecisionReadiness({
    ...completeArchiveCheck, how: "through a vote", howSourceBasis: "",
  });
  assert.equal(statedHow.ok, false);
  assert.ok(statedHow.missing.includes("how exact source support"));
  const payload = archiveDecisionPayload(completeArchiveCheck);
  assert.equal(payload.workType, "archive_lead_verification");
  assert.equal(payload.sourceTimestampSeconds, 75);
  assert.equal(payload.how, "");
});

test("archive negative readiness cannot be labeled exact-source supported", () => {
  const mismatch = {
    decision: "archive_mismatch", sourceAvailable: true, contextVerified: true,
    exactSourceVerified: false, testable: false,
    rationale: "The checked source does not contain the archive wording.",
  };
  assert.deepEqual(archiveDecisionReadiness(mismatch), { ok: true, missing: [] });
  assert.equal(archiveDecisionReadiness({ ...mismatch, exactSourceVerified: true }).ok, false);
  assert.deepEqual(archiveDecisionReadiness({
    decision: "source_unavailable", sourceAvailable: false, contextVerified: false,
    exactSourceVerified: false, testable: false,
    rationale: "The assigned public source could not be opened for review.",
  }), { ok: true, missing: [] });
});

test("candidate review starts fail-safe and does not legitimize machine suggestions", () => {
  assert.match(review, /AI suggestions may be discarded/);
  assert.match(review, /This is not a verified claim/);
  assert.match(review, /AI-generated draft; check every word/);
  assert.match(review, /Discard this suggestion/);
  assert.match(review, /value="promote" disabled/);
  assert.match(review, /id="candidate-submit" type="submit" disabled/);
  assert.doesNotMatch(review, /value="promote"[^>]*(?:checked|selected)/);
  assert.doesNotMatch(review, /value="\$\{escapeHtml\(candidate\.title/);
  assert.doesNotMatch(review, /atomicPropositionDraft|atomic_proposition_draft|proposedStatementType|proposed_statement_type/);
  assert.doesNotMatch(review, /Transcript quality/);
});

const completePromotion = {
  originalSourceVerified: true,
  contextVerified: true,
  title: "A bounded public event",
  statementType: "testable_prediction",
  atomicProposition: "The named event will occur by the deadline.",
  deadline: "2027-01-01",
  who: "The named institution", whoSourceBasis: "the institution",
  what: "will publish the result", whatSourceBasis: "will publish the result",
  why: "because the vote passed", whySourceBasis: "because the vote passed",
  where: "in the public register", whereSourceBasis: "in the public register",
  when: "before January 2027", whenSourceBasis: "before January 2027",
  how: "through a recorded vote", howSourceBasis: "through a recorded vote",
  publicEvidence: "The dated public register entry",
  publicEvidenceSourceBasis: "publish the result in the public register",
  passCondition: "A matching entry appears by 2027-01-01",
  passConditionSourceBasis: "will publish the result before January 2027",
  failCondition: "No matching entry appears by 2027-01-01",
  failConditionSourceBasis: "will publish the result before January 2027",
  rationale: "Every required element is stated in the checked source context.",
};

test("promotion readiness blocks missing or invented 5W1H and evidence fields", () => {
  assert.deepEqual(promotionReadiness(completePromotion), { ok: true, missing: [] });
  const missingWhy = promotionReadiness({ ...completePromotion, why: "Not stated" });
  assert.equal(missingWhy.ok, false);
  assert.ok(missingWhy.missing.includes("why"));
  const missingBasis = promotionReadiness({ ...completePromotion, howSourceBasis: "" });
  assert.equal(missingBasis.ok, false);
  assert.ok(missingBasis.missing.includes("how source words"));
  const mechanismOpen = promotionReadiness({ ...completePromotion, how: "Not stated", howSourceBasis: "" });
  assert.deepEqual(mechanismOpen, { ok: true, missing: [] });
  const mechanismBlank = promotionReadiness({ ...completePromotion, how: "", howSourceBasis: "" });
  assert.deepEqual(mechanismBlank, { ok: true, missing: [] });
  const genericAdvice = promotionReadiness({
    originalSourceVerified: true,
    contextVerified: true,
    atomicProposition: "Who you know can be valuable.",
    rationale: "This is generic advice without a concrete public test.",
  });
  assert.equal(genericAdvice.ok, false);
  for (const field of ["who", "what", "why", "where", "when", "public evidence", "what would prove it true", "what would prove it false"]) {
    assert.ok(genericAdvice.missing.includes(field));
  }
  assert.ok(!genericAdvice.missing.includes("how"));
});

test("candidate promotion payload preserves exact human grounding and separate pass/fail tests", () => {
  const payload = candidateDecisionPayload({ ...completePromotion, decision: "promote" });
  assert.equal(payload.workType, "candidate_verification");
  assert.equal(payload.who, completePromotion.who);
  assert.deepEqual(payload.claimElements.why, {
    value: completePromotion.why,
    sourceBasis: completePromotion.whySourceBasis,
  });
  assert.equal(payload.publicEvidenceSourceBasis, completePromotion.publicEvidenceSourceBasis);
  assert.match(payload.criteria, /Evidence that would prove true:/);
  assert.match(payload.criteria, /Evidence that would prove false:/);
  const openMechanism = candidateDecisionPayload({
    ...completePromotion, decision: "promote", how: "", howSourceBasis: "",
  });
  assert.equal(openMechanism.how, "not stated");
  assert.deepEqual(openMechanism.claimElements.how, { value: "not stated", sourceBasis: "" });
});

test("promoted candidate review leads with 5W1H then pass and fail before source context", () => {
  const payload = candidateDecisionPayload({ ...completePromotion, decision: "promote" });
  const glance = promotedCandidateAtGlance(payload);
  const orderedLabels = ["Who", "will do What", "Where", "When", "Why", "How (if stated)", "Pass if", "Fail if"];
  let previous = -1;
  for (const label of orderedLabels) {
    const position = glance.indexOf(label);
    assert.ok(position > previous, `${label} must follow the preceding at-a-glance field`);
    previous = position;
  }
  const adjudication = review.slice(review.indexOf("function renderClaimAdjudication"));
  assert.ok(adjudication.indexOf("promotedCandidateAtGlance(candidateDecisionFields)")
    < adjudication.indexOf("<blockquote>"));
  assert.ok(adjudication.indexOf("<blockquote>") < adjudication.indexOf("sourceGrounding(candidateDecisionFields)"));
});

test("status is textual, focus visible, touch targets and narrow layouts are explicit", () => {
  assert.match(app, /Counts are not a score/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /overflow:\s*clip/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test("methodology preserves its copy while fitting point headings and enlarging explanations", () => {
  assert.match(app, /class="section-wrap prose-page methodology-page"/);
  assert.match(app, /<h1>Check the claim,<span class="mobile-line"> step by step<\/span><\/h1>/);
  for (const heading of [
    "1. Which claims can be rated?",
    "2. How is a claim checked?",
    "3. When does a rating become final?",
    "4. When will there be a track-record score?",
    "5. What can a score never prove?",
  ]) assert.match(app.replaceAll('<span class="mobile-line">', "").replaceAll("</span>", ""),
    new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(css, /\.methodology-page \.method-step h2\s*\{[^}]*font-size:\s*clamp\(30px,\s*3\.7vw,\s*38px\)/s);
  assert.match(css, /\.methodology-page \.method-step p\s*\{[^}]*font-size:\s*clamp\(20px,\s*1\.8vw,\s*23px\)/s);
  assert.match(css, /@media \(min-width: 801px\)\s*\{\s*\.methodology-page \.method-step h2\s*\{\s*white-space:\s*nowrap/s);
  assert.match(css, /\.mobile-line\s*\{\s*display:\s*inline/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.mobile-line\s*\{\s*display:\s*block/);
  assert.match(css, /p\s*\{[^}]*text-wrap:\s*pretty/s);
});

test("methodology preserves every claim version and forbids selective cross-video stitching", () => {
  assert.match(app, /Each source stays a distinct statement so a later retelling cannot replace earlier details/);
  assert.match(app, /Every recorded version stays in the ledger/);
  assert.match(app, /each version and every stated detail are tested on their own/);
  assert.match(app, /may not stitch selected fragments from separate videos into a new prophecy/);
  assert.match(app, /claim record, archived words, date, and review history remain in the ledger/);
  assert.match(app, /only the original link is marked unavailable/);
  assert.doesNotMatch(app, /If a source disappears, we mark it unavailable without guessing why/);
});

test("home explains the claim review in ordinary language", () => {
  assert.match(app, /<h1 id="directory-title">Testing Public Prophecy<\/h1>/);
  assert.match(app, /<span>Prophecies, not personalities<\/span>/);
  assert.match(app, /We test public prophecies and their stated details against evidence/);
  assert.doesNotMatch(app, /People, not personalities/);
  assert.match(app, /Search people/);
  assert.match(app, /Troy Black is the first profile/);
  assert.match(app, /Many more people will be added/);
  assert.match(app, /public profile<br>open now/i);
  assert.match(app, /What happened/);
  assert.match(app, /What was already public/);
  assert.match(app, /What still needs checking/);
  assert.match(app, /Useful facts, with honest limits/);
  assert.match(app, /Two documented examples/);
  assert.match(app, /No final ratings yet/);
  assert.doesNotMatch(app, /<strong>0<\/strong><small>Minimum for analysis/);
});

test("Troy profile is summary-first with optional archive detail after the claims and process", () => {
  const summary = app.indexOf('class="profile-hero paper"');
  const claims = app.indexOf('id="claim-briefs"');
  const process = app.indexOf('class="evidence-timeline"');
  const archive = app.indexOf('id="coverage-archive"');
  const sources = app.indexOf('id="source-archive"');
  const method = app.indexOf('id="method-limits"');
  const intakePanel = app.indexOf('class="intake-panel"');
  assert.ok(summary >= 0 && summary < claims);
  assert.ok(claims < process && process < archive);
  assert.ok(archive < sources && sources < method && method < intakePanel);
  assert.match(app, /Review in progress/);
  assert.match(app, /Archive claims/);
  assert.match(app, /Original videos/);
  assert.match(app, /Source checks/);
  assert.match(app, /Counts are not a score/);
});

test("home separates source coverage from checked claims and final ratings", () => {
  for (const label of [
    "Sources", "Archive claims", "Original videos", "Source checks", "Transcripts", "Specific candidates",
    "Human reviews", "Final ratings",
  ]) assert.match(app, new RegExp(label, "i"));
  assert.match(app, /profile\?\.corpusCoverage/);
  assert.match(app, /Counts are not a score/);
  assert.doesNotMatch(app, />1,114</,
    "verified counts must come from the public API instead of static promotional copy");
});

test("source browser uses the paged public endpoint and has useful reader states", () => {
  assert.match(app, /\/api\/people\/\$\{encodeURIComponent\(sourceBrowser\.slug\)\}\/sources\?/);
  assert.match(app, /URLSearchParams\(\{ limit: "25", status: sourceBrowser\.status, platform: sourceBrowser\.platform, sort: "newest" \}\)/);
  assert.match(app, /parameters\.set\("cursor"/);
  assert.match(app, /Search by title or web address/);
  assert.match(app, /Loading public posts/);
  assert.match(app, /No matching public posts/);
  assert.match(app, /We could not load the public posts/);
  assert.match(app, /Show more posts/);
  assert.match(app, /Transcript not available/);
  assert.match(app, /Not checked for a claim yet/);
  assert.match(app, /name="status"/);
  assert.match(app, /value="ready_for_human_check"/);
  assert.match(app, /<details id="source-archive">/);
  assert.match(app, /if \(!details\.open \|\| details\.dataset\.loaded\) return/);
  assert.match(app, /details\.dataset\.loaded = "true"/);
  assert.match(app, /Open this section to load public posts/);
});

test("source browser opens on titled official posts and describes its real search fields", () => {
  assert.match(app, /platform: "official_site"/);
  assert.match(app, /<option value="official_site" selected>Official website<\/option>/);
  assert.match(app, /Search by title or web address/);
  assert.match(app, /original page or linked video/);
  assert.doesNotMatch(app, /titles and descriptions/i);
  assert.match(app, /<option value="all">All sources<\/option>/);
});

test("ordinary readers are not shown internal research jargon", () => {
  const visible = `${shell}\n${app}`;
  for (const phrase of [
    "Final adjudication", "Evidence dossier", "Evidence brief", "Evidence signal",
    "Source register", "Selection-bias warning", "Pre-cutoff", "Novelty boundary",
    "Publication boundary", "Reviewer demo",
    "Ingestion pipeline", "Keyset", "Lease token", "Extraction run",
  ]) assert.doesNotMatch(visible, new RegExp(phrase, "i"));
  assert.match(visible, /How it works/);
  assert.match(visible, /two independent reviewers/i);
});

test("public video submission is save-only pending identity confirmation", () => {
  assert.match(app, /save the link so its source and speaker identity can be confirmed/i);
  assert.match(app, /does not start an automatic scan/i);
  assert.match(app, /saved for identity confirmation/i);
  assert.doesNotMatch(app, /add it to the review queue|submitted for review/i);
  assert.doesNotMatch(intake, /INGESTION_QUEUE|secureIntakeDispatch|releaseIntakeDispatch/);
  assert.doesNotMatch(pagesConfig, /\[\[queues\.producers\]\]|INGESTION_QUEUE/);
});

test("home and claim details hydrate only from the safe public research projection", () => {
  assert.match(app, /fetch\(`\/api\/people\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(app, /fetch\("\/api\/people"/);
  assert.match(app, /profile\.researchRecords/);
  assert.match(app, /supportingReferences/);
  assert.match(app, /reference\.role === "independent_outcome"/);
  assert.match(app, /reference\.role === "prior_public_information"/);
  assert.match(app, /renderClaim\(claimId, profile\.researchRecords\.find/);
  assert.doesNotMatch(app, /profile\?\.claims|profile\.claims/);
  assert.match(app, /Showing the basic source information instead/);
});

test("people and claim routes preserve the SPA shell and legacy claim links", () => {
  assert.match(redirects, /^\/people\/\* \/ 200$/m);
  assert.match(redirects, /^\/claims\/\* \/ 200$/m);
  assert.match(app, /\^\\\/people\\\/\(\[\^\/\]\+\)\\\/claims/);
  assert.match(app, /\^\\\/people\\\/\(\[\^\/\]\+\)\$/);
  assert.match(app, /legacyClaim/);
  assert.match(app, /href="\/people\/\$\{encodeURIComponent\(slug\)\}"/);
});

test("people directory numbers every reusable profile row from its array index", () => {
  assert.match(app, /function directoryPersonCard\(entry, index\)/);
  assert.match(app, /String\(index \+ 1\)\.padStart\(2, "0"\)/);
  assert.doesNotMatch(app, /class="person-index"[^>]*><span>01<\/span>/);
  assert.match(app, /people\.map\(directoryPersonCard\)/);
});

test("the public profile shows first-party archive progress without calling it verified", () => {
  assert.match(app, /archiveClaimsCatalogued/);
  assert.match(app, /Archive claims/);
  assert.match(app, /Original videos/);
  assert.match(app, /Source checks/);
  assert.match(app, /first-party lead index, not proof/i);
});

test("public UI does not expose private transcript bodies or raw AI analysis", () => {
  assert.doesNotMatch(app, /transcriptBody|transcript_body|rawTranscript|raw_transcript/);
  assert.doesNotMatch(app, /rawAi|raw_ai|modelResponse|model_response|analysisJson|analysis_json/);
  assert.match(app, /Transcript available/);
  assert.match(app, /exact transcript candidates ready for human checking/i);
  assert.match(app, /First-party rows preserved as leads/);
});

test("SaneApps evidence-laboratory treatment is responsive and motion-safe", () => {
  for (const token of ["--void", "--paper", "--cyan", "--amber"]) {
    assert.match(css, new RegExp(token));
  }
  assert.match(shell, /class="brand-mark"/);
  assert.match(css, /\.claim-brief/);
  assert.match(css, /\.evidence-timeline/);
  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test("SaneUI color and typography invariants are explicit", () => {
  assert.match(css, /--cyan:\s*#52e0f0/i);
  assert.match(css, /--white:\s*#fff/i);
  assert.match(css, /--body-size:\s*16px/);
  assert.match(css, /--secondary-size:\s*14px/);
  assert.match(css, /--label-size:\s*13px/);
  assert.doesNotMatch(css, /--muted|\.secondary|#f2eadb|#dfd2bd/i);
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-2])px\b/);
  const textColors = [...css.matchAll(/(?:^|[;{])\s*color:\s*([^;}\n]+)/gm)].map((match) => match[1].trim());
  assert.deepEqual([...new Set(textColors)], ["var(--white)"]);
});

test("reviewer helper text and inline links keep mobile-accessible computed sizes", () => {
  const labelSize = Number(css.match(/--label-size:\s*(\d+)px/)?.[1]);
  assert.ok(labelSize >= 13, "the shared small-text token must remain at least 13px");
  assert.match(css, /small\s*\{[^}]*font-size:\s*var\(--label-size\)/s,
    "browser small defaults must be overridden by the shared 13px token");
  assert.match(css, /\.candidate-meta a,\s*footer a\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s,
    "reviewer source and footer links must expose 44px touch targets");
  assert.match(css, /\.archive-source-version a,\s*\.archive-link-register a\s*\{[^}]*min-height:\s*44px[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s,
    "archive source links must expose 44px touch targets");
  assert.match(css, /\.archive-at-glance dl,\s*\.archive-assertions,\s*\.archive-version-list li\s*\{\s*grid-template-columns:\s*1fr/s,
    "archive summary, assertions, and version rows must collapse at the tablet breakpoint");
  const mobileCss = css.slice(css.indexOf("@media (max-width: 520px)"));
  assert.doesNotMatch(mobileCss, /font-size:\s*(?:[0-9]|1[0-2])px\b/,
    "mobile overrides must not reintroduce sub-13px text");
});

test("UI copy does not make personal or theological-office judgments", () => {
  const visible = `${shell}\n${app}\n${review}\n${archiveReview}`;
  assert.doesNotMatch(visible, /\b(?:fraudster|false prophet|con artist|liar)\b/i);
  assert.match(visible, /not anyone's faith, motives, or character/i);

});
test("preview is explicitly non-indexable and Pages security headers are restrictive", () => {
  assert.match(shell, /<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">/);
  assert.equal(robots, "User-agent: *\nDisallow: /\n");
  assert.match(headers, /^\/\*/);
  for (const name of [
    "Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy",
    "Permissions-Policy", "X-Frame-Options", "X-Robots-Tag", "Strict-Transport-Security",
  ]) assert.match(headers, new RegExp(`^  ${name}:`, "m"));
  assert.match(headers, /default-src 'self'/);
  assert.match(headers, /script-src 'self'/);
  assert.match(headers, /connect-src 'self'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /object-src 'none'/);
  assert.doesNotMatch(headers, /navigate-to/,
    "external YouTube and evidence links must remain navigable");
});

test("function security middleware preserves PDF download headers and bytes", async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  const response = await securityMiddleware({
    next: async () => new Response(bytes, { headers: {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="report.pdf"',
    } }),
  });
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="report.pdf"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("biblical criteria derivation route is public, navigable, and scope-safe", () => {
  assert.match(shell, /href="\/biblical-prophecy">Why these criteria<\/a>/);
  assert.match(shell, /href="\/biblical-prophecy\.css"/);
  assert.match(app, /import \{ renderBiblicalProphecy \} from "\.\/biblical-prophecy\.js"/);
  assert.match(app, /path === "\/biblical-prophecy"/);
  assert.match(redirects, /^\/biblical-prophecy \/ 200$/m);
  assert.match(biblical, /How Scripture teaches us to test prophecy/);
  assert.match(biblical, /We assume Scripture is true/);
  assert.doesNotMatch(biblical, /fact-check of God or the Bible/);
  assert.match(biblical, /Scripture is the example and authority from which the testing method is derived/);
  assert.doesNotMatch(biblical, /prove(?:s|d)? (?:the )?Bible|disprove(?:s|d)? (?:the )?Bible/i);
});

test("biblical criteria derivation publishes the complete claim anatomy and optional How rule", () => {
  for (const label of ["Who", "What", "Why", "Where", "When", "How"]) {
    assert.match(biblical, new RegExp(`\\["${label.replace(/[()]/g, "\\$&")}"`));
  }
  assert.equal((biblical.match(/"Required"/g) || []).length, 5);
  assert.match(biblical, /"Record if stated"/);
  assert.match(biblical, /A prophecy is not rejected merely because the mechanism remains unstated until fulfillment/);
  assert.match(biblical, /Specificity protects both the speaker and the reviewer/);
});

test("biblical criteria are grounded in explicit tests and three worked fulfillment examples", () => {
  for (const passage of [
    "Deuteronomy 18:21–22", "Jeremiah 28:9", "Jeremiah 18:7–10",
    "1 Corinthians 14:29", "1 Thessalonians 5:20–21", "Joshua 6:26",
    "1 Kings 16:34", "1 Samuel 10:2–8", "1 Samuel 10:9–10", "Jonah 3:4–10",
  ]) assert.match(biblical, new RegExp(passage));
  assert.equal((biblical.match(/Worked derivation/g) || []).length, 1,
    "the shared label is rendered by every worked example");
  assert.equal((biblical.match(/Derived rule:/g) || []).length, 3);
  assert.match(biblical, /The speaker does not certify the speaker/);
  assert.match(biblical, /Stated conditions must remain part of the test/);
  assert.match(biblical, /How the criteria are extracted from the text/);
});

test("biblical study stays focused on the criteria and worked scriptural examples", () => {
  for (const internalDetail of [
    "How the 66-book catalogue validates this method",
    "Follow-up validation, not the page’s purpose",
    "Text and corpus record",
    "Exactly what is being catalogued",
    "Archive SHA-256",
  ]) assert.doesNotMatch(biblical, new RegExp(internalDetail));
  assert.match(biblical, /Worked fulfillment examples/);
  assert.match(biblical, /Samuel gives Saul signs that occur/);
  assert.match(biblical, /Joshua’s word about rebuilding Jericho is reported fulfilled/);
  assert.match(biblical, /Nineveh shows why conditions and purpose matter/);
});

test("biblical study CSS preserves bright text, readable labels, touch targets, and narrow layout", () => {
  assert.doesNotMatch(biblicalCss, /--muted|\.secondary|gray|grey|opacity\s*:/i);
  assert.doesNotMatch(biblicalCss, /font-size:\s*(?:[0-9]|1[0-2])px\b/);
  assert.match(biblicalCss, /min-height:\s*44px/);
  assert.match(biblicalCss, /@media \(max-width: 520px\)/);
  const textColors = [...biblicalCss.matchAll(/(?:^|[;{])\s*color:\s*([^;}\n]+)/gm)]
    .map((match) => match[1].trim());
  assert.deepEqual([...new Set(textColors)], []);
});
