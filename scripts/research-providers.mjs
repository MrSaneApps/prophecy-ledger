/**
 * Shared LLM providers for Prophecy Ledger research.
 *
 * Cost preference for closed-book draft synthesis:
 *   NVIDIA free (live IDs only) → cheap OpenRouter → Gemini
 * Web-grounded source finding:
 *   Gemini google_search → OpenRouter :online fallback
 *
 * NEVER trust stale `nv` CLI shortcuts. Model IDs below were verified against
 * integrate.api.nvidia.com/v1/models + chat/completions probes on 2026-08-01.
 * Secrets from env only. Never log key material.
 */

export const GEMINI_DEFAULT_MODEL = process.env.RESEARCH_MODEL || "gemini-3.5-flash-lite";
export const OPENROUTER_DEFAULT_MODEL = process.env.RESEARCH_OPENROUTER_MODEL
  || "meta-llama/llama-3.3-70b-instruct";
/** Verified responding on NVIDIA Build chat (free tier). */
export const NVIDIA_DEFAULT_MODEL = process.env.RESEARCH_NVIDIA_MODEL
  || "mistralai/mistral-nemotron";
export const CLOUDFLARE_CRITIC_MODEL = process.env.RESEARCH_CLOUDFLARE_CRITIC_MODEL
  || "@cf/nvidia/nemotron-3-120b-a12b";
export const CLOUDFLARE_JUDGE_MODEL = process.env.RESEARCH_CLOUDFLARE_JUDGE_MODEL
  || "@cf/qwen/qwen3-30b-a3b-fp8";

let cloudflareAccountId = null;

/**
 * Only aliases that map to LIVE, chat-callable NVIDIA / known OR ids.
 * Stale nv shortcuts (kimi-k2.5, meta-405b, gemma-3-27b, mistral-large-3-675b, …) omitted on purpose.
 */
export const MODEL_ALIASES = Object.freeze({
  // NVIDIA Build — probed OK 2026-08-01
  "nv:nemotron-ultra": "nvidia/nemotron-3-ultra-550b-a55b",
  "nv:nemotron-super": "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nv:nemotron-super-1.5": "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nv:nemotron-nano": "nvidia/nemotron-3-nano-30b-a3b",
  "nv:nemotron-nano-omni": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nv:nemotron-120b": "nvidia/nemotron-3-super-120b-a12b",
  "nv:mistral-nemotron": "mistralai/mistral-nemotron",
  "nv:glm": "z-ai/glm-5.2",
  "nv:laguna": "poolside/laguna-xs-2.1",
  "nv:step-flash": "stepfun-ai/step-3.7-flash",
  // OpenRouter cheap / free-ish
  "or:llama-70b": "meta-llama/llama-3.3-70b-instruct",
  "or:scout": "meta-llama/llama-4-scout-17b-16e-instruct",
  "or:kimi": "moonshotai/kimi-k2.5-0127",
  "or:gemini": "google/gemini-3-flash-preview-20251217",
  "or:grok-fast": "x-ai/grok-code-fast-1",
});

/** Bakeoff slate: free NVIDIA first, then cheap OR, then current Gemini draft model. */
export const BAKEOFF_DRAFT_MODELS = Object.freeze([
  { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b", label: "nv-nemotron-ultra", tier: "nvidia_free" },
  { provider: "nvidia", model: "nvidia/llama-3.3-nemotron-super-49b-v1", label: "nv-nemotron-super", tier: "nvidia_free" },
  { provider: "nvidia", model: "mistralai/mistral-nemotron", label: "nv-mistral-nemotron", tier: "nvidia_free" },
  { provider: "nvidia", model: "z-ai/glm-5.2", label: "nv-glm-5.2", tier: "nvidia_free" },
  { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", label: "or-llama-70b", tier: "openrouter_cheap" },
  { provider: "openrouter", model: "meta-llama/llama-4-scout-17b-16e-instruct", label: "or-scout", tier: "openrouter_cheap" },
  { provider: "gemini", model: GEMINI_DEFAULT_MODEL, label: "gemini-flash", tier: "gemini" },
]);

export function resolveModelId(model) {
  const raw = String(model || "").trim();
  return MODEL_ALIASES[raw] || raw;
}

function textFromGemini(data) {
  return (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("\n");
}

function openAiMessageText(data) {
  const msg = data.choices?.[0]?.message || {};
  const content = String(msg.content || "").trim();
  if (content) return content;
  // Some NVIDIA reasoning models put usable text only in reasoning fields when max_tokens is tight.
  const reasoning = String(msg.reasoning_content || msg.reasoning || "").trim();
  return reasoning;
}

async function resolveCloudflareAccountId(fetchImpl = fetch) {
  if (process.env.RESEARCH_CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID) {
    return process.env.RESEARCH_CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  }
  if (cloudflareAccountId) return cloudflareAccountId;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN missing from environment");
  const response = await fetchImpl("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const data = await response.json();
  if (!response.ok || data?.success !== true || !Array.isArray(data.result)) {
    throw new Error(`cloudflare_accounts_${response.status}`);
  }
  if (data.result.length !== 1) throw new Error("cloudflare_account_id_required");
  cloudflareAccountId = data.result[0].id;
  return cloudflareAccountId;
}

export async function callCloudflare(prompt, {
  model = CLOUDFLARE_CRITIC_MODEL, temperature = 0.1, maxTokens = 1200,
  fetchImpl = fetch,
} = {}) {
  if (process.env.RESEARCH_CLOUDFLARE_ADVERSARIAL_ENABLED !== "1") {
    throw new Error("cloudflare_adversarial_disabled_no_charge");
  }
  const apiKey = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiKey) throw new Error("CLOUDFLARE_API_TOKEN missing from environment");
  const accountId = await resolveCloudflareAccountId(fetchImpl);
  const modelId = resolveModelId(model);
  const started = Date.now();
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }], temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const data = await response.json();
  if (!response.ok || data?.success === false) throw new Error(`cloudflare_${response.status}`);
  const result = data.result || data;
  const text = String(result.response || openAiMessageText(result) || "").trim();
  if (!text) throw new Error("cloudflare_empty_response");
  const usage = result.usage || {};
  return {
    provider: "cloudflare", model: modelId, text,
    latencyMs: Date.now() - started,
    usage: {
      promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
      completionTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    },
    costUsd: null, tier: "cloudflare_free_allocation",
  };
}

export async function callGemini(prompt, {
  model = GEMINI_DEFAULT_MODEL,
  search = false,
  temperature = 0.2,
} = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing from environment");
  const modelId = resolveModelId(model);
  const started = Date.now();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(search ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { temperature },
      }),
    },
  );
  const raw = await response.text();
  if (!response.ok) throw new Error(`gemini_${response.status}:${raw.slice(0, 180)}`);
  const data = JSON.parse(raw);
  const usage = data.usageMetadata || {};
  return {
    provider: "gemini",
    model: modelId,
    text: textFromGemini(data),
    latencyMs: Date.now() - started,
    usage: {
      promptTokens: usage.promptTokenCount ?? null,
      completionTokens: usage.candidatesTokenCount ?? null,
      totalTokens: usage.totalTokenCount ?? null,
    },
    costUsd: null,
    tier: "gemini",
  };
}

async function openAiCompatibleChat({
  provider, endpoint, apiKey, model, prompt, temperature, search, extraHeaders = {},
}) {
  const modelId = resolveModelId(model);
  const started = Date.now();
  const body = {
    model: modelId,
    temperature,
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }],
  };
  if (search && provider === "openrouter") {
    if (!String(modelId).endsWith(":online")) body.plugins = [{ id: "web", max_results: 5 }];
    body.provider = { sort: "throughput", allow_fallbacks: true };
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${provider}_${response.status}:${raw.slice(0, 180)}`);
  const data = JSON.parse(raw);
  const usage = data.usage || {};
  return {
    provider,
    model: modelId,
    text: openAiMessageText(data),
    latencyMs: Date.now() - started,
    usage: {
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    },
    costUsd: typeof usage.cost === "number" ? usage.cost
      : (typeof usage.total_cost === "number" ? usage.total_cost : null),
    tier: provider === "nvidia" ? "nvidia_free" : "openrouter",
  };
}

export async function callNvidia(prompt, {
  model = NVIDIA_DEFAULT_MODEL,
  temperature = 0.2,
} = {}) {
  const key = process.env.NV_API_KEY;
  if (!key) throw new Error("NV_API_KEY missing from environment");
  return openAiCompatibleChat({
    provider: "nvidia",
    endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    apiKey: key,
    model,
    prompt,
    temperature,
    search: false,
  });
}

export async function callOpenRouter(prompt, {
  model = OPENROUTER_DEFAULT_MODEL,
  search = false,
  temperature = 0.2,
} = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY missing from environment");
  return openAiCompatibleChat({
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: key,
    model,
    prompt,
    temperature,
    search,
    extraHeaders: {
      "HTTP-Referer": "https://prophecy-ledger.pages.dev",
      "X-Title": "Prophecy Ledger research",
    },
  });
}

/**
 * Cost-first research call.
 * provider=auto|gemini|nvidia|openrouter|cloudflare (env RESEARCH_PROVIDER overrides default auto).
 */
export async function callResearchModel(prompt, options = {}) {
  const provider = String(options.provider || process.env.RESEARCH_PROVIDER || "auto").toLowerCase();
  const search = Boolean(options.search);

  if (provider === "gemini") return callGemini(prompt, options);
  if (provider === "nvidia" || provider === "nv") return callNvidia(prompt, options);
  if (provider === "openrouter" || provider === "grok") return callOpenRouter(prompt, options);
  if (provider === "cloudflare" || provider === "cf") return callCloudflare(prompt, options);

  if (provider !== "auto") throw new Error(`research_provider_unsupported:${provider}`);

  if (search) {
    try {
      return await callGemini(prompt, options);
    } catch (primaryError) {
      const onlineModel = "meta-llama/llama-3.3-70b-instruct:online";
      try {
        return await callOpenRouter(prompt, { ...options, model: onlineModel, search: true });
      } catch {
        throw primaryError;
      }
    }
  }

  const cascade = [];
  if (process.env.NV_API_KEY) {
    cascade.push(() => callNvidia(prompt, {
      ...options,
      model: options.nvidiaModel || options.model || NVIDIA_DEFAULT_MODEL,
    }));
  }
  if (process.env.OPENROUTER_API_KEY) {
    cascade.push(() => callOpenRouter(prompt, {
      ...options,
      model: options.openrouterModel || OPENROUTER_DEFAULT_MODEL,
      search: false,
    }));
  }
  if (process.env.GEMINI_API_KEY) {
    cascade.push(() => callGemini(prompt, { ...options, search: false }));
  }
  if (!cascade.length) throw new Error("no_research_provider_keys");

  let lastError;
  for (const attempt of cascade) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("research_cascade_failed");
}
