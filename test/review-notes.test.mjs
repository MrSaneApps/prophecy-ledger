import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPersonProfile, getPublicClaim } from "../functions/lib/repository.js";
import { makeEnv, ROOT } from "./helpers/d1.mjs";

const MIGRATION = readFileSync(join(ROOT, "migrations", "0070_joshua_oct23_review_notes.sql"), "utf8");
// 148 live claims match the October review. Two of them are not in a fresh
// replay: the Moth word (created only when migration 0067 is replayed with its
// own fixtures) and the Russian barge word (published through the reviewer
// workflow in production). Every id was checked against the live site, so a
// replay of this migration matches 146 and production matches 148.
const REPLAYABLE_ASSESSMENTS = 146;
const HALEY = "tb-2024-03-nikki-haley-s-loss";
const MARKET_PLUNGE = "tb-2026-03-market-plunge-quarter-1-2026";
const RUSSIA = "tb-2020-22-13-russian-invasion-of-ukraine";
const MOTH = "moth-prophecy-president-2024";

function replay(env, { joshua = true, notes = true } = {}) {
  const db = env.DB.db;
  if (joshua) {
    db.prepare(
      `INSERT INTO reviewer_public_attributions (attribution_id,reviewer_id,display_name,created_at)
       VALUES ('attribution_joshua_notes','reviewer_joshua_notes','Joshua','2026-09-21T00:00:00.000Z')`).run();
  }
  db.exec(readFileSync(join(ROOT, "migrations", "0064_joshua_doc_adjudications.sql"), "utf8"));
  db.exec(readFileSync(join(ROOT, "migrations", "0066_haley_amendment.sql"), "utf8"));
  if (notes) db.exec(MIGRATION);
}

const count = (env, sql) => env.DB.db.prepare(sql).get().count;

test("0070 adds assessment notes, date corrections, one overall view and four drafts", () => {
  const env = makeEnv();
  replay(env);
  assert.equal(count(env, "SELECT count(*) count FROM reviewer_notes WHERE note_kind='assessment'"), REPLAYABLE_ASSESSMENTS);
  assert.equal(count(env, "SELECT count(*) count FROM reviewer_notes WHERE note_kind='date_correction'"), 9);
  assert.equal(count(env, "SELECT count(*) count FROM reviewer_notes WHERE note_kind='overall_view'"), 1);
  assert.equal(count(env, "SELECT count(*) count FROM draft_review_entries"), 4);
  assert.equal(count(env, "SELECT count(*) count FROM draft_review_entries WHERE draft_status='draft_needs_exact_quote'"), 4);
});

test("0070 is idempotent and a no-op without a Joshua attribution", () => {
  const env = makeEnv();
  replay(env);
  env.DB.exec(MIGRATION);
  assert.equal(count(env, "SELECT count(*) count FROM reviewer_notes"), REPLAYABLE_ASSESSMENTS + 10);
  const bare = makeEnv();
  replay(bare, { joshua: false });
  assert.equal(count(bare, "SELECT count(*) count FROM reviewer_notes"), 0);
  assert.equal(count(bare, "SELECT count(*) count FROM draft_review_entries"), 0);
});

test("notes and drafts are append-only", () => {
  const env = makeEnv();
  replay(env);
  const db = env.DB.db;
  assert.throws(() => db.prepare("UPDATE reviewer_notes SET body='x' WHERE claim_id=?").run(HALEY), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM reviewer_notes WHERE claim_id=?").run(HALEY), /append-only/);
  assert.throws(() => db.prepare("UPDATE draft_review_entries SET title='x'").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM draft_review_entries").run(), /append-only/);
});

test("notes never change outcomes, scores, or stored claim rows", async () => {
  const before = makeEnv();
  replay(before, { notes: false });
  const after = makeEnv();
  replay(after);
  const a = await getPersonProfile(before.DB, "troy-black", "2026-10-25");
  const b = await getPersonProfile(after.DB, "troy-black", "2026-10-25");
  assert.deepEqual(b.score, a.score);
  assert.equal(b.claims.length, a.claims.length);
  const outcomes = (profile) => profile.claims.map((claim) => [claim.claim_id, claim.outcome_status]);
  assert.deepEqual(outcomes(b), outcomes(a));
  const decisions = (profile) => profile.researchRecords.map((r) => [r.id, r.humanDecision?.outcomeStatus]);
  assert.deepEqual(decisions(b), decisions(a));
  const rows = (env) => env.DB.db.prepare("SELECT claim_id,source_date,outcome_status FROM claims ORDER BY claim_id").all();
  assert.deepEqual(rows(after), rows(before));
});

test("Haley keeps the amended outcome and gains Joshua's labelled note", async () => {
  const env = makeEnv();
  replay(env);
  const profile = await getPersonProfile(env.DB, "troy-black", "2026-10-25");
  const record = profile.researchRecords.find((item) => item.id === HALEY);
  assert.equal(record.humanDecision.outcomeStatus, "true");
  assert.equal(record.reviewerNotes.length, 1);
  assert.equal(record.reviewerNotes[0].reviewerName, "Joshua");
  assert.equal(record.reviewerNotes[0].rating, "Weak");
  assert.match(record.reviewerNotes[0].text, /already widely expected/);
  assert.match(record.reviewerNotes[0].reviewLabel, /October 23, 2026/);
});

test("the Moth word gets Joshua's note and no decision change", () => {
  const start = MIGRATION.indexOf("'moth-prophecy-president-2024'");
  assert.ok(start > 0, "moth note present in the migration");
  const row = MIGRATION.slice(start, MIGRATION.indexOf("\n", start));
  assert.match(row, /entry 2024-2/);
  assert.match(row, /has not changed/);
  assert.match(row, /'Weak'/);
});

test("nine dates are corrected with the earlier date shown; Market Plunge is left alone", async () => {
  const env = makeEnv();
  replay(env);
  const profile = await getPersonProfile(env.DB, "troy-black", "2026-10-25");
  const russia = profile.researchRecords.find((item) => item.id === RUSSIA);
  assert.equal(russia.sourceDate, "2021-12-07");
  assert.equal(russia.dateCorrection.previousDate, "2021-07-05");
  assert.match(russia.dateCorrection.verificationUrl, /iyijrK-MvQo/);
  assert.equal(profile.claims.find((c) => c.claim_id === RUSSIA).source_date, "2021-12-07");
  assert.equal(profile.catalogueRecords.find((c) => c.claim_id === RUSSIA).source_date, "2021-12-07");
  assert.equal(env.DB.db.prepare("SELECT source_date FROM claims WHERE claim_id=?").get(RUSSIA).source_date, "2021-07-05");
  assert.equal(profile.researchRecords.filter((item) => item.dateCorrection).length, 9);
  const market = profile.researchRecords.find((item) => item.id === MARKET_PLUNGE);
  assert.equal(market.sourceDate, "2025-12-24");
  assert.equal(market.dateCorrection, undefined);
  assert.equal(market.reviewerNotes.length, 1);
});

test("public claim detail carries notes and the corrected date", async () => {
  const env = makeEnv();
  replay(env);
  const detail = await getPublicClaim(env.DB, RUSSIA);
  assert.equal(detail.claim.source_date, "2021-12-07");
  assert.equal(detail.dateCorrection.previousDate, "2021-07-05");
  assert.equal(detail.reviewerNotes.length, 1);
  const plain = await getPublicClaim(env.DB, HALEY);
  assert.equal(plain.dateCorrection, null);
});

test("draft entries stay out of every public projection", async () => {
  const env = makeEnv();
  replay(env);
  const profile = JSON.stringify(await getPersonProfile(env.DB, "troy-black", "2026-10-25"));
  for (const title of ["Elon Musk 2022 Prophecy", "Fire in the Skies: November 2025", "Bar Exam Prophecy", "Four-Week Economy Word: Japan"]) {
    assert.equal(profile.includes(title), false, title);
  }
  assert.equal(profile.includes("draft_needs_exact_quote"), false);
  assert.equal(count(env, "SELECT count(*) count FROM claims WHERE title IN ('Bar Exam Prophecy','Elon Musk 2022 Prophecy')"), 0);
  const bar = env.DB.db.prepare("SELECT * FROM draft_review_entries WHERE title='Bar Exam Prophecy'").get();
  assert.equal(bar.date_check, "video_not_available");
  assert.equal(bar.youtube_upload_date, null);
});

test("overall view is attributed to Joshua and speaks only about predictions", async () => {
  const env = makeEnv();
  replay(env);
  const profile = await getPersonProfile(env.DB, "troy-black", "2026-10-25");
  assert.equal(profile.reviewerOverallNotes.length, 1);
  const note = profile.reviewerOverallNotes[0];
  assert.equal(note.reviewerName, "Joshua");
  assert.match(note.text, /This is Joshua's view/);
  assert.doesNotMatch(note.text, /gifting|prophetic ministry/i);
});

test("note wording is plain and carries no Deere material", () => {
  const env = makeEnv();
  replay(env);
  const text = env.DB.db.prepare("SELECT group_concat(body, ' ') text FROM reviewer_notes").get().text
    + " " + env.DB.db.prepare("SELECT group_concat(body, ' ') text FROM draft_review_entries").get().text;
  for (const banned of [/clock game/i, /retrofit/i, /noun swap/i, /word of obvious/i, /miss-and-rewrite/i,
    /composite/i, /base[- ]rate/i, /Deere/i, /Vineyard/i, /molest/i, /cover-up/i, /Malarkey/i]) {
    assert.doesNotMatch(text, banned);
  }
});

test("0070 is additive: it never writes outcomes, amendments, reviews, or claim rows", () => {
  const sql = MIGRATION.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE)\b/im);
  for (const table of ["claims", "claim_decision_amendments", "moderator_reviews", "claim_revisions",
    "public_research_briefs", "claim_events"]) {
    assert.doesNotMatch(sql, new RegExp(`INSERT[^;]*INTO\\s+${table}\\b`, "i"), table);
    assert.doesNotMatch(sql, new RegExp(`UPDATE\\s+${table}\\b`, "i"), table);
  }
  assert.match(sql, /moth-prophecy-president-2024/);
});
