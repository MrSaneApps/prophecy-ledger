import { bindResearchPanel, researchPanelMarkup } from "./research.js";
import { renderArchiveVerification } from "./archive-review.js";
import {
  approximateClipLocator, candidateAtGlance, candidateDecisionPayload, candidateValue,
  citationHref, claimElementFields, escapeHtml, groundedText, leaseNote, options,
  promotedCandidateAtGlance, promotionReadiness, safeHttpUrl, sourceGrounding,
  sourceUrlAt, stageRail, timestampLabel,
} from "./review-ui.js";

export {
  approximateClipLocator, candidateDecisionPayload, citationHref,
  promotedCandidateAtGlance, promotionReadiness,
} from "./review-ui.js";

const html = String.raw;

let activeFeedbackRef = null;

const EVIDENCE_LANES = [
  ["original", "Original source", "The exact statement and its surrounding context."],
  ["prior", "Contemporary / prior information", "Information publicly available before the claimed outcome."],
  ["outcome", "Independent outcome / fulfillment", "Evidence independent of the speaker that shows what happened."],
  ["first-party", "First-party claimed result / follow-up", "Speaker-authored material is context, not independent proof."],
];

function evidenceLaneFor(item) {
  const role = item.evidence_role || item.evidenceRole || item.role || "";
  if (role === "original_statement") return "original";
  if (role === "contemporaneous_public_information" || role === "prior_public_information") return "prior";
  if (role === "independent_outcome") return "outcome";
  return "first-party";
}

function evidenceLanes(evidence) {
  return html`<fieldset class="evidence-lanes"><legend>Evidence by source role</legend>${EVIDENCE_LANES.map(([key, title, description]) => {
    const items = evidence.filter((item) => evidenceLaneFor(item) === key);
    return `<section class="evidence-lane"><h4>${title}</h4><p>${description}</p>${items.length ? items.map((item) => {
      const sourceUrl = safeHttpUrl(item.source_url || item.sourceUrl || item.url);
      const itemTitle = item.title || item.source_title || item.sourceTitle || item.evidence_role || item.evidenceRole || "Evidence record";
      const method = item.verification_method || item.verificationMethod || "Verification method not recorded";
      const published = item.published_at || item.publishedAt;
      const accessed = item.accessed_at || item.accessedAt;
      const date = published ? `published ${String(published).slice(0, 10)}`
        : accessed ? `accessed ${String(accessed).slice(0, 10)}` : "Date not recorded";
      const note = item.note || item.summary || "No additional note.";
      const excerpt = item.supporting_excerpt || item.supportingExcerpt || "";
      const cited = citationHref(sourceUrl, { excerpt, page: item.source_page ?? item.sourcePage });
      const deepLinked = cited && cited !== safeHttpUrl(sourceUrl);
      return `<div class="evidence-item"><span><strong>${escapeHtml(itemTitle)}</strong>${excerpt ? `<blockquote class="evidence-excerpt">“${escapeHtml(excerpt)}”</blockquote>` : ""}<small>${escapeHtml(note)}</small><small>${escapeHtml(method)} · ${escapeHtml(date)}${cited ? ` · <a href="${escapeHtml(cited)}" rel="noreferrer">${deepLinked ? "open cited passage ↗" : "source ↗"}</a>` : ""}${item.archived_url ? ` · <a href="${escapeHtml(item.archived_url)}" rel="noreferrer">archived copy ↗</a>` : ""}${item.capture_sha256 ? ` · <a href="/api/review/capture/${escapeHtml(item.capture_sha256)}" rel="noreferrer" title="hash-verified private capture">private capture ↗</a>` : ""}</small></span></div>`;
    }).join("") : `<p class="empty-evidence">No ${title.toLowerCase()} evidence is attached.</p>`}</section>`;
  }).join("")}</fieldset>`;
}

function assignmentId(assignment) {
  // Never fall back to claim/candidate ids — those 404 on /api/review/:assignmentId.
  return String(assignment.assignmentId || assignment.assignment_id || assignment.id || "");
}

function assignmentType(assignment) {
  return assignment.workType || assignment.work_type || "claim_adjudication";
}

function principalLabel(principal) {
  if (principal?.demo || principal?.mode === "local_non_deployable_demo") {
    return "Signed in (local demo reviewer)";
  }
  if (principal?.mode === "cloudflare_access") {
    return principal.displayName || principal.display_name || principal.email
      || "Signed in via Cloudflare Access";
  }
  return principal.displayName || principal.display_name || principal.email
    || principal.reviewerId || principal.reviewer_id || principal.id || "Verified reviewer";
}

async function fetchReviewJson(url, init = {}, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await responseJson(response);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("The reviewer service timed out. Reload and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function responseJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Your reviewer session is not active. Sign in again and reload this page.");
  }
  const data = await response.json();
  if (!response.ok) {
    const details = Array.isArray(data.details) && data.details.length
      ? ` Missing: ${data.details.join(", ")}.` : "";
    throw new Error(`${data.error || "The reviewer workspace is unavailable."}${details}`);
  }
  return data;
}

export function renderReview(main) {
  main.innerHTML = html`<article class="section-wrap review-page">
    <header class="workspace-header"><div><p class="eyebrow"><span class="signal-dot"></span>Private review boundary</p><h1>Reviewer workspace</h1><p>Review one source-bound atomic claim at a time. General statements and archive source leads stay outside this queue. Publication still requires two matching independent reviewers.</p></div></header>
    <section class="review-session" aria-label="Reviewer session"><span>Signed-in reviewer</span><strong id="reviewer-principal">Checking session…</strong><a id="reviewer-logout" hidden>Sign out</a></section>
    <div class="review-layout">
      <aside class="queue" aria-labelledby="queue-title"><h2 id="queue-title">Your atomic claims</h2><p class="queue-guidance">Every tracked claim appears below with its pipeline state. Open any claim marked ready.</p><label class="queue-search" for="claim-search">Search claims<input id="claim-search" type="search" autocomplete="off" placeholder="Filter by words, person, or state"></label><p id="queue-status" class="form-status" role="status" aria-live="polite">Loading your queue…</p><div id="review-queue"></div></aside>
      <section id="review-private" class="review-work" aria-live="polite"><div class="workspace-empty" data-dashboard-slot><span>01</span><h2>Loading your workspace…</h2><p>Up next, items waiting on your reviewing partner, and your recent decisions.</p></div></section>
    </div>
    ${researchPanelMarkup()}
    <details class="tool-panel" id="feedback-panel" open><summary>General notes and feedback history</summary><div class="tool-panel-body"><p>Notes about a specific prophecy belong in that claim's visible note thread above. Use this general form for the review screen, feature requests, or anything that is not tied to one claim. All saved notes remain visible in the history below.</p><form id="feedback-form"><label>Category<select name="category"><option value="ai_extraction_quality">The AI picked a wrong or weak candidate</option><option value="ui_friction">A screen or step is confusing</option><option value="evidence_gap">Evidence is wrong or missing</option><option value="feature_request">Feature request</option><option value="other">Something else</option></select></label><label>What happened, and what did you expect?<textarea name="message" rows="4" minlength="5" maxlength="4000" required placeholder="Plain words are perfect. Paste the exact wording that looks wrong if you have it."></textarea></label><button type="submit">Send general note</button><p id="feedback-status" class="form-status" role="status" aria-live="polite"></p></form><div id="feedback-receipt" class="feedback-receipt" hidden></div><section id="feedback-history" class="feedback-history" aria-live="polite"><h3>Your recent feedback</h3><p class="form-status">Loading what you already sent…</p></section></div></details>
    <details class="tool-panel" id="scorecard-panel"><summary>AI extraction scorecard</summary><div class="tool-panel-body"><p>How the extraction pipeline scores against human review, by prompt version. Computed from real reviewer decisions and feedback; the AI never grades itself.</p><div id="scorecard-body"><p class="form-status">Open this section to load the scorecard.</p></div></div></details>
  </article>`;
  loadQueue();
  bindResearchPanel();
  bindFeedbackPanel();
  bindScorecardPanel();
}

function renderFeedbackHistory(items) {
  const history = document.querySelector("#feedback-history");
  if (!history) return;
  if (!items.length) {
    history.innerHTML = html`<h3>Your recent feedback</h3><p class="form-status">Nothing recorded yet. After you send feedback, it appears here with a receipt id so you can confirm it landed.</p>`;
    return;
  }
  history.innerHTML = html`<h3>Your recent feedback</h3><ul class="feedback-history-list">${items.map((item) => {
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
    const ref = item.claimId || item.candidateId || item.assignmentId || "";
    const action = item.actionState === "research_applied" ? "Applied in a newer AI research pass"
      : item.actionState === "routed_to_research" ? "Routed to AI research"
      : "Queued for maintainer review";
    return `<li><strong>${escapeHtml(item.categoryLabel || item.category || "Feedback")}</strong>
      <small>${escapeHtml(when)}${ref ? ` · ref ${escapeHtml(String(ref).slice(0, 24))}` : ""}</small>
      <code>${escapeHtml(item.feedbackId || "")}</code>
      <p><strong>Status:</strong> ${escapeHtml(action)}</p>
      <p>${escapeHtml(String(item.message || "").slice(0, 280))}</p></li>`;
  }).join("")}</ul>`;
}

function feedbackActionLabel(item) {
  return item.actionState === "qa_receipt" ? "Attached live QA receipt — no research action needed"
    : item.actionState === "research_applied" ? "Applied in a newer AI research pass"
    : item.actionState === "routed_to_research" ? "Routed to AI research"
    : "Queued for maintainer review";
}

function claimFeedbackMarkup(claimId) {
  return html`<section class="claim-feedback" aria-labelledby="claim-feedback-title">
    <span class="lane-eyebrow">Your notes and responses</span>
    <h3 id="claim-feedback-title">Notes for this prophetic claim</h3>
    <p>Add a note here and it stays attached to this claim. AI/evidence notes are routed into the next private research pass; interface and feature notes go to the maintainer.</p>
    <form id="claim-feedback-form" class="claim-feedback-form">
      <input type="hidden" name="claimId" value="${escapeHtml(claimId)}">
      <label>Note type<select name="category"><option value="ai_extraction_quality">The AI selected or interpreted something incorrectly</option><option value="evidence_gap">Evidence is wrong or missing</option><option value="ui_friction">The review screen is confusing</option><option value="feature_request">Feature request</option><option value="other">Other note</option></select></label>
      <label>Your note<textarea name="message" rows="3" minlength="5" maxlength="4000" required placeholder="Write what needs attention. This note will stay visible below."></textarea></label>
      <button type="submit">Save note on this claim</button>
      <p class="form-status" role="status" aria-live="polite"></p>
    </form>
    <div id="claim-feedback-thread" class="claim-feedback-thread" aria-live="polite"><p class="form-status">Loading notes and responses…</p></div>
  </section>`;
}

function renderClaimFeedbackThread(container, items) {
  if (!items.length) {
    container.innerHTML = html`<p class="form-status">No notes on this claim yet. A saved note will appear here immediately.</p>`;
    return;
  }
  container.innerHTML = html`<ol class="claim-feedback-list">${items.map((item) => {
    const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
    const responseWhen = item.response?.createdAt
      ? new Date(item.response.createdAt).toLocaleString() : "";
    return `<li><article class="claim-note"><header><strong>Your note</strong><small>${escapeHtml(when)}</small></header><p>${escapeHtml(item.message || "")}</p><p class="claim-note-status"><strong>Status:</strong> ${escapeHtml(feedbackActionLabel(item))}</p><small>Receipt <code>${escapeHtml(item.feedbackId || "")}</code></small></article>
      ${item.response ? `<article class="claim-response"><header><strong>AI research response</strong><small>${escapeHtml(responseWhen)}</small></header><p>${escapeHtml(item.response.message || "")}</p>${item.response.outcomeStatus ? `<p><strong>Pending outcome:</strong> ${escapeHtml(String(item.response.outcomeStatus).replaceAll("_", " "))}</p>` : ""}</article>` : `<p class="claim-response-pending">${item.actionState === "qa_receipt" ? "No research action needed — this note was generated by a live workflow check." : item.actionState === "maintainer_review" ? "Awaiting maintainer response." : "Awaiting the next AI research pass."}</p>`}</li>`;
  }).join("")}</ol>`;
}

async function loadClaimFeedbackThread(claimId) {
  const container = document.querySelector("#claim-feedback-thread");
  if (!container) return;
  try {
    const data = await responseJson(await fetch(`/api/review/feedback?claimId=${encodeURIComponent(claimId)}`, {
      headers: { accept: "application/json" }, cache: "no-store",
    }));
    renderClaimFeedbackThread(container, Array.isArray(data.items) ? data.items : []);
  } catch (error) {
    container.innerHTML = html`<p class="form-status">${escapeHtml(error instanceof Error ? error.message : "Could not load this claim's notes.")}</p>`;
  }
}

function bindClaimFeedbackThread(claimId, assignmentId) {
  const form = document.querySelector("#claim-feedback-form");
  if (!form) return;
  loadClaimFeedbackThread(claimId);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector(".form-status");
    const button = form.querySelector("button[type='submit']");
    const data = Object.fromEntries(new FormData(form).entries());
    status.textContent = "Saving note…";
    status.classList.remove("success");
    button.disabled = true;
    try {
      const result = await responseJson(await fetch("/api/review/feedback", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...data, claimId, assignmentId }),
      }));
      if (!result?.feedbackId) throw new Error("The server did not confirm this note was saved.");
      status.classList.add("success");
      status.textContent = `Saved on this claim. ${feedbackActionLabel(result)}. Receipt ${result.feedbackId}.`;
      form.reset();
      await loadClaimFeedbackThread(claimId);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "The note could not be saved.";
    } finally { button.disabled = false; }
  });
}

async function loadFeedbackHistory() {
  const history = document.querySelector("#feedback-history");
  if (!history) return;
  history.innerHTML = html`<h3>Your recent feedback</h3><p class="form-status">Loading what you already sent…</p>`;
  try {
    const data = await responseJson(await fetch("/api/review/feedback", {
      headers: { accept: "application/json" }, cache: "no-store",
    }));
    renderFeedbackHistory(Array.isArray(data.items) ? data.items : []);
  } catch (error) {
    history.innerHTML = html`<h3>Your recent feedback</h3><p class="form-status">${escapeHtml(error instanceof Error ? error.message : "Could not load feedback history.")}</p>`;
  }
}

function bindFeedbackPanel() {
  const panel = document.querySelector("#feedback-panel");
  const form = document.querySelector("#feedback-form");
  let historyLoaded = false;
  if (panel?.open) {
    historyLoaded = true;
    loadFeedbackHistory();
  }
  panel?.addEventListener("toggle", () => {
    if (panel.open && !historyLoaded) {
      historyLoaded = true;
      loadFeedbackHistory();
    }
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector("#feedback-status");
    const receipt = document.querySelector("#feedback-receipt");
    const button = form.querySelector("button[type='submit']");
    const data = Object.fromEntries(new FormData(form).entries());
    status.textContent = "Sending feedback…";
    status.classList.remove("success");
    if (receipt) { receipt.hidden = true; receipt.textContent = ""; }
    button.disabled = true;
    try {
      const result = await responseJson(await fetch("/api/review/feedback", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...data, ...(activeFeedbackRef || {}) }),
      }));
      if (!result?.feedbackId) {
        throw new Error("The server did not return a feedback receipt. Nothing was confirmed saved.");
      }
      const action = result.actionState === "routed_to_research"
        ? "Routed to the next AI research pass for this claim."
        : "Queued for maintainer review.";
      status.classList.add("success");
      status.textContent = `Saved. Receipt ${result.feedbackId}. ${action}`;
      if (receipt) {
        receipt.hidden = false;
        receipt.innerHTML = html`<p><strong>Feedback recorded</strong></p>
          <p>Receipt: <code>${escapeHtml(result.feedbackId)}</code></p>
          <p>${escapeHtml(result.categoryLabel || result.category || "")} · ${escapeHtml(String(result.message || data.message || "").slice(0, 240))}</p>
          <p><strong>Status:</strong> ${escapeHtml(action)}</p>
          <p>This stays in your history below so you can confirm what happened to it.</p>`;
      }
      form.reset();
      historyLoaded = true;
      await loadFeedbackHistory();
    } catch (error) {
      status.classList.remove("success");
      status.textContent = error instanceof Error ? error.message : "The feedback could not be saved.";
    } finally { button.disabled = false; }
  });
}

function bindScorecardPanel() {
  const panel = document.querySelector("#scorecard-panel");
  let loaded = false;
  panel?.addEventListener("toggle", async () => {
    if (!panel.open || loaded) return;
    loaded = true;
    const body = document.querySelector("#scorecard-body");
    try {
      const data = await responseJson(await fetch("/api/review/scorecard", {
        headers: { accept: "application/json" }, cache: "no-store",
      }));
      const section = (title, list, first) => `<section><h4>${title}</h4>${list.length
        ? `<ul>${list.map((row) => `<li>${escapeHtml(String(row[first] || "unknown"))}${row.decision || row.reason ? ` · ${escapeHtml(String(row.decision || row.reason))}` : ""} · ${escapeHtml(String(row.count))}</li>`).join("")}</ul>`
        : "<p>No entries yet.</p>"}</section>`;
      body.innerHTML = html`<div class="scorecard-grid">
        ${section("Human decisions by prompt version", data.humanDecisions, "promptVersion")}
        ${section("Rejection reasons", data.rejectionReasons, "promptVersion")}
        ${section("Automated gate outcomes", data.admissibility, "gateVersion")}
        ${section("Reviewer feedback", data.reviewerFeedback, "category")}
        ${section("Public issue reports", data.publicReports, "category")}
      </div><p class="scorecard-basis">${escapeHtml(data.basis)}</p>`;
    } catch (error) {
      loaded = false;
      body.innerHTML = html`<p class="form-status">${escapeHtml(error instanceof Error ? error.message : "The scorecard is unavailable.")}</p>`;
    }
  });
}

let claimSearchBound = false;
function bindClaimSearch() {
  if (claimSearchBound) return;
  const search = document.querySelector("#claim-search");
  if (!search) return;
  claimSearchBound = true;
  search.addEventListener("input", () => {
    const term = search.value.trim().toLowerCase();
    document.querySelectorAll("#review-queue [data-search]").forEach((row) => {
      row.hidden = Boolean(term) && !row.dataset.search.includes(term);
    });
  });
}

async function loadQueue() {
  const status = document.querySelector("#queue-status");
  const queue = document.querySelector("#review-queue");
  try {
    const [data, pendingData, archiveData] = await Promise.all([
      fetchReviewJson("/api/review/queue", {
        headers: { accept: "application/json" }, cache: "no-store",
      }, { timeoutMs: 25000 }),
      fetchReviewJson("/api/review/pending", {
        headers: { accept: "application/json" }, cache: "no-store",
      }, { timeoutMs: 8000 }).catch(() => ({ claims: [] })),
      fetchReviewJson("/api/review/archive/queue", {
        headers: { accept: "application/json" }, cache: "no-store",
      }, { timeoutMs: 8000 }).catch(() => ({ assignments: [], counts: {} })),
    ]);
    const received = Array.isArray(data.assignments) ? data.assignments
      : Array.isArray(data.items) ? data.items : [];
    const assignments = received.filter((assignment) => assignmentType(assignment) !== "archive_lead_verification");
    document.querySelector("#reviewer-principal").textContent = data.principal
      ? principalLabel(data.principal) : "Verified Access reviewer";
    const logoutTarget = data.logoutTarget || data.logout_target
      || data.principal?.logoutTarget || data.principal?.logout_target;
    if (logoutTarget) {
      const logout = document.querySelector("#reviewer-logout");
      logout.href = logoutTarget;
      logout.hidden = false;
    }
    const allClaims = Array.isArray(pendingData.claims) ? pendingData.claims : [];
    const activeWorkItems = new Set(assignments.map((assignment) =>
      assignment.workItemId || assignment.work_item_id).filter(Boolean));
    status.textContent = `${assignments.length} active · ${allClaims.length} tracked ${allClaims.length === 1 ? "claim" : "claims"}.`;
    const STATE_LABELS = {
      ready: "Ready for review", in_preparation: "Being prepared",
      awaiting_second_review: "Awaiting second review",
      awaiting_reconciliation: "Reconciling", decided: "Decided",
    };
    const claimRows = allClaims.map((item) => {
      const openable = ["ready", "awaiting_second_review"].includes(item.state)
        && !activeWorkItems.has(item.workItemId);
      return html`<button class="queue-item claim-row" type="button"
        ${openable ? `data-lease-work-item="${escapeHtml(item.workItemId)}"` : "disabled"}
        data-state="${escapeHtml(item.state)}"
        data-search="${escapeHtml(`${item.title} ${item.person} ${STATE_LABELS[item.state] || item.state}`.toLowerCase())}">
        <span>${escapeHtml(STATE_LABELS[item.state] || item.state)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.person)}${item.deadline ? ` · due ${escapeHtml(item.deadline)}` : ""}${item.hasDraft ? " · AI draft ready" : ""}</small>
      </button>`;
    }).join("");
    const assignmentRows = assignments.filter((assignment) => assignmentId(assignment)).map((assignment, index) => {
      const id = assignmentId(assignment);
      const workType = assignmentType(assignment);
      const person = assignment.person || assignment.personName || assignment.person_name || "";
      const title = workType === "candidate_verification" ? "AI-extracted claim to confirm"
        : assignment.title || assignment.headline || assignment.claimTitle
          || assignment.claim_title || person || "Assigned review";
      const state = assignment.status || assignment.state || "Ready to review";
      const deadline = assignment.deadline ? ` · due ${assignment.deadline}` : "";
      const nextAction = assignment.nextAction || assignment.next_action || state;
      const label = workType === "candidate_verification" ? "Confirm or discard this AI-extracted claim" : "Accept or send back";
      return html`<button class="queue-item" type="button" data-assignment-id="${escapeHtml(id)}" data-work-type="${escapeHtml(workType)}" data-search="${escapeHtml(`${title} ${person}`.toLowerCase())}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(title)}</strong>${person && person !== title ? `<small>${escapeHtml(person)}</small>` : ""}<small>${label} · ${escapeHtml(String(nextAction).replaceAll("_", " "))}${escapeHtml(deadline)}</small></button>`;
    }).join("");
    const archiveAssignments = Array.isArray(archiveData.assignments) ? archiveData.assignments : [];
    const archiveCounts = archiveData.counts || {};
    const mineArchive = new Set(archiveAssignments.map((assignment) => assignment.workItemId).filter(Boolean));
    const assignedArchiveRows = archiveAssignments.map((assignment) => {
      const id = assignment.archiveAssignmentId || assignment.archive_assignment_id || assignment.assignmentId || "";
      const title = assignment.description || assignment.title || assignment.prophecy || "Archive source check";
      return html`<button class="queue-item claim-row" type="button" data-archive-assignment-id="${escapeHtml(id)}" data-search="${escapeHtml(`archive ${title}`.toLowerCase())}"><span>Yours now</span><strong>${escapeHtml(String(title).slice(0, 90))}</strong><small>${escapeHtml(String(assignment.status || "leased"))}</small></button>`;
    }).join("");
    const availableArchive = (Array.isArray(archiveData.available) ? archiveData.available : [])
      .filter((item) => !mineArchive.has(item.workItemId));
    const availableArchiveRows = availableArchive.map((item) => html`<button class="queue-item claim-row" type="button" ${item.taken ? "disabled" : `data-archive-work-item="${escapeHtml(item.workItemId)}"`} data-search="${escapeHtml(`archive ${item.title} ${item.matched ? "quote located" : ""}`.toLowerCase())}"><span>${item.matched ? "Quote located" : item.taken ? "Held or checked" : "Source check"}</span><strong>${escapeHtml(String(item.title).slice(0, 90))}</strong><small>${escapeHtml(item.dateShared || "date not stated")}</small></button>`).join("");
    const archiveRows = assignedArchiveRows + availableArchiveRows;
    queue.innerHTML = html`<div class="queue-chips" role="group" aria-label="Filter work"><button type="button" data-queue-chip="pending" aria-pressed="true">Pending</button><button type="button" data-queue-chip="recent">Recent</button><button type="button" data-queue-chip="all">All</button></div>${assignmentRows ? `<p class="queue-group">Your active work</p>${assignmentRows}` : ""}
      <p class="queue-group">All claims</p>${claimRows || `<p class="queue-empty">No claims are tracked yet.</p>`}
      <p class="queue-group">Source checks — ${escapeHtml(String(archiveCounts.ready ?? 0))} ready, ${escapeHtml(String(archiveCounts.matched ?? 0))} with the quote already located</p>
      <p class="queue-hint">The machine takes quote-located items automatically as videos transcribe. Rows here are waiting on transcription or need human eyes; open one only if you want to verify against the video yourself.</p>${archiveRows}`;
    queue.querySelectorAll("[data-assignment-id]").forEach((button) => {
      button.addEventListener("click", () => loadAssignedItem(button.dataset.assignmentId, button));
    });
    queue.querySelectorAll("[data-lease-work-item]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = "Opening the claim…";
        try {
          const opened = await responseJson(await fetch("/api/review/queue", {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ leaseWorkItemId: button.dataset.leaseWorkItem }),
          }));
          await loadQueue();
          const row = document.querySelector(`[data-assignment-id="${opened.assignment.assignmentId}"]`);
          if (row) row.click();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "The claim could not be opened.";
          status.scrollIntoView({ behavior: "smooth", block: "center" });
          button.disabled = false;
        }
      });
    });
    queue.querySelectorAll("[data-archive-assignment-id]").forEach((button) => {
      button.addEventListener("click", () => loadArchiveItem(button.dataset.archiveAssignmentId, button));
    });
    queue.querySelectorAll("[data-archive-work-item]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = "Opening the source check…";
        try {
          const opened = await responseJson(await fetch("/api/review/archive/queue", {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ leaseArchiveWorkItemId: button.dataset.archiveWorkItem }),
          }));
          await loadQueue();
          const row = document.querySelector(`[data-archive-assignment-id="${opened.assignment.assignmentId}"]`);
          if (row) row.click(); else status.textContent = "Opened — find it under Yours now.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "The source check could not be opened.";
          status.scrollIntoView({ behavior: "smooth", block: "center" });
          button.disabled = false;
        }
      });
    });
    bindClaimSearch();
    bindQueueChips();
    renderDashboard({ assignments, allClaims, archiveData, availableArchive });
    // The deep link opens its claim ONCE. Re-firing it on every queue
    // refresh would override whatever the reviewer just clicked.
    const requested = deepLinkConsumed ? null : new URLSearchParams(location.search).get("claim");
    if (requested) {
      deepLinkConsumed = true;
      history.replaceState(null, "", location.pathname);
      const hit = [...queue.querySelectorAll("[data-assignment-id]")]
        .find((item) => item.dataset.assignmentId === requested);
      if (hit) hit.click();
      else {
        status.textContent = "That link is no longer an open assignment. Pick a claim from your active work.";
      }
    } else {
      // One-shot auto-resume so reviewers are not left staring at a dashboard card.
      const resume = document.querySelector("#review-private [data-dashboard-open]");
      if (resume && !deepLinkConsumed) {
        deepLinkConsumed = true;
        queue.querySelector(resume.dataset.dashboardOpen)?.click();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The reviewer queue could not be loaded.";
    const friendly = message === "Not found."
      ? "You are not signed in as a reviewer. Reviewer access is invite-only; if you have an invitation, use Reviewer sign in to open your private queue."
      : message;
    status.textContent = friendly;
    queue.innerHTML = html`<a class="button-link" href="/review">Reviewer sign in</a>`;
    const panel = document.querySelector("#review-private");
    if (panel) {
      panel.innerHTML = html`<div class="workspace-error" role="alert"><h2>Workspace did not load</h2><p>${escapeHtml(friendly)}</p><p><button type="button" id="retry-queue">Retry</button></p></div>`;
      panel.querySelector("#retry-queue")?.addEventListener("click", () => {
        panel.innerHTML = html`<div class="workspace-empty" data-dashboard-slot><span>01</span><h2>Loading your workspace…</h2><p>Retrying…</p></div>`;
        loadQueue();
      });
    }
  }
}

async function loadArchiveItem(assignmentId, button) {
  const container = document.querySelector("#review-private");
  document.querySelectorAll(".queue-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  container.innerHTML = html`<div class="workspace-empty"><span class="signal-dot"></span><h2>Loading archive source check…</h2></div>`;
  container.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const bundle = await responseJson(await fetch(`/api/review/archive/${encodeURIComponent(assignmentId)}`, {
      headers: { accept: "application/json" }, cache: "no-store",
    }));
    renderArchiveVerification(bundle, assignmentId);
  } catch (error) {
    container.innerHTML = html`<div class="workspace-error" role="alert"><h2>Source check unavailable</h2><p>${escapeHtml(error instanceof Error ? error.message : "This archive assignment could not be loaded.")}</p></div>`;
  }
}

let deepLinkConsumed = false;

function renderDashboard({ assignments, allClaims, archiveData, availableArchive }) {
  const container = document.querySelector("#review-private");
  if (!container || !container.querySelector("[data-dashboard-slot]")) return;
  const openClaim = assignments.find((assignment) => (assignment.status || "") !== "submitted");
  const archiveMine = (archiveData.assignments || []).filter((assignment) => (assignment.status || assignment.assignment_status || "leased") === "leased");
  const upNext = openClaim
    ? { label: "Resume your claim review", title: openClaim.prophecy || openClaim.title || "Assigned claim", selector: `[data-assignment-id="${openClaim.assignmentId || openClaim.assignment_id}"]` }
    : archiveMine.length
      ? { label: "Resume your source check", title: archiveMine[0].description || "Archive source check", selector: `[data-archive-assignment-id="${archiveMine[0].archiveAssignmentId || archiveMine[0].assignmentId}"]` }
      : (availableArchive || []).filter((item) => !item.taken).slice(0, 1).map((item) => ({
          label: item.matched ? "Start the next source check — quote already located" : "Start the next source check",
          title: item.title, selector: `[data-archive-work-item="${item.workItemId}"]` }))[0] || null;
  const waiting = [
    ...assignments.filter((assignment) => (assignment.status || "") === "submitted")
      .map((assignment) => assignment.prophecy || assignment.title || "Claim review"),
    ...allClaims.filter((claim) => (claim.state || "") === "awaiting_second_review"
        && !assignments.some((assignment) => (assignment.status || "") !== "submitted"
          && (assignment.claimId || assignment.claim_id) === (claim.claimId || claim.claim_id)))
      .map((claim) => claim.title || claim.prophecy || "Claim"),
  ];
  const recent = (archiveData.assignments || [])
    .filter((assignment) => (assignment.status || assignment.assignment_status) === "submitted")
    .slice(0, 5).map((assignment) => assignment.description || "Source check");
  const counts = archiveData.counts || {};
  container.innerHTML = html`<div class="workspace-dashboard">
    <span class="lane-eyebrow">Your reviewer workspace</span>
    <h2>${upNext ? "Ready when you are" : "All caught up"}</h2>
    <p class="queue-hint">${escapeHtml(String(counts.ready ?? 0))} source checks open (${escapeHtml(String(counts.matched ?? 0))} with the quote located) · ${escapeHtml(String(assignments.filter((a) => (a.status || "") !== "submitted").length))} claim${assignments.filter((a) => (a.status || "") !== "submitted").length === 1 ? "" : "s"} open for you · ${escapeHtml(String([...new Set(waiting)].length))} waiting on your reviewing partner.</p>
    ${upNext ? html`<section class="method-step"><h3>Up next</h3><p><strong>${escapeHtml(String(upNext.title).slice(0, 110))}</strong></p><button class="button-link" type="button" data-dashboard-open="${escapeHtml(upNext.selector)}">${escapeHtml(upNext.label)}</button></section>` : ""}
    ${waiting.length ? html`<section class="method-step"><h3>Waiting on your reviewing partner — you are not blocked</h3><p>Your review is already in on ${waiting.length === 1 ? "this item" : "these items"}. Each publishes only if the second, blind review matches; there is nothing more for you to do here.</p><ul>${[...new Set(waiting)].map((title) => `<li>${escapeHtml(String(title).slice(0, 100))}</li>`).join("")}</ul></section>` : ""}
    ${recent.length ? html`<section class="method-step"><h3>Your recent decisions</h3><ul>${recent.map((title) => `<li>${escapeHtml(String(title).slice(0, 100))}</li>`).join("")}</ul></section>` : ""}
    <p class="queue-hint">Pick anything else from the list on the left — Pending shows what is open right now.</p>
  </div>`;
  container.querySelector("[data-dashboard-open]")?.addEventListener("click", (event) => {
    document.querySelector(event.currentTarget.dataset.dashboardOpen)?.click();
  });
}

function bindQueueChips() {
  const queue = document.querySelector("#review-queue");
  queue.querySelectorAll("[data-queue-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      queue.querySelectorAll("[data-queue-chip]").forEach((other) => other.removeAttribute("aria-pressed"));
      chip.setAttribute("aria-pressed", "true");
      const mode = chip.dataset.queueChip;
      queue.querySelectorAll(".queue-item").forEach((row) => {
        const kind = row.disabled || /submitted/i.test(row.textContent) ? "recent" : "pending";
        row.hidden = mode !== "all" && mode !== kind;
      });
    });
  });
}

async function loadAssignedItem(assignmentId, button) {
  const container = document.querySelector("#review-private");
  document.querySelectorAll(".queue-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  container.innerHTML = html`<div class="workspace-empty"><span class="signal-dot"></span><h2>Loading assigned work…</h2></div>`;
  container.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const bundle = await responseJson(await fetch(`/api/review/${encodeURIComponent(assignmentId)}`, {
      headers: { accept: "application/json" }, cache: "no-store",
    }));
    history.replaceState(null, "", `/review?claim=${encodeURIComponent(assignmentId)}`);
    activeFeedbackRef = {
      assignmentId,
      claimId: bundle?.subject?.claim_id || null,
      candidateId: bundle?.subject?.candidate_id || null,
    };
    const workType = bundle.workType || bundle.work_type || button.dataset.workType;
    if (workType === "candidate_verification") {
      renderCandidateVerification(bundle, assignmentId);
    } else if (workType === "claim_adjudication") {
      renderClaimAdjudication(bundle, assignmentId);
    } else {
      throw new Error("This source-lead task is not part of the atomic claim reviewer workflow.");
    }
  } catch (error) {
    container.innerHTML = html`<div class="workspace-error" role="alert"><h2>Work unavailable</h2><p>${escapeHtml(error instanceof Error ? error.message : "This assigned work could not be loaded.")}</p></div>`;
  }
}

function renderCandidateVerification(bundle, assignmentId) {
  const container = document.querySelector("#review-private");
  const candidate = bundle.subject || bundle.candidate || bundle.item || {};
  const quote = candidate.exactQuote || candidate.exact_quote || candidate.quote || "Exact quotation unavailable.";
  const sourceTitle = candidate.sourceTitle || candidate.source_title || candidate.title || "Assigned source";
  const sourceUrl = safeHttpUrl(candidate.sourceUrl || candidate.source_url);
  const atomicReadiness = bundle.atomicReadiness || bundle.atomic_readiness || {};
  const locator = approximateClipLocator(candidate, atomicReadiness);
  const context = candidateValue(candidate, "boundedContext", "bounded_context", "contextExcerpt", "context_excerpt", "surroundingContext", "surrounding_context");
  container.innerHTML = html`<section aria-labelledby="review-title">
    ${stageRail("freeze")}
    <span class="status">Machine fallback: confirm the frozen test · private</span><h2 id="review-title">${escapeHtml(sourceTitle)}</h2>${leaseNote(bundle.assignment)}
    ${candidateAtGlance(candidate)}
    <div class="ai-warning" role="note"><span aria-hidden="true">AI</span><div><strong>This is not a verified claim.</strong><p>AI suggested this passage. Check it against the original source, and discard it if it is generic, missing an essential field, or not testable. AI suggestions may be discarded.</p></div></div>
    <section class="source-review-card" aria-labelledby="source-review-title"><span>Original source</span><h3 id="source-review-title">Verify the exact words and context</h3><blockquote>“${escapeHtml(quote)}”</blockquote><div class="source-locator"><strong>Approximate clip locator</strong><span>${escapeHtml(timestampLabel(locator))}</span>${sourceUrl ? `<a href="${escapeHtml(sourceUrlAt(sourceUrl, locator))}" rel="noreferrer">Open video near locator ↗</a>` : "<span>Source link unavailable</span>"}</div>${context ? `<details class="context-excerpt"><summary>Show bounded transcript context</summary><p>${escapeHtml(context)}</p></details>` : `<p class="context-excerpt">No context excerpt is attached. Watch before and after the locator and record what you checked.</p>`}</section>
    <dl class="candidate-meta"><div><dt>Person</dt><dd>${escapeHtml(candidate.person || candidate.person_name || "Not provided")}</dd></div><div><dt>Source date</dt><dd>${escapeHtml(candidate.sourceDate || candidate.source_date || "Not provided")}</dd></div><div><dt>Transcript status</dt><dd>AI-generated draft; check every word</dd></div><div><dt>Source</dt><dd>${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" rel="noreferrer">Open original source ↗</a>` : "Unavailable"}</dd></div></dl>
    <form id="candidate-form" class="review-form">
      <fieldset class="decision-gate"><legend>Choose a path</legend><p>Discard is the correct decision whenever the source does not explicitly state every essential detail.</p>
        <label class="decision-option"><input type="radio" name="decision" value="reject"><span><strong>Discard this suggestion</strong><small>Use for generic advice, missing essential details, invented meaning, or anything that cannot pass and fail on public evidence.</small></span></label>
        <button id="start-promotion" type="button" aria-controls="promotion-panel" aria-expanded="false">Check whether it can be promoted</button>
      </fieldset>
      <section id="reject-panel" class="reject-panel" hidden>
        <h3>Why should it be discarded?</h3>
        <label>Clear reason<select name="reasonCode" disabled required><option value="">Choose a reason</option><option value="generic_advice_or_commentary">Generic advice, encouragement, or commentary</option><option value="non_falsifiable">No observable way to prove it true or false</option><option value="missing_essential_context">Who, what, why, where, or when is not stated</option><option value="invented_causality_or_mechanism">A stated reason or mechanism was replaced with an invented one</option><option value="non_observable_mental_state">Depends on an unobservable thought, feeling, or motive</option><option value="invalid_quote">Quotation does not match the source</option><option value="context_changes_meaning">Surrounding context changes the meaning</option><option value="duplicate">Duplicates an existing claim</option><option value="insufficient_source_verification">Original source could not be verified</option></select></label>
      </section>
      <section id="promotion-panel" class="promotion-panel" hidden>
        <header><span>Promotion lock</span><h3>Build the claim only from the source</h3><p>Fill every required field with what the speaker or surrounding source explicitly states. “Not stated” blocks essential fields. How may remain open, but never infer it.</p></header>
        <fieldset><legend>Source checks</legend><label class="checkbox"><input type="checkbox" name="originalSourceVerified" data-promotion-control><span>The quotation matches the original source exactly.</span></label><label class="checkbox"><input type="checkbox" name="contextVerified" data-promotion-control><span>The surrounding context supports this reading without changing its meaning.</span></label><div class="review-field-grid"><label>Human-confirmed exact timestamp<input name="verifiedTimestampSeconds" type="number" min="0" step="1" data-promotion-control><small>Enter whole seconds after opening the original source. The AI locator is approximate.</small></label><label>Surrounding-context note<textarea name="contextNote" rows="3" data-promotion-control placeholder="State what you watched before and after the quote and whether it changes the meaning."></textarea></label></div></fieldset>
        <div class="review-field-grid"><label>Short claim title<input name="title" data-promotion-control placeholder="Plain-language title; do not copy an AI draft"></label><label>Statement type<select name="statementType" data-promotion-control><option value="">Choose only after checking</option><option value="testable_prediction">Testable prediction</option><option value="present_or_past_factual_claim">Present or past factual claim</option><option value="conditional_prediction">Conditional prediction</option></select></label></div>
        <label>Single testable statement<textarea name="atomicProposition" data-promotion-control rows="3" placeholder="One concrete statement that can be proven true or false."></textarea></label>
        <fieldset class="claim-elements"><legend>Who, what, why, where, when, and optional how</legend><p class="field-guidance">Who, what, why, where, and when need exact source support. How may be left blank and recorded as “not stated / mechanism remains open.” If a mechanism is stated, copy its exact support so it can be tested separately.</p>${claimElementFields()}</fieldset>
        <label>Bounded deadline<input name="deadline" data-promotion-control type="date"><small>Required for predictions. The source must ground the time window.</small></label>
        <fieldset class="evidence-test"><legend>Concrete public evidence test</legend><p class="field-guidance">Name public, observable evidence that can resolve the statement in either direction.</p>
          <label>Public evidence to check<textarea name="publicEvidence" data-promotion-control rows="3" placeholder="Name the public record, event, result, or measurement."></textarea></label><label>Source words supporting that test<textarea name="publicEvidenceSourceBasis" data-promotion-control rows="2" placeholder="Copy the exact quote or context that makes this the right evidence."></textarea></label>
          <div class="evidence-test-grid"><label>What would prove it true<textarea name="passCondition" data-promotion-control rows="3" placeholder="A concrete observable pass condition."></textarea></label><label>Source words supporting the pass condition<textarea name="passConditionSourceBasis" data-promotion-control rows="3" placeholder="Exact quote or context; no inference."></textarea></label><label>What would prove it false<textarea name="failCondition" data-promotion-control rows="3" placeholder="A concrete observable fail condition."></textarea></label><label>Source words supporting the fail condition<textarea name="failConditionSourceBasis" data-promotion-control rows="3" placeholder="Exact quote or context; no inference."></textarea></label></div>
        </fieldset>
      </section>
      <label id="decision-rationale" hidden>Reviewer reason<textarea name="rationale" disabled required minlength="10" rows="4" placeholder="Explain why the source should be discarded or why every promotion field is grounded."></textarea></label>
      <div id="promotion-lock" class="promotion-lock" hidden><div><strong id="promotion-summary">Promotion is locked.</strong><p id="promotion-missing">Complete every required source-grounded field above.</p></div><label class="decision-option"><input id="promote-decision" type="radio" name="decision" value="promote" disabled><span><strong>Promote to claim review</strong><small>This appends a human decision. It does not publish a claim.</small></span></label></div>
      <button id="candidate-submit" type="submit" disabled>Choose discard or complete promotion</button><p id="review-status" class="form-status" role="status" aria-live="polite"></p>
    </form></section>`;
  const form = document.querySelector("#candidate-form");
  form.addEventListener("submit", (event) => submitCandidate(event, assignmentId));
  const rejectPanel = form.querySelector("#reject-panel");
  const promotionPanel = form.querySelector("#promotion-panel");
  const rationale = form.querySelector("#decision-rationale");
  const promotionLock = form.querySelector("#promotion-lock");
  const promoteDecision = form.querySelector("#promote-decision");
  const submit = form.querySelector("#candidate-submit");
  const startPromotion = form.querySelector("#start-promotion");
  let promotionMode = false;

  const formValues = () => {
    const values = Object.fromEntries(new FormData(form).entries());
    values.originalSourceVerified = form.originalSourceVerified.checked;
    values.contextVerified = form.contextVerified.checked;
    return values;
  };
  const updateCandidateFields = () => {
    const rejecting = form.querySelector('[name="decision"][value="reject"]').checked;
    if (rejecting) promotionMode = false;
    rejectPanel.hidden = !rejecting;
    form.reasonCode.disabled = !rejecting;
    promotionPanel.hidden = !promotionMode;
    promotionLock.hidden = !promotionMode;
    startPromotion.setAttribute("aria-expanded", String(promotionMode));
    form.querySelectorAll("[data-promotion-control]").forEach((field) => {
      field.disabled = !promotionMode;
      field.required = promotionMode && field.name !== "deadline"
        && !field.hasAttribute("data-optional-promotion");
    });
    rationale.hidden = !rejecting && !promotionMode;
    form.rationale.disabled = !rejecting && !promotionMode;
    const values = formValues();
    form.deadline.required = promotionMode && values.statementType !== "present_or_past_factual_claim";
    const readiness = promotionMode ? promotionReadiness(values) : { ok: false, missing: [] };
    promoteDecision.disabled = !readiness.ok;
    if (!readiness.ok) promoteDecision.checked = false;
    form.querySelector("#promotion-summary").textContent = readiness.ok
      ? "Every required field is complete." : "Promotion is locked.";
    form.querySelector("#promotion-missing").textContent = readiness.ok
      ? "Review the source basis once more, then deliberately choose Promote."
      : `Still needed: ${readiness.missing.join(", ")}.`;
    promotionLock.classList.toggle("ready", readiness.ok);
    const decision = new FormData(form).get("decision");
    const rejectReady = decision === "reject" && groundedText(values.reasonCode)
      && groundedText(values.rationale) && String(values.rationale).trim().length >= 10;
    const promoteReady = decision === "promote" && readiness.ok;
    submit.disabled = !rejectReady && !promoteReady;
    submit.textContent = rejectReady ? "Append discard decision"
      : promoteReady ? "Append promotion decision" : promotionMode
        ? "Complete every required field, then choose Promote" : "Choose discard or check promotion";
  };
  startPromotion.addEventListener("click", () => {
    promotionMode = true;
    form.querySelectorAll('[name="decision"]').forEach((choice) => { choice.checked = false; });
    updateCandidateFields();
    promotionPanel.querySelector("input, select, textarea")?.focus();
  });
  form.addEventListener("input", updateCandidateFields);
  form.addEventListener("change", updateCandidateFields);
  updateCandidateFields();
}

const OUTCOME_LABELS = {
  true: "Happened", false: "Did not happen", partial: "Partly happened",
  pending: "Still pending", undetermined: "Undetermined", not_falsifiable: "Cannot be tested",
};

function renderClaimAdjudication(bundle, assignmentId) {
  const container = document.querySelector("#review-private");
  const claim = bundle.subject || bundle.claim || {};
  const draft = bundle.aiDraftDecision || null;
  const candidateDecisionFields = bundle.candidateDecisionFields || bundle.candidate_decision_fields || null;
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const receipts = Array.isArray(bundle.priorInformationReceipts) ? bundle.priorInformationReceipts
    : Array.isArray(bundle.receipts) ? bundle.receipts : [];
  const verifiedSeconds = claim.source_timestamp_seconds ?? claim.sourceTimestampSeconds ?? null;
  const verifiedOriginal = evidence.some((item) => (item.evidence_role || item.evidenceRole) === "original_statement"
    && ((item.verification_method || item.verificationMethod) === "authorized_transcript"
      || ((item.verification_method || item.verificationMethod) === "timestamp" && verifiedSeconds != null)));
  const sourceVerificationNote = verifiedOriginal
    ? `Original statement verified ${verifiedSeconds != null
      ? `near ${timestampLabel(verifiedSeconds)} in the original video`
      : "against an authorized transcript"}. Confirm the surrounding context yourself before deciding.`
    : (claim.transcript_warning || claim.transcriptWarning
      || "Verify the original statement and full context before submitting.");
  container.innerHTML = html`<section aria-labelledby="review-title">
    ${stageRail("outcome")}
    <span class="status">Human decision · private</span><h2 id="review-title">${escapeHtml(claim.title || claim.headline || "Assigned claim")}</h2>${leaseNote(bundle.assignment)}
    ${promotedCandidateAtGlance(candidateDecisionFields, claim)}
    <blockquote>“${escapeHtml(claim.exact_quote || claim.exactQuote || "Exact quotation unavailable.")}”</blockquote>
    ${sourceGrounding(candidateDecisionFields)}
    <p class="warning">${escapeHtml(sourceVerificationNote)}</p>
    <section class="ai-research" aria-labelledby="ai-research-title"><span class="lane-eyebrow">What the AI found</span><h3 id="ai-research-title">Research collected for this claim</h3><p>Every item links to its source. The lanes stay separate: prior information, independent outcome, and the speaker's own account, which is never proof.</p>${evidenceLanes(evidence)}</section>
    ${draft ? `<section class="ai-draft-card" aria-labelledby="ai-draft-title"><span class="lane-eyebrow">Pending AI decision · needs human review</span><h3 id="ai-draft-title">${escapeHtml(OUTCOME_LABELS[draft.outcomeStatus] || draft.outcomeStatus)}</h3><p>${escapeHtml(draft.reasoning)}</p><p class="draft-provenance">AI-drafted from the research above. It carries no weight until two independent humans decide.</p></section>` : `<aside class="load-warning" role="status"><strong>No pending AI decision.</strong><p>This claim has no AI draft yet, so it cannot be decided in the simple flow.</p></aside>`}
    ${claimFeedbackMarkup(claim.claim_id || claim.claimId || "")}
    <form id="review-form" class="review-form">
      ${draft ? `<fieldset class="verdict-choice"><legend>Your decision</legend>
      <label class="decision-option"><input type="radio" name="verdict" value="agree" required><span><strong>Accept the verdict</strong><small>The AI-verified evidence supports the pending decision: ${escapeHtml(OUTCOME_LABELS[draft.outcomeStatus] || draft.outcomeStatus)}.</small></span></label>
      <label class="decision-option"><input type="radio" name="verdict" value="disagree"><span><strong>Send it back</strong><small>The evidence is wrong, incomplete, or supports a different outcome — record why. That rejection becomes a research lesson and the claim returns for another pass.</small></span></label>
      </fieldset>
      <label id="disagree-outcome" hidden>What the evidence supports instead<select name="disagreeOutcome" disabled>${options([
        ["true", "Happened"], ["false", "Did not happen"], ["partial", "Partly happened"],
        ["pending", "Still pending"], ["undetermined", "Undetermined"], ["not_falsifiable", "Cannot be tested"],
      ])}</select></label>` : ""}
      <label>Why, in your words<textarea name="rationale" required minlength="10" rows="4" placeholder="One or two sentences. What in the evidence decides it?"></textarea></label>
      <p class="blind-note">Publishes only when a second reviewer, working blind, also accepts. Sending it back publishes nothing and records your reasons for the next research pass.</p>
      <button type="submit" ${draft ? "" : "disabled"}>Submit my decision</button><p id="review-status" class="form-status" role="status" aria-live="polite"></p>
    </form></section>`;
  const form = document.querySelector("#review-form");
  form.addEventListener("submit", (event) => submitReview(event, assignmentId));
  const disagreePanel = form.querySelector("#disagree-outcome");
  const updateVerdict = () => {
    const disagreeing = form.querySelector('input[name="verdict"][value="disagree"]')?.checked;
    if (disagreePanel) {
      disagreePanel.hidden = !disagreeing;
      form.disagreeOutcome.disabled = !disagreeing;
      form.disagreeOutcome.required = Boolean(disagreeing);
    }
  };
  form.addEventListener("change", updateVerdict);
  updateVerdict();
  bindClaimFeedbackThread(claim.claim_id || claim.claimId || "", assignmentId);
}

async function submitCandidate(event, assignmentId) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("#review-status");
  const button = form.querySelector("button[type='submit']");
  const data = new FormData(form);
  const body = candidateDecisionPayload({
    ...Object.fromEntries(data.entries()),
    originalSourceVerified: data.has("originalSourceVerified"),
    contextVerified: data.has("contextVerified"),
  });
  status.textContent = "Appending your candidate decision…";
  button.disabled = true;
  try {
    const result = await responseJson(await fetch(`/api/review/${encodeURIComponent(assignmentId)}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }));
    const id = result.decisionId || result.reviewId || "";
    if (!id && !result.state && !result.claimId) {
      throw new Error("The server did not confirm the candidate decision. Retry or send feedback.");
    }
    status.classList.add("success");
    status.textContent = result.message
      || `Saved. ${id ? `Decision ${id}. ` : ""}${result.claimId ? `Claim ${result.claimId}. ` : ""}${String(result.state || body.decision || "recorded").replaceAll("_", " ")}.`;
    await loadQueue();
  } catch (error) {
    status.classList.remove("success");
    status.textContent = error instanceof Error ? error.message : "The candidate decision could not be saved.";
    button.disabled = false;
  }
}

function decisionReceiptHtml({ sendingBack, result, rationale, hasNext = false }) {
  const rawState = String(result.publication?.state || result.state || "recorded");
  const state = rawState.replaceAll("_", " ");
  const published = /published|complete|matched/i.test(rawState);
  const reviewId = result.reviewId || "(missing)";
  const sendback = result.sendbackRecorded ? "yes — research will re-run with your lesson" : "no";
  const acceptMsg = published
    ? "Your acceptance matched an independent second review. This claim is now published. You will not see the other reviewer’s rationale (blinded)."
    : "Your acceptance is stored. Publication still needs a matching independent second review. You will not see another reviewer’s rationale (blinded).";
  return html`<div class="workspace-receipt" role="status">
    <span>OK</span>
    <h2>${sendingBack ? "Sent back for research" : (published ? "Published" : "Decision recorded")}</h2>
    <p><strong>Review id:</strong> <code>${escapeHtml(reviewId)}</code></p>
    <p><strong>Publication / queue state:</strong> ${escapeHtml(state)}</p>
    <p><strong>Research send-back recorded:</strong> ${escapeHtml(sendback)}</p>
    <p><strong>Your rationale:</strong> ${escapeHtml(String(rationale || "").slice(0, 400))}</p>
    <p>${sendingBack
      ? "Your rejection is stored as an append-only research lesson. A new AI draft will return to the queue after research. You will not see another reviewer’s rationale (blinded)."
      : acceptMsg}</p>
    <p class="form-status" id="receipt-advance-status">${hasNext
      ? "A next case is ready. Stay here until you have copied the review id if you need it."
      : "No other open case is waiting right now. Fresh drafts return after the research pass."}</p>
    ${hasNext ? `<p><button type="button" class="button-link" id="receipt-open-next">Open next case</button></p>` : ""}
  </div>`;
}

async function submitReview(event, claimId) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("#review-status");
  const button = form.querySelector("button[type='submit']");
  const data = new FormData(form);
  const body = { workType: "claim_adjudication", verdict: data.get("verdict"), rationale: data.get("rationale") };
  if (body.verdict === "disagree") body.disagreeOutcome = data.get("disagreeOutcome");
  const sendingBack = body.verdict === "disagree";
  status.textContent = sendingBack ? "Sending it back for research…" : "Recording your acceptance…";
  status.classList.remove("success");
  button.disabled = true;
  try {
    const result = await responseJson(await fetch(`/api/review/${encodeURIComponent(claimId)}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }));
    if (!result?.reviewId) {
      throw new Error("The server did not return a review id. Do not assume this was saved — retry or send feedback.");
    }
    if (sendingBack && result.sendbackRecorded !== true) {
      throw new Error("Review saved but research send-back was not recorded. Tell maintainers with this review id: " + result.reviewId);
    }
    status.classList.add("success");
    status.textContent = sendingBack
      ? `Sent back. Review ${result.reviewId}. Research lesson recorded. Showing receipt…`
      : `Accepted. Review ${result.reviewId}. State: ${String(result.publication?.state || "recorded").replaceAll("_", " ")}. Showing receipt…`;

    await loadQueue();
    const next = document.querySelector("#review-queue [data-assignment-id]:not(.active)")
      || document.querySelector("#review-queue [data-lease-work-item]")
      || document.querySelector("#review-queue [data-archive-work-item]");
    const panel = document.querySelector("#review-private");
    if (panel) {
      panel.innerHTML = decisionReceiptHtml({
        sendingBack, result, rationale: body.rationale, hasNext: Boolean(next),
      });
      panel.querySelector("#receipt-open-next")?.addEventListener("click", () => {
        const again = document.querySelector("#review-queue [data-assignment-id]:not(.active)")
          || document.querySelector("#review-queue [data-lease-work-item]")
          || document.querySelector("#review-queue [data-archive-work-item]");
        if (again) again.click();
        else {
          const statusEl = document.querySelector("#receipt-advance-status");
          if (statusEl) statusEl.textContent = "That next case is no longer open. Pick one from Your active work.";
        }
      });
    }
  } catch (error) {
    status.classList.remove("success");
    status.textContent = error instanceof Error ? error.message : "The review could not be saved.";
    button.disabled = false;
  }
}
