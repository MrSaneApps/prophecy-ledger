import { scoreClaims } from "./scoring.js";

async function all(statement) {
  const result = await statement.all();
  return result.results || [];
}

function publicLanguage(value) {
  if (value == null) return value;
  return String(value)
    .replace("Source found; the archive says the timing was wrong",
      "The speaker's own record says the prediction did not happen in 2021")
    .replace(/two independent automated passes/gi, "two independent checks")
    .replace(/two automated passes/gi, "two independent checks")
    .replace(/saved private transcript/gi, "saved transcript")
    .replace(/fully testable atomic claim/gi, "clear claim that can be fairly tested")
    .replace(/current Who, What, Why, Where, and When gate/gi,
      "basic details needed for a fair test")
    .replace(/novelty score/gi, "judgment about whether it was already public")
    .replace(/resubmitted for a rating/gi, "reviewed again")
    .replace(/source-supported definition/gi, "clear definition supported by the original words")
    .replace(/Get matching decisions from two independent, verified reviewers(?: before any final public rating)?/gi,
      "Get one named human reviewer to make and publish the final decision");
}

export async function getPersonProfile(db, slug, asOf = new Date().toISOString().slice(0, 10)) {
  const person = await db.prepare(
    `SELECT person_id,slug,display_name,corpus_label,corpus_start,corpus_end,
      discovered_videos,reviewed_videos,corpus_frozen_at,rubric_version,rubric_frozen_at
     FROM people WHERE slug=?1`
  ).bind(slug).first();
  if (!person) return null;
  const sources = await all(db.prepare(
    `SELECT source_type,url,identity_status,source_role,availability,note,accessed_at
     FROM sources WHERE person_id=?1 ORDER BY source_type,url`
  ).bind(person.person_id));
  const claims = await all(db.prepare(
    `SELECT claim_id,cluster_id,title,exact_quote,source_url,source_date,statement_type,
      criteria,deadline,as_of_date,lifecycle_status,outcome_status,novelty_status,
      baseline_probability,publication_summary,visibility
     FROM claims WHERE person_id=?1 AND visibility='published' ORDER BY source_date,claim_id`
  ).bind(person.person_id));
  const decisionRows = await all(db.prepare(
    `SELECT revision.claim_id,attribution.display_name reviewer_name,
      review.outcome_status,review.rationale,review.created_at
     FROM claim_revisions revision
     JOIN moderator_reviews review ON review.claim_id=revision.claim_id
       AND EXISTS (SELECT 1 FROM json_each(revision.actor_ids_json) actor
         WHERE actor.value=review.reviewer_id)
     JOIN reviewer_public_attributions attribution
       ON attribution.reviewer_id=review.reviewer_id
      AND NOT EXISTS (SELECT 1 FROM reviewer_public_attributions newer
        WHERE newer.reviewer_id=attribution.reviewer_id
          AND (newer.created_at>attribution.created_at OR
            (newer.created_at=attribution.created_at AND newer.attribution_id>attribution.attribution_id)))
     WHERE revision.revision_type='publication'
       AND revision.claim_id IN (SELECT claim_id FROM claims WHERE person_id=?1)
     ORDER BY review.created_at,review.review_id`
  ).bind(person.person_id));
  const decisionByClaim = new Map(decisionRows.map((row) => [row.claim_id, {
    reviewerName: row.reviewer_name, outcomeStatus: row.outcome_status,
    rationale: row.rationale, decidedAt: row.created_at,
  }]));
  for (const claim of claims) claim.humanDecision = decisionByClaim.get(claim.claim_id) || null;
  const catalogueRecords = await all(db.prepare(
    `SELECT claim_id,title,source_url,source_date,statement_type,lifecycle_status,
      CASE WHEN visibility='published' THEN 'published' ELSE 'provisional_not_adjudicated' END AS record_status
     FROM claims WHERE person_id=?1 ORDER BY source_date,claim_id`
  ).bind(person.person_id));
  const researchRows = await all(db.prepare(
    `SELECT c.claim_id,c.title,c.exact_quote,c.source_url,c.source_date,c.source_timestamp_seconds,c.statement_type,
      b.quotation_source_url,b.headline,b.evidence_strength,b.test_framing,
      b.evidence_summary,b.prior_information_summary,b.corpus_warning,
      b.missing_gates_json,b.research_status,b.as_of_date,b.revision_number
     FROM claims c
     JOIN public_research_briefs b ON b.claim_id=c.claim_id
     WHERE c.person_id=?1
       AND NOT EXISTS (
         SELECT 1 FROM public_research_briefs newer
         WHERE newer.claim_id=b.claim_id AND newer.revision_number>b.revision_number
       )
     ORDER BY c.source_date,c.claim_id`
  ).bind(person.person_id));
  const researchReferences = await all(db.prepare(
    `SELECT r.reference_id,b.claim_id,r.reference_role,r.title,r.url,r.published_at,r.note
     FROM public_research_references r
     JOIN public_research_briefs b ON b.brief_id=r.brief_id
     JOIN claims c ON c.claim_id=b.claim_id
     WHERE c.person_id=?1
       AND NOT EXISTS (
         SELECT 1 FROM public_research_briefs newer
         WHERE newer.claim_id=b.claim_id AND newer.revision_number>b.revision_number
       )
     ORDER BY c.source_date,r.display_order,r.reference_id`
  ).bind(person.person_id));
  const referencesByClaim = new Map();
  for (const reference of researchReferences) {
    const claimReferences = referencesByClaim.get(reference.claim_id) || [];
    claimReferences.push({
      id: reference.reference_id,
      role: reference.reference_role,
      title: reference.title,
      url: reference.url,
      publishedAt: reference.published_at,
      note: publicLanguage(reference.note),
    });
    referencesByClaim.set(reference.claim_id, claimReferences);
  }
  const researchRecords = researchRows.map((record) => ({
    id: record.claim_id,
    title: record.title,
    exactArchivedQuote: record.exact_quote,
    sourceDate: record.source_date,
    exactTimestampSeconds: record.source_timestamp_seconds,
    originalSourceUrl: record.source_url,
    quotationSourceUrl: record.quotation_source_url,
    statementType: record.statement_type,
    headline: publicLanguage(record.headline),
    evidenceStrength: record.evidence_strength,
    testFraming: publicLanguage(record.test_framing),
    currentEvidenceSummary: publicLanguage(record.evidence_summary),
    priorPublicInformationSummary: publicLanguage(record.prior_information_summary),
    corpusWarning: publicLanguage(record.corpus_warning),
    missingGates: decisionByClaim.has(record.claim_id) ? []
      : JSON.parse(record.missing_gates_json).map(publicLanguage),
    researchStatus: record.research_status,
    finalAdjudicationStatus: decisionByClaim.has(record.claim_id) ? "published" : "not_adjudicated",
    humanDecision: decisionByClaim.get(record.claim_id) || null,
    asOf: record.as_of_date,
    revision: record.revision_number,
    supportingReferences: referencesByClaim.get(record.claim_id) || [],
  }));
  const corpusCoverage = await getCorpusCoverage(db, person.person_id);
  let archiveCatalog = [];
  try {
    archiveCatalog = await all(db.prepare(
      `SELECT revision.description_text AS title, revision.date_shared_text AS dateShared
       FROM first_party_archive_lead_revisions revision
       JOIN first_party_archive_leads lead ON lead.archive_lead_id=revision.archive_lead_id
       WHERE lead.person_id=?1
       ORDER BY revision.date_shared_text, revision.description_text, revision.archive_revision_id`
    ).bind(person.person_id));
  } catch (error) {
    if (!ingestionTablesMissing(error)) throw error;
  }
  return {
    asOf,
    person: {
      slug: person.slug,
      displayName: person.display_name,
      corpusLabel: person.corpus_label,
    },
    completeness: person.corpus_label,
    sources,
    catalogueRecords,
    archiveCatalog,
    researchRecords,
    corpusCoverage,
    claims,
    score: scoreClaims(claims, {
      discoveredVideos: person.discovered_videos,
      reviewedVideos: person.reviewed_videos,
      corpusLabel: person.corpus_label,
      corpusFrozenAt: person.corpus_frozen_at,
      rubricVersion: person.rubric_version,
      rubricFrozenAt: person.rubric_frozen_at,
      asOf,
    }),
  };
}

export async function getPublicClaim(db, claimId) {
  const claim = await db.prepare(
    `SELECT claim_id,person_id,video_id,cluster_id,title,exact_quote,source_url,
      source_date,source_timestamp_seconds,statement_type,atomic_proposition,criteria,
      deadline,as_of_date,lifecycle_status,outcome_status,novelty_status,
      baseline_probability,publication_summary,published_at
     FROM claims WHERE claim_id=?1 AND visibility='published'`
  ).bind(claimId).first();
  if (!claim) return null;
  const evidence = await all(db.prepare(
    `SELECT evidence_id,evidence_role,url,title,published_at,accessed_at,source_role,note,
      search_query,cutoff_date,verification_method
     FROM evidence WHERE claim_id=?1 ORDER BY created_at,evidence_id`
  ).bind(claimId));
  const events = await all(db.prepare(
    `SELECT event_type,actor_id,detail_json,created_at FROM claim_events
     WHERE claim_id=?1 AND event_type IN ('published','source_unavailable')
     ORDER BY created_at,event_id`
  ).bind(claimId));
  const humanDecision = await db.prepare(
    `SELECT attribution.display_name reviewer_name,review.outcome_status,
      review.rationale,review.created_at
     FROM claim_revisions revision
     JOIN moderator_reviews review ON review.claim_id=revision.claim_id
       AND EXISTS (SELECT 1 FROM json_each(revision.actor_ids_json) actor
         WHERE actor.value=review.reviewer_id)
     JOIN reviewer_public_attributions attribution
       ON attribution.reviewer_id=review.reviewer_id
      AND NOT EXISTS (SELECT 1 FROM reviewer_public_attributions newer
        WHERE newer.reviewer_id=attribution.reviewer_id
          AND (newer.created_at>attribution.created_at OR
            (newer.created_at=attribution.created_at AND newer.attribution_id>attribution.attribution_id)))
     WHERE revision.claim_id=?1 AND revision.revision_type='publication'
     ORDER BY review.created_at DESC,review.review_id DESC LIMIT 1`
  ).bind(claimId).first();
  return {
    asOf: claim.as_of_date,
    claim,
    evidence: {
      original: evidence.filter((item) => item.evidence_role === "original_statement"),
      retrospective: evidence.filter((item) => item.evidence_role === "retrospective_fulfillment"),
      outcome: evidence.filter((item) => item.evidence_role === "independent_outcome"),
      priorInformation: evidence.filter((item) => item.evidence_role === "contemporaneous_public_information"),
    },
    timeline: events,
    publication: { requiresOneNamedHumanDecision: true, summary: claim.publication_summary,
      humanDecision: humanDecision ? {
        reviewerName: humanDecision.reviewer_name, outcomeStatus: humanDecision.outcome_status,
        rationale: humanDecision.rationale, decidedAt: humanDecision.created_at,
      } : null },
  };
}

export async function getReviewBundle(db, claimId) {
  const claim = await db.prepare(
    `SELECT claim_id,person_id,video_id,cluster_id,title,exact_quote,source_url,source_date,
      source_timestamp_seconds,transcript_warning,statement_type,atomic_proposition,criteria,
      deadline,as_of_date,lifecycle_status,visibility,created_at
     FROM claims WHERE claim_id=?1`
  ).bind(claimId).first();
  if (!claim) return null;
  const evidence = await all(db.prepare(
    `SELECT evidence_id,claim_id,evidence_role,url,title,published_at,accessed_at,
      source_role,note,search_query,cutoff_date,verification_method,created_at
     FROM evidence WHERE claim_id=?1 ORDER BY created_at,evidence_id`
  ).bind(claimId));
  const receipts = await all(db.prepare(
    `SELECT receipt_id,claim_id,cutoff_date,status,search_queries_json,
      sources_checked_json,method_note,completed_at,created_at
     FROM prior_information_receipts WHERE claim_id=?1 ORDER BY created_at,receipt_id`
  ).bind(claimId));
  const reviews = await all(db.prepare(
    `SELECT review_id,reviewer_id,claim_type,outcome_status,novelty_status,
      baseline_probability,evidence_ids_json,prior_receipt_id,decision_fingerprint,
      rationale,created_at
     FROM moderator_reviews WHERE claim_id=?1 ORDER BY created_at,review_id`
  ).bind(claimId));
  const events = await all(db.prepare(
    `SELECT event_id,event_type,actor_id,detail_json,created_at
     FROM claim_events WHERE claim_id=?1 ORDER BY created_at,event_id`
  ).bind(claimId));
  return { claim, evidence, receipts, reviews, events };
}

export async function insertIntake(db, parsed, now = new Date().toISOString()) {
  const requestId = `ingest_${parsed.canonicalVideoId}`;
  await db.prepare(
    `INSERT OR IGNORE INTO ingest_requests
      (request_id,canonical_video_id,normalized_url,status,candidate_sources_json,created_at,updated_at)
     VALUES (?1,?2,?3,'pending_identity','[]',?4,?4)`
  ).bind(requestId, parsed.canonicalVideoId, parsed.normalizedUrl, now).run();
  const record = await db.prepare(
    `SELECT request_id,canonical_video_id,normalized_url,status,candidate_sources_json,created_at,updated_at
     FROM ingest_requests WHERE canonical_video_id=?1`
  ).bind(parsed.canonicalVideoId).first();
  return { record, reused: record.request_id !== requestId || record.created_at !== now };
}

const COVERAGE_EMPTY = Object.freeze({
  postsFound: 0,
  videosLinked: 0,
  transcriptsAvailable: 0,
  possibleClaimPosts: 0,
  specificClaimCandidates: 0,
  archiveClaimsCatalogued: 0,
  archiveOriginalVideos: 0,
  archiveSourceChecksCompleted: 0,
  claimsCheckedByPeople: 0,
  finalRatings: 0,
  lastScanAt: null,
  scanStatus: "not_started",
  sources: [],
});

function ingestionTablesMissing(error) {
  return /no such (?:table|view):\s*(source_items|source_item_revisions|source_scan_receipts|transcript_artifacts|claim_candidates|eligible_claim_candidates|ingestion_runs|ingestion_jobs|first_party_archive_leads|first_party_archive_lead_revisions|first_party_archive_revision_links|archive_verification_work_items|transcript_analysis_runs|transcript_batch_items|effective_transcript_batch_item_dispositions|review_work_items|review_assignments|candidate_review_decisions)/i
    .test(String(error?.message || error));
}

export async function getCorpusCoverage(db, personId) {
  try {
    const counts = await db.prepare(
      `WITH latest_revisions AS (
         SELECT revision.* FROM source_item_revisions revision
         WHERE NOT EXISTS (
           SELECT 1 FROM source_item_revisions newer
           WHERE newer.source_item_id=revision.source_item_id
             AND (newer.fetched_at>revision.fetched_at OR
               (newer.fetched_at=revision.fetched_at AND newer.revision_id>revision.revision_id))
         )),
       latest_archive_revisions AS (
         SELECT revision.* FROM first_party_archive_lead_revisions revision
         WHERE NOT EXISTS (
           SELECT 1 FROM first_party_archive_lead_revisions newer
           WHERE newer.archive_lead_id=revision.archive_lead_id
             AND (newer.fetched_at>revision.fetched_at OR
               (newer.fetched_at=revision.fetched_at AND newer.archive_revision_id>revision.archive_revision_id))
         ))
       SELECT
         (SELECT COUNT(*) FROM source_items WHERE person_id=?1 AND platform='official_site') posts_found,
         (SELECT COUNT(DISTINCT revision.embedded_item_id) FROM source_items item
           JOIN latest_revisions revision ON revision.source_item_id=item.source_item_id
           WHERE item.person_id=?1 AND revision.embedded_item_id IS NOT NULL) videos_linked,
         (SELECT COUNT(DISTINCT item.source_item_id) FROM source_items item
           JOIN transcript_artifacts artifact ON artifact.source_item_id=item.source_item_id
           WHERE item.person_id=?1) transcripts_available,
         (SELECT COUNT(DISTINCT item.source_item_id) FROM source_items item
           JOIN claim_candidates candidate ON candidate.source_item_id=item.source_item_id
           WHERE item.person_id=?1 AND candidate.candidate_kind='description_lead') possible_claim_posts,
         (SELECT COUNT(DISTINCT candidate.candidate_id) FROM source_items item
           JOIN eligible_claim_candidates candidate ON candidate.source_item_id=item.source_item_id
           WHERE item.person_id=?1 AND candidate.candidate_kind='exact_transcript_claim') specific_claim_candidates,
         (SELECT COUNT(*) FROM first_party_archive_leads
           WHERE person_id=?1) archive_claims_catalogued,
         (SELECT COUNT(DISTINCT link.source_item_id) FROM first_party_archive_leads lead
           JOIN latest_archive_revisions revision ON revision.archive_lead_id=lead.archive_lead_id
           JOIN first_party_archive_revision_links link ON link.archive_revision_id=revision.archive_revision_id
           WHERE lead.person_id=?1 AND link.link_role='original_video'
             AND link.source_item_id IS NOT NULL) archive_original_videos,
         (SELECT COUNT(DISTINCT work.archive_work_item_id) FROM first_party_archive_leads lead
           JOIN latest_archive_revisions revision ON revision.archive_lead_id=lead.archive_lead_id
           JOIN archive_verification_work_items work ON work.archive_revision_id=revision.archive_revision_id
           WHERE lead.person_id=?1 AND work.status='complete') archive_source_checks_completed,
         (SELECT COUNT(DISTINCT review.claim_id) FROM moderator_reviews review
           JOIN claims claim ON claim.claim_id=review.claim_id WHERE claim.person_id=?1) claims_checked,
         (SELECT COUNT(*) FROM claims WHERE person_id=?1 AND visibility='published') final_ratings`
    ).bind(personId).first();
    const latestRun = await db.prepare(
      `SELECT status,COALESCE(completed_at,discovery_finished_at,started_at,created_at) last_scan_at
       FROM ingestion_runs WHERE person_id=?1
       ORDER BY created_at DESC,run_id DESC LIMIT 1`
    ).bind(personId).first();
    const receiptRows = await all(db.prepare(
      `SELECT receipt.source_name,receipt.status,receipt.item_count,
        receipt.public_explanation,receipt.observed_at
       FROM source_scan_receipts receipt
       WHERE receipt.person_id=?1 AND NOT EXISTS (
         SELECT 1 FROM source_scan_receipts newer
         WHERE newer.person_id=receipt.person_id AND newer.source_name=receipt.source_name
           AND (newer.observed_at>receipt.observed_at OR
             (newer.observed_at=receipt.observed_at AND newer.receipt_id>receipt.receipt_id))
       )
       ORDER BY receipt.source_name`
    ).bind(personId));
    return {
      postsFound: Number(counts?.posts_found || 0),
      videosLinked: Number(counts?.videos_linked || 0),
      transcriptsAvailable: Number(counts?.transcripts_available || 0),
      possibleClaimPosts: Number(counts?.possible_claim_posts || 0),
      specificClaimCandidates: Number(counts?.specific_claim_candidates || 0),
      archiveClaimsCatalogued: Number(counts?.archive_claims_catalogued || 0),
      archiveOriginalVideos: Number(counts?.archive_original_videos || 0),
      archiveSourceChecksCompleted: Number(counts?.archive_source_checks_completed || 0),
      claimsCheckedByPeople: Number(counts?.claims_checked || 0),
      finalRatings: Number(counts?.final_ratings || 0),
      lastScanAt: latestRun?.last_scan_at || null,
      scanStatus: latestRun?.status || "not_started",
      sources: receiptRows.map((row) => ({
        name: row.source_name,
        status: row.status,
        itemsFound: Number(row.item_count || 0),
        explanation: row.public_explanation,
        checkedAt: row.observed_at,
      })),
    };
  } catch (error) {
    if (ingestionTablesMissing(error)) return { ...COVERAGE_EMPTY, sources: [] };
    throw error;
  }
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function secureIntakeDispatch(db, record, personId = "person_troy_black", now = new Date().toISOString()) {
  const runId = `run_intake_${record.canonical_video_id}`;
  const stableKey = `youtube:${record.canonical_video_id}`;
  const jobId = `job_${await sha256(`${runId}:video_metadata:${stableKey}`)}`;
  const payload = { youtubeId: record.canonical_video_id };
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO ingestion_runs
       (run_id,person_id,trigger_type,scope,status,error_count,created_at)
       VALUES (?1,?2,'intake','video','queued',0,?3)`
    ).bind(runId, personId, now),
    db.prepare(
      `INSERT OR IGNORE INTO ingestion_jobs
       (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,successor_enqueued)
       VALUES (?1,?2,'video_metadata',?3,?4,'queued',0,0)`
    ).bind(jobId, runId, stableKey, JSON.stringify(payload)),
  ]);
  const reservation = await db.prepare(
    `UPDATE ingestion_jobs SET successor_enqueued=1
     WHERE job_id=?1 AND successor_enqueued=0 AND status='queued'`
  ).bind(jobId).run();
  return {
    reserved: Number(reservation?.meta?.changes || 0) === 1,
    message: {
      version: 1,
      jobId,
      runId,
      personId,
      type: "video_metadata",
      stableKey,
      payload,
    },
  };
}

export async function releaseIntakeDispatch(db, jobId) {
  await db.prepare(
    `UPDATE ingestion_jobs SET successor_enqueued=0
     WHERE job_id=?1 AND status='queued'`
  ).bind(jobId).run();
}

const SOURCE_CURSOR_VERSION = 2;
const SOURCE_STATES = new Set(["all", "possible_claim", "needs_transcript", "analysis_pending", "ready_for_human_check", "checked", "source_unavailable"]);
const SOURCE_PLATFORMS = new Set(["all", "official_site", "youtube", "rumble", "facebook", "instagram", "x", "other"]);
const SOURCE_SORTS = new Set(["newest", "oldest"]);

export class SourceCatalogueError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function encodeCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value) {
  try {
    if (value.length > 2_048) throw new Error("cursor_too_long");
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
  } catch { throw new SourceCatalogueError("invalid_cursor", "That page link is invalid or expired."); }
}

function sourceOptions(input) {
  const result = {
    status: input.status || "all", platform: input.platform || "all", sort: input.sort || "newest",
    query: String(input.query || "").trim(), limit: input.limit === undefined ? 25 : Number(input.limit),
  };
  if (!SOURCE_STATES.has(result.status)) throw new SourceCatalogueError("invalid_status", "That source status is not supported.");
  if (!SOURCE_PLATFORMS.has(result.platform)) throw new SourceCatalogueError("invalid_platform", "That source platform is not supported.");
  if (!SOURCE_SORTS.has(result.sort)) throw new SourceCatalogueError("invalid_sort", "That source order is not supported.");
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 50) throw new SourceCatalogueError("invalid_limit", "Choose between 1 and 50 sources per page.");
  if (result.query.length > 120) throw new SourceCatalogueError("invalid_query", "Search text must be 120 characters or fewer.");
  return result;
}

export async function getSourceCatalogue(db, slug, input = {}) {
  const options = sourceOptions(input);
  const person = await db.prepare("SELECT person_id,slug,display_name FROM people WHERE slug=?1").bind(slug).first();
  if (!person) return null;
  const cursor = input.cursor ? decodeCursor(String(input.cursor)) : null;
  if (cursor) {
    const keys = Object.keys(cursor).sort().join(",");
    const actual = [cursor.version, cursor.personId, cursor.status, cursor.platform, cursor.sort, cursor.query];
    const expected = [SOURCE_CURSOR_VERSION, person.person_id, options.status, options.platform, options.sort, options.query];
    if (keys !== "date,group,id,personId,platform,query,sort,status,version" ||
        actual.some((value, index) => value !== expected[index]) || typeof cursor.date !== "string" ||
        typeof cursor.id !== "string" || !cursor.id || ![0, 1].includes(cursor.group) ||
        cursor.date.length > 64 || cursor.id.length > 200) {
      throw new SourceCatalogueError("cursor_mismatch", "That page link does not match these filters.");
    }
  }
  const escapedQuery = options.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const direction = options.sort === "newest" ? "DESC" : "ASC";
  const comparison = options.sort === "newest" ? "<" : ">";
  const rows = await all(db.prepare(
    `WITH latest_revisions AS (
       SELECT revision.* FROM source_item_revisions revision WHERE NOT EXISTS (
         SELECT 1 FROM source_item_revisions newer WHERE newer.source_item_id=revision.source_item_id
           AND (newer.fetched_at>revision.fetched_at OR (newer.fetched_at=revision.fetched_at AND newer.revision_id>revision.revision_id)))),
     latest_analysis AS (
       SELECT analysis.* FROM transcript_analysis_runs analysis WHERE NOT EXISTS (
         SELECT 1 FROM transcript_analysis_runs newer WHERE newer.source_item_id=analysis.source_item_id
           AND (newer.created_at>analysis.created_at OR
             (newer.created_at=analysis.created_at AND newer.analysis_run_id>analysis.analysis_run_id)))),
     source_claim_links AS (
       SELECT DISTINCT item.source_item_id,claim.claim_id,claim.visibility
       FROM source_items item
       LEFT JOIN latest_revisions revision ON revision.source_item_id=item.source_item_id
       JOIN claims claim ON claim.person_id=item.person_id AND
         (claim.source_url=item.canonical_url OR claim.source_url=revision.embedded_url)),
     source_work_items AS (
       SELECT work.work_item_id,candidate.source_item_id
       FROM review_work_items work JOIN claim_candidates candidate ON candidate.candidate_id=work.candidate_id
       UNION
       SELECT work.work_item_id,link.source_item_id
       FROM review_work_items work JOIN source_claim_links link ON link.claim_id=work.claim_id),
     review_facts AS (
       SELECT mapped.source_item_id,
         MAX(CASE WHEN EXISTS (SELECT 1 FROM candidate_review_decisions decision
               WHERE decision.work_item_id=work.work_item_id)
             OR EXISTS (SELECT 1 FROM moderator_reviews review WHERE review.claim_id=work.claim_id)
           THEN 1 ELSE 0 END) reviewed,
         MAX(CASE WHEN EXISTS (SELECT 1 FROM review_assignments assignment
               WHERE assignment.work_item_id=work.work_item_id AND assignment.status='leased')
           THEN 1 ELSE 0 END) in_progress,
         MAX(CASE WHEN work.status='ready' THEN 1 ELSE 0 END) ready
       FROM source_work_items mapped JOIN review_work_items work ON work.work_item_id=mapped.work_item_id
       GROUP BY mapped.source_item_id),
     phases AS (
       SELECT item.source_item_id,item.platform,item.canonical_url,item.availability,
         revision.public_title,revision.publication_date,revision.embedded_url,
         COALESCE(revision.publication_date,item.first_discovered_at,'') sort_date,
         CASE WHEN item.platform='official_site' THEN 0 ELSE 1 END sort_group,
         CASE
           WHEN EXISTS (SELECT 1 FROM transcript_artifacts artifact WHERE artifact.source_item_id=item.source_item_id)
             OR EXISTS (SELECT 1 FROM transcript_batch_items batch_item
               WHERE batch_item.source_item_id=item.source_item_id AND batch_item.status='completed') THEN 'acquired'
           WHEN EXISTS (SELECT 1 FROM effective_transcript_batch_item_dispositions disposition
               WHERE disposition.source_item_id=item.source_item_id) THEN 'quarantined_source_unavailable'
           WHEN EXISTS (SELECT 1 FROM transcript_batch_items batch_item
               WHERE batch_item.source_item_id=item.source_item_id AND batch_item.status='active') THEN 'active'
           WHEN EXISTS (SELECT 1 FROM transcript_batch_items batch_item
               WHERE batch_item.source_item_id=item.source_item_id AND batch_item.status='pending') THEN 'pending'
           WHEN EXISTS (SELECT 1 FROM transcript_batch_items batch_item
               WHERE batch_item.source_item_id=item.source_item_id AND batch_item.status='skipped') THEN 'skipped_terminal_failure'
           ELSE 'not_started' END acquisition_status,
         CASE
           WHEN NOT EXISTS (SELECT 1 FROM transcript_artifacts artifact
               WHERE artifact.source_item_id=item.source_item_id) THEN 'not_started'
           WHEN analysis.status='queued' THEN 'queued'
           WHEN analysis.status='running' THEN 'running'
           WHEN analysis.status='partial' THEN 'partial'
           WHEN analysis.status='completed' THEN 'completed'
           WHEN analysis.status='failed' THEN 'needs_attention'
           ELSE 'not_started' END analysis_status,
         CASE WHEN COALESCE(review.reviewed,0)=1 THEN 'reviewed'
           WHEN COALESCE(review.in_progress,0)=1 THEN 'in_progress'
           WHEN COALESCE(review.ready,0)=1 THEN 'ready'
           ELSE 'not_ready' END human_review_status,
         CASE WHEN EXISTS (SELECT 1 FROM source_claim_links link
             WHERE link.source_item_id=item.source_item_id AND link.visibility='published')
           THEN 'published' ELSE 'not_published' END public_status,
         CASE WHEN EXISTS (SELECT 1 FROM claim_candidates candidate
             WHERE candidate.source_item_id=item.source_item_id AND candidate.candidate_kind='description_lead')
           THEN 1 ELSE 0 END has_description_lead
       FROM source_items item LEFT JOIN latest_revisions revision ON revision.source_item_id=item.source_item_id
       LEFT JOIN latest_analysis analysis ON analysis.source_item_id=item.source_item_id
       LEFT JOIN review_facts review ON review.source_item_id=item.source_item_id
       WHERE item.person_id=?1),
     catalogue AS (
       SELECT phases.*,
         CASE WHEN availability IN ('unavailable','blocked')
               OR acquisition_status='quarantined_source_unavailable' THEN 'source_unavailable'
           WHEN human_review_status='reviewed' THEN 'checked'
           WHEN human_review_status IN ('ready','in_progress') THEN 'ready_for_human_check'
           WHEN acquisition_status='acquired' THEN 'analysis_pending'
           WHEN has_description_lead=1 THEN 'possible_claim'
           ELSE 'needs_transcript' END public_state
       FROM phases)
     SELECT * FROM catalogue
     WHERE (?2='all' OR catalogue.platform=?2) AND (?3='all' OR catalogue.public_state=?3)
       AND (?4='' OR catalogue.public_title LIKE '%' || ?4 || '%' ESCAPE '\\' OR catalogue.canonical_url LIKE '%' || ?4 || '%' ESCAPE '\\')
       AND (?5='' OR catalogue.sort_group>?7 OR (catalogue.sort_group=?7 AND
         (catalogue.sort_date ${comparison} ?5 OR (catalogue.sort_date=?5 AND catalogue.source_item_id>?6))))
     ORDER BY catalogue.sort_group ASC,catalogue.sort_date ${direction},catalogue.source_item_id ASC LIMIT ?8`
  ).bind(person.person_id, options.platform, options.status, escapedQuery, cursor?.date || "", cursor?.id || "",
    cursor?.group || 0, options.limit + 1));
  const page = rows.slice(0, options.limit), last = page.at(-1);
  return {
    person: { slug: person.slug, displayName: person.display_name },
    filters: { status: options.status, platform: options.platform, query: options.query, sort: options.sort },
    sources: page.map((row) => ({ id: row.source_item_id,
      title: row.public_title || (row.platform === "youtube" ? "Linked YouTube video" : "Untitled source"),
      publishedAt: row.publication_date, platform: row.platform, originalUrl: row.canonical_url,
      linkedVideoUrl: row.embedded_url, status: row.public_state, availability: row.availability,
      acquisitionStatus: row.acquisition_status, analysisStatus: row.analysis_status,
      humanReviewStatus: row.human_review_status, publicStatus: row.public_status })),
    nextCursor: rows.length > options.limit && last ? encodeCursor({ version: SOURCE_CURSOR_VERSION, personId: person.person_id,
      status: options.status, platform: options.platform, sort: options.sort, query: options.query,
      date: last.sort_date, group: last.sort_group, id: last.source_item_id }) : null,
  };
}

export async function appendReview(db, claimId, reviewerId, review, now = new Date().toISOString()) {
  const reviewId = `review_${crypto.randomUUID()}`;
  const eventId = `event_${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(
      `INSERT INTO moderator_reviews
       (review_id,claim_id,reviewer_id,claim_type,outcome_status,novelty_status,
        baseline_probability,evidence_ids_json,prior_receipt_id,decision_fingerprint,rationale,created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
    ).bind(reviewId, claimId, reviewerId, review.claimType, review.outcomeStatus,
      review.noveltyStatus, review.baselineProbability, JSON.stringify(review.evidenceIds),
      review.priorReceiptId, review.decisionFingerprint, review.rationale, now),
    db.prepare(
      `INSERT INTO claim_events (event_id,claim_id,event_type,actor_id,detail_json,created_at)
       VALUES (?1,?2,'review_submitted',?3,?4,?5)`
    ).bind(eventId, claimId, reviewerId, JSON.stringify({ reviewId }), now),
  ]);
  return reviewId;
}
