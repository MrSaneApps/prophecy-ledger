const PUBLIC_ORIGIN = "https://prophecy-ledger.pages.dev";
const DEFAULT_TITLE = "The Prophecy Ledger — Check the claim, follow the evidence";
const DEFAULT_DESCRIPTION = "See what public prophets said, what the evidence shows, and the final decision from a named human reviewer.";
const INDEX_ROBOTS = "index, follow";
const NOINDEX_ROBOTS = "noindex, nofollow, noarchive";

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; media-src 'none'; worker-src 'none'; manifest-src 'self'; upgrade-insecure-requests",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-frame-options": "DENY",
});

const PAGE_SOCIAL = Object.freeze({
  "/": { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION },
  "/people/troy-black": {
    title: "Troy Black — The Prophecy Ledger",
    description: "Public claim record for Troy Black: original words, independent evidence, and named human decisions.",
  },
  "/people/troy-black/method": {
    title: "The pattern in the fulfilled archive — The Prophecy Ledger",
    description: "How Troy Black's fulfilled list is built: original videos, later titles, and the repeating pattern between them.",
  },
  "/methodology": {
    title: "How it works — The Prophecy Ledger",
    description: "How the Prophecy Ledger checks a public claim, from original words to a named human decision.",
  },
  "/biblical-prophecy": {
    title: "Why these rules — The Prophecy Ledger",
    description: "How Scripture teaches the tests this ledger uses for public prophetic claims.",
  },
  "/privacy": {
    title: "Privacy — The Prophecy Ledger",
    description: "What the Prophecy Ledger collects, what stays private, and how to reach us.",
  },
});

export function normalizePublicPath(pathname = "") {
  const path = String(pathname).replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function robotsTagForPath(pathname = "") {
  const path = normalizePublicPath(pathname);
  if (path === "/") return INDEX_ROBOTS;
  if (path.startsWith("/review") || path.startsWith("/api/") || path.endsWith(".pdf")) {
    return NOINDEX_ROBOTS;
  }
  return INDEX_ROBOTS;
}

export function socialForPath(pathname = "") {
  const path = normalizePublicPath(pathname);
  if (PAGE_SOCIAL[path]) return PAGE_SOCIAL[path];
  if (/^\/people\/[^/]+\/claims\//.test(path)) {
    return { title: "Claim record — The Prophecy Ledger", description: DEFAULT_DESCRIPTION };
  }
  if (/^\/people\/[^/]+$/.test(path)) {
    return { title: "Public claim record — The Prophecy Ledger", description: DEFAULT_DESCRIPTION };
  }
  return { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION };
}

export function canonicalForPath(pathname = "") {
  const path = normalizePublicPath(pathname);
  return path === "/" ? `${PUBLIC_ORIGIN}/` : `${PUBLIC_ORIGIN}${path}`;
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function replaceAttrContent(html, attr, key, value) {
  const pattern = new RegExp(
    `(<meta[^>]*${attr}="${key}"[^>]*content=")[^"]*(")`,
    "i",
  );
  return html.replace(pattern, `$1${escapeAttr(value)}$2`);
}

export function applySocialTags(html, { title, description, url }) {
  let next = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeAttr(title)}</title>`);
  next = next.replace(
    /(<link rel="canonical" href=")[^"]*(")/i,
    `$1${escapeAttr(url)}$2`,
  );
  next = replaceAttrContent(next, "name", "description", description);
  next = replaceAttrContent(next, "property", "og:url", url);
  next = replaceAttrContent(next, "property", "og:title", title);
  next = replaceAttrContent(next, "property", "og:description", description);
  next = replaceAttrContent(next, "name", "twitter:url", url);
  next = replaceAttrContent(next, "name", "twitter:title", title);
  next = replaceAttrContent(next, "name", "twitter:description", description);
  return next;
}

export async function onRequest(context) {
  const response = await context.next();
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
  const pathname = context.request instanceof Request ? new URL(context.request.url).pathname : "";
  secured.headers.set("x-robots-tag", robotsTagForPath(pathname));
  const type = secured.headers.get("content-type") || "";
  if (!type.includes("text/html") || !pathname) return secured;
  const page = socialForPath(pathname);
  const url = canonicalForPath(pathname);
  const html = applySocialTags(await secured.text(), { ...page, url });
  return new Response(html, { status: secured.status, headers: secured.headers });
}
