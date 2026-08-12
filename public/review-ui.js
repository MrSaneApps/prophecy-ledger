const html = String.raw;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

export function options(items) {
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
  ["verifiedTimestampSeconds", "human-confirmed exact timestamp"],
  ["contextNote", "surrounding-context note"],
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

export function groundedText(value) {
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

export function claimElementFields() {
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

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function citationHref(url, { excerpt = "", page = null } = {}) {
  const safe = safeHttpUrl(url);
  if (!safe) return "";
  if (/youtube\.com|youtu\.be/i.test(safe)) return safe;
  if (page != null && Number.isFinite(Number(page))) return `${safe}#page=${Math.max(1, Math.floor(Number(page)))}`;
  const text = String(excerpt || "").trim();
  if (!text) return safe;
  const encode = (value) => encodeURIComponent(value).replaceAll("-", "%2D");
  const words = text.split(/\s+/);
  const fragment = words.length > 10
    ? `${encode(words.slice(0, 5).join(" "))},${encode(words.slice(-4).join(" "))}`
    : encode(text);
  return `${safe}#:~:text=${fragment}`;
}

export function promotedCandidateAtGlance(fields, claim = null) {
  if (!fields && claim && (claim.atomic_proposition || claim.atomicProposition || claim.criteria)) {
    return html`<div class="claim-at-glance"><span>Frozen test under review</span><h3>${escapeHtml(claim.atomic_proposition || claim.atomicProposition || claim.title || "Not preserved")}</h3><div class="test-outcome-grid"><div><strong>Deadline</strong><p>${escapeHtml(claim.deadline || "Not stated")}</p></div><div><strong>What counts as pass or fail</strong><p>${escapeHtml(claim.criteria || "Not preserved")}</p></div><div><strong>Statement type</strong><p>${escapeHtml(String(claim.statement_type || claim.statementType || "Not classified").replaceAll("_", " "))}</p></div></div><p>This older claim has no preserved source-grounded Who / What / Where / When / Why / How frame. Judge only the frozen proposition above; do not infer missing details.</p></div>`;
  }
  if (!fields) return html`<div class="claim-at-glance legacy-framing"><span>At a glance</span><p>This older claim does not have a preserved source-grounded Who / What / Where / When / Why / How (if stated) frame. Do not infer the missing details.</p></div>`;
  return html`<div class="claim-at-glance"><span>Atomic proposition</span><h3>${escapeHtml(fields.atomicProposition || fields.atomic_proposition || "Not preserved")}</h3><p class="claim-sentence"><strong>Who</strong> ${escapeHtml(preservedElement(fields, "who"))} <strong>will do What</strong> ${escapeHtml(preservedElement(fields, "what"))} <strong>Where</strong> ${escapeHtml(preservedElement(fields, "where"))} <strong>When</strong> ${escapeHtml(preservedElement(fields, "when"))} <strong>Why</strong> ${escapeHtml(preservedElement(fields, "why"))} <strong>How (if stated)</strong> ${escapeHtml(preservedElement(fields, "how"))}</p><div class="test-outcome-grid"><div><strong>Deadline</strong><p>${escapeHtml(fields.deadline || "Not preserved")}</p></div><div><strong>Pass if</strong><p>${escapeHtml(fields.passCondition || fields.pass_condition || "Not preserved")}</p></div><div><strong>Fail if</strong><p>${escapeHtml(fields.failCondition || fields.fail_condition || "Not preserved")}</p></div></div><p class="public-test"><strong>Public evidence</strong> ${escapeHtml(fields.publicEvidence || fields.public_evidence || "Not preserved")}</p></div>`;
}

export function sourceGrounding(fields) {
  if (!fields?.claimElements) return "";
  const items = CLAIM_ELEMENTS.map(([key, label]) => html`<div><dt>${label}</dt><dd>${escapeHtml(fields.claimElements[key]?.sourceBasis || (key === "how" ? "Mechanism not stated; no source words required" : "Not preserved"))}</dd></div>`).join("");
  return html`<details class="source-grounding"><summary>Source words behind this frame</summary><dl>${items}<div><dt>Public evidence</dt><dd>${escapeHtml(fields.publicEvidenceSourceBasis || "Not preserved")}</dd></div><div><dt>Pass condition</dt><dd>${escapeHtml(fields.passConditionSourceBasis || "Not preserved")}</dd></div><div><dt>Fail condition</dt><dd>${escapeHtml(fields.failConditionSourceBasis || "Not preserved")}</dd></div></dl></details>`;
}

export function sourceUrlAt(sourceUrl, seconds) {
  const safe = safeHttpUrl(sourceUrl);
  if (!safe || !Number.isFinite(Number(seconds))) return safe;
  const url = new URL(safe);
  url.searchParams.set("t", `${Math.max(0, Math.floor(Number(seconds)))}s`);
  return url.href;
}

export function leaseNote(assignment) {
  const raw = assignment?.leaseExpiresAt || assignment?.lease_expires_at;
  const expires = raw ? new Date(raw) : null;
  if (!expires || Number.isNaN(expires.valueOf())) return "";
  const time = expires.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return html`<p class="lease-note" data-lease-expires="${escapeHtml(String(raw))}">Your private lease on this item holds until ${escapeHtml(time)} (<span data-lease-countdown></span>). If it lapses while you research, reopen it from the queue to renew, then submit.</p>`;
}

if (typeof document !== "undefined") setInterval(() => {
  document.querySelectorAll("[data-lease-expires]").forEach((note) => {
    const target = note.querySelector("[data-lease-countdown]");
    if (!target) return;
    const left = Math.floor((new Date(note.dataset.leaseExpires).valueOf() - Date.now()) / 1000);
    target.textContent = left > 0
      ? `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, "0")}s left`
      : "lapsed — reopen from the queue";
  });
}, 1_000);

export function timestampLabel(seconds) {
  if (!Number.isFinite(Number(seconds))) return "Not provided";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function candidateValue(candidate, ...keys) {
  const match = keys.find((key) => candidate?.[key] !== undefined && candidate?.[key] !== null);
  return match ? candidate[match] : "";
}

export function approximateClipLocator(candidate, atomicReadiness) {
  const subjectLocator = candidateValue(candidate,
    "approximateClipStartSeconds", "approximate_clip_start_seconds",
    "approximateTimestampSeconds", "approximate_timestamp_seconds",
    "sourceTimestampSeconds", "source_timestamp_seconds",
    "timestampSeconds", "timestamp_seconds", "startSeconds", "start_seconds");
  if (subjectLocator !== "") return subjectLocator;
  return candidateValue(atomicReadiness,
    "approximateClipStartSeconds", "approximate_clip_start_seconds");
}

export function stageRail(current) {
  const stages = [
    ["freeze", "Freeze source"], ["prior", "Research prior information"],
    ["outcome", "Evaluate outcome"], ["decision", "Decision"],
  ];
  const currentIndex = stages.findIndex(([key]) => key === current);
  return html`<nav class="stage-rail" aria-label="Claim review stages"><ol>${stages.map(([key, label], index) => `<li class="${index < currentIndex ? "complete" : index === currentIndex ? "current" : "pending"}" ${index === currentIndex ? 'aria-current="step"' : ""}><span class="stage-index">${String(index + 1).padStart(2, "0")}</span><strong class="stage-label">${label}</strong></li>`).join("")}</ol></nav>`;
}

export function candidateAtGlance(candidate) {
  const proposed = candidateValue(candidate, "atomicPropositionDraft", "atomic_proposition_draft", "atomicProposition", "atomic_proposition") || "No atomic proposition was extracted. Discard this suggestion unless the source states one.";
  const fields = candidate.claimElements || candidate.claim_elements || {};
  const element = (key) => fields[key]?.value || candidateValue(candidate, key, `${key}_text`) || "Not provided";
  const how = element("how");
  return html`<section class="atomic-review-card" aria-labelledby="atomic-proposition-title"><span>Atomic proposition to verify</span><h3 id="atomic-proposition-title">${escapeHtml(proposed)}</h3><p>AI-extracted draft. The source, not the draft, controls every word.</p><dl class="claim-elements-summary">${CLAIM_ELEMENTS.map(([key, label]) => `<div><dt>${label}</dt><dd>${escapeHtml(key === "how" && !groundedText(how) ? "Not stated / mechanism remains open" : element(key))}</dd></div>`).join("")}</dl><div class="test-outcome-grid"><div><strong>Deadline</strong><p>${escapeHtml(candidateValue(candidate, "deadline", "explicitDeadlineText", "explicit_deadline_text") || "Not provided")}</p></div><div><strong>Pass if</strong><p>${escapeHtml(candidateValue(candidate, "passCondition", "pass_condition", "pass_condition_text") || "Not provided")}</p></div><div><strong>Fail if</strong><p>${escapeHtml(candidateValue(candidate, "failCondition", "fail_condition", "fail_condition_text") || "Not provided")}</p></div></div></section>`;
}
