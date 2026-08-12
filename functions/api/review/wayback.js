import { resolveReviewerPrincipal } from "../../lib/reviewer-auth.js";
import { apiError, json } from "../../lib/response.js";

export async function onRequestGet({ request, env }) {
  const principal = await resolveReviewerPrincipal(request, env);
  if (!principal) return apiError("Not found.", "not_found", 404);
  const target = String(new URL(request.url).searchParams.get("url") || "").trim();
  let parsed;
  try {
    parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("scheme");
  } catch {
    return apiError("Provide a full http(s) URL to look up.", "url_invalid", 400);
  }
  if (target.length > 500) return apiError("The URL is too long.", "url_invalid", 400);
  try {
    const cdx = new URL("https://web.archive.org/cdx/search/cdx");
    cdx.searchParams.set("url", target);
    cdx.searchParams.set("output", "json");
    cdx.searchParams.set("fl", "timestamp,original,statuscode");
    cdx.searchParams.set("filter", "statuscode:200");
    cdx.searchParams.set("collapse", "timestamp:8");
    cdx.searchParams.set("limit", "80");
    const response = await fetch(cdx.href, {
      headers: { accept: "application/json", "user-agent": "prophecy-ledger-research/1.0" },
    });
    if (!response.ok) throw new Error(`cdx_${response.status}`);
    const rows = await response.json();
    const snapshots = (Array.isArray(rows) ? rows.slice(1) : []).map(([timestamp, original]) => ({
      timestamp,
      capturedAt: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
      snapshotUrl: `https://web.archive.org/web/${timestamp}/${original}`,
    }));
    return json({
      url: target,
      snapshots,
      basis: "Independent Wayback Machine index. Snapshots show what the page said on each date; compare them to find changed or deleted content. Absence of a snapshot is not proof a page never existed.",
    });
  } catch (error) {
    console.error("wayback_lookup_failed", error);
    return apiError("The Wayback index is unavailable right now.", "wayback_unavailable", 503);
  }
}
