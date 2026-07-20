import test from "node:test";
import assert from "node:assert/strict";
import {
  compareVideoClaims, extractPublicVideoClaims, extractTranscriptClaims, triageDescription,
  primaryVideoPrompt, verifyPublicVideoClaims,
} from "../scanner/src/ai.js";

const ai = (responses) => ({
  calls: [],
  async run(model, input) {
    this.calls.push({ model, input });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { response: typeof next === "string" ? next : JSON.stringify(next) };
  },
});

function groundedField(transcript, value) {
  if (value === "Not stated") return { value, supportQuote: null, supportStart: null, supportEnd: null };
  const supportStart = transcript.indexOf(value);
  return { value, supportQuote: value, supportStart, supportEnd: supportStart + value.length };
}

function groundedCandidate(transcript, overrides = {}) {
  const quote = transcript; const start = 0;
  return {
    quote, start, end: quote.length, contextStart: 0, contextEnd: transcript.length,
    statementType: "present_or_past_factual_claim",
    atomicProposition: "Mayor Lee closed the north bridge at 9 AM on Friday because inspectors found cracks, using a signed city order.",
    deadlineText: null, sourceTimestampSeconds: 0,
    who: groundedField(transcript, "Mayor Lee"), what: groundedField(transcript, "closed the north bridge"),
    why: groundedField(transcript, "because inspectors found cracks"), where: groundedField(transcript, "north bridge"),
    when: groundedField(transcript, "9 AM on Friday"), how: groundedField(transcript, "using a signed city order"),
    evidenceTest: { publicEvidence: "The signed public city order and bridge closure log.",
      passCondition: "The records show Mayor Lee closed the north bridge at that time for the stated reason.",
      failCondition: "The records show no such closure or a materially different actor, time, place, reason, or method." },
    ...overrides,
  };
}

test("description triage produces only a neutral lead and never an exact quote or rating", async () => {
  const fake = ai([{ category: "testable_prediction", neutralParaphrase: "The post may contain a dated prediction." }]);
  const result = await triageDescription(fake, { title: "A title", description: "The event will happen next year.", models: ["primary"] });
  assert.equal(result.category, "testable_prediction");
  assert.equal("exactQuote" in result, false);
  assert.equal("outcome" in result, false);
  assert.equal(fake.calls[0].input.response_format.type, "json_schema");
});

test("missing first-party description is honestly not enough information without calling AI", async () => {
  const fake = ai([]);
  const result = await triageDescription(fake, { title: "Only title", description: "", models: ["primary"] });
  assert.equal(result.category, "not_enough_information");
  assert.equal(fake.calls.length, 0);
});

test("verified transcript extraction requires exact quotes and offsets and removes exact duplicates", async () => {
  const transcript = "At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks, using a signed city order.";
  const candidate = groundedCandidate(transcript); const quote = candidate.quote;
  const result = await extractTranscriptClaims(ai([{ candidates: [candidate, candidate] }]), { transcript, models: ["primary"] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].quote, quote);
});

test("a unique exact quote gets deterministic offsets when the model's offset arithmetic is wrong", async () => {
  const transcript = "Before. At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks, using a signed city order. After.";
  const quote = "At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks, using a signed city order.";
  const candidate = groundedCandidate(transcript, { quote, start: 0, end: 3,
    contextStart: transcript.indexOf(quote), contextEnd: transcript.indexOf(quote) + quote.length });
  const result = await extractTranscriptClaims(ai([{ candidates: [candidate] }]), { transcript, models: ["primary"] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].start, transcript.indexOf(quote));
  assert.equal(result.candidates[0].end, transcript.indexOf(quote) + quote.length);
  assert.equal(result.correctedOffsetCount, 1);
});

test("unique context and support quotes repair bad model arithmetic without inferring words", async () => {
  const quote = "At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks, using a signed city order.";
  const transcript = `Intro words. ${quote} Closing words.`;
  const candidate = groundedCandidate(transcript, { quote, start: 0, end: 1,
    contextStart: 999, contextEnd: 1 });
  for (const name of ["who", "what", "why", "where", "when", "how"]) {
    candidate[name] = { ...candidate[name], supportStart: 0, supportEnd: 1 };
  }
  const result = await extractTranscriptClaims(ai([{ candidates: [candidate] }]), {
    transcript, models: ["primary"],
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.correctedOffsetCount, 1);
  const repaired = result.candidates[0];
  assert.equal(repaired.contextStart, transcript.indexOf("At 9 AM"));
  assert.equal(repaired.contextEnd, transcript.indexOf("city order.") + "city order.".length);
  assert.ok(Object.values(repaired.grounding).every((field) => field.supportStart >= repaired.contextStart &&
    field.supportEnd <= repaired.contextEnd &&
    transcript.slice(field.supportStart, field.supportEnd) === field.supportQuote));
});

test("ambiguous support repair fails closed while a valid supplied repeated-phrase span remains usable", async () => {
  const transcript = "Mayor Lee said Mayor Lee closed the north bridge at 9 AM on Friday because inspectors found cracks.";
  const ambiguous = groundedCandidate(transcript, {
    atomicProposition: "Mayor Lee closed the north bridge at 9 AM on Friday because inspectors found cracks.",
    who: { value: "Mayor Lee", supportQuote: "Mayor Lee", supportStart: 3, supportEnd: 5 },
    what: groundedField(transcript, "closed the north bridge"),
    why: groundedField(transcript, "because inspectors found cracks"),
    where: groundedField(transcript, "north bridge"), when: groundedField(transcript, "9 AM on Friday"),
    how: groundedField(transcript, "Not stated"),
  });
  const rejected = await extractTranscriptClaims(ai([{ candidates: [ambiguous] }]), {
    transcript, models: ["primary"],
  });
  assert.equal(rejected.candidates.length, 0);
  assert.ok(rejected.rejectionCodes.includes("invalid_grounding_who"));

  const explicit = { ...ambiguous,
    who: { value: "Mayor Lee", supportQuote: "Mayor Lee", supportStart: 0, supportEnd: "Mayor Lee".length } };
  const accepted = await extractTranscriptClaims(ai([{ candidates: [explicit] }]), {
    transcript, models: ["primary"],
  });
  assert.equal(accepted.candidates.length, 1);
});

test("context repair stays bounded and ambiguous exact quotes remain fail-closed", async () => {
  const quote = "Mayor Lee closed the north bridge because inspectors found cracks.";
  const distantWhen = "9 AM on Friday";
  const transcript = `${quote}${" x".repeat(700)} ${distantWhen}`;
  const candidate = groundedCandidate(transcript, { quote, start: 0, end: quote.length,
    contextStart: 0, contextEnd: quote.length,
    atomicProposition: "Mayor Lee closed the north bridge at 9 AM on Friday because inspectors found cracks.",
    who: groundedField(transcript, "Mayor Lee"), what: groundedField(transcript, "closed the north bridge"),
    why: groundedField(transcript, "because inspectors found cracks"), where: groundedField(transcript, "north bridge"),
    when: groundedField(transcript, distantWhen), how: groundedField(transcript, "Not stated") });
  const bounded = await extractTranscriptClaims(ai([{ candidates: [candidate] }]), {
    transcript, models: ["primary"],
  });
  assert.equal(bounded.candidates.length, 0);
  assert.ok(bounded.rejectionCodes.includes("invalid_context"));

  const repeated = `${quote} Later, ${quote}`;
  const ambiguous = groundedCandidate(repeated, { quote, start: 2, end: 4 });
  const result = await extractTranscriptClaims(ai([{ candidates: [ambiguous] }]), {
    transcript: repeated, models: ["primary"],
  });
  assert.equal(result.assessments.length, 0);
  assert.deepEqual(result.rejectionCodes, ["ambiguous_quote"]);
});

test("generic advice and non-observable mental-state propositions fail the grounded gate", async () => {
  const transcript = "It's about power and sometimes who you know and how you interact with each other is more valuable than what you have.";
  const candidate = groundedCandidate(transcript, {
    atomicProposition: "President Trump understands the value of relationships and power.",
    statementType: "testable_prediction", deadlineText: "potentially sometime this year or into the next year",
    who: groundedField(transcript, "who you know"), what: groundedField(transcript, "It's about power"),
    why: groundedField(transcript, "more valuable than what you have"), where: groundedField(transcript, "Not stated"),
    when: groundedField(transcript, "Not stated"), how: groundedField(transcript, "how you interact with each other"),
  });
  const result = await extractTranscriptClaims(ai([{ candidates: [candidate] }]), { transcript, models: ["primary"] });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.assessments[0].decision, "rejected");
  assert.ok(result.rejectionCodes.includes("essential_not_stated_where"));
  assert.ok(result.rejectionCodes.includes("essential_not_stated_when"));
  assert.ok(result.rejectionCodes.includes("non_observable_mental_state"));
  assert.ok(result.rejectionCodes.includes("prediction_deadline_not_grounded"));
});

test("missing why rejects while an unstated mechanism is retained as an optional specificity metric", async () => {
  const transcript = "At 9 AM on Friday, Mayor Lee closed the north bridge.";
  const candidate = groundedCandidate(transcript, {
    quote: transcript, end: transcript.length, contextEnd: transcript.length,
    atomicProposition: "Mayor Lee closed the north bridge at 9 AM on Friday.",
    who: groundedField(transcript, "Mayor Lee"), what: groundedField(transcript, "closed the north bridge"),
    where: groundedField(transcript, "north bridge"), when: groundedField(transcript, "9 AM on Friday"),
    why: groundedField(transcript, "Not stated"), how: groundedField(transcript, "Not stated"),
  });
  const result = await extractTranscriptClaims(ai([{ candidates: [candidate] }]), { transcript, models: ["primary"] });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.rejectionCodes.filter((code) => code.startsWith("essential_not_stated")),
    ["essential_not_stated_why"]);
  assert.equal(result.assessments[0].howSpecificity, "not_stated");
});

test("a grounded candidate remains eligible when only how is not stated", async () => {
  const transcript = "At 9 AM on Friday, Mayor Lee closed the north bridge because inspectors found cracks.";
  const candidate = groundedCandidate(transcript, {
    quote: transcript, end: transcript.length, contextEnd: transcript.length,
    atomicProposition: "Mayor Lee closed the north bridge at 9 AM on Friday because inspectors found cracks.",
    who: groundedField(transcript, "Mayor Lee"), what: groundedField(transcript, "closed the north bridge"),
    why: groundedField(transcript, "because inspectors found cracks"), where: groundedField(transcript, "north bridge"),
    when: groundedField(transcript, "9 AM on Friday"), how: groundedField(transcript, "Not stated"),
  });
  const result = await extractTranscriptClaims(ai([{ candidates: [candidate] }]), { transcript, models: ["primary"] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].howSpecificity, "not_stated");
  assert.deepEqual(result.rejectionCodes, []);
});

test("transcript extraction rejects bad individual suggestions while malformed model output fails closed", async () => {
  const base = { quote: "invented", start: 0, end: 8, statementType: "testable_prediction", atomicProposition: "x", deadlineText: null, sourceTimestampSeconds: null };
  const filtered = await extractTranscriptClaims(ai([{ candidates: [base,
    { ...base, quote: "real", end: 4, statementType: "verdict" }] }]), { transcript: "real transcript", models: ["m"] });
  assert.equal(filtered.candidates.length, 0);
  assert.equal(filtered.rejectedCandidateCount, 2);
  assert.deepEqual(filtered.rejectionCodes, ["invalid_candidate", "quote_not_in_transcript"]);
  await assert.rejects(() => extractTranscriptClaims(ai(["not json", "still not json"]), { transcript: "real transcript", models: ["m"] }), /ai_unavailable/);
});

test("model availability failure uses one configured fallback and total loss stays failed", async () => {
  const unavailable = Object.assign(new Error("model unavailable"), { status: 503 });
  const fallback = ai([unavailable, { category: "not_enough_information", neutralParaphrase: null }]);
  const result = await triageDescription(fallback, { title: "x", description: "y", models: ["primary", "fallback"] });
  assert.equal(result.model, "fallback");
  await assert.rejects(() => triageDescription(ai([unavailable, unavailable]), { title: "x", description: "y", models: ["a", "b"] }), /ai_unavailable/);
});

test("JSON Mode refusal retries the same Workers AI model with an explicit plain-JSON contract", async () => {
  const fake = ai([new Error("JSON Mode couldn't be met"), { candidates: [] }]);
  const result = await extractTranscriptClaims(fake, { transcript: "No concrete prediction here.", models: ["primary"] });
  assert.equal(result.model, "primary");
  assert.equal(result.candidates.length, 0);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].input.response_format.type, "json_schema");
  assert.equal("response_format" in fake.calls[1].input, false);
});

test("a never-resolving primary model times out per model and falls back", async () => {
  const fake = {
    calls: [],
    run(model) {
      this.calls.push(model);
      if (model === "primary") return new Promise(() => {});
      return Promise.resolve({ response: JSON.stringify({ category: "not_enough_information", neutralParaphrase: null }) });
    },
  };
  const result = await triageDescription(fake, {
    title: "Title", description: "Description", models: ["primary", "fallback"], timeoutMs: 5,
  });
  assert.equal(result.model, "fallback");
  assert.deepEqual(fake.calls, ["primary", "fallback"]);
});

const videoClaim = (overrides = {}) => ({
  quote: "Rain will fall by Friday.", startSeconds: 120, endSeconds: 125,
  statementType: "testable_prediction", atomicProposition: "Rain will fall by Friday.",
  deadlineText: "by Friday", contextBefore: "Before", contextAfter: "After", confidence: 0.92,
  ...overrides,
});

const videoClaimTuple = (claim = videoClaim()) => [
  claim.quote, claim.startSeconds, claim.endSeconds, claim.statementType,
  claim.atomicProposition, claim.deadlineText, claim.contextBefore, claim.contextAfter,
  claim.confidence,
];

function geminiResponse(structured, model = "gemini-test") {
  return new Response(JSON.stringify({
    id: "interaction-1", model, status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(structured) }] }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("Gemini primary video extraction sends one public URL with storage disabled and validates strict output", async () => {
  const calls = [];
  const result = await extractPublicVideoClaims({
    apiKey: "secret", gatewayAccountId: "2c267ab06352ba2522114c3081a8c5fa",
    gatewayId: "default", gatewayToken: "gateway-secret", model: "gemini-primary",
    videoUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M",
    fetcher: async (url, options) => { calls.push({ url, options }); return geminiResponse({ claims: [videoClaimTuple()] }); },
  });
  assert.equal(result.claims.length, 1);
  assert.equal(result.interactionId, "interaction-1");
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.store, false);
  assert.deepEqual(request.input.map((item) => item.type), ["video", "text"]);
  assert.equal(request.input[0].uri, "https://www.youtube.com/watch?v=ZidiIdg3U4M");
  assert.deepEqual(request.response_format.map((format) => format.type), ["text"]);
  assert.equal(request.response_format[0].mime_type, "application/json");
  assert.equal(request.response_format[0].schema.properties.claims.items.type, "array");
  assert.equal(request.response_format[0].schema.properties.claims.items.prefixItems.length, 9);
  assert.deepEqual(request.response_format[0].schema.properties.claims.items.prefixItems[3].enum, [
    "testable_prediction", "present_or_past_factual_claim", "conditional_prediction",
  ]);
  assert.equal(result.structured.claims[0].quote, "Rain will fall by Friday.");
  assert.equal(calls[0].url, "https://gateway.ai.cloudflare.com/v1/2c267ab06352ba2522114c3081a8c5fa/default/google-ai-studio/v1beta/interactions");
  assert.equal(calls[0].options.headers["cf-aig-authorization"], "Bearer gateway-secret");
  assert.equal(calls[0].options.headers["cf-aig-skip-cache"], "true");
  assert.equal(calls[0].options.headers["cf-aig-collect-log-payload"], "false");
  assert.equal(calls[0].options.headers["cf-aig-max-attempts"], "1");
  assert.equal(calls[0].options.headers["x-goog-api-key"], "secret");
});

test("Gemini video timeout remains active until the gateway response body is consumed", async () => {
  await assert.rejects(() => extractPublicVideoClaims({
    apiKey: "secret", gatewayAccountId: "2c267ab06352ba2522114c3081a8c5fa",
    gatewayId: "default", gatewayToken: "gateway-secret", model: "gemini-primary",
    videoUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M", timeoutMs: 5,
    fetcher: async (_url, options) => ({
      ok: true, status: 200, headers: new Headers(),
      text: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true })),
    }),
  }), /gemini_timeout/);
});

test("Cloudflare-stored Gemini BYOK omits the provider key from the Worker request", async () => {
  let headers;
  await extractPublicVideoClaims({
    gatewayAccountId: "2c267ab06352ba2522114c3081a8c5fa", gatewayId: "default",
    gatewayToken: "gateway-secret", useByok: true, model: "gemini-primary",
    videoUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M",
    fetcher: async (_url, options) => { headers = options.headers; return geminiResponse({ claims: [] }); },
  });
  assert.equal(headers["x-goog-api-key"], undefined);
  assert.equal(headers["cf-aig-authorization"], "Bearer gateway-secret");
});

test("Gemini video extraction fails closed on malformed fields and impossible timestamps", async () => {
  const run = (claim) => extractPublicVideoClaims({
    apiKey: "secret", gatewayAccountId: "2c267ab06352ba2522114c3081a8c5fa",
    gatewayId: "default", gatewayToken: "gateway-secret", model: "model",
    videoUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M",
    fetcher: async () => geminiResponse({ claims: [claim] }),
  });
  await assert.rejects(() => run([...videoClaimTuple(), "true"]), /gemini_invalid_claim_fields/);
  await assert.rejects(() => run(videoClaimTuple(videoClaim({ endSeconds: 120 }))), /gemini_invalid_timestamp/);
  await assert.rejects(() => run(videoClaimTuple(videoClaim({ statementType: "verdict" }))), /gemini_invalid_claim/);
  await assert.rejects(() => run(videoClaimTuple(videoClaim({ statementType: "general_encouragement" }))), /gemini_invalid_claim/);
  await assert.rejects(() => run(videoClaimTuple(videoClaim({ deadlineText: null }))), /gemini_prediction_deadline_required/);
  assert.equal((await run(videoClaimTuple(videoClaim({
    statementType: "present_or_past_factual_claim", deadlineText: null,
  })))).claims.length, 1);
});

test("video prompt explicitly omits generic encouragement and unbounded prophecy language", () => {
  const prompt = primaryVideoPrompt();
  assert.match(prompt, /Ignore and omit all general encouragement/);
  assert.match(prompt, /observable event and a bounded deadline or time window/);
  assert.match(prompt, /Return an empty claims array/);
});

test("independent verifier must return every candidate ID exactly once", async () => {
  const candidate = { candidateId: "candidate-1", ...videoClaim() };
  const verified = await verifyPublicVideoClaims({
    apiKey: "secret", gatewayAccountId: "2c267ab06352ba2522114c3081a8c5fa",
    gatewayId: "default", gatewayToken: "gateway-secret", model: "verifier",
    videoUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M",
    candidates: [candidate], fetcher: async () => geminiResponse({ checks: [[candidate.candidateId, ...videoClaimTuple(candidate)]] }),
  });
  assert.equal(verified.checks[0].candidateId, "candidate-1");
  await assert.rejects(() => verifyPublicVideoClaims({
    apiKey: "secret", gatewayAccountId: "2c267ab06352ba2522114c3081a8c5fa",
    gatewayId: "default", gatewayToken: "gateway-secret", model: "verifier",
    videoUrl: "https://www.youtube.com/watch?v=ZidiIdg3U4M",
    candidates: [candidate], fetcher: async () => geminiResponse({ checks: [] }),
  }), /gemini_incomplete_checks/);
});

test("deterministic agreement compares quote, timestamp, deadline, type, and meaning", () => {
  const agreed = compareVideoClaims(videoClaim(), videoClaim({ quote: "Rain will fall by Friday", startSeconds: 121, endSeconds: 125 }));
  assert.equal(agreed.agrees, true);
  const disputed = compareVideoClaims(videoClaim(), videoClaim({
    quote: "Snow is already falling.", startSeconds: 400, endSeconds: 405,
    statementType: "present_or_past_factual_claim", atomicProposition: "Snow is falling now.", deadlineText: null,
  }));
  assert.equal(disputed.agrees, false);
  assert.deepEqual(disputed.reasons, ["quote_mismatch", "timestamp_mismatch", "deadline_mismatch", "statement_type_mismatch", "meaning_mismatch"]);
});
