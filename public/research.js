const html = String.raw;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

function timeLabel(seconds) {
  if (!Number.isFinite(Number(seconds))) return "?";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

async function requestJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The research console is unavailable.");
  return data;
}

export function researchPanelMarkup() {
  return html`<details class="tool-panel" id="research-panel"><summary>Transcript research console</summary><div class="tool-panel-body">
    <p>Search the private AI-generated transcript archive. Every hit is cited: video, date, clip range, and transcript hash. Clip ranges are approximate locators; confirm exact words against the original video before citing publicly.</p>
    <form id="research-form"><div class="research-controls"><label>Search the archive<input name="q" type="search" required minlength="2" maxlength="200" placeholder="Try a phrase: oil boom · war · economy"></label><label>Mode<select name="mode"><option value="any">All words</option><option value="phrase">Exact phrase</option><option value="advanced">Advanced (FTS syntax)</option></select></label><button type="submit">Search</button></div></form>
    <p id="research-status" class="form-status" role="status" aria-live="polite"></p>
    <div id="research-results"></div>
    <h4 class="wayback-heading">Source history (Wayback Machine)</h4>
    <p>Independent snapshots of any page over time. Use it on the speaker's own site or social pages to find what changed or was deleted. Absence of a snapshot proves nothing.</p>
    <form id="wayback-form"><div class="research-controls"><label>Page URL<input name="url" type="url" required maxlength="500" placeholder="https://troyblackvideos.com/prophecy-archive-all/"></label><button type="submit">List snapshots</button></div></form>
    <p id="wayback-status" class="form-status" role="status" aria-live="polite"></p>
    <div id="wayback-results"></div>
    <p class="research-index-row"><button id="research-index" type="button">Index newly acquired transcripts</button><span id="research-index-status" class="form-status" role="status"></span></p>
  </div></details>`;
}

export function bindResearchPanel() {
  const form = document.querySelector("#research-form");
  const status = document.querySelector("#research-status");
  const results = document.querySelector("#research-results");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const query = String(data.get("q") || "").trim();
    status.textContent = "Searching the archive…";
    results.innerHTML = "";
    try {
      const payload = await requestJson(await fetch(
        `/api/review/search?q=${encodeURIComponent(query)}&mode=${encodeURIComponent(data.get("mode"))}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      ));
      status.textContent = payload.hits.length
        ? `${payload.hits.length} cited ${payload.hits.length === 1 ? "hit" : "hits"}.`
        : "No matches in the indexed archive.";
      results.innerHTML = payload.hits.map((hit) => {
        const marked = escapeHtml(hit.snippet).replaceAll("[", "<mark>").replaceAll("]", "</mark>");
        const watchUrl = hit.clipStartSeconds != null && hit.videoUrl
          ? `${hit.videoUrl}${hit.videoUrl.includes("?") ? "&" : "?"}t=${hit.clipStartSeconds}s` : hit.videoUrl;
        const clip = hit.clipStartSeconds != null
          ? `clip ${timeLabel(hit.clipStartSeconds)}–${timeLabel(hit.clipEndSeconds)}` : "clip range unknown";
        return html`<article class="search-hit"><blockquote>…${marked}…</blockquote><p class="hit-citation">${watchUrl ? `<a href="${escapeHtml(watchUrl)}" rel="noreferrer">${escapeHtml(hit.videoTitle || "Original video")} ↗</a>` : escapeHtml(hit.videoTitle || "Original video")} · ${escapeHtml(hit.publishedAt || "date not recorded")} · ${escapeHtml(clip)} · transcript ${escapeHtml(String(hit.transcriptSha256 || "").slice(0, 8))}</p></article>`;
      }).join("");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "The search failed.";
    }
  });
  const waybackForm = document.querySelector("#wayback-form");
  const waybackStatus = document.querySelector("#wayback-status");
  const waybackResults = document.querySelector("#wayback-results");
  waybackForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = String(new FormData(waybackForm).get("url") || "").trim();
    waybackStatus.textContent = "Checking the Wayback index…";
    waybackResults.innerHTML = "";
    try {
      const payload = await requestJson(await fetch(
        `/api/review/wayback?url=${encodeURIComponent(url)}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      ));
      waybackStatus.textContent = payload.snapshots.length
        ? `${payload.snapshots.length} snapshots. Compare dates to find changes or deletions.`
        : "No snapshots indexed for that URL. Absence is not proof it never existed.";
      waybackResults.innerHTML = payload.snapshots.length
        ? html`<ul class="wayback-list">${payload.snapshots.map((snap) =>
            `<li><a href="${escapeHtml(snap.snapshotUrl)}" rel="noreferrer">${escapeHtml(snap.capturedAt)} ↗</a></li>`).join("")}</ul>`
        : "";
    } catch (error) {
      waybackStatus.textContent = error instanceof Error ? error.message : "The lookup failed.";
    }
  });
  const indexButton = document.querySelector("#research-index");
  const indexStatus = document.querySelector("#research-index-status");
  indexButton?.addEventListener("click", async () => {
    indexButton.disabled = true;
    indexStatus.textContent = "Indexing…";
    try {
      const result = await requestJson(await fetch("/api/review/search-index", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      }));
      indexStatus.textContent = `Indexed ${result.indexedTranscripts} new (${result.totalTranscripts} transcripts, ${result.totalChunks} clips total).`;
    } catch (error) {
      indexStatus.textContent = error instanceof Error ? error.message : "Indexing failed.";
    } finally {
      indexButton.disabled = false;
    }
  });
}
