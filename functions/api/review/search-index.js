import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import { apiError, json, readJson } from "../../lib/response.js";

const CLIP_LABEL = /\[CLIP (\d{2}):(\d{2}):(\d{2})-(\d{2}):(\d{2}):(\d{2})[^\]]*\]/g;

function seconds(h, m, s) { return Number(h) * 3600 + Number(m) * 60 + Number(s); }

function splitClips(text) {
  const clips = [];
  const labels = [...text.matchAll(CLIP_LABEL)];
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    const start = label.index + label[0].length;
    const end = index + 1 < labels.length ? labels[index + 1].index : text.length;
    const body = text.slice(start, end).trim();
    if (body) {
      clips.push({
        start: seconds(label[1], label[2], label[3]),
        end: seconds(label[4], label[5], label[6]),
        text: body,
      });
    }
  }
  if (!clips.length && text.trim()) clips.push({ start: null, end: null, text: text.trim() });
  return clips;
}

export async function onRequestPost({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  let body = {};
  try { body = await readJson(request, 2_048); } catch (error) {
    if (error.message !== "body_required") {
      return apiError("The request must be a small JSON object.", error.message, 400);
    }
  }
  const limit = Math.min(Math.max(Number(body?.limit || 20), 1), 50);
  try {
    const artifacts = (await env.DB.prepare(
      `SELECT t.transcript_id, t.r2_key, t.content_sha256, s.source_item_id,
        s.canonical_url, revision.public_title, revision.publication_date
       FROM transcript_artifacts t
       JOIN source_items s ON s.source_item_id=t.source_item_id
       LEFT JOIN source_item_revisions revision ON revision.source_item_id=s.source_item_id
         AND NOT EXISTS (SELECT 1 FROM source_item_revisions newer
           WHERE newer.source_item_id=revision.source_item_id
             AND (newer.fetched_at>revision.fetched_at OR
               (newer.fetched_at=revision.fetched_at AND newer.revision_id>revision.revision_id)))
       WHERE NOT EXISTS (
         SELECT 1 FROM transcript_search indexed
         WHERE indexed.transcript_id=t.transcript_id
           AND indexed.content_sha256=t.content_sha256
       )
       LIMIT ?1`
    ).bind(limit).all()).results || [];
    let indexedChunks = 0;
    for (const artifact of artifacts) {
      const object = await env.ARTIFACTS.get(artifact.r2_key);
      if (!object) continue;
      const text = await object.text();
      const clips = splitClips(text);
      const statements = [
        env.DB.prepare("DELETE FROM transcript_search WHERE transcript_id=?1")
          .bind(artifact.transcript_id),
        ...clips.map((clip) => env.DB.prepare(
          `INSERT INTO transcript_search
           (chunk_text, transcript_id, source_item_id, video_url, video_title,
            published_at, clip_start_seconds, clip_end_seconds, content_sha256)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
        ).bind(clip.text, artifact.transcript_id, artifact.source_item_id,
          artifact.canonical_url, artifact.public_title || "Untitled video",
          artifact.publication_date || null, clip.start, clip.end,
          artifact.content_sha256)),
      ];
      await env.DB.batch(statements);
      indexedChunks += clips.length;
    }
    const counts = await env.DB.prepare(
      "SELECT COUNT(*) chunks, COUNT(DISTINCT transcript_id) transcripts FROM transcript_search"
    ).first();
    return json({
      indexedTranscripts: artifacts.length,
      indexedChunks,
      totalChunks: Number(counts?.chunks || 0),
      totalTranscripts: Number(counts?.transcripts || 0),
    });
  } catch (error) {
    console.error("search_index_failed", error);
    return apiError("Indexing is unavailable.", "index_unavailable", 503);
  }
}
