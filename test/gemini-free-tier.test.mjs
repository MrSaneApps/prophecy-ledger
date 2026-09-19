import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_FREE_TIER_MEDIA_SECONDS,
  GEMINI_FREE_TIER_MEDIA_SECONDS_MAX,
  GEMINI_FREE_TIER_MODEL,
  GEMINI_FREE_TIER_FALLBACK_MODEL,
  geminiDailyMediaSeconds,
  geminiTranscriptFallbackModel,
  parseGeminiRetryAfterSeconds,
  gemini429ResumeAfter,
} from "../scanner/src/gemini-free-tier.js";

test("Gemini daily media stays inside the free YouTube 8-hour project cap", () => {
  assert.equal(GEMINI_FREE_TIER_MEDIA_SECONDS, 25_200);
  assert.equal(GEMINI_FREE_TIER_MEDIA_SECONDS_MAX, 27_000);
  assert.ok(GEMINI_FREE_TIER_MEDIA_SECONDS_MAX < 28_800);
  assert.equal(GEMINI_FREE_TIER_MODEL, "gemini-3.5-flash-lite");
  assert.equal(GEMINI_FREE_TIER_FALLBACK_MODEL, "gemini-3.1-flash-lite");
  assert.equal(geminiDailyMediaSeconds({}), 25_200);
  assert.equal(geminiDailyMediaSeconds({ GEMINI_DAILY_MEDIA_SECONDS: "3600" }), 3_600);
  assert.equal(geminiDailyMediaSeconds({ GEMINI_DAILY_MEDIA_SECONDS: "25200" }), 25_200);
  assert.equal(geminiDailyMediaSeconds({ GEMINI_DAILY_MEDIA_SECONDS: "86400" }), 25_200);
  assert.equal(geminiDailyMediaSeconds({ GEMINI_DAILY_MEDIA_SECONDS: "0" }), 25_200);
});

test("429 failover stays on free lite models and never 3.7/Pro", () => {
  assert.equal(geminiTranscriptFallbackModel({}, "gemini-3.5-flash-lite"), "gemini-3.1-flash-lite");
  assert.equal(geminiTranscriptFallbackModel({
    GEMINI_TRANSCRIPT_FALLBACK_MODEL: "gemini-3.5-flash-lite",
  }, "gemini-3.5-flash-lite"), null);
  assert.equal(geminiTranscriptFallbackModel({
    GEMINI_TRANSCRIPT_FALLBACK_MODEL: "gemini-3.7-flash",
  }, "gemini-3.5-flash-lite"), null);
});

test("Retry-After becomes a short same-day resume, not the next UTC day", () => {
  const headers = new Map([["retry-after", "90"]]);
  assert.equal(parseGeminiRetryAfterSeconds({ headers: { get: (key) => headers.get(key.toLowerCase()) } }), 90);
  assert.equal(gemini429ResumeAfter("2026-07-20T10:00:00.000Z", 90), "2026-07-20T10:01:30.000Z");
});
