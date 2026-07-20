import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/d1.mjs";
import { archiveNextPageState, archiveUrl, normalizeOfficialUrl, parseArchivePage,
  parseFulfilledProphecyArchive, parsePostDetail, youtubeId } from "../scanner/src/wordpress.js";

const raw = (name) => readFileSync(join(ROOT, "test/fixtures/scanner", name), "utf8");

test("archive parser keeps only unique well-formed Prophetic Words cards", () => {
  const cards = parseArchivePage(raw("archive-page.html"));
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.platformItemId), ["101", "102"]);
  assert.equal(cards[0].title, "A Word About Rain & Rivers");
  assert.equal(cards[1].description, "Description with markup.");
  assert.equal(cards[1].canonicalUrl, "https://troyblackvideos.com/another-public-word/");
});

test("fulfilled-prophecy parser preserves six columns, publisher identity, and ordered links", () => {
  const rows = parseFulfilledProphecyArchive(raw("fulfilled-prophecy-archive.html"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    publisherElementId: "wptb-element-text-603",
    sourceLocatorYIndex: 7,
    description: "Russian Oil Price Spike",
    dateShared: "September 10, 2020",
    prophecy: "“Russian oil prices are going to skyrocket in November.”",
    claimedResult: "The publisher says prices rose by more than 30%.",
    claimedEvidence: "Market report",
    videoLinks: [
      { ordinal: 1, label: "Original Prophecy", url: "https://www.youtube.com/watch?v=ZidiIdg3U4M", youtubeId: "ZidiIdg3U4M", linkRole: "original_video" },
      { ordinal: 2, label: "Follow-up Version", url: "https://www.youtube.com/watch?v=iyijrK-MvQo", youtubeId: "iyijrK-MvQo", linkRole: "claimed_follow_up" },
    ],
    evidenceLinks: [
      { ordinal: 1, label: "Market report", url: "https://example.com/report?a=1&b=2", youtubeId: null, linkRole: "claimed_evidence" },
    ],
  });
  assert.equal(rows[1].publisherElementId, "wptb-element-text-609");
  assert.equal(rows[1].videoLinks[0].url, "https://www.youtube.com/watch?v=AbCdEfGhI12");
});

test("fulfilled-prophecy link classification is label-bound, deduplicates split anchors, and fails closed", () => {
  const html = `<!doctype html><table><tr>
    <td data-y-index="9" data-x-index="0"><div class="wptb-element-text-999">Labels</div></td>
    <td data-y-index="9" data-x-index="1">2024</td>
    <td data-y-index="9" data-x-index="2">
      <a href="https://youtu.be/Original001">O</a><a href="https://youtu.be/Original001">riginal Prophecy</a>
      <a href="https://youtu.be/FollowUp001">Follow Up</a>
      <a href="https://youtu.be/FollowUp002">Follow-Up</a>
      <a href="https://youtu.be/RecapVideo1">Recap Video</a>
      <a href="https://youtu.be/Unknown0001">Watch this</a>
    </td>
    <td data-y-index="9" data-x-index="3">A testable statement.</td>
    <td data-y-index="9" data-x-index="4">Claimed result.</td>
    <td data-y-index="9" data-x-index="5"><a href="https://youtu.be/Evidence001">Evidence video</a></td>
  </tr></table>`;
  const [row] = parseFulfilledProphecyArchive(html);
  assert.equal(row.videoLinks.length, 5, "split anchors for one URL must be merged");
  assert.equal(row.videoLinks[0].label, "Original Prophecy");
  assert.equal(row.videoLinks[0].linkRole, "original_video");
  for (const label of ["Follow Up", "Follow-Up", "Recap Video", "Watch this"]) {
    assert.equal(row.videoLinks.find((link) => link.label === label).linkRole, "claimed_follow_up");
  }
  assert.equal(row.evidenceLinks[0].linkRole, "claimed_evidence");
  assert.equal(row.videoLinks.filter((link) => link.linkRole === "original_video").length, 1);
});

test("archive parser stops honestly on zero matching cards and handles a seven-card terminal page", () => {
  assert.deepEqual(parseArchivePage("<article class='category-general'>Other</article>"), []);
  const terminal = raw("archive-terminal.html");
  assert.equal(parseArchivePage(terminal).length, 7);
  assert.equal(archiveNextPageState(terminal, 124), false);
  assert.equal(archiveNextPageState('<a href="/series/prophetic-words/page/2/" data-page-num="2">2</a>', 1), true);
  assert.equal(archiveNextPageState("<main>No pagination</main>", 1), null);
});

test("detail parser returns exact canonical metadata and validated embedded YouTube ID", () => {
  const detail = parsePostDetail(raw("post-detail-youtube.html"), "https://troyblackvideos.com/fallback/");
  assert.equal(detail.canonicalUrl, "https://troyblackvideos.com/a-word-about-rain/");
  assert.equal(detail.title, "A Word About Rain & Rivers");
  assert.equal(detail.embeddedItemId, "ZidiIdg3U4M");
  assert.equal(detail.embeddedUrl, "https://www.youtube.com/watch?v=ZidiIdg3U4M");
  assert.match(detail.description, /not a transcript/i);
});

test("detail parser accepts missing video but rejects foreign canonical hosts and missing titles", () => {
  const detail = parsePostDetail(raw("post-detail-no-video.html"), "https://troyblackvideos.com/fallback/");
  assert.equal(detail.embeddedItemId, null);
  assert.throws(() => parsePostDetail('<link rel="canonical" href="https://evil.example/post"><title>x</title>', "https://troyblackvideos.com/x/"), /foreign_canonical_host/);
  assert.throws(() => parsePostDetail('<link rel="canonical" href="/post/">', "https://troyblackvideos.com/x/"), /missing_post_title/);
});

test("URL builders reject unsafe archive pages and malformed video IDs", () => {
  assert.equal(archiveUrl(1), "https://troyblackvideos.com/series/prophetic-words/");
  assert.equal(archiveUrl(124), "https://troyblackvideos.com/series/prophetic-words/page/124/");
  assert.throws(() => archiveUrl(251), /invalid_archive_page/);
  assert.equal(youtubeId("https://youtu.be/iyijrK-MvQo"), "iyijrK-MvQo");
  assert.equal(youtubeId("https://youtube.com/embed/not-valid"), null);
  assert.throws(() => normalizeOfficialUrl("https://example.com/post"), /foreign_canonical_host/);
});
