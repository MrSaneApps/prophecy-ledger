const html = String.raw;

const CLAIM_ELEMENTS = [
  ["who", "Who", "Name the person, group, institution, or place affected.", true],
  ["what", "What", "State the observable event or condition being claimed.", true],
  ["why", "Why (if stated)", "Use only the reason the speaker explicitly gave, or leave blank.", false],
  ["where", "Where", "State the location or scope named in the source.", true],
  ["when", "When", "State the time window or source-grounded timing.", true],
  ["how", "How (if stated)", "Enter the speaker-stated mechanism, or leave blank when it remains open.", false],
];

const ARCHIVE_REQUIRED_TEXT = [
  ["exactSourceQuote", "exact source quotation"],
  ...CLAIM_ELEMENTS.filter(([, , , required]) => required).flatMap(([key, label]) => [
    [key, label.toLowerCase()], [`${key}SourceBasis`, `${label.toLowerCase()} exact source support`],
  ]),
  ["publicEvidenceNote", "public evidence to check"],
  ["passConditionNote", "what would pass"],
  ["failConditionNote", "what would fail"],
  ["rationale", "reviewer rationale"],
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function groundedText(value) {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.toLowerCase() !== "not stated";
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

export function archiveDecisionReadiness(values) {
  const decision = String(values.decision || "");
  const missing = [];
  if (!decision) return { ok: false, missing: ["decision"] };
  if (!groundedText(values.rationale) || String(values.rationale).trim().length < 10) {
    missing.push("reviewer rationale");
  }
  if (decision === "source_unavailable") {
    if (values.sourceAvailable || values.contextVerified || values.exactSourceVerified || values.testable) {
      missing.push("clear source checks for an unavailable source");
    }
    return { ok: missing.length === 0, missing };
  }
  if (!values.sourceAvailable) missing.push("source availability check");
  if (!values.contextVerified) missing.push("surrounding context check");
  if (decision === "archive_mismatch") {
    if (values.exactSourceVerified) missing.push("clear exact-source support for a mismatch");
    return { ok: missing.length === 0, missing };
  }
  if (!values.exactSourceVerified) missing.push("exact-source confirmation");
  if (decision === "not_testable") {
    if (!groundedText(values.exactSourceQuote)) missing.push("exact source quotation");
    if (values.testable) missing.push("clear testable for a not-testable decision");
    return { ok: missing.length === 0, missing };
  }
  if (decision !== "source_supported") return { ok: false, missing: ["valid decision"] };
  if (!values.testable) missing.push("testability check");
  for (const [key, label] of ARCHIVE_REQUIRED_TEXT) {
    if (!groundedText(values[key]) && !missing.includes(label)) missing.push(label);
  }
  if (groundedText(values.how) && !groundedText(values.howSourceBasis)) {
    missing.push("how exact source support");
  }
  if (groundedText(values.why) && !groundedText(values.whySourceBasis)) {
    missing.push("why exact source support");
  }
  if (groundedText(values.passConditionNote)
      && values.passConditionNote === values.failConditionNote) {
    missing.push("distinct pass and fail conditions");
  }
  return { ok: missing.length === 0, missing };
}

export function archiveDecisionPayload(values) {
  const body = { ...values, workType: "archive_lead_verification" };
  for (const key of ["sourceAvailable", "contextVerified", "exactSourceVerified", "testable"]) {
    body[key] = Boolean(values[key]);
  }
  body.sourceTimestampSeconds = groundedText(values.sourceTimestampSeconds)
    ? Number(values.sourceTimestampSeconds) : null;
  if (!groundedText(body.how)) {
    body.how = "";
    body.howSourceBasis = "";
  }
  if (!groundedText(body.why)) {
    body.why = "";
    body.whySourceBasis = "";
  }
  return body;
}

function archiveClaimElementFields() {
  return CLAIM_ELEMENTS.map(([key, label, prompt, required]) => html`<div class="claim-element">
    <label>${label}<textarea name="${key}" rows="2" data-archive-supported ${required ? "" : "data-archive-optional"} placeholder="${prompt}"></textarea></label>
    <label>Exact source support for ${label.toLowerCase()}<textarea name="${key}SourceBasis" rows="2" data-archive-supported ${required ? "" : "data-archive-optional"} placeholder="${required ? "Copy the exact source words. Do not infer." : "Required only when this source states a mechanism."}"></textarea></label>
  </div>`).join("");
}

function archiveLinks(links, { assigned = false } = {}) {
  if (!links.length) return html`<p>No links were preserved in this archive version.</p>`;
  return html`<ol class="archive-link-register">${links.map((link) => html`<li class="${assigned && link.assigned ? "assigned-source" : ""}"><span>${String(link.ordinal || 0).padStart(2, "0")}</span><a href="${escapeHtml(link.url)}" rel="noreferrer">${escapeHtml(link.label || link.url)} ↗</a>${assigned && link.assigned ? "<strong>Source under review</strong>" : ""}</li>`).join("")}</ol>`;
}

async function submitArchiveReview(event, assignmentId) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("#review-status");
  const button = form.querySelector("button[type='submit']");
  const data = new FormData(form);
  const body = archiveDecisionPayload({
    ...Object.fromEntries(data.entries()),
    sourceAvailable: data.has("sourceAvailable"),
    contextVerified: data.has("contextVerified"),
    exactSourceVerified: data.has("exactSourceVerified"),
    testable: data.has("testable"),
  });
  status.textContent = "Appending this source check…";
  button.disabled = true;
  try {
    const result = await responseJson(await fetch(`/api/review/archive/${encodeURIComponent(assignmentId)}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }));
    const id = result.decisionId || result.observationId || "";
    if (!id && !result.state && !result.decision) {
      throw new Error("The server did not confirm the source check. Retry or send feedback.");
    }
    status.classList.add("success");
    status.textContent = `Source check saved${id ? ` (${id})` : ""}: ${String(result.decision || result.state || "recorded").replaceAll("_", " ")}. No claim or rating was created.`;
    document.dispatchEvent(new CustomEvent("prophecy-ledger:review-saved"));
    const next = document.querySelector("#review-queue [data-archive-work-item], #review-queue [data-archive-assignment-id]");
    if (next) {
      const openNext = document.createElement("button");
      openNext.type = "button";
      openNext.id = "archive-open-next";
      openNext.textContent = "Open next source check";
      openNext.addEventListener("click", () => {
        const again = document.querySelector("#review-queue [data-archive-work-item], #review-queue [data-archive-assignment-id]");
        if (again) again.click();
        else status.textContent = "No other source check is waiting. Pick one from Your active work.";
      });
      status.insertAdjacentElement("afterend", openNext);
    }
  } catch (error) {
    status.classList.remove("success");
    status.textContent = error instanceof Error ? error.message : "The source check could not be saved.";
    button.disabled = false;
  }
}

export function renderArchiveVerification(bundle, assignmentId) {
  const container = document.querySelector("#review-private");
  const subject = bundle.subject || {};
  const assignedSource = bundle.assignedSourceVersion || {};
  const originalLinks = Array.isArray(bundle.originalVideoLinks) ? bundle.originalVideoLinks : [];
  const followUpLinks = Array.isArray(bundle.claimedFollowUpLinks) ? bundle.claimedFollowUpLinks : [];
  const evidenceLinks = Array.isArray(bundle.claimedEvidenceLinks) ? bundle.claimedEvidenceLinks : [];
  const versions = Array.isArray(bundle.archiveVersions) ? bundle.archiveVersions : [];
  container.innerHTML = html`<section aria-labelledby="review-title">
    <span class="status">First-party archive lead · private</span>
    <h2 id="review-title">${escapeHtml(subject.description_text || "Archive source check")}</h2>
    <div class="archive-review-warning" role="note"><strong>Not independent evidence.</strong><p>The prophecy, result, and evidence below are retrospective assertions supplied by the speaker’s archive. They do not establish fulfillment. This assignment checks only one original source version.</p></div>
    <section class="archive-at-glance" aria-labelledby="archive-glance-title"><span>At a glance</span><h3 id="archive-glance-title">What the archive says</h3><dl><div><dt>Description</dt><dd>${escapeHtml(subject.description_text || "Not provided")}</dd></div><div><dt>Date shared</dt><dd>${escapeHtml(subject.date_shared_text || "Not provided")}</dd></div><div><dt>Prophecy</dt><dd>${escapeHtml(subject.prophecy_text || "Not provided")}</dd></div></dl></section>
    <section class="archive-source-version" aria-labelledby="source-version-title"><span>One source version under review</span><h3 id="source-version-title">${escapeHtml(assignedSource.label || "Original video")}</h3><a href="${escapeHtml(assignedSource.url || "#")}" rel="noreferrer">Open this source version ↗</a><p>Use only this video and its surrounding context for this decision. Do not combine wording from the other videos.</p></section>
    <section class="archive-reference-section"><h3>All original-video links in this archive version</h3><p>Each link remains a separate source version. The teal-marked link is the only one assigned here.</p>${archiveLinks(originalLinks, { assigned: true })}</section>
    <section class="archive-follow-ups"><span>Speaker-linked follow-ups · not independent evidence</span><p>These links appeared in the archive’s Video Links column but were not explicitly labeled as prophecy sources. They remain first-party follow-ups and are never merged into the source under review.</p>${archiveLinks(followUpLinks)}</section>
    <section class="archive-assertions" aria-label="Speaker-claimed result and evidence"><article><span>Speaker-claimed result · not independently verified</span><p>${escapeHtml(subject.claimed_result_text || "No result text supplied")}</p></article><article><span>Speaker-claimed evidence · not independent evidence</span><p>${escapeHtml(subject.claimed_evidence_text || "No evidence text supplied")}</p>${archiveLinks(evidenceLinks)}</article></section>
    <section class="archive-version-list"><h3>Preserved archive snapshots</h3><p>The selected snapshot supplies the text above. Other hashes remain visible as preserved versions, not text to merge into this review.</p><ul>${versions.map((version) => `<li class="${version.selected ? "selected" : ""}"><strong>${version.selected ? "Selected snapshot" : "Preserved snapshot"}</strong><span>${escapeHtml(version.fetchedAt)}</span><code>${escapeHtml(version.contentSha256)}</code></li>`).join("")}</ul></section>
    <form id="archive-form" class="review-form archive-review-form">
      <fieldset class="decision-gate"><legend>Decision for this source version</legend><p>This appends a human source-check lead only. It cannot create a claim, promotion, fulfillment rating, or publication.</p>
        <label class="decision-option"><input type="radio" name="decision" value="source_supported"><span><strong>Source supports a testable statement</strong><small>The selected source and context explicitly support Who, What, Why, Where, When, and any stated How.</small></span></label>
        <label class="decision-option"><input type="radio" name="decision" value="archive_mismatch"><span><strong>Archive does not match this source</strong><small>The selected source is available, but its wording or context does not support the retrospective archive entry.</small></span></label>
        <label class="decision-option"><input type="radio" name="decision" value="not_testable"><span><strong>Not testable, or already public news</strong><small>Generic, non-observable, missing Who / What / Where / When, or current events dressed as prophecy. Use this when the “prediction” was already in the news or otherwise predictable.</small></span></label>
        <label class="decision-option"><input type="radio" name="decision" value="source_unavailable"><span><strong>Source is unavailable</strong><small>The assigned original source cannot be checked. Preserve the archive lead without guessing why.</small></span></label>
      </fieldset>
      <fieldset id="archive-source-checks"><legend>Original-source checks</legend><label class="checkbox"><input type="checkbox" name="sourceAvailable"><span>The assigned original source is available.</span></label><label class="checkbox"><input type="checkbox" name="contextVerified"><span>I checked enough surrounding context to preserve the source’s meaning.</span></label><label class="checkbox"><input type="checkbox" name="exactSourceVerified"><span>The archive reading matches the exact words in this source version.</span></label><label class="checkbox"><input type="checkbox" name="testable"><span>This source version states an observable proposition with distinct pass and fail conditions.</span></label></fieldset>
      <section id="archive-source-detail" class="archive-review-panel" hidden><div class="review-field-grid"><label>Exact source quotation<textarea name="exactSourceQuote" rows="4" placeholder="Copy the exact words from this one source version."></textarea></label><label>Timestamp in seconds, if found<input name="sourceTimestampSeconds" type="number" min="0" step="1" placeholder="Optional"></label></div></section>
      <section id="archive-supported-panel" class="promotion-panel" hidden><header><span>Exact-source grounding</span><h3>Record the testable statement</h3><p>Who, What, Where, and When must have exact support in this source version. Why and How stay open unless the speaker states them.</p></header><fieldset class="claim-elements"><legend>Who, what, where, when, and optional why / how</legend>${archiveClaimElementFields()}</fieldset><fieldset class="evidence-test"><legend>Future independent evidence test</legend><p class="field-guidance">These are reviewer notes about what independent public evidence would later resolve the statement. The speaker’s claimed result and evidence above do not count as independent.</p><label>Public evidence to check<textarea name="publicEvidenceNote" data-archive-supported rows="3"></textarea></label><div class="evidence-test-grid"><label>What would pass<textarea name="passConditionNote" data-archive-supported rows="3"></textarea></label><label>What would fail<textarea name="failConditionNote" data-archive-supported rows="3"></textarea></label></div></fieldset></section>
      <label>Reviewer rationale<textarea name="rationale" required minlength="10" rows="4" placeholder="Explain this decision from the selected source and context only."></textarea></label>
      <div id="archive-decision-lock" class="promotion-lock"><div><strong>Submission is locked.</strong><p>Choose a decision and complete its required source checks.</p></div></div>
      <button id="archive-submit" type="submit" disabled>Complete the source check</button>
      <p id="archive-missing-hint" class="form-status">Choose a decision first. The button names whatever is still missing.</p>
      <p id="review-status" class="form-status" role="status" aria-live="polite"></p>
    </form></section>`;
  const form = document.querySelector("#archive-form");
  const sourceDetail = form.querySelector("#archive-source-detail");
  const supportedPanel = form.querySelector("#archive-supported-panel");
  const lock = form.querySelector("#archive-decision-lock");
  const submit = form.querySelector("#archive-submit");
  const values = () => {
    const entries = Object.fromEntries(new FormData(form).entries());
    for (const key of ["sourceAvailable", "contextVerified", "exactSourceVerified", "testable"]) {
      entries[key] = form[key].checked;
    }
    return entries;
  };
  const update = () => {
    const current = values();
    const decision = current.decision || "";
    const unavailable = decision === "source_unavailable";
    const mismatch = decision === "archive_mismatch";
    const supported = decision === "source_supported";
    sourceDetail.hidden = !decision || unavailable;
    supportedPanel.hidden = !supported;
    form.sourceAvailable.disabled = unavailable;
    form.contextVerified.disabled = unavailable;
    form.exactSourceVerified.disabled = unavailable || mismatch;
    form.testable.disabled = !supported;
    if (unavailable) {
      form.sourceAvailable.checked = false;
      form.contextVerified.checked = false;
      form.exactSourceVerified.checked = false;
      form.testable.checked = false;
    } else if (mismatch) {
      form.exactSourceVerified.checked = false;
      form.testable.checked = false;
    } else if (decision === "not_testable") {
      form.testable.checked = false;
    }
    form.querySelectorAll("[data-archive-supported]").forEach((field) => {
      field.disabled = !supported;
      field.required = supported && !field.hasAttribute("data-archive-optional");
    });
    form.exactSourceQuote.required = supported || decision === "not_testable";
    const readiness = archiveDecisionReadiness(values());
    submit.disabled = !readiness.ok;
    lock.classList.toggle("ready", readiness.ok);
    lock.querySelector("strong").textContent = readiness.ok ? "Ready to append." : "Submission is locked.";
    const missingText = readiness.missing.join(", ");
    lock.querySelector("p").textContent = readiness.ok
      ? "Review the selected source once more, then save this source check."
      : `Still needed: ${missingText}.`;
    const hint = form.querySelector("#archive-missing-hint");
    if (hint) {
      hint.textContent = readiness.ok
        ? "All required checks are complete. Save this source check, then open the next one."
        : (missingText ? `Still needed: ${missingText}.` : "Choose a decision first.");
    }
    submit.textContent = readiness.ok
      ? "Save this source check"
      : readiness.missing.length
        ? `Still needed: ${readiness.missing[0]}${readiness.missing.length > 1 ? ` (+${readiness.missing.length - 1} more)` : ""}`
        : "Complete the source check";
  };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  form.addEventListener("submit", (event) => submitArchiveReview(event, assignmentId));
  update();
}
