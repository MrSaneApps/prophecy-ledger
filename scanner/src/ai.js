const TRIAGE_CATEGORIES = new Set([
  "testable_prediction", "other_claimed_revelation", "encouragement_symbolism_theology", "not_enough_information",
]);
const STATEMENT_TYPES = new Set([
  "testable_prediction", "present_or_past_factual_claim", "conditional_prediction",
]);
const CLAIM_DIMENSIONS = ["who", "what", "why", "where", "when", "how"];
const REQUIRED_CLAIM_DIMENSIONS = new Set(["who", "what", "why", "where", "when"]);
const NOT_STATED = "not stated";
const NON_OBSERVABLE_MENTAL_STATE = /\b(?:understands?|knows?|believes?|feels?|thinks?|intends?|wants?|has insight)\b/i;
const VIDEO_STATEMENT_TYPES = new Set([
  "testable_prediction", "present_or_past_factual_claim", "conditional_prediction",
]);

const VIDEO_CLAIM_KEYS = [
  "atomicProposition", "confidence", "contextAfter", "contextBefore", "deadlineText",
  "endSeconds", "quote", "startSeconds", "statementType",
];

const VIDEO_CLAIM_TUPLE_KEYS = [
  "quote", "startSeconds", "endSeconds", "statementType", "atomicProposition",
  "deadlineText", "contextBefore", "contextAfter", "confidence",
];

const VIDEO_CLAIM_TUPLE_ITEMS = [
  { type: "string" }, { type: "integer" }, { type: "integer" },
  { type: "string", enum: [...VIDEO_STATEMENT_TYPES] },
  { type: "string" }, { type: ["string", "null"] }, { type: "string" },
  { type: "string" }, { type: "number" },
];

function videoClaimTupleSchema({ candidateId = false, support = false } = {}) {
  const prefixItems = [
    ...(candidateId ? [{ type: "string" }] : []),
    ...VIDEO_CLAIM_TUPLE_ITEMS,
    ...(support ? [{ type: "string", enum: ["primary", "verifier", "both", "neither"] }] : []),
  ];
  return { type: "array", minItems: prefixItems.length, maxItems: prefixItems.length, prefixItems };
}

const VIDEO_PRIMARY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["claims"],
  properties: {
    claims: {
      type: "array", maxItems: 25,
      items: videoClaimTupleSchema(),
    },
  },
};

function videoCheckSchema(candidateIds, includeSupport = false) {
  return {
    type: "object", additionalProperties: false, required: ["checks"],
    properties: {
      checks: {
        type: "array", minItems: candidateIds.length, maxItems: candidateIds.length,
        items: videoClaimTupleSchema({ candidateId: true, support: includeSupport }),
      },
    },
  };
}

const TRIAGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["category", "neutralParaphrase"],
  properties: {
    category: { type: "string", enum: [...TRIAGE_CATEGORIES] },
    neutralParaphrase: { type: ["string", "null"] },
  },
};

const CLAIM_SCHEMA = {
  type: "object", additionalProperties: false, required: ["candidates"],
  properties: {
    candidates: {
      type: "array", maxItems: 25,
      items: {
        type: "object", additionalProperties: false,
        required: ["quote", "start", "end", "contextStart", "contextEnd", "statementType",
          "atomicProposition", "deadlineText", "sourceTimestampSeconds", ...CLAIM_DIMENSIONS, "evidenceTest"],
        properties: {
          quote: { type: "string" }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 },
          contextStart: { type: "integer", minimum: 0 }, contextEnd: { type: "integer", minimum: 1 },
          statementType: { type: "string", enum: [...STATEMENT_TYPES] },
          atomicProposition: { type: "string" }, deadlineText: { type: ["string", "null"] },
          sourceTimestampSeconds: { type: ["integer", "null"], minimum: 0 },
          ...Object.fromEntries(CLAIM_DIMENSIONS.map((name) => [name, {
            type: "object", additionalProperties: false,
            required: ["value", "supportQuote", "supportStart", "supportEnd"],
            properties: {
              value: { type: "string" }, supportQuote: { type: ["string", "null"] },
              supportStart: { type: ["integer", "null"], minimum: 0 },
              supportEnd: { type: ["integer", "null"], minimum: 1 },
            },
          }])),
          evidenceTest: {
            type: "object", additionalProperties: false,
            required: ["publicEvidence", "passCondition", "failCondition"],
            properties: {
              publicEvidence: { type: "string" }, passCondition: { type: "string" },
              failCondition: { type: "string" },
            },
          },
        },
      },
    },
  },
};

function parsePayload(result) {
  const raw = result?.response ?? result;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") throw new Error("ai_missing_json");
  try { return JSON.parse(raw); } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("ai_invalid_json");
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error("ai_invalid_json"); }
  }
}

function retryableModelError(error) {
  const status = Number(error?.status || error?.cause?.status || 0);
  return error?.fallbackEligible === true ||
    ["invalid_json", "invalid_payload", "json_schema_unsupported", "model_unavailable", "provider_429", "provider_5xx"]
      .includes(error?.safeCauseCode) ||
    status === 429 || status >= 500 || /unavailable|not found|model|timeout/i.test(error?.message || "");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function cleanVideoClaim(value, { candidateId = false, support = false } = {}) {
  const expected = [...VIDEO_CLAIM_KEYS];
  if (candidateId) expected.push("candidateId");
  if (support) expected.push("supports");
  if (!exactKeys(value, expected)) throw new Error("gemini_invalid_claim_fields");
  if (candidateId && (typeof value.candidateId !== "string" || !value.candidateId)) throw new Error("gemini_invalid_candidate_id");
  if (support && !["primary", "verifier", "both", "neither"].includes(value.supports)) throw new Error("gemini_invalid_support");
  if (typeof value.quote !== "string" || !value.quote.trim() || value.quote.length > 2_000) throw new Error("gemini_invalid_quote");
  if (!Number.isInteger(value.startSeconds) || !Number.isInteger(value.endSeconds) ||
      value.startSeconds < 0 || value.endSeconds <= value.startSeconds || value.endSeconds > 43_200) {
    throw new Error("gemini_invalid_timestamp");
  }
  if (!VIDEO_STATEMENT_TYPES.has(value.statementType) || typeof value.atomicProposition !== "string" ||
      !value.atomicProposition.trim() || value.atomicProposition.length > 1_000) throw new Error("gemini_invalid_claim");
  if (value.deadlineText !== null && (typeof value.deadlineText !== "string" || value.deadlineText.length > 500)) throw new Error("gemini_invalid_deadline");
  if (value.statementType !== "present_or_past_factual_claim" && !value.deadlineText?.trim()) {
    throw new Error("gemini_prediction_deadline_required");
  }
  if (typeof value.contextBefore !== "string" || value.contextBefore.length > 2_000 ||
      typeof value.contextAfter !== "string" || value.contextAfter.length > 2_000) throw new Error("gemini_invalid_context");
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error("gemini_invalid_confidence");
  }
  return {
    ...(candidateId ? { candidateId: value.candidateId } : {}),
    quote: value.quote.trim(), startSeconds: value.startSeconds, endSeconds: value.endSeconds,
    statementType: value.statementType, atomicProposition: value.atomicProposition.trim(),
    deadlineText: value.deadlineText?.trim() || null, contextBefore: value.contextBefore.trim(),
    contextAfter: value.contextAfter.trim(), confidence: value.confidence,
    ...(support ? { supports: value.supports } : {}),
  };
}

function videoClaimFromTuple(value, { candidateId = false, support = false } = {}) {
  const keys = [
    ...(candidateId ? ["candidateId"] : []),
    ...VIDEO_CLAIM_TUPLE_KEYS,
    ...(support ? ["supports"] : []),
  ];
  if (!Array.isArray(value) || value.length !== keys.length) throw new Error("gemini_invalid_claim_fields");
  return Object.fromEntries(keys.map((key, index) => [key, value[index]]));
}

function tupleInstruction({ candidateId = false, support = false } = {}) {
  const keys = [
    ...(candidateId ? ["candidateId"] : []),
    ...VIDEO_CLAIM_TUPLE_KEYS,
    ...(support ? ["supports"] : []),
  ];
  return [
    `Encode every result as one JSON array in this exact positional order: [${keys.join(", ")}].`,
    `statementType must be exactly one of: ${[...VIDEO_STATEMENT_TYPES].join(", ")}.`,
    ...(support ? ["supports must be exactly one of: primary, verifier, both, neither."] : []),
  ].join(" ");
}

function interactionText(payload) {
  if (payload?.status !== "completed") throw new Error("gemini_incomplete_response");
  const text = (payload.steps || []).filter((step) => step?.type === "model_output")
    .flatMap((step) => step.content || []).filter((part) => part?.type === "text")
    .map((part) => part.text || "").join("");
  if (!text) throw new Error("gemini_missing_output");
  return text;
}

function sanitizedGatewayBody(bodyText, secrets) {
  let redacted = bodyText;
  for (const secret of secrets.filter(Boolean)) redacted = redacted.split(secret).join("[redacted]");
  try { return JSON.parse(redacted); }
  catch {
    return {
      nonJson: true, bodyExcerpt: redacted.slice(0, 4_096),
      bodyLength: redacted.length, truncated: redacted.length > 4_096,
    };
  }
}

function gatewayResult(response, raw, model) {
  return {
    raw, structured: null, model, interactionId: raw?.id || null,
    gatewayLogId: response.headers.get("cf-aig-log-id"), httpStatus: response.status,
  };
}

async function callGeminiInteraction({
  apiKey, gatewayAccountId, gatewayId, gatewayToken, useByok = false,
  model, input, systemInstruction = null, schema, strictJson = true,
  fetcher = fetch, timeoutMs = 90_000,
}) {
  if (!/^[a-f0-9]{32}$/.test(gatewayAccountId || "")) throw new Error("ai_gateway_account_invalid");
  if (!/^[a-z0-9-]{1,64}$/.test(gatewayId || "")) throw new Error("ai_gateway_id_invalid");
  if (!gatewayToken) throw new Error("ai_gateway_token_required");
  if (!useByok && !apiKey) throw new Error("gemini_key_required");
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(model || "")) throw new Error("gemini_model_required");
  const controller = new AbortController();
  const gatewayTimeoutMs = Math.max(1_000, timeoutMs - 1_000);
  const timer = setTimeout(() => controller.abort("gemini_timeout"), timeoutMs);
  let response; let bodyText;
  try {
    const endpoint = `https://gateway.ai.cloudflare.com/v1/${gatewayAccountId}/${gatewayId}/google-ai-studio/v1beta/interactions`;
    const headers = {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${gatewayToken}`,
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log-payload": "false",
      "cf-aig-max-attempts": "1",
      "cf-aig-request-timeout": String(gatewayTimeoutMs),
      ...(!useByok ? { "x-goog-api-key": apiKey } : {}),
    };
    response = await fetcher(endpoint, {
      method: "POST", signal: controller.signal, headers,
      body: JSON.stringify({
        model, store: false, input,
        ...(systemInstruction ? { system_instruction: systemInstruction } : {}),
        response_format: [{ type: "text", mime_type: "application/json",
          ...(schema ? { schema } : {}) }],
      }),
    });
    bodyText = await response.text();
  } catch (cause) {
    const error = new Error(cause?.name === "AbortError" || controller.signal.aborted ? "gemini_timeout" : "gemini_network_error");
    error.retryable = true; error.cause = cause; throw error;
  } finally { clearTimeout(timer); }
  const raw = sanitizedGatewayBody(bodyText, [apiKey, gatewayToken]);
  if (!response.ok) {
    const error = new Error([408, 504].includes(response.status) ? "gemini_timeout" : `gemini_http_${response.status}`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    error.geminiResult = gatewayResult(response, raw, model);
    throw error;
  }
  if (raw?.nonJson) {
    const error = new Error("gemini_invalid_response_json");
    error.geminiResult = gatewayResult(response, raw, model);
    throw error;
  }
  let structured;
  try {
    const outputText = interactionText(raw);
    structured = strictJson ? JSON.parse(outputText) : outputText;
  } catch (cause) {
    const error = new Error(cause?.message?.startsWith("gemini_") ? cause.message : "gemini_invalid_output_json");
    error.geminiResult = gatewayResult(response, raw, raw.model || model);
    error.cause = cause; throw error;
  }
  return {
    raw, structured, model: raw.model || model, interactionId: raw.id || null,
    gatewayLogId: response.headers.get("cf-aig-log-id"), httpStatus: response.status,
  };
}

export async function callGeminiVideo({
  apiKey, gatewayAccountId, gatewayId, gatewayToken, useByok = false,
  model, videoUrl, prompt, schema, fetcher = fetch, timeoutMs = 90_000,
}) {
  if (!/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(videoUrl || "")) throw new Error("gemini_invalid_video_url");
  return callGeminiInteraction({
    apiKey, gatewayAccountId, gatewayId, gatewayToken, useByok, model, schema, fetcher, timeoutMs,
    input: [{ type: "video", uri: videoUrl }, { type: "text", text: prompt }],
  });
}

export function primaryVideoPrompt() {
  return [
    "Watch the entire public video and extract only specific factual claims or prophecies that can be proven or disproven with public evidence.",
    "Ignore and omit all general encouragement, advice, prayer, exhortation, symbolism, theology, biblical interpretation, personal impressions without an observable claim, and vague statements such as something will change, a new season is coming, soon, or someday.",
    "A future or conditional prediction qualifies only when the speaker identifies an observable event and a bounded deadline or time window. A conditional prediction must also identify the trigger and the time allowed for the predicted result. Present or past factual claims may use a null deadline.",
    "For each qualifying candidate, transcribe the exact words as heard, give start and end timestamps in whole seconds, preserve the surrounding context, classify the statement type, and write one self-contained atomic proposition naming the subject, observable event, location or conditions when stated, and bounded time window. Copy the speaker's exact deadline wording into deadlineText.",
    "Do not judge truth, outcome, novelty, probability, character, motive, sincerity, prophetic office, fraud, or divine causation. Return an empty claims array when there are no checkable statements.",
    tupleInstruction(),
  ].join(" ");
}

export function verifierVideoPrompt(candidates) {
  return [
    "Independently watch the same public video and verify each proposed candidate below. Do not trust its quote, timestamps, context, deadline, type, or interpretation.",
    "Reject the premise rather than endorsing encouragement, advice, prayer, exhortation, symbolism, theology, biblical interpretation, vague future language, or any prediction without an observable event and bounded time window.",
    "Locate the segment yourself and return your own exact transcription, timestamps, context, statement type, self-contained atomic proposition, deadline wording, and confidence for every candidate ID.",
    "Do not judge truth, outcome, novelty, probability, character, motive, sincerity, prophetic office, fraud, or divine causation.",
    tupleInstruction({ candidateId: true }),
    JSON.stringify(candidates),
  ].join("\n");
}

export function tiebreakerVideoPrompt(disputes) {
  return [
    "Independently inspect the disputed segments in the same public video. For each candidate ID, return your own best transcription, timestamps, context, type, proposition, and deadline.",
    "Support neither when the segment is encouragement, advice, prayer, exhortation, symbolism, theology, biblical interpretation, vague future language, or a prediction without an observable event and bounded time window.",
    "Set supports to primary, verifier, both, or neither based only on what the video contains. Do not rate truth or make personal or theological judgments.",
    tupleInstruction({ candidateId: true, support: true }),
    JSON.stringify(disputes),
  ].join("\n");
}

export async function extractPublicVideoClaims(options) {
  const prompt = primaryVideoPrompt();
  const result = await callGeminiVideo({ ...options, prompt, schema: VIDEO_PRIMARY_SCHEMA });
  try {
    if (!exactKeys(result.structured, ["claims"]) || !Array.isArray(result.structured.claims) || result.structured.claims.length > 25) {
      throw new Error("gemini_invalid_claims");
    }
    const claims = result.structured.claims.map((claim) => cleanVideoClaim(videoClaimFromTuple(claim)));
    return { ...result, structured: { claims }, prompt, claims };
  } catch (error) {
    error.geminiResult = result;
    throw error;
  }
}

async function checkPublicVideoClaims(options, includeSupport) {
  const ids = options.candidates.map((candidate) => candidate.candidateId);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("gemini_invalid_candidate_set");
  const prompt = includeSupport ? tiebreakerVideoPrompt(options.candidates) : verifierVideoPrompt(options.candidates);
  const result = await callGeminiVideo({ ...options, prompt, schema: videoCheckSchema(ids, includeSupport) });
  try {
    if (!exactKeys(result.structured, ["checks"]) || !Array.isArray(result.structured.checks)) throw new Error("gemini_invalid_checks");
    const checks = result.structured.checks.map((claim) => cleanVideoClaim(
      videoClaimFromTuple(claim, { candidateId: true, support: includeSupport }),
      { candidateId: true, support: includeSupport },
    ));
    if (checks.length !== ids.length || new Set(checks.map((check) => check.candidateId)).size !== ids.length ||
        checks.some((check) => !ids.includes(check.candidateId))) throw new Error("gemini_incomplete_checks");
    return { ...result, structured: { checks }, prompt, checks };
  } catch (error) {
    error.geminiResult = result;
    throw error;
  }
}

export const verifyPublicVideoClaims = (options) => checkPublicVideoClaims(options, false);
export const tiebreakPublicVideoClaims = (options) => checkPublicVideoClaims(options, true);

function normalizedText(value) {
  return String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function levenshteinSimilarity(left, right) {
  const a = normalizedText(left), b = normalizedText(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prior = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(
      current[j - 1] + 1, prior[j] + 1, prior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
    );
    prior = current;
  }
  return 1 - prior[b.length] / Math.max(a.length, b.length);
}

function tokenSimilarity(left, right) {
  const a = new Set(normalizedText(left).split(" ").filter(Boolean));
  const b = new Set(normalizedText(right).split(" ").filter(Boolean));
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

function timestampOverlap(left, right) {
  const intersection = Math.max(0, Math.min(left.endSeconds, right.endSeconds) - Math.max(left.startSeconds, right.startSeconds));
  return intersection / Math.min(left.endSeconds - left.startSeconds, right.endSeconds - right.startSeconds);
}

export function compareVideoClaims(primary, check) {
  const quoteSimilarity = levenshteinSimilarity(primary.quote, check.quote);
  const overlap = timestampOverlap(primary, check);
  const deadlineAgreement = normalizedText(primary.deadlineText) === normalizedText(check.deadlineText);
  const statementTypeAgreement = primary.statementType === check.statementType;
  const meaningSimilarity = tokenSimilarity(primary.atomicProposition, check.atomicProposition);
  const reasons = [];
  if (quoteSimilarity < 0.85) reasons.push("quote_mismatch");
  if (overlap < 0.5) reasons.push("timestamp_mismatch");
  if (!deadlineAgreement) reasons.push("deadline_mismatch");
  if (!statementTypeAgreement) reasons.push("statement_type_mismatch");
  if (meaningSimilarity < 0.6) reasons.push("meaning_mismatch");
  return {
    quoteSimilarity, timestampOverlap: overlap, deadlineAgreement,
    statementTypeAgreement, meaningSimilarity, agrees: reasons.length === 0, reasons,
  };
}

export function createGeminiGatewayTextRunner({
  apiKey = null, gatewayAccountId, gatewayId, gatewayToken, useByok = false,
  fetcher = fetch,
}) {
  return {
    provider: "gemini-ai-gateway",
    async runAbortable(model, input, { timeoutMs, schema }) {
      const messages = Array.isArray(input?.messages) ? input.messages : [];
      const systemInstruction = messages.filter((message) => message?.role === "system")
        .map((message) => String(message.content || "")).filter(Boolean).join("\n\n");
      const userInput = messages.filter((message) => message?.role !== "system")
        .map((message) => `${String(message?.role || "user").toUpperCase()}:\n${String(message?.content || "")}`)
        .join("\n\n");
      if (!userInput) throw new Error("ai_missing_input");
      const responseSchema = input?.response_format?.type === "json_schema" ? schema : null;
      try {
        const result = await callGeminiInteraction({
          apiKey, gatewayAccountId, gatewayId, gatewayToken, useByok,
          model, input: userInput, systemInstruction, schema: responseSchema,
          strictJson: Boolean(responseSchema), fetcher, timeoutMs,
        });
        return result.structured;
      } catch (cause) {
        const status = Number(cause?.status || cause?.geminiResult?.httpStatus || 0);
        const providerError = cause?.geminiResult?.raw?.error;
        const providerStatus = String(providerError?.status || "");
        const providerMessage = String(providerError?.message || "").slice(0, 4_096);
        const schemaContractRejected = status === 400 && Boolean(responseSchema) &&
          providerStatus === "INVALID_ARGUMENT" &&
          (/\bresponse[_\s-]?format\b|\bresponse\s+schema\b/i.test(providerMessage) ||
           /\bschema\b.{0,120}\b(?:complex|unsupported|invalid|property|properties|additional)\b/i.test(providerMessage) ||
           /\b(?:complex|unsupported|invalid)\b.{0,120}\bschema\b/i.test(providerMessage));
        let message = cause?.message || "gemini_network_error";
        if (message === "gemini_timeout") message = "ai_timeout_confirmed";
        else if (schemaContractRejected) message = "json_schema_unsupported";
        else if (message === "gemini_invalid_response_json" || message === "gemini_invalid_output_json") message = "ai_invalid_json";
        else if (message === "gemini_incomplete_response" || message === "gemini_missing_output") message = "ai_invalid_payload";
        const error = new Error(message);
        error.status = status || undefined;
        // Gemini's Interactions API can return only the generic body
        // { error: { message: "Request contains an invalid argument." } } for a
        // rejected response schema. The mode and HTTP status are durable facts;
        // allow exactly one schema-free attempt without claiming the prose named
        // the schema. Plain mode never sets this flag, so this cannot recurse.
        error.schemaFallbackEligible = status === 400 && Boolean(responseSchema);
        error.retryable = cause?.retryable === true || status === 429 || status >= 500 ||
          ["ai_timeout_confirmed", "ai_invalid_json", "ai_invalid_payload"].includes(message);
        error.cause = cause;
        throw error;
      }
    },
  };
}

export function textAnalysisRuntime(env) {
  const gatewayModels = [env.GEMINI_ANALYSIS_MODEL, env.GEMINI_ANALYSIS_FALLBACK_MODEL].filter(Boolean);
  const timeout = Number(env.AI_TIMEOUT_MS);
  if (!gatewayModels.length) {
    return { ai: env.AI, models: [env.AI_MODEL, env.AI_FALLBACK_MODEL].filter(Boolean),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45_000 };
  }
  return {
    ai: createGeminiGatewayTextRunner({
      apiKey: env.AI_GATEWAY_BYOK === "1" ? null : env.GEMINI_API_KEY,
      gatewayAccountId: env.AI_GATEWAY_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID || "default",
      gatewayToken: env.AI_GATEWAY_TOKEN,
      useByok: env.AI_GATEWAY_BYOK === "1",
      fetcher: env.GEMINI_TEXT_FETCH || env.GEMINI_FETCH || fetch,
    }),
    models: gatewayModels,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45_000,
  };
}

async function runWithTimeout(ai, model, input, timeoutMs, schema) {
  if (typeof ai?.runAbortable === "function") {
    return ai.runAbortable(model, input, { timeoutMs, schema });
  }
  let timer;
  try {
    return await Promise.race([
      ai.run(model, input),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("ai_timeout");
          error.retryable = true;
          error.uncancelled = true;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function safeWorkersAiCause(error, mode = "json_schema") {
  const status = Number(error?.status || error?.cause?.status || 0);
  const message = String(error?.message || "");
  if (message === "ai_timeout_confirmed") return "ai_timeout_confirmed";
  if (message === "json_schema_unsupported") return "json_schema_unsupported";
  if (message === "ai_timeout" || message === "ai_timeout_unconfirmed") return "ai_timeout_unconfirmed";
  if (status === 429) return "provider_429";
  if (status >= 500) return "provider_5xx";
  if (/json mode couldn.?t be met|json[_ ]mode|json schema/i.test(message)) return "json_schema_unsupported";
  if (/ai_invalid_json|ai_missing_json/i.test(message)) return "invalid_json";
  if (/invalid_|missing_|payload|candidate|category/i.test(message)) return "invalid_payload";
  if (/unavailable|not found|model/i.test(message)) return "model_unavailable";
  return mode === "plain_json" && /json/i.test(message) ? "invalid_json" : "unknown_provider_error";
}

function payloadTypeMatches(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  });
}

function validateRequiredPayload(payload, schema) {
  if (!payloadTypeMatches(payload, schema?.type)) throw new Error("ai_invalid_payload");
  for (const key of schema.required || []) {
    const valid = Object.prototype.hasOwnProperty.call(payload, key) &&
      payloadTypeMatches(payload[key], schema.properties?.[key]?.type);
    if (!valid) {
      throw new Error(key === "candidates" ? "ai_invalid_candidates" : "ai_invalid_payload");
    }
  }
}

const STRUCTURED_OUTPUT_MAX_TOKENS = 16_384;

async function structured(ai, { models, messages, schema, timeoutMs = 45_000,
  maxTokens = STRUCTURED_OUTPUT_MAX_TOKENS, onAttempt = null }) {
  let last;
  let ordinal = 0;
  const emitAttempt = async (receipt) => {
    if (!onAttempt) return;
    try { await onAttempt({ ...receipt, providerName: ai?.provider || "workers-ai" }); }
    catch (cause) {
      const error = new Error("workers_ai_attempt_receipt_failed");
      error.code = "workers_ai_attempt_receipt_failed";
      error.retryable = true;
      error.receiptPersistenceFailure = true;
      error.cause = cause;
      throw error;
    }
  };
  const attempt = async (model, mode, input) => {
    const currentOrdinal = ordinal; ordinal += 1;
    const started = Date.now(); const startedAt = new Date(started).toISOString();
    await emitAttempt({ modelName: model, mode, ordinal: currentOrdinal,
      status: "started", safeCauseCode: null, httpStatus: null, fallbackEligible: false,
      startedAt, completedAt: null, latencyMs: null });
    let payload;
    try {
      payload = parsePayload(await runWithTimeout(ai, model, input, timeoutMs, schema));
      validateRequiredPayload(payload, schema);
    } catch (error) {
      const completed = Date.now(); const safeCauseCode = safeWorkersAiCause(error, mode);
      const fallbackEligible = safeCauseCode !== "ai_timeout_unconfirmed" &&
        (error.schemaFallbackEligible === true || safeCauseCode === "provider_429" ||
         safeCauseCode === "provider_5xx" ||
         safeCauseCode === "model_unavailable" || safeCauseCode === "json_schema_unsupported" ||
         safeCauseCode === "invalid_json" || safeCauseCode === "invalid_payload" ||
         safeCauseCode === "ai_timeout_confirmed");
      error.safeCauseCode = safeCauseCode; error.fallbackEligible = fallbackEligible;
      await emitAttempt({ modelName: model, mode, ordinal: currentOrdinal,
        status: "failed", safeCauseCode,
        httpStatus: Number(error?.status || error?.cause?.status || 0) || null,
        fallbackEligible, startedAt, completedAt: new Date(completed).toISOString(),
        latencyMs: completed - started });
      throw error;
    }
    const completed = Date.now();
    await emitAttempt({ modelName: model, mode, ordinal: currentOrdinal,
      status: "completed", safeCauseCode: null, httpStatus: null, fallbackEligible: false,
      startedAt, completedAt: new Date(completed).toISOString(), latencyMs: completed - started });
    return payload;
  };
  for (const model of models.filter(Boolean)) {
    try {
      const payload = await attempt(model, "json_schema", {
        messages, temperature: 0, max_tokens: maxTokens,
        response_format: { type: "json_schema", json_schema: schema },
      });
      return { payload, model, provider: ai?.provider || "workers-ai" };
    } catch (error) {
      last = error;
      const safeCauseCode = error?.safeCauseCode || safeWorkersAiCause(error);
      console.warn("workers_ai_structured_failed", { model, safeCauseCode,
        httpStatus: Number(error?.status || error?.cause?.status || 0) || null });
      if (error.receiptPersistenceFailure) {
        const failure = new Error("ai_unavailable"); failure.code = error.code;
        failure.retryable = true; failure.cause = error; throw failure;
      }
      if (error.safeCauseCode === "ai_timeout_unconfirmed") {
        const failure = new Error("ai_unavailable"); failure.code = error.safeCauseCode;
        failure.retryable = true; failure.cause = error; throw failure;
      }
      if (error.schemaFallbackEligible === true ||
          ["json_schema_unsupported","invalid_json","invalid_payload"].includes(error.safeCauseCode)) {
        try {
          const payload = await attempt(model, "plain_json", {
            messages: [{ role: "system", content: `Return only valid JSON matching this schema: ${JSON.stringify(schema)}` }, ...messages],
            temperature: 0, max_tokens: maxTokens,
          });
          return { payload, model, provider: ai?.provider || "workers-ai" };
        } catch (plainError) {
          last = plainError;
          const safeCauseCode = plainError?.safeCauseCode || safeWorkersAiCause(plainError, "plain_json");
          console.warn("workers_ai_plain_json_failed", { model, safeCauseCode,
            httpStatus: Number(plainError?.status || plainError?.cause?.status || 0) || null });
          if (plainError.receiptPersistenceFailure) {
            const failure = new Error("ai_unavailable"); failure.code = plainError.code;
            failure.retryable = true; failure.cause = plainError; throw failure;
          }
          if (plainError.safeCauseCode === "ai_timeout_unconfirmed") {
            const failure = new Error("ai_unavailable"); failure.code = plainError.safeCauseCode;
            failure.retryable = true; failure.cause = plainError; throw failure;
          }
        }
      }
      if (!retryableModelError(last)) break;
    }
  }
  const failure = new Error("ai_unavailable");
  failure.code = last?.safeCauseCode || safeWorkersAiCause(last);
  failure.retryable = retryableModelError(last);
  failure.cause = last;
  throw failure;
}

export async function triageDescription(ai, { title, description, models, timeoutMs = 45_000,
  onAttempt = null }) {
  if (!description?.trim()) return { status: "not_enough_information", category: "not_enough_information", neutralParaphrase: null, model: null };
  const { payload, model, provider } = await structured(ai, {
    models, schema: TRIAGE_SCHEMA, name: "description_triage", timeoutMs, onAttempt,
    messages: [
      { role: "system", content: "Classify only the supplied first-party title and description. This is a lead for human research, not a quotation, verdict, or truth rating. Paraphrase neutrally and return null when there is not enough information." },
      { role: "user", content: JSON.stringify({ title, description }) },
    ],
  });
  if (!TRIAGE_CATEGORIES.has(payload.category)) throw new Error("ai_invalid_category");
  const paraphrase = typeof payload.neutralParaphrase === "string" ? payload.neutralParaphrase.trim() : null;
  if (payload.category !== "not_enough_information" && !paraphrase) throw new Error("ai_missing_paraphrase");
  return { status: "completed", category: payload.category, neutralParaphrase: paraphrase, model, provider };
}

function exactSpan(text, quote, start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start &&
    text.slice(start, end) === quote;
}

function uniqueSpan(text, quote) {
  if (!quote) return null;
  const first = text.indexOf(quote);
  if (first < 0 || text.indexOf(quote, first + 1) >= 0) return null;
  return { start: first, end: first + quote.length };
}

export async function extractTranscriptClaims(ai, { transcript, models, timeoutMs = 45_000, onAttempt = null }) {
  if (!transcript?.trim()) throw new Error("transcript_required");
  const { payload, model, provider } = await structured(ai, {
    models, schema: CLAIM_SCHEMA, name: "transcript_claim_candidates", timeoutMs, onAttempt,
    messages: [
      { role: "system", content: "Extract only concrete public statements that can be checked true or false with public evidence. For each suggestion, extract who, what, why, where, when, and how from one bounded passage around the exact quote. Each stated dimension must contain the speaker's verbatim wording plus exact character offsets. Use the literal value 'Not stated' with null support when the passage does not explicitly state a dimension. Who, what, why, where, and when are essential. How is optional because a prediction may not reveal its mechanism; preserve it as 'Not stated' rather than inferring it. Never infer or invent a missing subject, place, time, cause, rationale, mechanism, intent, belief, knowledge, or relationship. Why must be speaker-stated. How, when present, must also be speaker-stated and becomes separately testable. Also provide the public evidence to inspect and separate concrete pass and fail conditions without adding facts absent from the passage. A suggestion with any essential 'Not stated' field will be rejected before the reviewer queue. Omit general encouragement, advice, commentary, prayer, exhortation, symbolism, theology, biblical interpretation, rhetorical or hypothetical speech, internal mental-state claims, vague future language, and predictions without a bounded deadline. The candidate context must be at most 1,200 characters and must contain the exact quote. A prediction's deadline must be verbatim in that same context. Every quote, context, support quote, and character offset must exactly match the supplied transcript. Do not judge truth, novelty, probability, character, motive, sincerity, prophetic status, fraud, or divine causation. Return an empty candidates array when nothing qualifies." },
      { role: "user", content: transcript },
    ],
  });
  if (!Array.isArray(payload.candidates)) throw new Error("ai_invalid_candidates");
  const seen = new Set();
  const candidates = [];
  const assessments = [];
  const rejectionCodes = [];
  let rejectedCandidateCount = 0;
  let correctedOffsetCount = 0;
  for (const item of payload.candidates) {
    if (!item || typeof item.quote !== "string" || !Number.isInteger(item.start) || !Number.isInteger(item.end)) {
      rejectionCodes.push("invalid_offsets"); rejectedCandidateCount += 1; continue;
    }
    let candidateOffsetsCorrected = false;
    let start = item.start; let end = item.end;
    if (!exactSpan(transcript, item.quote, start, end)) {
      const repaired = uniqueSpan(transcript, item.quote);
      if (!repaired) {
        rejectionCodes.push(transcript.includes(item.quote) ? "ambiguous_quote" : "quote_not_in_transcript"); rejectedCandidateCount += 1; continue;
      }
      start = repaired.start; end = repaired.end; candidateOffsetsCorrected = true;
    }
    if (!STATEMENT_TYPES.has(item.statementType) || !item.atomicProposition?.trim()) {
      if (candidateOffsetsCorrected) correctedOffsetCount += 1;
      rejectionCodes.push("invalid_candidate"); rejectedCandidateCount += 1; continue;
    }
    if (item.sourceTimestampSeconds !== null && (!Number.isInteger(item.sourceTimestampSeconds) || item.sourceTimestampSeconds < 0)) {
      if (candidateOffsetsCorrected) correctedOffsetCount += 1;
      rejectionCodes.push("invalid_timestamp"); rejectedCandidateCount += 1; continue;
    }
    const reasons = [];
    let contextStart = item.contextStart; let contextEnd = item.contextEnd;
    const grounding = {};
    for (const name of CLAIM_DIMENSIONS) {
      const field = item[name]; const value = typeof field?.value === "string" ? field.value.trim() : "";
      const supportQuote = typeof field?.supportQuote === "string" ? field.supportQuote : null;
      let supportStart = field?.supportStart; let supportEnd = field?.supportEnd;
      if (!value || value.toLowerCase() === NOT_STATED) {
        if (REQUIRED_CLAIM_DIMENSIONS.has(name)) reasons.push(`essential_not_stated_${name}`);
        grounding[name] = { value: value || "Not stated", supportQuote: null, supportStart: null, supportEnd: null };
        continue;
      }
      if (supportQuote && !exactSpan(transcript, supportQuote, supportStart, supportEnd)) {
        const repaired = uniqueSpan(transcript, supportQuote);
        if (repaired) {
          supportStart = repaired.start; supportEnd = repaired.end; candidateOffsetsCorrected = true;
        }
      }
      if (!supportQuote || !exactSpan(transcript, supportQuote, supportStart, supportEnd)) {
        reasons.push(`invalid_grounding_${name}`);
      } else if (!supportQuote.toLocaleLowerCase("en-US").includes(value.toLocaleLowerCase("en-US"))) {
        reasons.push(`ungrounded_value_${name}`);
      }
      grounding[name] = { value, supportQuote, supportStart, supportEnd };
    }
    const groundedSpans = Object.values(grounding).filter((field) =>
      field.supportQuote && exactSpan(transcript, field.supportQuote, field.supportStart, field.supportEnd));
    const contextContainsEvidence = Number.isInteger(contextStart) && Number.isInteger(contextEnd) &&
      contextStart >= 0 && contextEnd > contextStart && contextEnd - contextStart <= 1_200 &&
      start >= contextStart && end <= contextEnd && groundedSpans.every((field) =>
        field.supportStart >= contextStart && field.supportEnd <= contextEnd);
    if (!contextContainsEvidence) {
      const repairedStart = Math.min(start, ...groundedSpans.map((field) => field.supportStart));
      const repairedEnd = Math.max(end, ...groundedSpans.map((field) => field.supportEnd));
      if (repairedEnd - repairedStart <= 1_200) {
        contextStart = repairedStart; contextEnd = repairedEnd; candidateOffsetsCorrected = true;
      } else reasons.push("invalid_context");
    }
    const evidence = item.evidenceTest;
    const publicEvidence = typeof evidence?.publicEvidence === "string" ? evidence.publicEvidence.trim() : "";
    const passCondition = typeof evidence?.passCondition === "string" ? evidence.passCondition.trim() : "";
    const failCondition = typeof evidence?.failCondition === "string" ? evidence.failCondition.trim() : "";
    if (!publicEvidence || !passCondition || !failCondition || passCondition === failCondition ||
        [publicEvidence, passCondition, failCondition].some((value) => value.toLowerCase() === NOT_STATED)) {
      reasons.push("evidence_test_incomplete");
    }
    if (NON_OBSERVABLE_MENTAL_STATE.test(`${item.quote} ${item.atomicProposition}`)) {
      reasons.push("non_observable_mental_state");
    }
    if (item.statementType !== "present_or_past_factual_claim") {
      const deadline = item.deadlineText?.trim(); const whenSupport = grounding.when?.supportQuote;
      if (!deadline) reasons.push("prediction_deadline_required");
      else if (!whenSupport || !whenSupport.toLocaleLowerCase("en-US").includes(deadline.toLocaleLowerCase("en-US"))) {
        reasons.push("prediction_deadline_not_grounded");
      }
    }
    const key = `${start}:${end}:${item.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const assessed = { ...item, start, end, contextStart, contextEnd,
      atomicProposition: item.atomicProposition.trim(), deadlineText: item.deadlineText?.trim() || null,
      grounding, howSpecificity: grounding.how.value.toLowerCase() === NOT_STATED ? "not_stated" : "stated",
      evidenceTest: { publicEvidence, passCondition, failCondition },
      decision: reasons.length ? "rejected" : "eligible", rejectionCodes: [...new Set(reasons)].sort() };
    if (candidateOffsetsCorrected) correctedOffsetCount += 1;
    assessments.push(assessed);
    if (reasons.length) { rejectionCodes.push(...reasons); rejectedCandidateCount += 1; }
    else candidates.push(assessed);
  }
  return { status: "completed", model, provider, candidates, rejectedCandidateCount,
    assessments, rejectionCodes: [...new Set(rejectionCodes)].sort(), correctedOffsetCount };
}
