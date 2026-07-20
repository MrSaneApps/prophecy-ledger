import test from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeUrl, YouTubeUrlError } from "../functions/lib/youtube-url.js";

const ID = "ZidiIdg3U4M";

test("accepted YouTube video forms normalize to one watch URL", () => {
  for (const input of [
    `https://www.youtube.com/watch?v=${ID}&t=4`,
    `https://youtube.com/shorts/${ID}`,
    `https://m.youtube.com/live/${ID}?feature=share`,
    `https://youtube.com/embed/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
  ]) {
    assert.deepEqual(parseYouTubeUrl(input), {
      canonicalVideoId: ID,
      normalizedUrl: `https://www.youtube.com/watch?v=${ID}`,
    });
  }
});

test("hostile, indirect, and malformed URLs fail closed", () => {
  for (const input of [
    "http://youtube.com/watch?v=ZidiIdg3U4M",
    "https://user:pass@youtube.com/watch?v=ZidiIdg3U4M",
    "https://youtube.com.evil.test/watch?v=ZidiIdg3U4M",
    "https://youtube.com/playlist?list=PL123",
    "https://youtube.com/watch?v=short",
    "https://youtu.be/ZidiIdg3U4M/extra",
    "javascript:alert(1)",
  ]) assert.throws(() => parseYouTubeUrl(input), YouTubeUrlError, input);
});
