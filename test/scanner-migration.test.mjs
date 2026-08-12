import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { D1Shim, makeEnv, ROOT } from "./helpers/d1.mjs";
import { analysisDiscoverySql } from "../scripts/analysis-reconciler.mjs";

test("ingestion migration creates operational, inventory, transcript, and candidate tables", () => {
  const env = makeEnv();
  const names = env.DB.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  for (const name of ["ingestion_runs", "ingestion_jobs", "source_items", "source_item_revisions", "source_item_links", "source_availability_events", "source_scan_receipts", "transcript_attempts", "transcript_artifacts", "extraction_runs", "claim_candidates", "video_analysis_attempts", "video_claim_candidates", "video_cross_checks", "video_agreement_results", "video_escalation_events"]) assert.ok(names.includes(name), name);
});

test("archive leads use a separate append-only review lane with no independent-outcome provenance", () => {
  const env = makeEnv(); const db = env.DB.db;
  for (const name of ["first_party_archive_receipts", "first_party_archive_leads",
    "first_party_archive_lead_revisions", "first_party_archive_revision_observations",
    "first_party_archive_revision_links", "first_party_archive_source_confirmations",
    "archive_verification_work_items", "archive_review_assignments",
    "archive_review_decisions", "archive_review_source_checks"]) {
    assert.ok(db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?").get(name), name);
  }
  const migration = readFileSync(join(ROOT, "migrations/0020_first_party_archive_leads.sql"), "utf8");
  assert.doesNotMatch(migration, /'independent_outcome'/);
  assert.doesNotMatch(migration, /(?:ALTER|DROP)\s+TABLE\s+review_work_items/i);
  assert.doesNotMatch(migration, /(?:ALTER|DROP)\s+TABLE\s+ingestion_jobs/i);
  assert.equal(db.prepare("SELECT identity_status FROM sources WHERE source_id='source_troy_archive'").get().identity_status, "confirmed");
  assert.throws(() => db.prepare("UPDATE first_party_archive_source_confirmations SET confirmed_at='later'").run(), /append-only/);
  assert.throws(() => db.prepare(`INSERT INTO first_party_archive_lead_revisions
    (archive_revision_id,archive_lead_id,receipt_id,content_sha256,source_locator_y_index,
     description_text,prophecy_text,prophecy_provenance,result_provenance,evidence_provenance,
     parser_version,fetched_at) VALUES ('bad','missing','missing',?,1,'d','p',
      'independent_outcome','first_party_claimed_result','first_party_claimed_evidence','v1','2026-07-20')`)
    .run("a".repeat(64)), /CHECK constraint|FOREIGN KEY constraint/);
  assert.match(migration, /FOREIGN KEY \(archive_revision_id,archive_video_link_id\)/);
  assert.match(migration, /'claimed_follow_up'/);
});

test("transcript analysis migration is additive and keeps private section work separate from acquisition", () => {
  const env = makeEnv(); const db = env.DB.db;
  for (const name of ["transcript_analysis_runs", "transcript_analysis_sections",
    "transcript_batch_repair_events"]) {
    assert.ok(db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?").get(name), name);
  }
  const migration = readFileSync(join(ROOT, "migrations/0021_transcript_analysis.sql"), "utf8");
  assert.doesNotMatch(migration, /(?:ALTER|DROP)\s+TABLE\s+ingestion_jobs/i);
  assert.doesNotMatch(migration, /transcript_(?:text|body)|r2_key/i);
  assert.match(migration, /legacy_stitch_repaired/);
  assert.ok(db.prepare(`SELECT 1 ok FROM sqlite_master WHERE type='trigger'
    AND name='transcript_batch_repair_events_no_update'`).get());
});

test("transcript batch repair migration makes frozen item identity append-only", () => {
  const env = makeEnv(); const db = env.DB.db;
  const migration = readFileSync(join(ROOT, "migrations/0023_transcript_batch_repair.sql"), "utf8");
  assert.doesNotMatch(migration, /(?:DELETE|DROP)\s+(?:FROM|TABLE)\s+transcript_batch_items/i);
  for (const name of ["transcript_batch_items_identity_guard", "transcript_batch_items_no_delete"]) {
    assert.ok(db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='trigger' AND name=?").get(name), name);
  }
  assert.ok(db.prepare(`SELECT 1 ok FROM sqlite_master WHERE type='index'
    AND name='transcript_batch_one_legacy_repair'`).get());
});

test("candidate persistence rejections are content-free and append-only", () => {
  const env = makeEnv(); const db = env.DB.db;
  const columns = db.prepare("PRAGMA table_info(extraction_candidate_persistence_rejections)")
    .all().map((row) => row.name);
  assert.deepEqual(columns, ["rejection_id", "extraction_run_id", "candidate_ordinal",
    "candidate_id", "assessment_id", "error_code", "created_at"]);
  assert.ok(db.prepare(`SELECT 1 ok FROM sqlite_master WHERE type='trigger'
    AND name='extraction_candidate_persistence_rejections_no_update'`).get());
  const migration = readFileSync(join(ROOT, "migrations/0024_candidate_persistence_rejections.sql"), "utf8");
  assert.doesNotMatch(migration, /quote|transcript_(?:text|body)|grounding/i);
});

test("video migration preserves existing Queue rows while extending the job type constraint", () => {
  const db = new D1Shim();
  for (const file of readdirSync(join(ROOT, "migrations")).filter((name) => /^000[1-6]_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  db.db.prepare("INSERT INTO ingestion_runs(run_id,person_id,trigger_type,scope,status,created_at) VALUES ('run_old','person_troy_black','manual','official_site','running','2026-07-19')").run();
  db.db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,successor_enqueued)
    VALUES ('job_old','run_old','run_reconcile','old','{}','completed',2,1)`).run();
  db.exec(readFileSync(join(ROOT, "migrations/0007_gemini_video_analysis.sql"), "utf8"));
  const preserved = db.db.prepare("SELECT job_type,status,attempt_count,successor_enqueued FROM ingestion_jobs WHERE job_id='job_old'").get();
  assert.equal(preserved.job_type, "run_reconcile");
  assert.equal(preserved.status, "completed");
  assert.equal(preserved.attempt_count, 2);
  assert.equal(preserved.successor_enqueued, 1);
  db.db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status)
    VALUES ('job_video','run_old','video_analysis_primary','video','{}','queued')`).run();
});

test("0018 upgrades the already-applied empty 0016 batch schema without rewriting history", () => {
  const db = new D1Shim();
  for (const file of readdirSync(join(ROOT, "migrations")).filter((name) =>
    /^00(?:0[1-9]|1[0-6])_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  const beforeBatch = db.db.prepare("PRAGMA table_info(transcript_batches)").all().map((row) => row.name);
  const beforeItem = db.db.prepare("PRAGMA table_info(transcript_batch_items)").all().map((row) => row.name);
  assert.ok(!beforeBatch.includes("transition_count"));
  assert.ok(!beforeItem.includes("dispatch_state"));
  db.exec(readFileSync(join(ROOT, "migrations/0018_transcript_batch_dispatch_upgrade.sql"), "utf8"));
  const batchColumns = db.db.prepare("PRAGMA table_info(transcript_batches)").all().map((row) => row.name);
  const itemColumns = db.db.prepare("PRAGMA table_info(transcript_batch_items)").all().map((row) => row.name);
  assert.ok(batchColumns.includes("transition_count"));
  for (const column of ["dispatch_state", "dispatch_claimed_at", "first_job_dispatched_at", "last_job_dispatched_at"]) {
    assert.ok(itemColumns.includes(column), column);
  }
  db.db.prepare(`INSERT INTO transcript_batches
    (batch_id,idempotency_key,person_id,status,item_count,created_at,started_at)
    VALUES ('txb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','upgrade-test','person_troy_black','running',1,'2026-07-20','2026-07-20')`).run();
  db.db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES ('run_upgrade','person_troy_black','manual',
      'transcript:src_upgrade:60:batch:txb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','running','2026-07-20')`).run();
  db.db.prepare(`INSERT INTO source_items VALUES
    ('src_upgrade','person_troy_black',NULL,'youtube','Upgrade0001',
      'https://www.youtube.com/watch?v=Upgrade0001','2026-07-20','2026-07-20','available')`).run();
  db.db.prepare(`INSERT INTO transcript_batch_items
    (batch_item_id,batch_id,source_item_id,youtube_id,ordinal,status,run_id,duration_seconds,started_at)
    VALUES ('txbi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'txb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','src_upgrade','Upgrade0001',1,'active','run_upgrade',60,'2026-07-20')`).run();
  assert.throws(() => db.db.exec(`UPDATE transcript_batch_items
    SET status='completed',completed_at='2026-07-20T00:01:00Z'`), /dispatch lifecycle/);
  db.db.exec(`UPDATE transcript_batch_items SET status='completed',dispatch_state='sent',
    first_job_dispatched_at='2026-07-20T00:00:00Z',last_job_dispatched_at='2026-07-20T00:00:30Z',
    completed_at='2026-07-20T00:01:00Z'`);
  assert.equal(db.db.prepare("SELECT status FROM transcript_batch_items").get().status, "completed");
});

test("0019 preserves duration history and admits only official Data API provenance", () => {
  const db = new D1Shim();
  for (const file of readdirSync(join(ROOT, "migrations")).filter((name) =>
    /^00(?:0[1-9]|1[0-8])_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  db.db.prepare(`INSERT INTO source_items VALUES
    ('src_duration_upgrade','person_troy_black',NULL,'youtube','Upgrade0002',
      'https://www.youtube.com/watch?v=Upgrade0002','2026-07-20','2026-07-20','available')`).run();
  db.db.prepare(`INSERT INTO source_media_metadata VALUES
    ('smm_existing','src_duration_upgrade',60,'youtube_public_html_length_seconds',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-07-20')`).run();
  db.exec(readFileSync(join(ROOT, "migrations/0019_youtube_data_api_duration_provenance.sql"), "utf8"));
  assert.equal(db.db.prepare("SELECT method FROM source_media_metadata WHERE metadata_id='smm_existing'").get().method,
    "youtube_public_html_length_seconds");
  db.db.prepare(`INSERT INTO source_media_metadata VALUES
    ('smm_data_api','src_duration_upgrade',61,'youtube_data_api_v3_content_details',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','2026-07-20')`).run();
  assert.throws(() => db.db.prepare(`INSERT INTO source_media_metadata VALUES
    ('smm_bad','src_duration_upgrade',62,'untrusted_method',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','2026-07-20')`).run(), /CHECK constraint/);
  assert.throws(() => db.db.exec("UPDATE source_media_metadata SET duration_seconds=62"), /append-only/);
});

test("migration reruns and source evidence remains append-only", () => {
  const env = makeEnv();
  env.DB.exec(readFileSync(join(ROOT, "migrations/0006_ingestion_pipeline.sql"), "utf8"));
  env.DB.db.prepare("INSERT INTO ingestion_runs(run_id,person_id,trigger_type,scope,status,created_at) VALUES ('run','person_troy_black','canary','official_site','running','2026-07-19')").run();
  env.DB.db.prepare(`INSERT INTO source_items VALUES
    ('src','person_troy_black','source_troy_site','official_site','123','https://troyblackvideos.com/post/','2026-07-19','2026-07-19','available')`).run();
  env.DB.db.prepare(`INSERT INTO source_item_revisions VALUES
    ('rev','src','hash','https://troyblackvideos.com/post/','Title','Description','2026-01-01',NULL,NULL,NULL,'2026-07-19','v1','run')`).run();
  assert.throws(() => env.DB.db.exec("UPDATE source_item_revisions SET public_title='Changed'"), /append-only/);
  assert.throws(() => env.DB.db.exec("DELETE FROM source_items"), /cannot be deleted/);
  env.DB.db.exec("UPDATE source_items SET last_seen_at='2026-07-20',availability='unavailable'");
  assert.throws(() => env.DB.db.exec("UPDATE source_items SET canonical_url='https://troyblackvideos.com/other/'"), /identity is immutable/);
});

test("description leads cannot masquerade as quotations or ratings", () => {
  const env = makeEnv();
  env.DB.db.prepare("INSERT INTO ingestion_runs(run_id,person_id,trigger_type,scope,status,created_at) VALUES ('run','person_troy_black','manual','official_site','running','2026-07-19')").run();
  env.DB.db.prepare("INSERT INTO source_items VALUES ('src','person_troy_black',NULL,'official_site','1','https://troyblackvideos.com/post/','2026-07-19','2026-07-19','available')").run();
  env.DB.db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,transcript_id,input_kind,input_sha256,prompt_version,model_family,status,started_at,completed_at)
    VALUES ('ext','src',NULL,'first_party_description','hash','v1','model','completed','2026-07-19','2026-07-19')`).run();
  env.DB.db.prepare(`INSERT INTO claim_candidates
    (candidate_id,extraction_run_id,source_item_id,candidate_kind,neutral_paraphrase,requires_transcript,requires_human_review,created_at)
    VALUES ('lead','ext','src','description_lead','Possible prediction',1,1,'2026-07-19')`).run();
  assert.throws(() => env.DB.db.prepare(`INSERT INTO claim_candidates
    (candidate_id,extraction_run_id,source_item_id,candidate_kind,neutral_paraphrase,exact_quote,quote_start,quote_end,requires_transcript,requires_human_review,created_at)
    VALUES ('bad','ext','src','description_lead','x','invented',0,8,1,1,'2026-07-19')`).run(), /CHECK constraint/);
  const columns = env.DB.db.prepare("PRAGMA table_info(claim_candidates)").all().map((row) => row.name);
  assert.ok(!columns.some((name) => /outcome|rating|score|novelty|baseline/.test(name)));
});

test("Gemini video evidence is append-only and cannot become a rating row", () => {
  const env = makeEnv();
  env.DB.db.prepare("INSERT INTO ingestion_runs(run_id,person_id,trigger_type,scope,status,created_at) VALUES ('run_video','person_troy_black','canary','video_analysis','running','2026-07-20')").run();
  env.DB.db.prepare("INSERT INTO source_items VALUES ('src_video','person_troy_black',NULL,'youtube','ZidiIdg3U4M','https://www.youtube.com/watch?v=ZidiIdg3U4M','2026-07-20','2026-07-20','available')").run();
  env.DB.db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status)
    VALUES ('job_video','run_video','video_analysis_primary','video','{}','completed')`).run();
  env.DB.db.prepare(`INSERT INTO video_analysis_attempts
    (attempt_id,run_id,job_id,source_item_id,stage,provider,model_name,prompt_version,prompt_text,
     video_url,request_sha256,transport,gateway_id,raw_output_json,structured_output_json,status,started_at,completed_at)
    VALUES ('attempt','run_video','job_video','src_video','primary','google_gemini','model','video-primary-v1','prompt',
     'https://www.youtube.com/watch?v=ZidiIdg3U4M','hash','cloudflare_ai_gateway','default','{}','{"claims":[]}','completed','2026-07-20','2026-07-20')`).run();
  env.DB.db.prepare(`INSERT INTO video_claim_candidates
    (candidate_id,source_item_id,primary_attempt_id,ordinal,exact_quote,start_seconds,end_seconds,statement_type,
     atomic_proposition,context_before,context_after,confidence,created_at)
    VALUES ('candidate','src_video','attempt',0,'It will rain',10,13,'testable_prediction',
     'It will rain.','','',0.9,'2026-07-20')`).run();
  assert.throws(() => env.DB.db.exec("UPDATE video_claim_candidates SET confidence=1"), /append-only/);
  assert.throws(() => env.DB.db.exec("DELETE FROM video_analysis_attempts"), /append-only/);
  const columns = env.DB.db.prepare("PRAGMA table_info(video_claim_candidates)").all().map((row) => row.name);
  assert.ok(!columns.some((name) => /outcome|rating|score|novelty|baseline/.test(name)));
});

test("legacy exact candidates are quarantined and queue state is withdrawn without deleting history", () => {
  const db = new D1Shim();
  for (const file of readdirSync(join(ROOT, "migrations")).filter((name) => /^00(?:0[1-9]|1[0-3])_.*\.sql$/.test(name)).sort()) {
    db.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  db.db.prepare("INSERT INTO ingestion_runs(run_id,person_id,trigger_type,scope,status,created_at) VALUES ('run_legacy','person_troy_black','canary','legacy','complete','2026-07-20')").run();
  db.db.prepare(`INSERT INTO source_items VALUES
    ('source_legacy','person_troy_black',NULL,'youtube','c3vf85nk1O0','https://www.youtube.com/watch?v=c3vf85nk1O0','2026-07-20','2026-07-20','unknown')`).run();
  db.db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,input_kind,input_sha256,prompt_version,model_family,status,started_at,completed_at)
    VALUES ('extract_legacy','source_legacy','verified_transcript','hash','transcript-claims-v3','model','completed','2026-07-20','2026-07-20')`).run();
  const quote = "It's about power and sometimes who you know and how you interact with each other is more valuable than what you have.";
  db.db.prepare(`INSERT INTO claim_candidates
    (candidate_id,extraction_run_id,source_item_id,candidate_kind,exact_quote,quote_start,quote_end,
     source_timestamp_seconds,proposed_statement_type,atomic_proposition_draft,explicit_deadline_text,
     requires_transcript,requires_human_review,created_at)
    VALUES ('candidate_legacy','extract_legacy','source_legacy','exact_transcript_claim',?,0,?,0,
      'testable_prediction','President Trump understands the value of relationships and power.',
      'potentially sometime this year or into the next year',0,1,'2026-07-20')`).run(quote, quote.length);
  db.exec(readFileSync(join(ROOT, "migrations/0014_reviewer_workflow.sql"), "utf8"));
  db.db.prepare(`INSERT INTO review_assignments
    (assignment_id,work_item_id,reviewer_id,status,assigned_at,lease_expires_at)
    VALUES ('assignment_legacy','work_candidate_candidate_legacy','reviewer','leased','2026-07-20','2026-07-21')`).run();
  const migration = readFileSync(join(ROOT, "migrations/0015_candidate_admissibility.sql"), "utf8");
  db.exec(migration); db.exec(migration);
  assert.equal(db.db.prepare("SELECT decision FROM candidate_admissibility_assessments WHERE candidate_id='candidate_legacy'").get().decision, "quarantined");
  assert.equal(db.db.prepare("SELECT status FROM review_work_items WHERE candidate_id='candidate_legacy'").get().status, "withdrawn");
  assert.equal(db.db.prepare("SELECT status FROM review_assignments WHERE assignment_id='assignment_legacy'").get().status, "released");
  assert.equal(db.db.prepare("SELECT count(*) count FROM claim_candidates WHERE candidate_id='candidate_legacy'").get().count, 1);
  assert.equal(db.db.prepare("SELECT count(*) count FROM eligible_claim_candidates").get().count, 0);
  const audit = db.db.prepare(`SELECT event_type,work_item_id,candidate_id,detail_json
    FROM review_audit_events WHERE audit_event_id='audit_m0015_quarantine_work_candidate_candidate_legacy'`).get();
  assert.equal(audit.event_type, "evaluation_reconciled");
  assert.equal(audit.work_item_id, "work_candidate_candidate_legacy");
  assert.equal(audit.candidate_id, "candidate_legacy");
  assert.deepEqual(JSON.parse(audit.detail_json), {
    action: "candidate_quarantined",
    gateVersion: "legacy-v3-quarantine",
    assignmentReleased: true,
  });
  assert.equal(db.db.prepare(`SELECT count(*) count FROM review_audit_events
    WHERE audit_event_id='audit_m0015_quarantine_work_candidate_candidate_legacy'`).get().count, 1);
  assert.throws(() => db.db.exec("UPDATE candidate_admissibility_assessments SET decision='eligible'"), /append-only/);
  assert.throws(() => db.db.exec("DELETE FROM candidate_admissibility_assessments"), /append-only/);
});

test("future eligible assessments require structured grounding and exact support spans", () => {
  const env = makeEnv(); const db = env.DB.db;
  db.prepare("INSERT INTO ingestion_runs(run_id,person_id,trigger_type,scope,status,created_at) VALUES ('run_ground','person_troy_black','manual','grounding','complete','2026-07-20')").run();
  db.prepare("INSERT INTO source_items VALUES ('source_ground','person_troy_black',NULL,'youtube','Ground00001','https://www.youtube.com/watch?v=Ground00001','2026-07-20','2026-07-20','unknown')").run();
  db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,input_kind,input_sha256,prompt_version,model_family,status,started_at,completed_at)
    VALUES ('extract_ground','source_ground','verified_transcript','hash-ground','v4','model','completed','2026-07-20','2026-07-20')`).run();
  const quote = "Who what why where when.";
  db.prepare(`INSERT INTO claim_candidates
    (candidate_id,extraction_run_id,source_item_id,candidate_kind,exact_quote,quote_start,quote_end,
     proposed_statement_type,atomic_proposition_draft,requires_transcript,requires_human_review,created_at)
    VALUES ('candidate_ground','extract_ground','source_ground','exact_transcript_claim',?,0,?,
      'present_or_past_factual_claim','A grounded event happened.',0,1,'2026-07-20')`).run(quote, quote.length);
  const insert = db.prepare(`INSERT INTO candidate_admissibility_assessments
    (assessment_id,candidate_id,gate_version,decision,who_text,what_text,why_text,where_text,when_text,
     how_text,how_specificity,public_evidence_text,pass_condition_text,fail_condition_text,
     grounding_json,rejection_codes_json,assessed_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const fields = ["candidate_ground", "eligible", "Who", "what", "why", "where", "when",
    "Not stated", "not_stated", "Public record", "Record confirms it", "Record disproves it"];
  assert.throws(() => insert.run("assessment_bad_ground", fields[0], "gate-bad", ...fields.slice(1),
    "{}", "[]", "system:test", "2026-07-20T10:00:00Z"), /grounded support spans/);
  assert.throws(() => insert.run("assessment_partial_ground", fields[0], "gate-partial", ...fields.slice(1),
    JSON.stringify({ contextStart: 0, contextEnd: quote.length, dimensions: { who: { value: "Who" } } }),
    "[]", "system:test", "2026-07-20T10:00:00Z"), /grounded support spans/);
  const dimension = (value, start) => ({ value, supportQuote: value, supportStart: start, supportEnd: start + value.length });
  const grounding = JSON.stringify({ contextStart: 0, contextEnd: quote.length, dimensions: {
    who: dimension("Who", 0), what: dimension("what", 4), why: dimension("why", 9),
    where: dimension("where", 13), when: dimension("when", 19),
    how: { value: "Not stated", supportQuote: null, supportStart: null, supportEnd: null },
  } });
  insert.run("assessment_good_ground", fields[0], "gate-good", ...fields.slice(1),
    grounding, "[]", "system:test", "2026-07-20T10:00:01Z");
  assert.equal(db.prepare("SELECT decision FROM candidate_admissibility_assessments WHERE assessment_id='assessment_good_ground'").get().decision, "eligible");
});

test("0043 adds source dispositions without rewriting transcript or reviewer history", () => {
  const store = new D1Shim();
  for (const file of readdirSync(join(ROOT, "migrations"))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 42).sort()) {
    store.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  const db = store.db;
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,
     first_discovered_at,last_seen_at,availability)
    VALUES ('source_preserved_0043','person_troy_black','youtube','Preserve043',
      'https://www.youtube.com/watch?v=Preserve043','2026-08-03T00:00:00Z',
      '2026-08-03T00:00:00Z','unknown')`).run();
  const source = { source_item_id: "source_preserved_0043" };
  db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,created_at)
    VALUES ('tx_preserved_0043',?,'private/preserved-0043.txt',?,42,'en',0,
      'authorized_transcript','2026-08-03T00:00:00Z')`).run(source.source_item_id, "a".repeat(64));
  db.prepare(`INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES ('run_preserved_0043','person_troy_black','manual','preservation:0043',
      'complete','2026-08-03T00:00:00Z')`).run();
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,completed_section_count,failed_section_count,status,
     created_at,completed_at)
    VALUES ('analysis_preserved_0043','run_preserved_0043','tx_preserved_0043',?,?,'test-v1',
      1,1,0,'completed','2026-08-03T00:00:00Z','2026-08-03T00:01:00Z')`)
    .run(source.source_item_id, "a".repeat(64));
  const preservedTables = [
    "source_items", "source_item_revisions", "transcript_artifacts",
    "transcript_analysis_runs", "claims", "evidence", "review_work_items",
    "review_assignments", "moderator_reviews", "claim_revisions",
    "publication_evaluations", "claim_events", "review_audit_events",
  ];
  const snapshot = () => Object.fromEntries(preservedTables.map((name) =>
    [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  const before = snapshot();
  store.exec(readFileSync(join(ROOT, "migrations/0043_transcript_batch_source_dispositions.sql"), "utf8"));
  assert.deepEqual(snapshot(), before);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM transcript_batch_item_dispositions").get().count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0050-0056 keep a completed disposition bound across a later prompt generation", () => {
  const env = { DB: new D1Shim() };
  for (const file of readdirSync(join(ROOT, "migrations"))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 55)
    .sort()) {
    env.DB.exec(readFileSync(join(ROOT, "migrations", file), "utf8"));
  }
  const db = env.DB.db;
  const sourcePrompt = "transcript-claims-v5-grounded-5w1h-offset-repair";
  const targetPrompt = "transcript-claims-v12-gemini-gateway-plain-fallback";
  const sha = "d".repeat(64); const inputSha = "e".repeat(64);
  db.prepare(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,
     first_discovered_at,last_seen_at,availability)
    VALUES ('source_lineage','person_troy_black','youtube','Lineage0050',
      'https://www.youtube.com/watch?v=Lineage0050','2026-08-04','2026-08-04','available')`).run();
  db.prepare(`INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,language,has_timing,
     provenance,created_at)
    VALUES ('tx_lineage','source_lineage','private/lineage.txt',?,80,'en',1,
      'authorized_transcript','2026-08-04')`).run(sha);
  for (const [runId, status] of [["run_lineage_old", "failed"], ["run_lineage_new", "running"]]) {
    db.prepare(`INSERT INTO ingestion_runs
      (run_id,person_id,trigger_type,scope,status,created_at)
      VALUES (?,'person_troy_black','manual',?,?,'2026-08-04')`)
      .run(runId, `lineage:${runId}`, status);
  }
  db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,completed_at,error_code)
    VALUES ('job_lineage_old','run_lineage_old','transcript_extract','old',?,
      'failed',2,'2026-08-04','model_unavailable')`)
    .run(JSON.stringify({ phase: "analyze", analysisSectionId: "section_lineage_old" }));
  db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count)
    VALUES ('job_lineage_new','run_lineage_new','transcript_extract','new',?,'queued',0)`)
    .run(JSON.stringify({ phase: "analyze", analysisSectionId: "section_lineage_new" }));
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,failed_section_count,status,created_at,completed_at)
    VALUES ('analysis_lineage_old','run_lineage_old','tx_lineage','source_lineage',?, ?,
      1,1,'failed','2026-08-04','2026-08-04')`).run(sha, sourcePrompt);
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,status,created_at)
    VALUES ('analysis_lineage_new','run_lineage_new','tx_lineage','source_lineage',?, ?,
      1,'queued','2026-08-04')`).run(sha, targetPrompt);
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,status,attempt_count,error_code,completed_at,created_at)
    VALUES ('section_lineage_old','analysis_lineage_old',0,?,10,30,'failed',2,
      'model_unavailable','2026-08-04','2026-08-04')`).run(inputSha);
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,status,attempt_count,created_at)
    VALUES ('section_lineage_new','analysis_lineage_new',0,?,10,30,'queued',0,'2026-08-04')`)
    .run(inputSha);

  assert.equal(db.prepare(`SELECT debt_state FROM analysis_section_lineage_v2
    WHERE analysis_section_id='section_lineage_old'`).get().debt_state, "successor_pending");
  assert.throws(() => db.prepare(`INSERT INTO analysis_section_successor_links
    (link_id,predecessor_section_id,successor_section_id,predecessor_prompt_version,
     successor_prompt_version,action_id,created_at)
    VALUES ('link_bad','section_lineage_old','section_lineage_new',?,?,'action_bad','2026-08-04')`)
    .run("transcript-claims-v4-grounded-5w1h", targetPrompt), /binding mismatch/);
  db.prepare(`INSERT INTO analysis_section_successor_links
    (link_id,predecessor_section_id,successor_section_id,predecessor_prompt_version,
     successor_prompt_version,action_id,created_at)
    VALUES ('link_lineage','section_lineage_old','section_lineage_new',?,?,'action_lineage','2026-08-04')`)
    .run(sourcePrompt, targetPrompt);
  assert.throws(() => db.exec(`INSERT INTO analysis_section_dispositions
    VALUES ('disposition_early','section_lineage_old','section_lineage_new','link_lineage',
      'superseded_by_completed_successor','action_lineage','2026-08-04')`), /binding mismatch/);

  const extractionInsert = db.prepare(`INSERT INTO extraction_runs
    (extraction_run_id,source_item_id,transcript_id,input_kind,input_sha256,prompt_version,
     model_family,status,started_at,completed_at)
    VALUES (?,'source_lineage','tx_lineage','verified_transcript',?,?,
      'workers_ai','completed','2026-08-04','2026-08-04')`);
  extractionInsert.run("extract_lineage_wrong_input", "9".repeat(64), targetPrompt);
  extractionInsert.run("extract_lineage_wrong_prompt", inputSha, sourcePrompt);
  extractionInsert.run("extract_lineage_new", inputSha, targetPrompt);
  const dispositionSql = `INSERT INTO analysis_section_dispositions VALUES
    ('disposition_lineage','section_lineage_old','section_lineage_new','link_lineage',
      'superseded_by_completed_successor','action_lineage','2026-08-04')`;
  db.exec(`UPDATE transcript_analysis_sections SET status='failed',attempt_count=1,
    error_code='invalid_json',completed_at='2026-08-04'
    WHERE analysis_section_id='section_lineage_new';
    UPDATE ingestion_jobs SET status='failed',attempt_count=1,completed_at='2026-08-04',
      error_code='invalid_json' WHERE job_id='job_lineage_new';
    UPDATE transcript_analysis_runs SET status='failed',completed_section_count=0,
      failed_section_count=1,completed_at='2026-08-04'
      WHERE analysis_run_id='analysis_lineage_new';`);

  db.exec("BEGIN");
  db.prepare(`INSERT INTO analysis_reconciliation_item_receipts
    (item_receipt_id,run_id,analysis_section_id,outcome,safe_reason_code,before_status,
     after_status,readback_at,created_at,source_prompt_version,target_prompt_version)
    VALUES ('receipt_old_manual','reconcile_old_manual','section_lineage_old','manual_required',
      'legacy_manual_gate','failed','failed','2026-08-04','2026-08-04',?,?)`)
    .run(sourcePrompt, targetPrompt);
  db.prepare(`INSERT INTO analysis_reconciliation_runs
    (run_id,idempotency_sha256,limit_count,discovered_count,completed_count,
     manual_required_count,failed_count,status,started_at,completed_at)
    VALUES ('reconcile_old_manual',?,25,1,0,1,0,'completed','2026-08-04','2026-08-04')`)
    .run("f".repeat(64));
  db.exec("COMMIT");
  assert.equal(db.prepare(`SELECT debt_state FROM analysis_section_lineage_v2
    WHERE analysis_section_id='section_lineage_old'`).get().debt_state, "manual_required");

  db.exec(`UPDATE transcript_analysis_sections SET status='completed',attempt_count=2,
    extraction_run_id='extract_lineage_wrong_input',error_code=NULL,completed_at='2026-08-04'
    WHERE analysis_section_id='section_lineage_new';
    UPDATE ingestion_jobs SET status='completed',attempt_count=2,completed_at='2026-08-04',
      error_code=NULL WHERE job_id='job_lineage_new';
    UPDATE transcript_analysis_runs SET status='completed',completed_section_count=1,
      failed_section_count=0,completed_at='2026-08-04'
      WHERE analysis_run_id='analysis_lineage_new';`);
  assert.throws(() => db.exec(dispositionSql), /binding mismatch/);
  db.exec(`UPDATE transcript_analysis_sections
    SET extraction_run_id='extract_lineage_wrong_prompt'
    WHERE analysis_section_id='section_lineage_new'`);
  assert.throws(() => db.exec(dispositionSql), /binding mismatch/);
  db.exec(`UPDATE transcript_analysis_sections SET extraction_run_id='extract_lineage_new'
    WHERE analysis_section_id='section_lineage_new'`);
  assert.equal(db.prepare(`SELECT debt_state FROM analysis_section_lineage_v2
    WHERE analysis_section_id='section_lineage_old'`).get().debt_state, "finalization_pending");

  db.exec(dispositionSql);
  assert.throws(() => db.exec("UPDATE analysis_section_dispositions SET created_at='later'"),
    /append-only/);
  assert.throws(() => db.exec("DELETE FROM analysis_section_dispositions"), /append-only/);
  assert.equal(db.prepare(`SELECT status FROM transcript_analysis_sections
    WHERE analysis_section_id='section_lineage_old'`).get().status, "failed");
  assert.equal(db.prepare(`SELECT debt_state FROM analysis_section_lineage_v2
    WHERE analysis_section_id='section_lineage_old'`).get().debt_state, "superseded");

  db.exec("BEGIN");
  assert.throws(() => db.prepare(`INSERT INTO analysis_reconciliation_item_receipts
    (item_receipt_id,run_id,analysis_section_id,job_id,outcome,safe_reason_code,before_status,
     after_status,readback_at,created_at,source_prompt_version,target_prompt_version,
     successor_analysis_run_id,successor_analysis_section_id,successor_job_id,disposition_id)
    VALUES ('receipt_bad_binding','reconcile_bad','section_lineage_old','job_lineage_old',
      'completed','historical_section_superseded','failed','completed','2026-08-04','2026-08-04',
      ?,?,'analysis_lineage_new','section_lineage_new','job_lineage_old','disposition_lineage')`)
    .run(sourcePrompt, targetPrompt), /successor receipt mismatch/);
  db.exec("ROLLBACK");
  db.exec("BEGIN");
  db.prepare(`INSERT INTO analysis_reconciliation_item_receipts
    (item_receipt_id,run_id,analysis_section_id,job_id,outcome,safe_reason_code,before_status,
     after_status,readback_at,created_at,source_prompt_version,target_prompt_version,
     successor_analysis_run_id,successor_analysis_section_id,successor_job_id,disposition_id)
    VALUES ('receipt_lineage','reconcile_lineage','section_lineage_old','job_lineage_new',
      'completed','historical_section_superseded','failed','completed','2026-08-04','2026-08-04',
      ?,?,'analysis_lineage_new','section_lineage_new','job_lineage_new','disposition_lineage')`)
    .run(sourcePrompt, targetPrompt);
  db.prepare(`INSERT INTO analysis_reconciliation_runs
    (run_id,idempotency_sha256,limit_count,discovered_count,completed_count,
     manual_required_count,failed_count,status,started_at,completed_at)
    VALUES ('reconcile_lineage',?,25,1,1,0,0,'completed','2026-08-04','2026-08-04')`)
    .run("1".repeat(64));
  db.exec("COMMIT");
  env.DB.exec(readFileSync(join(ROOT,
    "migrations/0056_gemini_schema_http400_fallback_generation.sql"), "utf8"));
  const disposedAfterBump = db.prepare(`SELECT target_prompt_version,target_prompt_generation,
      successor_analysis_run_id,successor_analysis_section_id,successor_job_id,
      successor_status,successor_job_status,disposition_id,debt_state
    FROM analysis_section_lineage_v2
    WHERE analysis_section_id='section_lineage_old'`).get();
  assert.deepEqual({ ...disposedAfterBump }, {
    target_prompt_version: targetPrompt,
    target_prompt_generation: 12,
    successor_analysis_run_id: "analysis_lineage_new",
    successor_analysis_section_id: "section_lineage_new",
    successor_job_id: "job_lineage_new",
    successor_status: "completed",
    successor_job_status: "completed",
    disposition_id: "disposition_lineage",
    debt_state: "superseded",
  });
  assert.equal(db.prepare(analysisDiscoverySql(25)).all()
    .some((row) => row.analysis_section_id === "section_lineage_old"), false);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0056 exposes exhausted v12 manual debt as an immutable v13 successor requirement", () => {
  const env = makeEnv(); const db = env.DB.db;
  const prompt = "transcript-claims-v12-gemini-gateway-plain-fallback";
  const sha = "2".repeat(64);
  db.exec(`INSERT INTO source_items
    (source_item_id,person_id,platform,platform_item_id,canonical_url,
     first_discovered_at,last_seen_at,availability)
    VALUES ('source_current_manual','person_troy_black','youtube','Manual0050',
      'https://www.youtube.com/watch?v=Manual0050','2026-08-04','2026-08-04','available');
    INSERT INTO transcript_artifacts
    (transcript_id,source_item_id,r2_key,content_sha256,byte_count,provenance,created_at)
    VALUES ('tx_current_manual','source_current_manual','private/manual.txt','${sha}',10,
      'authorized_transcript','2026-08-04');
    INSERT INTO ingestion_runs
    (run_id,person_id,trigger_type,scope,status,created_at)
    VALUES ('run_current_manual','person_troy_black','manual','manual-current','failed','2026-08-04');`);
  db.prepare(`INSERT INTO ingestion_jobs
    (job_id,run_id,job_type,stable_key,payload_json,status,attempt_count,completed_at,error_code)
    VALUES ('job_current_manual','run_current_manual','transcript_extract','manual',?,
      'failed',1,'2026-08-04','manual_gate')`)
    .run(JSON.stringify({ phase: "analyze", analysisSectionId: "section_current_manual" }));
  db.prepare(`INSERT INTO transcript_analysis_runs
    (analysis_run_id,ingestion_run_id,transcript_id,source_item_id,transcript_sha256,
     prompt_version,section_count,failed_section_count,status,created_at,completed_at)
    VALUES ('analysis_current_manual','run_current_manual','tx_current_manual',
      'source_current_manual',?,?,1,1,'failed','2026-08-04','2026-08-04')`).run(sha, prompt);
  db.prepare(`INSERT INTO transcript_analysis_sections
    (analysis_section_id,analysis_run_id,section_index,input_sha256,base_offset,
     approximate_timestamp_seconds,status,attempt_count,error_code,completed_at,created_at)
    VALUES ('section_current_manual','analysis_current_manual',0,?,0,0,'failed',1,
      'manual_gate','2026-08-04','2026-08-04')`).run("3".repeat(64));
  db.exec("BEGIN");
  db.prepare(`INSERT INTO analysis_reconciliation_item_receipts
    (item_receipt_id,run_id,analysis_section_id,outcome,safe_reason_code,before_status,
     created_at,source_prompt_version,target_prompt_version)
    VALUES ('receipt_current_manual','reconcile_current_manual','section_current_manual',
      'manual_required','successor_manual_required','failed','2026-08-04',?,?)`)
    .run(prompt, prompt);
  db.prepare(`INSERT INTO analysis_reconciliation_runs
    (run_id,idempotency_sha256,limit_count,discovered_count,completed_count,
     manual_required_count,failed_count,status,started_at,completed_at)
    VALUES ('reconcile_current_manual',?,25,1,0,1,0,'completed','2026-08-04','2026-08-04')`)
    .run("4".repeat(64));
  db.exec("COMMIT");
  const lineage = db.prepare(`SELECT debt_state,target_prompt_version,source_prompt_version,
      source_attempt_count,source_error_code FROM analysis_section_lineage_v2
    WHERE analysis_section_id='section_current_manual'`).get();
  assert.deepEqual({ ...lineage }, {
    debt_state: "successor_required",
    target_prompt_version: "transcript-claims-v13-gemini-schema-http400-fallback",
    source_prompt_version: prompt,
    source_attempt_count: 1,
    source_error_code: "manual_gate",
  });
  assert.deepEqual({ ...db.prepare(`SELECT status,attempt_count,error_code FROM transcript_analysis_sections
    WHERE analysis_section_id='section_current_manual'`).get() }, {
    status: "failed", attempt_count: 1, error_code: "manual_gate",
  });
});
