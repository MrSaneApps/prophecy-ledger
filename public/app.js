import { renderReview } from "./review.js";
import { renderBiblicalProphecy } from "./biblical-prophecy.js";

const DEFAULT_PERSON_SLUG = "troy-black";
const PEOPLE_FALLBACKS = {
  "troy-black": {
    displayName: "Troy Black",
    archiveUrl: "https://troyblackvideos.com/prophecy-archive-all/",
    corpusLabel: "Provisional pilot — selected records, not a complete catalogue",
    records: {
      "southeast-asia-oil-2021": {
        title: "Southeast Asia oil statement",
        quote: "I heard this second phrase... It said, ‘But there’s going to be an oil boom in Southeast Asia next year.’",
        sourceDate: "September 10, 2020",
        sourceUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M",
      },
      "russia-spring-2022": {
        title: "Russia springtime statement",
        quote: "I heard Russia is going to declare war in the springtime. And I heard in full shift by July.",
        sourceDate: "December 7, 2021",
        sourceUrl: "https://www.youtube.com/watch?v=iyijrK-MvQo",
      },
    },
  },
};

const main = document.querySelector("#content");
const html = String.raw;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function sourceLink(url, label = url) {
  return `<a class="evidence-url" href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function notice() {
  return html`<aside class="notice" aria-label="Review status"><strong>Still being checked</strong>
    <p>This is an early review of selected claims, not a final decision or a full review of the channel. We show what still needs checking.</p></aside>`;
}

function displayDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? String(value)
    : new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function personFallback(slug) {
  return PEOPLE_FALLBACKS[slug] || { displayName: slug.replaceAll("-", " "), records: {} };
}

function fallbackResearchRecords(slug = DEFAULT_PERSON_SLUG) {
  return Object.entries(personFallback(slug).records).map(([id, record]) => ({
    id,
    title: record.title,
    exactArchivedQuote: record.quote,
    sourceDate: record.sourceDate,
    originalSourceUrl: record.sourceUrl,
    headline: "Claim summary temporarily unavailable",
    evidenceStrength: "insufficient",
    testFraming: "Reload the page to see how this claim is being checked.",
    currentEvidenceSummary: "The full claim review could not be loaded.",
    priorPublicInformationSummary: "Information published before the claim could not be loaded.",
    corpusWarning: "These selected claims are not a complete review of the channel or its track record.",
    missingGates: ["Restore the full claim review.", "Check the exact words and context.", "Get agreement from two independent reviewers."],
    supportingReferences: [],
  }));
}

function sourceRoleLabel(role) {
  return ({
    original_statement: "Original video",
    speaker_archive: "Speaker's later account",
    independent_outcome: "Independent reporting",
    prior_public_information: "Published before the claim",
    context: "Background",
  })[role] || "Source";
}

function researchBrief(record, index, slug = DEFAULT_PERSON_SLUG) {
  const label = String(index + 1).padStart(2, "0");
  const strength = record.evidenceStrength === "material_provisional"
    ? "Useful evidence found" : "More checking needed";
  const gates = Array.isArray(record.missingGates) ? record.missingGates : [];
  return html`<article class="claim-brief" aria-labelledby="brief-title-${escapeHtml(record.id)}">
    <div class="brief-index"><span>${label}</span><i></i><small>${escapeHtml(displayDate(record.sourceDate))}</small></div>
    <div class="brief-main">
      <div class="brief-topline"><p class="eyebrow">Public claim</p><span class="status ${record.evidenceStrength === "material_provisional" ? "status-warning" : ""}">${strength}</span></div>
      <h3 id="brief-title-${escapeHtml(record.id)}">${escapeHtml(record.headline || record.title)}</h3>
      <blockquote>“${escapeHtml(record.exactArchivedQuote)}”</blockquote>
      <p class="test-framing"><span>What would count</span>${escapeHtml(record.testFraming)}</p>
      <div class="brief-evidence">
        <div><span>What happened</span><p>${escapeHtml(record.currentEvidenceSummary)}</p></div>
        <div><span>What was already public</span><p>${escapeHtml(record.priorPublicInformationSummary)}</p></div>
      </div>
      <p class="brief-source">${sourceLink(record.originalSourceUrl, "Watch original video ↗")} · ${escapeHtml(displayDate(record.sourceDate))}</p>
    </div>
    <aside class="missing-gates"><span>What still needs checking</span><ul>${gates.slice(0, 2).map((gate) => `<li>${escapeHtml(gate)}</li>`).join("")}</ul><a href="/people/${encodeURIComponent(slug)}/claims/${encodeURIComponent(record.id)}">Read the full claim review <span aria-hidden="true">→</span></a></aside>
  </article>`;
}

function firstDefined(object, keys, fallback = 0) {
  for (const key of keys) if (object?.[key] !== undefined && object[key] !== null) return object[key];
  return fallback;
}

function coverageModel(profile) {
  const coverage = profile?.corpusCoverage || {};
  const counts = coverage.counts || coverage;
  return {
    posts: firstDefined(counts, ["postsFound", "posts_found", "sourceItems", "source_items"], 0),
    videos: firstDefined(counts, ["videosLinked", "videos_linked"], 0),
    transcripts: firstDefined(counts, ["transcriptsAvailable", "transcripts_available"], 0),
    possibleClaims: firstDefined(counts, ["possibleClaimPosts", "possible_claim_posts", "possibleClaimsFound", "possible_claims_found"], 0),
    specificClaims: firstDefined(counts, ["specificClaimCandidates", "specific_claim_candidates"], 0),
    archiveClaims: firstDefined(counts, ["archiveClaimsCatalogued", "archive_claims_catalogued"], 0),
    archiveVideos: firstDefined(counts, ["archiveOriginalVideos", "archive_original_videos"], 0),
    archiveChecks: firstDefined(counts, ["archiveSourceChecksCompleted", "archive_source_checks_completed"], 0),
    humanChecked: firstDefined(counts, ["claimsCheckedByPeople", "claims_checked_by_people", "humanReviewed", "human_reviewed"], 0),
    finalRatings: firstDefined(counts, ["finalRatings", "final_ratings", "publishedRatings", "published_ratings"], 0),
    status: firstDefined(coverage, ["scanStatus", "scan_status", "status"], "not_started"),
    lastScan: firstDefined(coverage, ["lastScanAt", "last_scan_at"], ""),
    note: firstDefined(coverage, ["statusMessage", "status_message", "publicNote", "public_note"], ""),
    access: firstDefined(coverage, ["sources", "sourceAccess", "source_access", "accessLimits", "access_limits"], []),
  };
}

function countLabel(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("en-US").format(number) : "—";
}

function directoryPersonCard(entry, index) {
  const person = entry.person || entry;
  const slug = person.slug || DEFAULT_PERSON_SLUG;
  const name = person.displayName || person.display_name || personFallback(slug).displayName;
  const coverage = coverageModel(entry);
  return html`<article class="person-row" data-person-row data-search="${escapeHtml(`${name} ${slug}`.toLowerCase())}">
    <div class="person-index" aria-hidden="true"><span>${String(index + 1).padStart(2, "0")}</span><i></i></div>
    <div class="person-copy"><p class="eyebrow">First public profile</p><h2>${escapeHtml(name)}</h2><p>${escapeHtml(person.corpusLabel || person.corpus_label || "Public sources are being catalogued and checked.")}</p><a class="button-link" href="/people/${encodeURIComponent(slug)}">Open public record <span aria-hidden="true">→</span></a></div>
    <dl class="person-measures"><div><dt>Sources</dt><dd>${escapeHtml(countLabel(coverage.posts))}</dd></div><div><dt>Archive claims</dt><dd>${escapeHtml(countLabel(coverage.archiveClaims))}</dd></div><div><dt>Transcripts</dt><dd>${escapeHtml(countLabel(coverage.transcripts))}</dd></div><div><dt>Human reviews</dt><dd>${escapeHtml(countLabel(coverage.humanChecked))}</dd></div><div><dt>Final ratings</dt><dd>${escapeHtml(countLabel(coverage.finalRatings))}</dd></div></dl>
  </article>`;
}

function renderDirectory(entries, loadError = "") {
  const people = entries.length ? entries : [{ person: { slug: DEFAULT_PERSON_SLUG, ...personFallback(DEFAULT_PERSON_SLUG) }, corpusCoverage: {} }];
  main.innerHTML = html`
    <section class="directory-hero paper" aria-labelledby="directory-title"><div class="case-rail" aria-hidden="true"><span>PUBLIC CLAIMS</span><i></i><span>LEDGER</span></div><div class="hero-copy">
      <p class="eyebrow"><span class="signal-dot"></span>Independent public record</p><h1 id="directory-title">Testing Public Prophecy</h1>
      <p class="lede">Start with a person. Follow the record from original sources and transcripts to specific claims, human reviews, and final ratings.</p>
      <p class="hero-footnote"><span>Prophecies, not personalities</span> We test public prophecies and their stated details against evidence. We do not judge faith, motives, character, prophetic status, or divine causation.</p>
    </div><div class="directory-seal" aria-hidden="true"><span>${escapeHtml(countLabel(people.length))}</span><small>public profile<br>open now</small></div></section>
    <section class="section-wrap people-directory" aria-labelledby="people-title">
      ${loadError ? `<aside class="load-warning" role="status"><strong>Directory update unavailable</strong><p>${escapeHtml(loadError)} Showing the first public profile.</p></aside>` : ""}
      <header class="directory-heading"><div><p class="eyebrow">People directory</p><h2 id="people-title">Choose a public record.</h2></div><p>Troy Black is the first profile. Many more people will be added as their public sources can be catalogued and checked under the same rules.</p></header>
      <form id="people-search" class="people-search" role="search"><label for="people-query">Search people</label><div><input id="people-query" name="query" type="search" autocomplete="off" placeholder="Search by name"><button type="submit">Search</button></div></form>
      <p id="people-status" class="source-status" role="status" aria-live="polite">${people.length} ${people.length === 1 ? "profile" : "profiles"} available.</p>
      <div class="person-register">${people.map(directoryPersonCard).join("")}</div>
      <aside class="directory-next"><span>More records are coming</span><p>Each new person will use the same evidence trail and the same separation between sources, transcripts, claims, human reviews, and final ratings.</p></aside>
    </section>`;
  bindDirectorySearch();
}

function bindDirectorySearch() {
  document.querySelector("#people-search")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = event.currentTarget.query.value.trim().toLowerCase();
    const rows = [...document.querySelectorAll("[data-person-row]")];
    let visible = 0;
    for (const row of rows) {
      row.hidden = Boolean(query) && !row.dataset.search.includes(query);
      if (!row.hidden) visible += 1;
    }
    document.querySelector("#people-status").textContent = visible
      ? `${visible} matching ${visible === 1 ? "profile" : "profiles"}.`
      : "No people match that search yet.";
  });
}

function scanStatusLabel(status) {
  return ({
    queued: "Waiting to scan", running: "Scanning now", scanning: "Scanning now",
    complete: "Latest scan finished", complete_with_errors: "Scan finished with limits",
    partial: "Partly scanned", failed: "Scan needs attention", not_started: "Scan not started",
  })[String(status || "").toLowerCase()] || "Scan status unavailable";
}

function accessRows(coverage) {
  const rows = Array.isArray(coverage.access) ? coverage.access : [];
  if (!rows.length) return html`<li><strong>Official website</strong><span>Public posts are being counted first.</span></li><li><strong>Social accounts</strong><span>Some sites limit what can be counted without signing in. We show those limits instead of guessing.</span></li>`;
  return rows.map((row) => {
    const name = row.name || row.sourceName || row.source_name || row.platform || "Public source";
    const found = row.itemsFound ?? row.items_found;
    const detail = row.explanation || row.publicMessage || row.public_message || row.note || row.status || "No details available.";
    const count = found === undefined ? "" : `${countLabel(found)} found. `;
    return `<li><strong>${escapeHtml(name)}</strong><span>${escapeHtml(count + detail)}</span></li>`;
  }).join("");
}

function sourceItem(item) {
  const title = item.title || item.publicTitle || item.public_title || "Untitled public post";
  const url = item.originalUrl || item.original_url || item.url || item.canonicalUrl || item.canonical_url;
  const videoUrl = item.linkedVideoUrl || item.linked_video_url || item.videoUrl || item.video_url;
  const platform = item.platformLabel || item.platform_label || item.platform || "Public source";
  const date = item.publishedAt || item.published_at || item.publicationDate || item.publication_date;
  const description = item.description || item.firstPartyDescription || item.first_party_description || "";
  const transcript = item.transcriptStatus || item.transcript_status;
  const possible = item.status || item.possibleClaimStatus || item.possible_claim_status;
  const transcriptLabel = ["provided", "verified", "available"].includes(transcript)
    ? "Transcript available" : possible === "needs_transcript" ? "Transcript not available" : "";
  const possibleLabel = ({ possible_claim: "Possible claim found", needs_transcript: "Transcript needed", ready_for_human_check: "Ready for a person to check", checked: "Checked by a person", source_unavailable: "Original source unavailable" })[possible] || "Not checked for a claim yet";
  return html`<li class="source-item"><div class="source-date"><span>${escapeHtml(displayDate(date))}</span><small>${escapeHtml(platform)}</small></div><div class="source-copy"><h3>${escapeHtml(title)}</h3>${description ? `<p>${escapeHtml(description)}</p>` : ""}<div class="source-badges">${transcriptLabel ? `<span>${escapeHtml(transcriptLabel)}</span>` : ""}<span>${escapeHtml(possibleLabel)}</span></div></div><div class="source-actions">${url ? sourceLink(url, "Open post ↗") : ""}${videoUrl ? sourceLink(videoUrl, "Watch video ↗") : ""}</div></li>`;
}

const sourceBrowser = { slug: DEFAULT_PERSON_SLUG, cursor: "", query: "", platform: "official_site", status: "all", loading: false };

async function loadSources({ append = false } = {}) {
  const list = document.querySelector("#source-results");
  const status = document.querySelector("#source-status");
  const more = document.querySelector("#source-more");
  if (!list || sourceBrowser.loading) return;
  sourceBrowser.loading = true;
  status.textContent = append ? "Loading more public posts…" : "Loading public posts…";
  if (!append) list.innerHTML = "";
  if (more) more.hidden = true;
  try {
    const parameters = new URLSearchParams({ limit: "25", status: sourceBrowser.status, platform: sourceBrowser.platform, sort: "newest" });
    if (sourceBrowser.query) parameters.set("q", sourceBrowser.query);
    if (append && sourceBrowser.cursor) parameters.set("cursor", sourceBrowser.cursor);
    const response = await fetch(`/api/people/${encodeURIComponent(sourceBrowser.slug)}/sources?${parameters}`, { headers: { accept: "application/json" }, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Public posts could not be loaded (${response.status}).`);
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.sources) ? data.sources : [];
    if (!items.length && !append) list.innerHTML = html`<li class="source-empty"><strong>No matching public posts</strong><span>Try a different word or show all sources.</span></li>`;
    else list.insertAdjacentHTML("beforeend", items.map(sourceItem).join(""));
    sourceBrowser.cursor = data.nextCursor || data.next_cursor || "";
    status.textContent = items.length ? `${items.length} public ${items.length === 1 ? "post" : "posts"} shown${append ? " in this group" : ""}.` : "No public posts matched your search.";
    if (more) more.hidden = !sourceBrowser.cursor;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Public posts could not be loaded.";
    if (!append) list.innerHTML = html`<li class="source-empty source-error"><strong>We could not load the public posts.</strong><span>Your claim reviews are still available below.</span><button type="button" id="source-retry">Try again</button></li>`;
    document.querySelector("#source-retry")?.addEventListener("click", () => loadSources());
  } finally { sourceBrowser.loading = false; }
}

function bindSourceBrowser(slug) {
  sourceBrowser.slug = slug;
  sourceBrowser.cursor = "";
  sourceBrowser.query = "";
  sourceBrowser.platform = "official_site";
  sourceBrowser.status = "all";
  document.querySelector("#source-search")?.addEventListener("submit", (event) => {
    event.preventDefault();
    sourceBrowser.query = event.currentTarget.query.value.trim();
    sourceBrowser.platform = event.currentTarget.platform.value;
    sourceBrowser.status = event.currentTarget.status.value;
    sourceBrowser.cursor = "";
    loadSources();
  });
  document.querySelector("#source-more")?.addEventListener("click", () => loadSources({ append: true }));
  const details = document.querySelector("#source-archive");
  details?.addEventListener("toggle", () => {
    if (!details.open || details.dataset.loaded) return;
    details.dataset.loaded = "true";
    loadSources();
  });
}

function renderPerson(profile, slug, loadError = "") {
  const fallback = personFallback(slug);
  const person = profile?.person || {};
  const displayName = person.displayName || fallback.displayName;
  const researchRecords = Array.isArray(profile?.researchRecords) && profile.researchRecords.length
    ? profile.researchRecords : fallbackResearchRecords(slug);
  const references = researchRecords.flatMap((record) => record.supportingReferences || []);
  const independentCount = profile ? references.filter((reference) => reference.role === "independent_outcome").length : null;
  const priorCount = profile ? references.filter((reference) => reference.role === "prior_public_information").length : null;
  const coverage = coverageModel(profile);
  const corpusWarning = researchRecords.find((record) => record.corpusWarning)?.corpusWarning
    || "These selected claims are not a complete review of the channel or its track record.";
  main.innerHTML = html`
    <section class="profile-hero paper" aria-labelledby="dossier-title">
      <div class="profile-intro"><p class="eyebrow"><span class="signal-dot"></span>Public claim record</p><div class="profile-title"><h1 id="dossier-title">${escapeHtml(displayName)}</h1><span class="status status-warning">Review in progress</span></div>
      <p class="lede"><strong>No final ratings yet.</strong> ${escapeHtml(countLabel(coverage.archiveClaims))} first-party archive claims catalogued; ${escapeHtml(countLabel(coverage.specificClaims))} exact transcript candidates ready for human checking.</p>
      <p>These examples show what is being checked and what remains unresolved. They do not establish an overall track record.</p>
      <div class="hero-actions"><a class="button-link button-primary" href="#claim-briefs">Read the two examples <span aria-hidden="true">↓</span></a><a class="text-link" href="/api/people/${encodeURIComponent(slug)}/report">Download report <span aria-hidden="true">↗</span></a></div></div>
      <dl class="profile-summary" aria-label="Review at a glance"><div><dt>Archive claims</dt><dd>${escapeHtml(countLabel(coverage.archiveClaims))}</dd></div><div><dt>Original videos</dt><dd>${escapeHtml(countLabel(coverage.archiveVideos))}</dd></div><div><dt>Source checks</dt><dd>${escapeHtml(countLabel(coverage.archiveChecks))}</dd></div><div><dt>Final ratings</dt><dd>${escapeHtml(countLabel(coverage.finalRatings))}</dd></div></dl>
      <p class="score-boundary"><strong>Counts are not a score.</strong> Only a clear claim checked by two independent reviewers can receive a final rating.</p>
    </section>
    <section class="section-wrap dossier" aria-labelledby="research-state-title">${notice()}
      ${loadError ? `<aside class="load-warning" role="status"><strong>Claim details unavailable</strong><p>${escapeHtml(loadError)} Showing the basic source information instead.</p></aside>` : ""}
      <header class="section-heading selected-heading"><div><p class="eyebrow">Claims under review</p><h2 id="research-state-title">Two documented examples.</h2></div><p>Compact summaries of the evidence collected so far. Neither example has a final rating.</p></header>
      <div id="claim-briefs" class="claim-briefs">${researchRecords.map((record, index) => researchBrief(record, index, slug)).join("")}</div>
      <section class="evidence-timeline" aria-labelledby="timeline-title"><div class="timeline-copy"><p class="eyebrow">How a claim is checked</p><h2 id="timeline-title">We do not rush to a verdict.</h2><p>Every step must be clear enough for someone else to check.</p></div><ol><li class="complete"><span>1</span><div><strong>Find the claim</strong><small>Save the exact words, date, and source</small></div></li><li class="complete"><span>2</span><div><strong>Check what happened</strong><small>Use reliable sources independent from the speaker</small></div></li><li class="current"><span>3</span><div><strong>Check the full context</strong><small>Exact timestamps and surrounding words are still needed</small></div></li><li><span>4</span><div><strong>Publish a final decision</strong><small>Two independent reviewers must agree</small></div></li></ol></section>
      <div class="archive-disclosures" aria-label="Optional record details">
        <details id="coverage-archive"><summary><span>Archive coverage</span><small>Counts, scan status, and access limits</small></summary><div class="disclosure-body"><aside class="corpus-warning"><span>Important</span><p>The publisher's archive is a first-party lead index, not proof that a prophecy was fulfilled. Each linked original video still needs an exact source check. ${fallback.archiveUrl ? sourceLink(fallback.archiveUrl, "Open the publisher's archive ↗") : ""}</p></aside><div class="coverage-grid" aria-label="${escapeHtml(displayName)} public source progress"><article><strong>${escapeHtml(countLabel(coverage.archiveClaims))}</strong><span>Archive claims</span><small>First-party rows preserved as leads</small></article><article><strong>${escapeHtml(countLabel(coverage.archiveVideos))}</strong><span>Original videos</span><small>Unique videos named in those rows</small></article><article><strong>${escapeHtml(countLabel(coverage.archiveChecks))}</strong><span>Source checks</span><small>Original-video checks completed</small></article><article><strong>${escapeHtml(countLabel(coverage.transcripts))}</strong><span>Transcripts</span><small>Exact words can be checked</small></article><article><strong>${escapeHtml(countLabel(coverage.specificClaims))}</strong><span>Specific candidates</span><small>Exact transcript candidates, not ratings</small></article><article><strong>${escapeHtml(countLabel(coverage.humanChecked))}</strong><span>Human reviews</span><small>Claims checked by a person</small></article><article class="coverage-final"><strong>${escapeHtml(countLabel(coverage.finalRatings))}</strong><span>Final ratings</span><small>Two reviewers agreed</small></article></div><section class="scan-note" aria-labelledby="scan-note-title"><div><p class="eyebrow">Latest scan</p><h3 id="scan-note-title">${escapeHtml(scanStatusLabel(coverage.status))}</h3><p>${escapeHtml(coverage.note || "The official website is counted first. Other public accounts are added when they can be checked reliably.")}</p><small>Last checked: ${escapeHtml(displayDate(coverage.lastScan))}</small></div><ul aria-label="Source access notes">${accessRows(coverage)}</ul></section></div></details>
        <details id="source-archive"><summary><span>Browse full source archive</span><small>Search public posts in groups of 25</small></summary><div class="disclosure-body"><section id="source-browser" class="source-browser" aria-labelledby="source-browser-title"><header><div><p class="eyebrow">Original sources</p><h2 id="source-browser-title">Browse the public posts</h2></div><p>Search by title or web address, then open the original page or linked video yourself.</p></header><form id="source-search" class="source-search" role="search"><label>Search by title or web address<input name="query" type="search" placeholder="Try: election, economy, Russia…"></label><label>Source<select name="platform"><option value="all">All sources</option><option value="official_site" selected>Official website</option><option value="youtube">YouTube</option><option value="rumble">Rumble</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="x">X</option></select></label><label>Show<select name="status"><option value="all">Everything found</option><option value="possible_claim">Possible claims</option><option value="needs_transcript">Needs a transcript</option><option value="ready_for_human_check">Ready for a person</option><option value="checked">Checked by a person</option><option value="source_unavailable">Source unavailable</option></select></label><button type="submit">Search</button></form><p id="source-status" class="source-status" role="status" aria-live="polite">Open this section to load public posts.</p><ol id="source-results" class="source-results"></ol><button id="source-more" class="source-more" type="button" hidden>Show more posts</button></section></div></details>
        <details id="method-limits"><summary><span>Method and limits</span><small>What this page can and cannot establish</small></summary><div class="disclosure-body"><section class="evidence-boundary" aria-labelledby="boundary-title"><header><p class="eyebrow">What this page can tell you</p><h2 id="boundary-title">Useful facts, with honest limits.</h2></header><div class="boundary-columns"><article><span class="boundary-label positive">What we have</span><ul><li>Two quotations with dates and links to the original videos.</li><li>${independentCount ?? "Multiple"} independent sources about what happened.</li><li>${priorCount ?? "Multiple"} sources published before the claims were made.</li><li>A clear list of what still needs checking for each claim.</li></ul></article><article><span class="boundary-label caution">What we do not have yet</span><ul><li>No final true, false, or partly true decision.</li><li>No verified timestamp or full surrounding context from the original videos.</li><li>No complete review of the channel or meaningful overall score.</li><li>No judgment of motive, character, prophetic status, or divine causation.</li></ul></article></div></section></div></details>
      </div>
      <section class="intake-panel" aria-labelledby="intake-title"><div><p class="eyebrow">Suggest another source</p><h2 id="intake-title">Submit a public video.</h2><p>We will save the link so its source and speaker identity can be confirmed. Submitting it does not start an automatic scan or decide whether any claim is true or false.</p></div><form id="intake-form" class="intake" novalidate><label for="youtube-url">Public YouTube URL</label><div class="input-row"><input id="youtube-url" name="youtubeUrl" type="url" inputmode="url" autocomplete="url" required placeholder="https://www.youtube.com/watch?v=…" aria-describedby="intake-help intake-status"><button type="submit">Submit video</button></div><p id="intake-help" class="help">We save the public link. We do not copy the video or create a claim automatically.</p><p id="intake-status" class="form-status" role="status" aria-live="polite"></p></form></section>
    </section>`;
  document.querySelector("#intake-form").addEventListener("submit", submitIntake);
  bindSourceBrowser(slug);
}

async function submitIntake(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.querySelector("#intake-status");
  const button = form.querySelector("button");
  status.textContent = "Submitting video…";
  button.disabled = true;
  try {
    const response = await fetch("/api/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ youtubeUrl: form.youtubeUrl.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The video could not be submitted.");
    status.textContent = data.reused ? "This video is already saved for identity confirmation." : "Video saved for identity confirmation.";
  } catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
}

function renderClaim(id, publicRecord, { slug = DEFAULT_PERSON_SLUG, displayName = personFallback(slug).displayName, loadError = "" } = {}) {
  const fallback = personFallback(slug).records[id];
  if (!publicRecord && !fallback) return renderNotFound();
  const record = publicRecord || fallbackResearchRecords(slug).find((item) => item.id === id);
  const references = Array.isArray(record.supportingReferences) ? record.supportingReferences : [];
  const gates = Array.isArray(record.missingGates) ? record.missingGates : [];
  const sourceCards = references.length ? references.map((reference) => html`<article class="evidence-item"><span>${escapeHtml(sourceRoleLabel(reference.role))}</span><h3>${escapeHtml(reference.title)}</h3><p>${escapeHtml(reference.note)}</p><small>${escapeHtml(reference.publishedAt || "Date not stated")}</small>${sourceLink(reference.url, "Open source ↗")}</article>`).join("") : `<p class="empty-evidence">Sources could not be loaded.</p>`;
  main.innerHTML = html`<article class="section-wrap claim-page"><a class="back" href="/people/${encodeURIComponent(slug)}">← Back to ${escapeHtml(displayName)} public record</a>${notice()}
    ${loadError ? `<aside class="load-warning" role="status"><strong>Claim details unavailable</strong><p>${escapeHtml(loadError)} Showing the basic source information instead.</p></aside>` : ""}
    <header class="claim-header"><div><p class="eyebrow">Claim review / ${escapeHtml(displayDate(record.asOf || "2026-07-19"))}</p><h1>${escapeHtml(record.headline || record.title)}</h1><p>${escapeHtml(record.title)}</p></div><span class="outcome-stamp">Still being checked</span></header>
    <section class="quote-card" aria-labelledby="exact-words"><div class="section-number">01 / WHAT WAS SAID</div><div><h2 id="exact-words">Exact words in the archive</h2><blockquote>“${escapeHtml(record.exactArchivedQuote)}”</blockquote><dl class="meta-grid"><div><dt>Date</dt><dd>${escapeHtml(displayDate(record.sourceDate))}</dd></div><div><dt>Original video</dt><dd>${sourceLink(record.originalSourceUrl, "Watch on YouTube ↗")}</dd></div><div><dt>Exact timestamp</dt><dd>Still needs checking</dd></div><div><dt>Final decision</dt><dd>None yet</dd></div></dl><p class="warning"><strong>Still needed:</strong> Check the exact timestamp and the full words around this quote before making a final decision.</p></div></section>
    <section class="ledger-section" aria-labelledby="test-question"><div class="section-number">02 / WHAT WOULD COUNT</div><div><h2 id="test-question">How we are checking the claim</h2><p class="ledger-lede">${escapeHtml(record.testFraming)}</p></div></section>
    <section class="ledger-section evidence-finding" aria-labelledby="current-evidence"><div class="section-number">03 / WHAT HAPPENED</div><div><p class="eyebrow">What we found so far</p><h2 id="current-evidence">What happened afterward</h2><p class="ledger-lede">${escapeHtml(record.currentEvidenceSummary)}</p></div></section>
    <section class="ledger-section prior-finding" aria-labelledby="prior-information"><div class="section-number">04 / WHAT WAS KNOWN</div><div><h2 id="prior-information">What was already public</h2><p class="ledger-lede">${escapeHtml(record.priorPublicInformationSummary)}</p><p class="warning"><strong>Still being checked:</strong> We are preserving the searches and sources used to show what was publicly known at the time.</p></div></section>
    <section class="ledger-section" aria-labelledby="sources"><div class="section-number">05 / SOURCES</div><div><h2 id="sources">Sources</h2><div class="evidence-register">${sourceCards}</div></div></section>
    <section class="ledger-section" aria-labelledby="required"><div class="section-number">06 / STILL TO CHECK</div><div><h2 id="required">What is needed before a final decision</h2><ul class="checklist">${gates.map((gate) => `<li>${escapeHtml(gate)}</li>`).join("")}</ul><div class="claim-actions"><a class="button-link button-primary" href="/api/people/${encodeURIComponent(slug)}/report">Download full report</a></div></div></section>
  </article>`;
}

function renderMethodology() {
  main.innerHTML = html`<article class="section-wrap prose-page methodology-page"><p class="eyebrow">How it works · July 20, 2026</p><h1>Check the claim,<span class="mobile-line"> step by step</span></h1>
    <p class="lede">We keep the public method simple enough for anyone to follow and strict enough to prevent cherry-picking.</p>
    <nav class="on-page" aria-label="How this works"><a href="#rateable">What can be rated</a><a href="#checking">How claims are checked</a><a href="#decision">Final ratings</a><a href="#track-record">Track record</a><a href="#limits">What a score cannot prove</a></nav>
    <section class="method-step" id="rateable"><h2>1. Which claims can be rated?</h2><p>Only clear statements about facts or future events can receive a true, false, or partly true rating. Encouragement, symbolism, theology, and personal interpretation may be described, but they are not treated as failed predictions.</p></section>
    <section class="method-step" id="checking"><h2>2. How is a claim checked?</h2><p>We save the exact words, date, original source, and surrounding context. Each source stays a distinct statement so a later retelling cannot replace earlier details. We decide what would count before judging the result, compare the claim with reliable sources independent from the speaker, and show what was already public when the claim was made.</p></section>
    <section class="method-step" id="decision"><h2>3. When does a rating<span class="mobile-line"> become final?</span></h2><p>Not until two independent, verified reviewers agree on the claim, the result, and the sources. Pending or unclear claims are not counted as misses. If the evidence changes, the public record keeps the correction history.</p></section>
    <section class="method-step" id="track-record"><h2>4. When will there be<span class="mobile-line"> a track-record score?</span></h2><p>Only after a broad, clearly defined group of videos has been reviewed. Every recorded version stays in the ledger. Related claims may share one scoring cluster so repetition does not inflate the score, but each version and every stated detail are tested on their own. Reviewers may not stitch selected fragments from separate videos into a new prophecy or ignore details that did not happen.</p></section>
    <section class="method-step" id="limits"><h2>5. What can a score<span class="mobile-line"> never prove?</span></h2><p>A score can describe how public, testable claims performed. It cannot prove or disprove anyone's faith, motives, character, prophetic status, or divine causation. If an original source disappears, its claim record, archived words, date, and review history remain in the ledger; only the original link is marked unavailable. We record the disappearance without guessing why.</p></section>
  </article>`;
}

function renderPrivacy() {
  main.innerHTML = html`<article class="section-wrap prose-page"><p class="eyebrow">Privacy · July 20, 2026</p><h1>Privacy, in plain language</h1>
    <p class="lede">The Prophecy Ledger collects only what it needs to document public claims, accept source suggestions, and support careful human review.</p>
    <section><h2>Public-source records</h2><p>We store public source links and related public metadata so readers can inspect the evidence trail. Suggested video links are saved for identity confirmation; submitting one does not start an automatic scan.</p></section>
    <section><h2>Private review material</h2><p>Generated transcripts, model output, reviewer assignments, and draft decisions stay on private services and are not served by the public site. Reviewers sign in through Cloudflare Access. The ledger stores a pseudonymous reviewer identifier and append-only review actions, not the reviewer's sign-in credentials.</p></section>
    <section><h2>Service providers</h2><p>Cloudflare hosts the site, database, private storage, access control, and in-house claim-analysis tools. Google Gemini may process a public video to generate transcript text for private human checking. We do not sell personal information.</p></section>
    <section><h2>Contact</h2><p>Questions about this policy can be sent to <a href="mailto:hi@saneapps.com">hi@saneapps.com</a>.</p></section>
  </article>`;
}

function renderNotFound() {
  main.innerHTML = html`<section class="paper not-found"><p class="eyebrow">404</p><h1>Page not found</h1><p>We could not find the page you requested.</p><a class="button-link" href="/">Return to the people directory</a></section>`;
}

async function loadPeopleDirectory() {
  const response = await fetch("/api/people", { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`The people directory could not be loaded (${response.status}).`);
  const data = await response.json();
  if (!Array.isArray(data.people)) throw new Error("The people directory is incomplete.");
  return data.people;
}

async function loadPublicProfile(slug) {
  const response = await fetch(`/api/people/${encodeURIComponent(slug)}`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`The claim review could not be loaded (${response.status}).`);
  const profile = await response.json();
  if (!Array.isArray(profile.researchRecords)) throw new Error("The claim review is incomplete.");
  return profile;
}

async function boot() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/biblical-prophecy") return renderBiblicalProphecy(main);
  if (path === "/methodology") return renderMethodology();
  if (path === "/privacy") return renderPrivacy();
  if (path === "/review") return renderReview(main, personFallback(DEFAULT_PERSON_SLUG).records);
  if (path === "/") {
    main.innerHTML = html`<section class="paper loading-state" role="status"><span class="signal-dot"></span><p>Loading the people directory…</p></section>`;
    try { return renderDirectory(await loadPeopleDirectory()); }
    catch (error) { return renderDirectory([], error instanceof Error ? error.message : "The people directory could not be loaded."); }
  }
  const nestedClaim = path.match(/^\/people\/([^/]+)\/claims\/(.+)$/);
  const personMatch = path.match(/^\/people\/([^/]+)$/);
  const legacyClaim = path.match(/^\/claims\/(.+)$/);
  if (!nestedClaim && !personMatch && !legacyClaim) return renderNotFound();
  const slug = decodeURIComponent(nestedClaim?.[1] || personMatch?.[1] || DEFAULT_PERSON_SLUG);
  const claimId = decodeURIComponent(nestedClaim?.[2] || legacyClaim?.[1] || "");
  main.innerHTML = html`<section class="paper loading-state" role="status"><span class="signal-dot"></span><p>Loading the claim review…</p></section>`;
  try {
    const profile = await loadPublicProfile(slug);
    if (!claimId) return renderPerson(profile, slug);
    return renderClaim(claimId, profile.researchRecords.find((record) => record.id === claimId), { slug, displayName: profile.person.displayName });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The claim review could not be loaded.";
    if (!claimId && PEOPLE_FALLBACKS[slug]) return renderPerson(null, slug, message);
    return renderClaim(claimId, null, { slug, loadError: message });
  }
}

boot();
