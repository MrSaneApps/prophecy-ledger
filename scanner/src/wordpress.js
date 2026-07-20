const SITE_ORIGINS = new Set(["https://troyblackvideos.com", "https://www.troyblackvideos.com"]);

function decode(value = "") {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function plain(value = "") {
  return decode(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")).normalize("NFC").replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return decode(match?.[1] ?? match?.[2] ?? "").trim();
}

function first(html, pattern) {
  return html.match(pattern)?.[1] ?? "";
}

export function normalizeOfficialUrl(raw) {
  const url = new URL(raw, "https://troyblackvideos.com");
  if (!SITE_ORIGINS.has(url.origin)) throw new Error("foreign_canonical_host");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
  return url.toString();
}

export function archiveUrl(page) {
  if (!Number.isInteger(page) || page < 1 || page > 250) throw new Error("invalid_archive_page");
  return page === 1
    ? "https://troyblackvideos.com/series/prophetic-words/"
    : `https://troyblackvideos.com/series/prophetic-words/page/${page}/`;
}

export function parseArchivePage(html) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const opening = `<article${match[1]}>`;
    const classes = attr(opening, "class").split(/\s+/);
    if (!classes.includes("category-prophetic-words")) continue;
    const idText = attr(opening, "id") || classes.find((item) => /^post-\d+$/.test(item)) || "";
    const id = idText.match(/(?:post-)?(\d+)/)?.[1];
    const body = match[2];
    const hrefs = [...body.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
      .map((item) => item[1] || item[2]);
    let url;
    for (const href of hrefs) {
      try {
        const candidate = normalizeOfficialUrl(href);
        if (!candidate.includes("/series/prophetic-words/")) { url = candidate; break; }
      } catch { /* ignore foreign navigation */ }
    }
    if (!id || !url || seen.has(id)) continue;
    const title = plain(first(body, /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i));
    const timeTag = first(body, /(<time\b[^>]*>)/i);
    const publicationDate = attr(timeTag, "datetime") || null;
    const description = plain(first(body, /<(?:div|p)\b[^>]*class\s*=\s*(?:"[^"]*(?:excerpt|entry-summary)[^"]*"|'[^']*(?:excerpt|entry-summary)[^']*')[^>]*>([\s\S]*?)<\/(?:div|p)>/i)) || null;
    if (!title) continue;
    seen.add(id);
    results.push({ platformItemId: id, canonicalUrl: url, title, description, publicationDate });
  }
  return results;
}

function mergeAnchorLabels(current, incoming) {
  if (!incoming || current === incoming || current.includes(incoming)) return current;
  if (!current || incoming.includes(current)) return incoming;
  // WPTB sometimes splits a single visual label across adjacent anchors that
  // point at the same URL (for example, "O" + "riginal Prophecy").
  if (/[A-Za-z0-9]$/.test(current) && /^[a-z]/.test(incoming)) return current + incoming;
  return `${current} ${incoming}`;
}

function orderedLinks(cellHtml, baseUrl, sourceColumn) {
  const linksByUrl = new Map();
  for (const match of cellHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const opening = `<a${match[1]}>`;
    const href = attr(opening, "href");
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      url.hash = "";
      const id = youtubeId(url.toString());
      const canonicalUrl = id ? `https://www.youtube.com/watch?v=${id}` : url.toString();
      const label = plain(match[2]);
      const existing = linksByUrl.get(canonicalUrl);
      if (existing) {
        existing.label = mergeAnchorLabels(existing.label, label);
        continue;
      }
      linksByUrl.set(canonicalUrl, { label, url: canonicalUrl, youtubeId: id });
    } catch { /* ignore malformed publisher links */ }
  }
  return [...linksByUrl.values()].map((link, index) => {
    const label = link.label || `Link ${index + 1}`;
    const linkRole = sourceColumn === "video_links" && /prophecy/i.test(label)
      ? "original_video"
      : sourceColumn === "video_links" ? "claimed_follow_up" : "claimed_evidence";
    return { ordinal: index + 1, label, url: link.url, youtubeId: link.youtubeId, linkRole };
  });
}

export function parseFulfilledProphecyArchive(html, {
  sourceUrl = "https://troyblackvideos.com/prophecy-archive-all/",
} = {}) {
  const rows = [];
  const seen = new Set();
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = new Map();
    for (const cellMatch of rowMatch[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
      const opening = `<td${cellMatch[1]}>`;
      const x = Number(attr(opening, "data-x-index"));
      const y = Number(attr(opening, "data-y-index"));
      if (Number.isInteger(x)) cells.set(x, { html: cellMatch[2], y });
    }
    if (![0, 1, 2, 3, 4, 5].every((index) => cells.has(index))) continue;
    const firstCell = cells.get(0);
    if (firstCell.y === 0) continue;
    const publisherElementId = first(firstCell.html,
      /\b(wptb-element-(?:text|image|button|star-rating)-[A-Za-z0-9_-]+)\b/i);
    if (!publisherElementId || seen.has(publisherElementId)) continue;
    const description = plain(firstCell.html);
    const prophecy = plain(cells.get(3).html);
    if (!description || !prophecy) continue;
    seen.add(publisherElementId);
    rows.push({
      publisherElementId,
      sourceLocatorYIndex: firstCell.y,
      description,
      dateShared: plain(cells.get(1).html) || null,
      prophecy,
      claimedResult: plain(cells.get(4).html) || null,
      claimedEvidence: plain(cells.get(5).html) || null,
      videoLinks: orderedLinks(cells.get(2).html, sourceUrl, "video_links"),
      evidenceLinks: orderedLinks(cells.get(5).html, sourceUrl, "evidence"),
    });
  }
  return rows;
}

export function archiveNextPageState(html, currentPage) {
  if (!Number.isInteger(currentPage) || currentPage < 1) throw new Error("invalid_archive_page");
  if (/<(?:span|a)\b[^>]*class\s*=\s*(?:"[^"]*nav-next[^\"]*disabled[^"]*"|'[^']*nav-next[^']*disabled[^']*')[^>]*>/i.test(html)) return false;
  const target = currentPage + 1;
  if (new RegExp(`(?:/series/prophetic-words/page/${target}/|data-page-num=["']${target}["'])`, "i").test(html)) return true;
  return null;
}

function meta(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (attr(tag, "property") === key || attr(tag, "name") === key) return attr(tag, "content");
  }
  return "";
}

function link(html, rel) {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (attr(tag, "rel").split(/\s+/).includes(rel)) return attr(tag, "href");
  }
  return "";
}

export function youtubeId(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw, "https://youtube.com");
    let id = null;
    if (["youtu.be"].includes(url.hostname)) id = url.pathname.split("/").filter(Boolean)[0];
    else if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(url.hostname)) {
      id = url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1];
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
}

export function parsePostDetail(html, requestedUrl) {
  const canonicalUrl = normalizeOfficialUrl(link(html, "canonical") || requestedUrl);
  const title = plain(meta(html, "og:title") || first(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  const description = plain(meta(html, "og:description") || meta(html, "description")) || null;
  const publicationDate = meta(html, "article:published_time") || null;
  const candidates = [meta(html, "og:video"), meta(html, "og:video:url"), meta(html, "og:video:secure_url")];
  for (const match of html.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/gi)) candidates.push(`https://youtu.be/${match[1]}`);
  const embeddedItemId = candidates.map(youtubeId).find(Boolean) || null;
  if (!title) throw new Error("missing_post_title");
  return {
    canonicalUrl, title, description, publicationDate,
    embeddedPlatform: embeddedItemId ? "youtube" : null,
    embeddedItemId,
    embeddedUrl: embeddedItemId ? `https://www.youtube.com/watch?v=${embeddedItemId}` : null,
  };
}
