// Official free-tier YouTube input is 8 hours/day (28,800s) per project, not
// per model. Rotating models does not buy more video hours.
// RPM/RPD are per model, so a single 429 failover to another free lite model
// can keep a chunk moving. Do not rotate to 3.7 Flash (20 RPD).
export const GEMINI_FREE_TIER_MEDIA_SECONDS = 25_200; // 7 hours
export const GEMINI_FREE_TIER_MEDIA_SECONDS_MAX = 27_000; // 7.5 hours
export const GEMINI_FREE_TIER_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_FREE_TIER_FALLBACK_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_429_DEFAULT_RESUME_SECONDS = 60;
export const GEMINI_429_MAX_RESUME_SECONDS = 900;

export function geminiDailyMediaSeconds(env) {
  const parsed = Number(env?.GEMINI_DAILY_MEDIA_SECONDS);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= GEMINI_FREE_TIER_MEDIA_SECONDS_MAX) {
    return parsed;
  }
  return GEMINI_FREE_TIER_MEDIA_SECONDS;
}

export function geminiTranscriptFallbackModel(env, primary) {
  const fallback = env?.GEMINI_TRANSCRIPT_FALLBACK_MODEL || GEMINI_FREE_TIER_FALLBACK_MODEL;
  if (typeof fallback !== "string" || !fallback || fallback === primary) return null;
  if (fallback.includes("3.7") || fallback.includes("pro")) return null;
  return fallback;
}

export function parseGeminiRetryAfterSeconds(response) {
  const raw = response?.headers?.get?.("retry-after") || response?.headers?.get?.("Retry-After");
  if (!raw) return GEMINI_429_DEFAULT_RESUME_SECONDS;
  const counted = Number(raw);
  if (Number.isInteger(counted) && counted >= 1) {
    return Math.min(GEMINI_429_MAX_RESUME_SECONDS, counted);
  }
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    const seconds = Math.ceil((when - Date.now()) / 1000);
    if (Number.isInteger(seconds) && seconds >= 1) {
      return Math.min(GEMINI_429_MAX_RESUME_SECONDS, seconds);
    }
  }
  return GEMINI_429_DEFAULT_RESUME_SECONDS;
}

export function gemini429ResumeAfter(at, retryAfterSeconds) {
  const wait = Number(retryAfterSeconds);
  const bounded = Number.isInteger(wait) && wait >= 1
    ? Math.min(GEMINI_429_MAX_RESUME_SECONDS, wait)
    : GEMINI_429_DEFAULT_RESUME_SECONDS;
  const start = Date.parse(at);
  if (!Number.isFinite(start)) return at;
  return new Date(start + (bounded * 1000)).toISOString();
}
