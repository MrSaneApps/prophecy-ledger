const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

export class YouTubeUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "YouTubeUrlError";
    this.code = code;
  }
}

export function parseYouTubeUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new YouTubeUrlError("youtube_url_required", "A YouTube video URL is required.");
  }
  const raw = input.trim();
  if (raw.length > 2_048) {
    throw new YouTubeUrlError("youtube_url_too_long", "The URL is too long.");
  }

  let url;
  try { url = new URL(raw); } catch {
    throw new YouTubeUrlError("youtube_url_invalid", "Enter a complete HTTPS YouTube video URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new YouTubeUrlError("youtube_url_invalid", "Only credential-free HTTPS YouTube URLs are accepted.");
  }

  const host = url.hostname.toLowerCase();
  let id = null;
  if (host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) throw new YouTubeUrlError("youtube_video_required", "Paste a direct YouTube video URL.");
    [id] = parts;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else if (parts.length === 2 && ["shorts", "live", "embed"].includes(parts[0])) {
      id = parts[1];
    } else {
      throw new YouTubeUrlError("youtube_video_required", "Paste a watch, short, live, embed, or youtu.be video URL.");
    }
  } else {
    throw new YouTubeUrlError("youtube_host_invalid", "This is not an accepted YouTube host.");
  }

  if (!VIDEO_ID.test(id || "")) {
    throw new YouTubeUrlError("youtube_id_invalid", "The YouTube video ID is malformed.");
  }
  return {
    canonicalVideoId: id,
    normalizedUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}
