// Archive-to-review conveyor. When a human archive reviewer records a
// source_supported observation (exact quote confirmed, grounded 5W1H with
// source bases, pass/fail conditions), this bridge materializes the
// candidate lane rows so the freeze-or-discard queue receives the claim.
// The eligible assessment quotes the HUMAN observation verbatim and is
// attributed to it; the machine invents nothing. Every hash and offset is
// re-derived from the private R2 artifact at bridge time and the DB binding
// guard re-checks the whole chain on insert.
const GATE_VERSION = "archive_observation_v2";
const CLIP_LABEL = /\[CLIP (\d{2}):(\d{2}):(\d{2})-(\d{2}):(\d{2}):(\d{2})[^\]]*\]/g;

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableId(prefix, seed) {
  return `${prefix}_${(await sha256Hex(seed)).slice(0, 32)}`;
}

export function candidateVerificationWork(candidateId, createdAt) {
  const id = String(candidateId || "");
  if (!/^[A-Za-z0-9_-]{3,200}$/.test(id)) throw new Error("invalid_candidate_id");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("invalid_created_at");
  return {
    workItemId: `work_candidate_${id}`,
    candidateId: id,
    originKind: "private_extraction_candidate",
    workType: "candidate_verification",
    status: "ready",
    requiredMatchingReviews: 2,
    maxReviews: 2,
    createdAt,
  };
}

function seconds(h, m, s) { return Number(h) * 3600 + Number(m) * 60 + Number(s); }

function supportedDimension(text, section, field) {
  const value = String(field?.value || "").trim();
  const supportQuote = String(field?.sourceBasis || "").trim();
  if (!value || !supportQuote || !supportQuote.toLowerCase().includes(value.toLowerCase())) return null;
  const supportStart = text.indexOf(supportQuote, section.bodyStart);
  const supportEnd = supportStart + supportQuote.length;
  if (supportStart < section.bodyStart || supportEnd > section.bodyEnd) return null;
  return { value, supportQuote, supportStart, supportEnd };
}

function sections(text) {
  const labels = [...text.matchAll(CLIP_LABEL)];
  return labels.map((label, index) => {
    const bodyStart = label.index + label[0].length;
    const bodyEnd = index + 1 < labels.length ? labels[index + 1].index : text.length;
    return {
      index,
      bodyStart,
      bodyEnd,
      clipStart: seconds(label[1], label[2], label[3]),
      clipEnd: seconds(label[4], label[5], label[6]),
    };
  });
}

export async function matchedReceiptFor(db, archiveRevisionId, archiveVideoLinkId) {
  return db.prepare(
    `SELECT archive_match_check_id, transcript_id, source_item_id, prophecy_sha256,
      matcher_version, transcript_sha256, match_status, match_method, exact_quote,
      quote_start, quote_end, approximate_clip_start_seconds, created_at
     FROM archive_transcript_match_checks
     WHERE archive_revision_id=?1 AND archive_video_link_id=?2
       AND match_status IN ('matched_exact','matched_strict_normalized')
     ORDER BY created_at DESC, archive_match_check_id DESC LIMIT 1`
  ).bind(archiveRevisionId, archiveVideoLinkId).first();
}

export async function prepareSupportedObservationBridge(db, artifacts, {
  archiveRevisionId, archiveVideoLinkId, decisionId, observationId, decision,
  now = new Date().toISOString(),
}) {
  if (decision.decision !== "source_supported") return { bridged: false, reason: "not_supported_decision" };
  const receipt = await matchedReceiptFor(db, archiveRevisionId, archiveVideoLinkId);
  if (!receipt) return { bridged: false, reason: "no_matched_receipt" };
  if (decision.exactSourceQuote !== receipt.exact_quote) {
    return { bridged: false, reason: "review_quote_receipt_mismatch" };
  }
  const artifactRow = await db.prepare(
    `SELECT transcript_id, source_item_id, r2_key, content_sha256
     FROM transcript_artifacts WHERE transcript_id=?1`
  ).bind(receipt.transcript_id).first();
  if (!artifactRow || artifactRow.content_sha256 !== receipt.transcript_sha256) {
    return { bridged: false, reason: "artifact_receipt_mismatch" };
  }
  const object = artifacts ? await artifacts.get(artifactRow.r2_key) : null;
  if (!object) return { bridged: false, reason: "artifact_unavailable" };
  const text = await object.text();
  if ((await sha256Hex(text)) !== artifactRow.content_sha256) {
    return { bridged: false, reason: "artifact_hash_mismatch" };
  }
  const quoteStart = Number(receipt.quote_start);
  const quoteEnd = Number(receipt.quote_end);
  if (text.slice(quoteStart, quoteEnd) !== receipt.exact_quote
      && receipt.match_method === "exact_text_v1") {
    return { bridged: false, reason: "quote_offset_mismatch" };
  }
  const section = sections(text).find((candidate) =>
    quoteStart >= candidate.bodyStart && quoteEnd <= candidate.bodyEnd);
  if (!section) return { bridged: false, reason: "quote_outside_sections" };
  if (section.clipEnd - section.clipStart > 300 || section.clipEnd <= section.clipStart) {
    return { bridged: false, reason: "section_span_invalid" };
  }
  const sourceTimestampSeconds = decision.sourceTimestampSeconds ?? section.clipStart;
  if (!Number.isInteger(sourceTimestampSeconds)
      || sourceTimestampSeconds < section.clipStart || sourceTimestampSeconds >= section.clipEnd) {
    return { bridged: false, reason: "review_timestamp_outside_section" };
  }
  const sectionText = text.slice(section.bodyStart, section.bodyEnd);
  const sectionSha = await sha256Hex(sectionText);
  const elements = decision.elements || {};
  const dimensions = {};
  for (const name of ["who", "what", "why", "where", "when"]) {
    dimensions[name] = supportedDimension(text, section, elements[name]);
    if (!dimensions[name]) return { bridged: false, reason: `${name}_source_basis_offset_mismatch` };
  }
  if (decision.how) {
    dimensions.how = supportedDimension(text, section, decision.how);
    if (!dimensions.how) return { bridged: false, reason: "how_source_basis_offset_mismatch" };
  } else {
    dimensions.how = { value: "Not stated", supportQuote: null, supportStart: null, supportEnd: null };
  }
  const grounded = Object.values(dimensions).filter((field) => field.supportStart != null);
  const contextStart = Math.min(quoteStart, ...grounded.map((field) => field.supportStart));
  const contextEnd = Math.max(quoteEnd, ...grounded.map((field) => field.supportEnd));
  if (contextEnd - contextStart > 1_200 || contextEnd <= contextStart) {
    return { bridged: false, reason: "context_window_invalid" };
  }
  const sourceRow = await db.prepare(
    `SELECT source_item_id, person_id, platform, platform_item_id, canonical_url
     FROM source_items WHERE source_item_id=?1`
  ).bind(artifactRow.source_item_id).first();
  if (!sourceRow) return { bridged: false, reason: "source_missing" };
  if (!sourceRow.person_id || !sourceRow.platform
      || !sourceRow.platform_item_id || !sourceRow.canonical_url) {
    return { bridged: false, reason: "source_identity_incomplete" };
  }

  const ingestionRunId = await stableId("ing_ao", `${receipt.transcript_id}:${GATE_VERSION}`);
  const analysisRunId = await stableId("an_ao", `${receipt.transcript_id}:${GATE_VERSION}`);
  const sectionId = await stableId("sec_ao", `${receipt.transcript_id}:${GATE_VERSION}:${section.index}`);
  const extractionRunId = await stableId(
    "ext_ao", `${receipt.transcript_id}:${GATE_VERSION}:${section.index}`,
  );
  const candidateId = await stableId("cand_ao", observationId);
  const assessmentId = await stableId("aa_ao", observationId);
  const readinessId = await stableId("ready_ao", observationId);
  const sectionCount = sections(text).length || 1;
  const grounding = {
    contextStart,
    contextEnd,
    dimensions,
    provenance: "human_archive_observation",
    archiveDecisionId: decisionId,
    archiveObservationId: observationId,
    matchCheckId: receipt.archive_match_check_id,
    matcherVersion: receipt.matcher_version,
    exactSourceQuote: decision.exactSourceQuote,
    sourceBases: Object.fromEntries(Object.entries(elements).map(([name, value]) =>
      [name, value?.sourceBasis || null])),
    howSourceBasis: decision.how?.sourceBasis || null,
  };
  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO ingestion_runs
       (run_id, person_id, trigger_type, scope, status, started_at, completed_at, created_at)
       VALUES (?1, ?2, 'manual', ?3, 'complete', ?4, ?4, ?4)`
    ).bind(ingestionRunId, sourceRow.person_id,
      `transcript:archive_observation:${receipt.transcript_id}`, now),
    db.prepare(
      `INSERT OR IGNORE INTO transcript_analysis_runs
       (analysis_run_id, ingestion_run_id, transcript_id, source_item_id,
        transcript_sha256, prompt_version, section_count, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'partial', ?8)`
    ).bind(analysisRunId, ingestionRunId, receipt.transcript_id,
      artifactRow.source_item_id, artifactRow.content_sha256, GATE_VERSION,
      sectionCount, now),
    db.prepare(
      `INSERT OR IGNORE INTO extraction_runs
       (extraction_run_id, source_item_id, transcript_id, input_kind, input_sha256,
        prompt_version, model_family, status, started_at, completed_at)
       VALUES (?1, ?2, ?3, 'verified_transcript', ?4, ?5, 'human_archive_observation',
        'completed', ?6, ?6)`
    ).bind(extractionRunId, artifactRow.source_item_id, receipt.transcript_id,
      sectionSha, GATE_VERSION, now),
    db.prepare(
      `INSERT OR IGNORE INTO transcript_analysis_sections
       (analysis_section_id, analysis_run_id, section_index, input_sha256, base_offset,
        approximate_timestamp_seconds, extraction_run_id, status, attempt_count,
        completed_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'completed', 1, ?8, ?8)`
    ).bind(sectionId, analysisRunId, section.index, sectionSha, section.bodyStart,
      section.clipStart, extractionRunId, now),
    db.prepare(
      `INSERT INTO claim_candidates
       (candidate_id, extraction_run_id, source_item_id, candidate_kind, exact_quote,
        quote_start, quote_end, source_timestamp_seconds, proposed_statement_type,
        atomic_proposition_draft, explicit_deadline_text, requires_transcript,
        requires_human_review, created_at)
       VALUES (?1, ?2, ?3, 'exact_transcript_claim', ?4, ?5, ?6, ?7, NULL, ?8, NULL, 0, 1, ?9)`
    ).bind(candidateId, extractionRunId, artifactRow.source_item_id,
      receipt.exact_quote, quoteStart, quoteEnd,
      sourceTimestampSeconds,
      decision.exactSourceQuote, now),
    db.prepare(
      `INSERT INTO candidate_admissibility_assessments
       (assessment_id, candidate_id, gate_version, decision, who_text, what_text,
        why_text, where_text, when_text, how_text, how_specificity,
        public_evidence_text, pass_condition_text, fail_condition_text,
        grounding_json, rejection_codes_json, assessed_by, created_at)
       VALUES (?1, ?2, ?3, 'eligible', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
        ?14, '[]', ?15, ?16)`
    ).bind(assessmentId, candidateId, GATE_VERSION,
      elements.who?.value, elements.what?.value, elements.why?.value,
      elements.where?.value, elements.when?.value,
      decision.how?.value || "Not stated",
      decision.how ? "stated" : "not_stated",
      decision.publicEvidenceNote, decision.passConditionNote,
      decision.failConditionNote, JSON.stringify(grounding),
      `archive_observation:${observationId}`, now),
    db.prepare(
      `INSERT INTO candidate_atomic_readiness
       (readiness_id, candidate_id, analysis_section_id, transcript_id, source_item_id,
        gate_version, state, material_proposition_count, transcript_sha256,
        section_sha256, source_sha256, source_identity_json, quote_start, quote_end,
       context_start, context_end, section_start, section_end, clip_start_seconds,
        clip_end_seconds, support_offsets_json, reason_codes_json, assessed_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'review_ready', 1, ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, ?16, ?17, ?18, ?19, '[]', ?20, ?21)`
    ).bind(readinessId, candidateId, sectionId, receipt.transcript_id,
      artifactRow.source_item_id, GATE_VERSION, artifactRow.content_sha256,
      sectionSha, receipt.prophecy_sha256,
      JSON.stringify({
        personId: sourceRow.person_id,
        platform: sourceRow.platform,
        platformItemId: sourceRow.platform_item_id,
        canonicalUrl: sourceRow.canonical_url,
      }),
      quoteStart, quoteEnd, contextStart, contextEnd, section.bodyStart,
      section.bodyEnd, section.clipStart, section.clipEnd,
      JSON.stringify(dimensions), `archive_observation:${observationId}`, now),
  ];
  return {
    bridged: true, candidateId, readinessId, gateVersion: GATE_VERSION, statements,
  };
}

export async function bridgeSupportedObservation(db, artifacts, input) {
  const prepared = await prepareSupportedObservationBridge(db, artifacts, input);
  if (!prepared.bridged) return prepared;
  await db.batch(prepared.statements);
  const readback = await db.prepare(
    `SELECT readiness_id FROM review_ready_claim_candidates
     WHERE candidate_id=?1 AND readiness_id=?2`
  ).bind(prepared.candidateId, prepared.readinessId).first();
  if (readback?.readiness_id !== prepared.readinessId) {
    return { bridged: false, reason: "candidate_not_queue_visible" };
  }
  const { statements: _statements, ...result } = prepared;
  return result;
}
