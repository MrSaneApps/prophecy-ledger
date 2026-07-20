import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, makeEnv, ROOT } from "./helpers/d1.mjs";

test("ordered migrations seed a neutral incomplete Troy catalogue", () => {
  const env = makeEnv();
  const data = fixture("troy-black.json");
  const person = env.DB.db.prepare("SELECT display_name,corpus_label FROM people WHERE slug='troy-black'").get();
  assert.equal(person.display_name, data.person.displayName);
  assert.match(person.corpus_label, /not a complete catalogue/i);
  const claims = env.DB.db.prepare("SELECT claim_id,visibility,proposed_outcome FROM claims ORDER BY claim_id").all();
  assert.equal(claims.length, 2);
  assert.ok(claims.every((claim) => claim.visibility === "draft"));
  assert.ok(claims.every((claim) => claim.proposed_outcome == null));
});

test("speaker-authored archive is not mislabeled as independent proof", () => {
  const env = makeEnv();
  const evidence = env.DB.db.prepare("SELECT source_role,note,verification_method FROM evidence ORDER BY evidence_id").all();
  assert.ok(evidence.every((item) => item.source_role === "speaker_authored"));
  assert.ok(evidence.every((item) => item.verification_method === "unverified"));
  assert.match(evidence[0].note, /not independent/i);
});

test("public research supports append-only corrections by numbered revision", () => {
  const env = makeEnv();
  const first = env.DB.db.prepare(
    "SELECT brief_id,revision_number FROM public_research_briefs WHERE claim_id='southeast-asia-oil-2021' ORDER BY revision_number LIMIT 1"
  ).get();
  assert.equal(first.revision_number, 1);
  const existing = env.DB.db.prepare(
    "SELECT brief_id,revision_number,supersedes_brief_id,headline FROM public_research_briefs WHERE claim_id='southeast-asia-oil-2021' ORDER BY revision_number"
  ).all();
  assert.deepEqual(existing.map((row) => row.revision_number), [1, 2]);
  assert.equal(existing[1].supersedes_brief_id, "brief_oil_r1");
  assert.match(existing[1].headline, /timing was wrong/i);
  env.DB.db.prepare(
    `INSERT INTO public_research_briefs
     (brief_id,claim_id,revision_number,supersedes_brief_id,quotation_source_url,
      headline,evidence_strength,test_framing,evidence_summary,prior_information_summary,
      corpus_warning,missing_gates_json,research_status,as_of_date,created_at)
     SELECT 'brief_oil_r3',claim_id,3,'brief_oil_r2',quotation_source_url,
      'Corrected public brief',evidence_strength,test_framing,evidence_summary,
      prior_information_summary,corpus_warning,missing_gates_json,research_status,
      '2026-07-20','2026-07-20T00:00:00.000Z'
     FROM public_research_briefs WHERE brief_id='brief_oil_r2'`
  ).run();
  assert.equal(env.DB.db.prepare(
    "SELECT count(*) count FROM public_research_briefs WHERE claim_id='southeast-asia-oil-2021'"
  ).get().count, 3);
  assert.throws(() => env.DB.db.exec(
    "UPDATE public_research_briefs SET headline='changed' WHERE brief_id='brief_oil_r1'"
  ), /append-only/);
  assert.throws(() => env.DB.db.exec("DELETE FROM public_research_references"), /append-only/);
});

test("ledger, review, receipt, and revision records are append-only", () => {
  const env = makeEnv();
  assert.throws(() => env.DB.db.exec("UPDATE evidence SET title='changed'"), /append-only/);
  assert.throws(() => env.DB.db.exec("DELETE FROM claim_events"), /append-only/);
  env.DB.db.prepare(
    `INSERT INTO review_assignments
     (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at,lease_version)
     VALUES ('assignment_test','work_southeast-asia-oil-2021','human','leased',
       '2026-07-19T00:00:00Z','2026-07-21T00:00:00Z',1)`
  ).run();
  env.DB.db.prepare(
    `INSERT INTO moderator_reviews
     (review_id,claim_id,reviewer_id,claim_type,outcome_status,novelty_status,
      baseline_probability,evidence_ids_json,rationale,created_at)
     VALUES ('r','southeast-asia-oil-2021','human','testable_prediction','undetermined',
      'not_assessed',NULL,'["evidence_oil_archive"]','Rationale','2026-07-19')`
  ).run();
  assert.throws(() => env.DB.db.exec("DELETE FROM moderator_reviews"), /append-only/);
  env.DB.db.prepare(
    `INSERT INTO prior_information_receipts VALUES
     ('p','southeast-asia-oil-2021','2020-09-10','completed','["q"]','[]','method','2026-07-19','2026-07-19')`
  ).run();
  assert.throws(() => env.DB.db.exec("UPDATE prior_information_receipts SET status='draft'"), /append-only/);
});

test("private extraction candidates require explicit human promotion before adjudication", () => {
  const env = makeEnv();
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM candidate_claim_promotions").get().count, 0);
  assert.equal(env.DB.db.prepare(
    "SELECT count(*) count FROM review_work_items WHERE work_type='claim_adjudication'"
  ).get().count, 2);
  assert.equal(env.DB.db.prepare(
    "SELECT count(*) count FROM review_work_items WHERE work_type='candidate_verification'"
  ).get().count, 0, "the base fixture has no extracted candidates to promote or queue");
});

test("archive observations are additive human source checks with no claim or rating relationship", () => {
  const env = makeEnv();
  const columns = env.DB.db.prepare("PRAGMA table_info(archive_review_observations)").all()
    .map((column) => column.name);
  for (const required of [
    "archive_decision_id", "source_available_confirmed", "context_confirmed",
    "exact_source_confirmed", "exact_source_quote", "source_timestamp_seconds",
    "who_text", "what_text", "why_text", "where_text", "when_text", "how_text",
    "public_evidence_note", "pass_condition_note", "fail_condition_note",
  ]) assert.ok(columns.includes(required), `${required} must be preserved`);
  const foreignKeys = env.DB.db.prepare("PRAGMA foreign_key_list(archive_review_observations)").all();
  assert.deepEqual(foreignKeys.map((key) => key.table), ["archive_review_decisions"]);
  assert.ok(columns.every((name) => !/claim|rating|promotion|publication/i.test(name)));
});

test("publication requires an immutable revision and locks the published claim", () => {
  const env = makeEnv();
  assert.throws(() => env.DB.db.exec("UPDATE claims SET visibility='published' WHERE claim_id='southeast-asia-oil-2021'"), /requires an immutable/);
  env.DB.db.prepare(
    `INSERT INTO claim_revisions VALUES
     ('rev','southeast-asia-oil-2021',1,'publication','{}','["a","b"]','2026-07-19')`
  ).run();
  env.DB.db.exec("UPDATE claims SET visibility='published' WHERE claim_id='southeast-asia-oil-2021'");
  assert.throws(() => env.DB.db.exec("UPDATE claims SET title='changed' WHERE claim_id='southeast-asia-oil-2021'"), /immutable revision/);
  assert.throws(() => env.DB.db.exec("DELETE FROM claims WHERE claim_id='southeast-asia-oil-2021'"), /cannot be deleted/);
  assert.throws(() => env.DB.db.exec("DELETE FROM claim_revisions"), /append-only/);
});

test("corpus coverage cannot exceed one at the database boundary", () => {
  const env = makeEnv();
  assert.throws(() => env.DB.db.exec("UPDATE people SET reviewed_videos=3 WHERE slug='troy-black'"), /cannot exceed/);
});

test("seed migration can rerun without changing counts", () => {
  const env = makeEnv();
  const before = env.DB.db.prepare("SELECT count(*) count FROM claims").get().count;
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0002_seed_troy_black.sql"), "utf8"));
  assert.equal(env.DB.db.prepare("SELECT count(*) count FROM claims").get().count, before);
});
