import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  assert.deepEqual(existing.map((row) => row.revision_number), [1, 2, 3]);
  assert.equal(existing[2].supersedes_brief_id, "brief_oil_r2");
  assert.match(existing[2].headline, /timing was wrong/i);
  env.DB.db.prepare(
    `INSERT INTO public_research_briefs
     (brief_id,claim_id,revision_number,supersedes_brief_id,quotation_source_url,
      headline,evidence_strength,test_framing,evidence_summary,prior_information_summary,
      corpus_warning,missing_gates_json,research_status,as_of_date,created_at)
     SELECT 'brief_oil_r4',claim_id,4,'brief_oil_r3',quotation_source_url,
      'Corrected public brief',evidence_strength,test_framing,evidence_summary,
      prior_information_summary,corpus_warning,missing_gates_json,research_status,
      '2026-07-20','2026-07-20T00:00:00.000Z'
     FROM public_research_briefs WHERE brief_id='brief_oil_r3'`
  ).run();
  assert.equal(env.DB.db.prepare(
    "SELECT count(*) count FROM public_research_briefs WHERE claim_id='southeast-asia-oil-2021'"
  ).get().count, 4);
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

test("migration chain is contiguous and fresh replay exposes the recovered schema", () => {
  const files = readdirSync(join(ROOT, "migrations"))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  assert.deepEqual(files.map((name) => Number(name.slice(0, 4))),
    Array.from({ length: 61 }, (_, index) => index + 1));

  const env = makeEnv();
  const db = env.DB.db;
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((row) => row.name);
  for (const name of ["candidate_atomic_readiness", "archive_transcript_match_checks",
    "archive_post_match_checks", "archive_falsifiability_findings",
    "reviewer_feedback_claim_links", "reviewer_public_attributions",
    "workers_ai_neuron_reservations"]) {
    assert.ok(tableNames.includes(name), name);
  }
  assert.equal(db.prepare(
    "SELECT count(*) count FROM sqlite_master WHERE type='view' AND name='reviewer_feedback_effective'"
  ).get().count, 1);
  assert.equal(db.prepare("SELECT count(*) count FROM sqlite_master WHERE name='transcript_search'").get().count, 0);

  db.prepare(`INSERT INTO workers_ai_neuron_reservations
    (reservation_id,usage_day,claim_id,role,model_name,reserved_neurons,limit_neurons,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run("cf_budget_full", "2026-08-16", "southeast-asia-oil-2021",
    "critic", "@cf/nvidia/nemotron-3-120b-a12b", 7800, 7800, "2026-08-16T01:00:00Z");
  assert.throws(() => db.prepare(`INSERT INTO workers_ai_neuron_reservations
    (reservation_id,usage_day,claim_id,role,model_name,reserved_neurons,limit_neurons,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run("cf_budget_over", "2026-08-16", "russia-spring-2022",
    "judge", "@cf/qwen/qwen3-30b-a3b-fp8", 1, 7800, "2026-08-16T01:01:00Z"),
  /free neuron budget exhausted/);

  const reservationSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='gemini_media_reservations'"
  ).get().sql;
  assert.match(reservationSql, /BETWEEN 1 AND 86400/);
  assert.match(readFileSync(join(ROOT, "migrations/0008_transcript_acquisition.sql"), "utf8"),
    /BETWEEN 1 AND 28800/);

  db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,completed_at,created_at)
    VALUES ('txb_migration_skip','migration-skip','person_troy_black','completed',0,
      '2026-07-22T05:00:00Z','2026-07-22T05:00:00Z')`).run();
  db.prepare(`INSERT INTO transcript_batch_events
    (event_id,batch_id,batch_item_id,event_type,detail_json,created_at)
    VALUES ('txbe_migration_skip','txb_migration_skip',NULL,'item_skipped','{}',
      '2026-07-22T05:00:01Z')`).run();
  assert.equal(db.prepare(
    "SELECT event_type FROM transcript_batch_events WHERE event_id='txbe_migration_skip'"
  ).get().event_type, "item_skipped");

  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,source_id,platform,platform_item_id,canonical_url,
     first_discovered_at,last_seen_at,availability)
    VALUES ('source_item_migration_disposition','person_troy_black','source_troy_site',
      'youtube','Unavailable1','https://www.youtube.com/watch?v=Unavailable1',
      '2026-07-22T05:00:00Z','2026-07-22T05:00:00Z','unavailable')`).run();
  const source = db.prepare(
    "SELECT source_item_id FROM source_items WHERE source_item_id='source_item_migration_disposition'"
  ).get();
  db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,completed_at,created_at)
    VALUES ('txb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','migration-disposition',
      'person_troy_black','completed',1,'2026-07-22T05:00:00Z','2026-07-22T05:00:00Z')`).run();
  db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,ordinal,status)
    VALUES ('txbi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'txb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'Unavailable1',1,'pending')`).run(source.source_item_id);
  db.prepare(`INSERT INTO transcript_batch_item_dispositions
    (disposition_id,batch_id,batch_item_id,source_item_id,successor_batch_item_id,
     disposition,link_availability,reason_code,observed_error_code,
     expected_transition_count,applied_transition_count,created_at)
    VALUES ('txbd_migration','txb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'txbi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',?,NULL,
      'source_unavailable','unavailable','youtube_video_not_found',
      'youtube_data_api_video_not_found',0,1,'2026-07-22T05:00:01Z')`).run(source.source_item_id);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM effective_transcript_batch_item_dispositions").get().count, 1);
  assert.throws(() => db.exec("UPDATE transcript_batch_item_dispositions SET created_at='later'"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM transcript_batch_item_dispositions"), /append-only/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0050-0056 register exact generations and preserve disposed bindings", () => {
  const env = makeEnv();
  const db = env.DB.db;
  assert.deepEqual(db.prepare(`SELECT prompt_version,generation
    FROM analysis_prompt_versions ORDER BY generation`).all()
    .map((row) => [row.prompt_version, Number(row.generation)]), [
    ["transcript-claims-v4-grounded-5w1h", 4],
    ["transcript-claims-v5-grounded-5w1h-offset-repair", 5],
    ["transcript-claims-v6-atomic-routing", 6],
    ["transcript-claims-v7-exact-span-routing", 7],
    ["transcript-claims-v8-archive-checklist", 8],
    ["transcript-claims-v9-archive-quoted-checklist", 9],
    ["transcript-claims-v10-receipted-successor-routing", 10],
    ["transcript-claims-v11-gemini-gateway-abortable", 11],
    ["transcript-claims-v12-gemini-gateway-plain-fallback", 12],
    ["transcript-claims-v13-gemini-schema-http400-fallback", 13],
  ]);
  assert.throws(() => db.exec("UPDATE analysis_prompt_versions SET generation=13"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM analysis_prompt_versions"), /append-only/);
  const receiptColumns = db.prepare("PRAGMA table_info(analysis_reconciliation_item_receipts)")
    .all().map((column) => column.name);
  for (const column of ["source_prompt_version", "target_prompt_version",
    "successor_analysis_run_id", "successor_analysis_section_id", "successor_job_id",
    "disposition_id"]) assert.ok(receiptColumns.includes(column), column);
  assert.ok(db.prepare(`SELECT 1 ok FROM sqlite_master
    WHERE type='view' AND name='analysis_section_lineage_v2'`).get());
  assert.ok(db.prepare(`SELECT 1 ok FROM sqlite_master
    WHERE type='table' AND name='text_ai_attempt_receipts'`).get());
  assert.ok(db.prepare(`SELECT 1 ok FROM sqlite_master
    WHERE type='view' AND name='text_ai_attempt_receipt_history'`).get());
  const bindingMigration = readFileSync(join(ROOT,
    "migrations/0053_bind_disposed_analysis_generation.sql"), "utf8");
  assert.doesNotMatch(bindingMigration, /(?:UPDATE|DELETE\s+FROM|DROP\s+TABLE)/i);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0047 operational receipts are append-only and reject incomplete run summaries", () => {
  const env = makeEnv();
  const db = env.DB.db;
  for (const name of ["analysis_reconciliation_runs",
    "analysis_reconciliation_item_receipts", "machine_conveyor_runs",
    "machine_conveyor_item_receipts", "queue_observation_receipts",
    "runtime_deployment_receipts"]) {
    assert.ok(db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?").get(name), name);
  }
  assert.throws(() => db.prepare(`INSERT INTO analysis_reconciliation_runs
    (run_id,idempotency_sha256,limit_count,discovered_count,completed_count,
     manual_required_count,failed_count,status,started_at,completed_at)
    VALUES ('arr_bad',?,25,1,1,0,0,'completed','2026-08-03','2026-08-03')`)
    .run("a".repeat(64)), /item counts disagree/);
  db.prepare(`INSERT INTO analysis_reconciliation_runs
    (run_id,idempotency_sha256,limit_count,discovered_count,completed_count,
     manual_required_count,failed_count,status,started_at,completed_at)
    VALUES ('arr_zero',?,25,0,0,0,0,'completed','2026-08-03','2026-08-03')`)
    .run("b".repeat(64));
  db.prepare(`INSERT INTO machine_conveyor_runs
    (run_id,idempotency_sha256,limit_count,considered_count,verified_count,
     classified_count,promoted_count,reused_count,failed_count,pending_promotions_count,
     status,started_at,completed_at)
    VALUES ('mcr_zero',?,25,0,0,0,0,0,0,0,'completed','2026-08-03','2026-08-03')`)
    .run("c".repeat(64));
  assert.throws(() => db.exec("UPDATE analysis_reconciliation_runs SET completed_at='later'"),
    /append-only/);
  assert.throws(() => db.exec("DELETE FROM machine_conveyor_runs"), /append-only/);
  db.prepare(`INSERT INTO queue_observation_receipts
    (observation_id,queue_name,status,backlog_count,backlog_bytes,observed_at)
    VALUES ('queue_zero','prophecy-ledger-analysis','observed',0,0,'2026-08-03')`).run();
  assert.throws(() => db.exec("DELETE FROM queue_observation_receipts"), /append-only/);
  const migration = readFileSync(join(ROOT, "migrations/0047_operations_run_receipts.sql"), "utf8");
  assert.doesNotMatch(migration, /transcript_(?:body|text)|reviewer_(?:id|token)|provider_(?:body|error)/i);
});
