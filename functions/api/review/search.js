import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import { apiError, json } from "../../lib/response.js";

function buildMatch(query, mode) {
  const cleaned = query.replaceAll('"', " ").trim();
  if (!cleaned) throw new Error("query_invalid");
  if (mode === "phrase") return `"${cleaned}"`;
  // any: every whitespace token quoted so FTS operators stay inert.
  return cleaned.split(/\s+/).map((token) => `"${token}"`).join(" ");
}

export async function onRequestGet({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") || "").trim();
  const mode = ["phrase", "any", "advanced"].includes(url.searchParams.get("mode"))
    ? url.searchParams.get("mode") : "any";
  if (query.length < 2 || query.length > 200) {
    return apiError("Search needs between 2 and 200 characters.", "query_length_invalid", 400);
  }
  let match;
  try {
    match = mode === "advanced" ? query : buildMatch(query, mode);
  } catch {
    return apiError("The search could not be parsed.", "query_invalid", 400);
  }
  try {
    const result = await env.DB.prepare(
      `SELECT snippet(transcript_search, 0, '[', ']', '…', 32) snippet,
        transcript_id, source_item_id, video_url, video_title, published_at,
        clip_start_seconds, clip_end_seconds, content_sha256,
        bm25(transcript_search) rank
       FROM transcript_search WHERE transcript_search MATCH ?1
       ORDER BY rank LIMIT 50`
    ).bind(match).all();
    const hits = (result.results || []).map((row) => ({
      snippet: row.snippet,
      videoUrl: row.video_url,
      videoTitle: row.video_title,
      publishedAt: row.published_at,
      clipStartSeconds: row.clip_start_seconds == null ? null : Number(row.clip_start_seconds),
      clipEndSeconds: row.clip_end_seconds == null ? null : Number(row.clip_end_seconds),
      transcriptId: row.transcript_id,
      sourceItemId: row.source_item_id,
      transcriptSha256: row.content_sha256,
    }));
    return json({
      query, mode, hits, total: hits.length,
      basis: "Private AI-generated transcript archive; clip ranges are approximate locators. Confirm exact words against the original video before citing publicly.",
    });
  } catch (error) {
    if (/fts5|syntax|malformed/i.test(String(error))) {
      return apiError("The advanced query syntax is invalid.", "query_invalid", 400);
    }
    console.error("transcript_search_failed", error);
    return apiError("The transcript search is unavailable.", "search_unavailable", 503);
  }
}
