import { insertIntake } from "../lib/repository.js";
import { apiError, json, readJson } from "../lib/response.js";
import { parseYouTubeUrl, YouTubeUrlError } from "../lib/youtube-url.js";

const CANDIDATE_SOURCE_TYPES = [
  "official website", "YouTube channel and playlists", "X", "Facebook",
  "Instagram", "Rumble", "podcasts", "newsletters", "other first-party archives",
];

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await readJson(request, 4_096); } catch (error) {
    const code = error.message;
    return apiError("The request body must be a small JSON object.", code, code === "body_too_large" ? 413 : 400);
  }

  let parsed;
  try { parsed = parseYouTubeUrl(body.youtubeUrl); } catch (error) {
    if (error instanceof YouTubeUrlError) return apiError(error.message, error.code, 400);
    return apiError("The video URL could not be processed.", "youtube_url_invalid", 400);
  }

  try {
    const { record, reused } = await insertIntake(env.DB, parsed);
    return json({
      requestId: record.request_id,
      canonicalVideoId: record.canonical_video_id,
      normalizedUrl: record.normalized_url,
      status: record.status,
      reused,
      dispatchStatus: "pending_identity",
      candidateSources: CANDIDATE_SOURCE_TYPES.map((type) => ({ type, status: "not_scanned" })),
      nextStep: "The video is saved for source and identity confirmation. No automatic transcript, claim, or rating was created.",
    }, 202);
  } catch (error) {
    console.error("intake_failed", error);
    return apiError("The intake request could not be saved.", "intake_unavailable", 503);
  }
}
