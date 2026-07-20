import { renderArchiveVerification } from "./archive-review.js";
export { archiveDecisionPayload, archiveDecisionReadiness } from "./archive-review.js";

const html = String.raw;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function options(items) {
  return items.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
}

const CLAIM_ELEMENTS = [
  ["who", "Who", "Name the person, group, institution, or place affected.", true],
  ["what", "What", "State the observable event or condition being claimed.", true],
  ["why", "Why", "Use only the reason the speaker explicitly gave.", true],
  ["where", "Where", "State the location or scope named in the source.", true],
  ["when", "When", "State the time window or source-grounded timing.", true],
  ["how", "How (if stated)", "Enter the speaker-stated mechanism, or leave blank when it remains open.", false],
];

const PROMOTION_TEXT_FIELDS = [
  ["title", "short title"], ["statementType", "statement type"],
  ["atomicProposition", "single testable statement"],
  ...CLAIM_ELEMENTS.filter(([, , , required]) => required).flatMap(([key, label]) => [
    [key, label.toLowerCase()], [`${key}SourceBasis`, `${label.toLowerCase()} source words`],
  ]),
  ["publicEvidence", "public evidence"],
  ["publicEvidenceSourceBasis", "public evidence source words"],
  ["passCondition", "what would prove it true"],
  ["passConditionSourceBasis", "true-condition source words"],
  ["failCondition", "what would prove it false"],
  ["failConditionSourceBasis", "false-condition source words"],
  ["rationale", "reviewer reason"],
];

function groundedText(value) {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.toLowerCase() !== "not stated";
}

export function promotionReadiness(values) {
  const missing = PROMOTION_TEXT_FIELDS
    .filter(([key]) => !groundedText(values[key]))
    .map(([, label]) => label);
  if (!values.originalSourceVerified) missing.push("exact quote check");
  if (!values.contextVerified) missing.push("surrounding context check");
  const how = String(values.how ?? "").trim();
  if (groundedText(how) && !groundedText(values.howSourceBasis)) {
    missing.push("how source words");
  }
  if (values.statementType && values.statementType !== "present_or_past_factual_claim"
      && !groundedText(values.deadline)) missing.push("bounded deadline");
  return { ok: missing.length === 0, missing };
}

export function candidateDecisionPayload(values) {
  const body = { ...values, workType: "candidate_verification" };
  body.originalSourceVerified = Boolean(values.originalSourceVerified);
  body.contextVerified = Boolean(values.contextVerified);
  if (body.decision !== "promote") return body;
  if (!groundedText(body.how)) {
    body.how = "not stated";
    body.howSourceBasis = "";
  }
  body.claimElements = Object.fromEntries(CLAIM_ELEMENTS.map(([key]) => [key, {
    value: String(body[key] || "").trim(),
    sourceBasis: String(body[`${key}SourceBasis`] || "").trim(),
  }]));
  body.criteria = `Evidence that would prove true: ${String(values.passCondition || "").trim()}\nEvidence that would prove false: ${String(values.failCondition || "").trim()}`;
  return body;
}

function claimElementFields() {
  return CLAIM_ELEMENTS.map(([key, label, prompt, required]) => html`<div class="claim-element">
    <label>${label}<textarea name="${key}" rows="2" data-promotion-control ${required ? "" : "data-optional-promotion"} placeholder="${prompt}"></textarea></label>
    <label>Exact source words for ${label.toLowerCase()}<textarea name="${key}SourceBasis" rows="2" data-promotion-control ${required ? "" : "data-optional-promotion"} placeholder="${required ? "Copy the exact quote or nearby context. Do not infer." : "Required only when the speaker states a mechanism."}"></textarea></label>
  </div>`).join("");
}

function preservedElement(fields, key) {
  const value = fields?.claimElements?.[key]?.value || fields?.claim_elements?.[key]?.value
    || fields?.[key] || "Not available in this older review record";
  return key === "how" && String(value).trim().toLowerCase() === "not stated"
    ? "not stated / mechanism remains open" : value;
}

export function promotedCandidateAtGlance(fields) {
  if (!fields) return html`<div class="claim-at-glance legacy-framing"><span>At a glance</span><p>This older claim does not have a preserved source-grounded Who / What / Where / When / Why / How (if stated) frame. Do not infer the missing details.</p></div>`;
  return html`<div class="claim-at-glance"><span>At a glance</span><p class="claim-sentence"><strong>Who</strong> ${escapeHtml(preservedElement(fields, "who"))} <strong>will do What</strong> ${escapeHtml(preservedElement(fields, "what"))} <strong>Where</strong> ${escapeHtml(preservedElement(fields, "where"))} <strong>When</strong> ${escapeHtml(preservedElement(fields, "when"))} <strong>Why</strong> ${escapeHtml(preservedElement(fields, "why"))} <strong>How (if stated)</strong> ${escapeHtml(preservedElement(fields, "how"))}</p><div class="pass-fail"><p><strong>Pass if</strong>${escapeHtml(fields.passCondition || fields.pass_condition || "Not preserved")}</p><p><strong>Fail if</strong>${escapeHtml(fields.failCondition || fields.fail_condition || "Not preserved")}</p></div><p class="public-test"><strong>Public evidence</strong> ${escapeHtml(fields.publicEvidence || fields.public_evidence || "Not preserved")}</p></div>`;
}

function sourceGrounding(fields) {
  if (!fields?.claimElements) return "";
  const items = CLAIM_ELEMENTS.map(([key, label]) => html`<div><dt>${label}</dt><dd>${escapeHtml(fields.claimElements[key]?.sourceBasis || (key === "how" ? "Mechanism not stated; no source words required" : "Not preserved"))}</dd></div>`).join("");
  return html`<details class="source-grounding"><summary>Source words behind this frame</summary><dl>${items}<div><dt>Public evidence</dt><dd>${escapeHtml(fields.publicEvidenceSourceBasis || "Not preserved")}</dd></div><div><dt>Pass condition</dt><dd>${escapeHtml(fields.passConditionSourceBasis || "Not preserved")}</dd></div><div><dt>Fail condition</dt><dd>${escapeHtml(fields.failConditionSourceBasis || "Not preserved")}</dd></div></dl></details>`;
}

function assignmentId(assignment) {
  return String(assignment.assignmentId || assignment.assignment_id
    || assignment.claimId || assignment.claim_id || assignment.candidateId
    || assignment.candidate_id || assignment.id || "");
}

function assignmentType(assignment) {
  return assignment.workType || assignment.work_type || "claim_adjudication";
}

function principalLabel(principal) {
  return principal.displayName || principal.display_name || principal.email
    || principal.reviewerId || principal.reviewer_id || principal.id || "Verified reviewer";
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
    <header class="workspace-header"><div><p class="eyebrow"><span class="signal-dot"></span>Private review boundary</p><h1>Reviewer workspace</h1><p>Open only work assigned to you. Archive checks verify one original source at a time; claim reviews remain separate and require two matching independent reviewers before publication.</p></div><a class="button-link reviewer-sign-in" href="/review">Reviewer sign in</a></header>
    <section class="review-session" aria-label="Reviewer session"><span>Signed-in reviewer</span><strong id="reviewer-principal">Checking session…</strong><a id="reviewer-logout" hidden>Sign out</a></section>
    <div class="review-layout">
      <aside class="queue" aria-labelledby="queue-title"><h2 id="queue-title">Assigned work</h2><div class="queue-tabs" role="group" aria-label="Filter assigned work"><button type="button" class="active" data-work-filter="all">All</button><button type="button" data-work-filter="archive_lead_verification">Archive checks</button><button type="button" data-work-filter="candidate_verification">Verify candidates</button><button type="button" data-work-filter="claim_adjudication">Review claims</button></div><p id="queue-status" class="form-status" role="status" aria-live="polite">Loading your queue…</p><div id="review-queue"></div></aside>
      <section id="review-private" class="review-work" aria-live="polite"><div class="workspace-empty"><span>01</span><h2>Select assigned work</h2><p>The source record and the correct review form will appear here.</p></div></section>
    </div>
  </article>`;
  loadQueue();
}

async function loadQueue() {
  const status = document.querySelector("#queue-status");
  const queue = document.querySelector("#review-queue");
  try {
    const data = await responseJson(await fetch("/api/review/queue", {
      headers: { accept: "application/json" }, cache: "no-store",
    }));
    const assignments = Array.isArray(data.assignments) ? data.assignments
      : Array.isArray(data.items) ? data.items : [];
    document.querySelector("#reviewer-principal").textContent = data.principal
      ? principalLabel(data.principal) : "Verified Access reviewer";
    const logoutTarget = data.logoutTarget || data.logout_target
      || data.principal?.logoutTarget || data.principal?.logout_target;
    if (logoutTarget) {
      const logout = document.querySelector("#reviewer-logout");
      logout.href = logoutTarget;
      logout.hidden = false;
    }
    if (!assignments.length) {
      status.textContent = "No work is assigned to you right now.";
      queue.innerHTML = html`<p class="queue-empty">Your queue is clear.</p>`;
      return;
    }
    status.textContent = `${assignments.length} assigned ${assignments.length === 1 ? "item" : "items"}.`;
    queue.innerHTML = assignments.map((assignment, index) => {
      const id = assignmentId(assignment);
      const workType = assignmentType(assignment);
      const person = assignment.person || assignment.personName || assignment.person_name || "";
      const title = workType === "archive_lead_verification" ? assignment.title || "First-party archive source check"
        : workType === "candidate_verification" ? "AI suggestion to verify"
        : assignment.title || assignment.headline || assignment.claimTitle
          || assignment.claim_title || person || "Assigned review";
      const state = assignment.status || assignment.state || "Ready to review";
      const deadline = assignment.deadline ? ` · due ${assignment.deadline}` : "";
      const nextAction = assignment.nextAction || assignment.next_action || state;
      const label = workType === "archive_lead_verification" ? "Check one source version"
        : workType === "candidate_verification" ? "Check or discard" : "Review claim";
      return html`<button class="queue-item" type="button" data-assignment-id="${escapeHtml(id)}" data-work-type="${escapeHtml(workType)}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(title)}</strong>${person && person !== title ? `<small>${escapeHtml(person)}</small>` : ""}<small>${label} · ${escapeHtml(String(nextAction).replaceAll("_", " "))}${escapeHtml(deadline)}</small></button>`;
    }).join("");
    queue.querySelectorAll("[data-assignment-id]").forEach((button) => {
      button.addEventListener("click", () => loadAssignedItem(button.dataset.assignmentId, button));
    });
    document.querySelectorAll("[data-work-filter]").forEach((filter) => {
      filter.addEventListener("click", () => filterQueue(filter.dataset.workFilter, filter));
    });
    const requested = new URLSearchParams(location.search).get("claim");
    const requestedButton = requested ? [...queue.querySelectorAll("[data-assignment-id]")]
      .find((item) => item.dataset.assignmentId === requested) : null;
    requestedButton?.click();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "The reviewer queue could not be loaded.";
    queue.innerHTML = html`<a class="button-link" href="/review">Reviewer sign in</a>`;
  }
}

function filterQueue(workType, selected) {
  document.querySelectorAll("[data-work-filter]").forEach((filter) => filter.classList.remove("active"));
  selected.classList.add("active");
  let visible = 0;
  document.querySelectorAll(".queue-item").forEach((item) => {
    item.hidden = workType !== "all" && item.dataset.workType !== workType;
    if (!item.hidden) visible += 1;
  });
  document.querySelector("#queue-status").textContent = visible
    ? `${visible} ${visible === 1 ? "assignment" : "assignments"} shown.`
    : "No assignments match this filter.";
}

async function loadAssignedItem(assignmentId, button) {
  const container = document.querySelector("#review-private");
  document.querySelectorAll(".queue-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  container.innerHTML = html`<div class="workspace-empty"><span class="signal-dot"></span><h2>Loading assigned work…</h2></div>`;
  try {
    const bundle = await responseJson(await fetch(`/api/review/${encodeURIComponent(assignmentId)}`, {
      headers: { accept: "application/json" }, cache: "no-store",
    }));
    history.replaceState(null, "", `/review?claim=${encodeURIComponent(assignmentId)}`);
    const workType = bundle.workType || bundle.work_type || button.dataset.workType;
    if (workType === "archive_lead_verification") {
      renderArchiveVerification(bundle, assignmentId);
    } else if (workType === "candidate_verification") {
      renderCandidateVerification(bundle, assignmentId);
    } else {
      renderClaimAdjudication(bundle, assignmentId);
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
  container.innerHTML = html`<section aria-labelledby="review-title">
    <span class="status">AI suggestion · private</span><h2 id="review-title">${escapeHtml(sourceTitle)}</h2>
    <div class="ai-warning" role="note"><span aria-hidden="true">AI</span><div><strong>This is not a verified claim.</strong><p>AI suggested this passage. Check it against the original source, and discard it if it is generic, missing an essential field, or not testable. AI suggestions may be discarded.</p></div></div>
    <blockquote>“${escapeHtml(quote)}”</blockquote>
    <dl class="candidate-meta"><div><dt>Person</dt><dd>${escapeHtml(candidate.person || candidate.person_name || "Not provided")}</dd></div><div><dt>Source date</dt><dd>${escapeHtml(candidate.sourceDate || candidate.source_date || "Not provided")}</dd></div><div><dt>Transcript status</dt><dd>AI-generated draft; check every word</dd></div><div><dt>Source</dt><dd>${candidate.sourceUrl || candidate.source_url ? `<a href="${escapeHtml(candidate.sourceUrl || candidate.source_url)}" rel="noreferrer">Open original source ↗</a>` : "Unavailable"}</dd></div></dl>
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
        <fieldset><legend>Source checks</legend><label class="checkbox"><input type="checkbox" name="originalSourceVerified" data-promotion-control><span>The quotation matches the original source exactly.</span></label><label class="checkbox"><input type="checkbox" name="contextVerified" data-promotion-control><span>The surrounding context supports this reading without changing its meaning.</span></label></fieldset>
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

function renderClaimAdjudication(bundle, assignmentId) {
  const container = document.querySelector("#review-private");
  const claim = bundle.subject || bundle.claim || {};
  const candidateDecisionFields = bundle.candidateDecisionFields || bundle.candidate_decision_fields || null;
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  const receipts = Array.isArray(bundle.priorInformationReceipts) ? bundle.priorInformationReceipts
    : Array.isArray(bundle.receipts) ? bundle.receipts : [];
  container.innerHTML = html`<section aria-labelledby="review-title">
    <span class="status">Assigned · private</span><h2 id="review-title">${escapeHtml(claim.title || claim.headline || "Assigned claim")}</h2>
    ${promotedCandidateAtGlance(candidateDecisionFields)}
    <blockquote>“${escapeHtml(claim.exact_quote || claim.exactQuote || "Exact quotation unavailable.")}”</blockquote>
    ${sourceGrounding(candidateDecisionFields)}
    <p class="warning">${escapeHtml(claim.transcript_warning || claim.transcriptWarning || "Verify the original statement and full context before submitting.")}</p>
    <h3>Required before publication</h3><ul class="checklist"><li>Verified original statement cited</li><li>Deadline present for a testable prediction</li><li>Independent outcome evidence cited for true, false, or partial</li><li>Completed cutoff-bound receipt for assessed novelty</li><li>Exact structured match from a second authenticated reviewer</li></ul>
    <form id="review-form" class="review-form">
      <label>Claim type<select name="claimType">${options([
        ["testable_prediction", "Testable prediction"],
        ["present_or_past_factual_claim", "Present or past factual claim"],
        ["conditional_prediction", "Conditional prediction"],
        ["symbolic_statement", "Symbolic statement"],
        ["general_encouragement", "General encouragement"],
        ["theological_claim", "Theological claim"],
        ["personal_interpretation", "Personal interpretation"],
      ])}</select></label>
      <label>Outcome<select name="outcomeStatus">${options([
        ["undetermined", "Undetermined"], ["true", "True"], ["false", "False"],
        ["partial", "Partial"], ["pending", "Pending"], ["not_falsifiable", "Not falsifiable"],
      ])}</select></label>
      <label>Prior-information class<select name="noveltyStatus">${options([
        ["not_assessed", "Not assessed"], ["already_public", "Already public"],
        ["widely_expected", "Widely expected"], ["strong_signals", "Strong signals"],
        ["emerging_signals", "Emerging signals"], ["no_precursor_found", "No precursor found under documented search"],
      ])}</select></label>
      <label>Conservative baseline probability<input name="baselineProbability" type="number" min="0" max="1" step="0.01" placeholder="Leave empty when novelty is not assessed"></label>
      <label>Prior-information receipt<select name="priorReceiptId"><option value="">None / not assessed</option>${receipts.map((receipt) => `<option value="${escapeHtml(receipt.receipt_id || receipt.receiptId)}">${escapeHtml(receipt.receipt_id || receipt.receiptId)} · ${escapeHtml(receipt.status)}</option>`).join("")}</select></label>
      <fieldset><legend>Cited evidence</legend>${evidence.length ? evidence.map((item) => `<label class="checkbox"><input type="checkbox" name="evidenceIds" value="${escapeHtml(item.evidence_id || item.evidenceId)}"> <span>${escapeHtml(item.evidence_role || item.evidenceRole)} · ${escapeHtml(item.verification_method || item.verificationMethod)}</span></label>`).join("") : "<p>No evidence is available for this assignment.</p>"}</fieldset>
      <label>Rationale<textarea name="rationale" required rows="5" placeholder="Explain the criterion, evidence, and uncertainty."></textarea></label>
      <button type="submit">Append review</button><p id="review-status" class="form-status" role="status" aria-live="polite"></p>
    </form></section>`;
  document.querySelector("#review-form").addEventListener("submit", (event) => submitReview(event, assignmentId));
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
    status.textContent = result.message || `Candidate decision appended: ${String(result.state || body.decision).replaceAll("_", " ")}.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "The candidate decision could not be saved.";
    button.disabled = false;
  }
}

async function submitReview(event, claimId) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = form.querySelector("#review-status");
  const button = form.querySelector("button[type='submit']");
  const data = new FormData(form);
  const body = Object.fromEntries(data.entries());
  body.workType = "claim_adjudication";
  body.evidenceIds = data.getAll("evidenceIds");
  status.textContent = "Appending your review…";
  button.disabled = true;
  try {
    const result = await responseJson(await fetch(`/api/review/${encodeURIComponent(claimId)}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }));
    status.textContent = `Review appended. State: ${String(result.publication?.state || result.state || "recorded").replaceAll("_", " ")}.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "The review could not be saved.";
    button.disabled = false;
  }
}
