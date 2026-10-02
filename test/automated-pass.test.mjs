import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePublication, reviewDecisionFingerprint } from "../functions/lib/claims.js";
import { getPersonProfile } from "../functions/lib/repository.js";
import { makeEnv, ROOT } from "./helpers/d1.mjs";

const RUSSIA = "russia-spring-2022";
const ECUADOR = "claim_743b73bfe201575d3e1119ae";
const OIL_DUP = "claim_e339f8e0e654570867b45d50";
const MOTH = "moth-prophecy-president-2024";
const SPAIN = "tb-2026-16-spain-wins-the-2026-world-cup";

function seedBacklog(env) {
  const db = env.DB.db;
  db.prepare(
    "INSERT INTO reviewer_public_attributions (attribution_id,reviewer_id,display_name,created_at) " +
    "VALUES ('attribution_joshua_doctest','reviewer_joshua_doctest','Joshua','2026-09-21T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO claims (claim_id,person_id,cluster_id,title,exact_quote,source_url,source_date," +
    "statement_type,atomic_proposition,criteria,deadline,source_timestamp_seconds,as_of_date," +
    "lifecycle_status,outcome_status,visibility,created_at) VALUES " +
    "('claim_743b73bfe201575d3e1119ae','person_troy_black','cluster_ecuador_test'," +
    "'Ecuador Government Branch Shutdown'," +
    "'Shutting down the governmental branches, the ones which protect rights, in Ecuador.'," +
    "'https://www.youtube.com/watch?v=QtPaJ0MlFng','2023-04-22','testable_prediction'," +
    "'A governmental branch in Ecuador that protects rights will be shut down.'," +
    "'The cited fulfillment event (Lasso dissolving the Assembly on May 17, 2023) must match per independent sources.'," +
    "'2022-12-31',0,'2026-07-24','deadline_passed_awaiting_review','undetermined','draft'," +
    "'2026-07-24T00:00:00.000Z')," +
    "('claim_e339f8e0e654570867b45d50','person_troy_black','cluster_oil_dup_test'," +
    "'Southeast Asia Oil Boom in 2021'," +
    "'There is going to be an oil boom in Southeast Asia next year.'," +
    "'https://www.youtube.com/watch?v=ZidiIdg3U4M','2020-09-10','testable_prediction'," +
    "'There will be an oil boom in Southeast Asia in 2021.'," +
    "'Measurable significant increase in oil activity during 2021.'," +
    "'2021-12-31',600,'2026-07-24','deadline_passed_awaiting_review','undetermined','draft'," +
    "'2026-07-24T00:00:00.000Z')"
  ).run();
  db.prepare("INSERT INTO claims (claim_id,person_id,cluster_id,title,exact_quote,source_url,source_date,statement_type,atomic_proposition,criteria,as_of_date,lifecycle_status,outcome_status,visibility,created_at) VALUES ('claim_51cbcb17013caa85fd2f059e','person_troy_black','cluster_charles_test','Succession of Prince Charles','he is next','https://www.youtube.com/watch?v=Lu3sWY0SsxU','2022-08-29','testable_prediction','Charles will take over.','Charles accedes.','2026-07-24','resolved','true','published','2026-07-24T00:00:00.000Z')").run();
  db.prepare(
    "INSERT OR IGNORE INTO review_work_items (work_item_id,claim_id,origin_kind,work_type,status," +
    "required_matching_reviews,max_reviews,created_at) VALUES " +
    "('work_russia-spring-2022','russia-spring-2022','existing_ledger_claim'," +
    "'claim_adjudication','ready',2,4,'2026-07-19T00:00:00.000Z')," +
    "('work_claim_743b73bfe201575d3e1119ae','claim_743b73bfe201575d3e1119ae'," +
    "'existing_ledger_claim','claim_adjudication','ready',2,4,'2026-07-24T00:00:00.000Z')," +
    "('work_claim_e339f8e0e654570867b45d50','claim_e339f8e0e654570867b45d50'," +
    "'existing_ledger_claim','claim_adjudication','ready',2,4,'2026-07-24T00:00:00.000Z')"
  ).run();
  db.prepare(
    "INSERT INTO evidence (evidence_id,claim_id,evidence_role,url,title,accessed_at," +
    "source_role,verification_method,note,created_at) VALUES " +
    "('evidence_743b73bfe201575d3e1119ae_original','claim_743b73bfe201575d3e1119ae'," +
    "'original_statement','https://www.youtube.com/watch?v=QtPaJ0MlFng','Ecuador word'," +
    "'2026-07-24T00:00:00.000Z','platform','timestamp','','2026-07-24T00:00:00.000Z')," +
    "('ev_rw_5fd3c865f151f198_1','claim_743b73bfe201575d3e1119ae','independent_outcome'," +
    "'https://example.test/ecuador-1','Assembly dissolved 1','2026-07-24T00:00:00.000Z'," +
    "'independent','unverified','','2026-07-24T00:00:00.000Z')," +
    "('ev_rw_5fd3c865f151f198_2','claim_743b73bfe201575d3e1119ae','independent_outcome'," +
    "'https://example.test/ecuador-2','Assembly dissolved 2','2026-07-24T00:00:00.000Z'," +
    "'independent','unverified','','2026-07-24T00:00:00.000Z')," +
    "('ev_rw_5fd3c865f151f198_3','claim_743b73bfe201575d3e1119ae','independent_outcome'," +
    "'https://example.test/ecuador-3','Assembly dissolved 3','2026-07-24T00:00:00.000Z'," +
    "'independent','unverified','','2026-07-24T00:00:00.000Z')"
  ).run();
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0064_joshua_doc_adjudications.sql"), "utf8"));
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0067_automated_pass_backlog.sql"), "utf8"));
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0068_automated_pass_briefs.sql"), "utf8"));
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0069_charles_brief.sql"), "utf8"));
}

test("automated-pass migration is a no-op without the production marker", () => {
  const env = makeEnv();
  const db = env.DB.db;
  assert.equal(db.prepare(
    "SELECT count(*) count FROM reviewer_public_attributions WHERE display_name='Site review'"
  ).get().count, 0);
  assert.equal(db.prepare(
    "SELECT visibility FROM claims WHERE claim_id='russia-spring-2022'"
  ).get().visibility, "draft");
  assert.equal(db.prepare(
    "SELECT count(*) count FROM claims WHERE claim_id='moth-prophecy-president-2024'"
  ).get().count, 0);
  assert.equal(db.prepare(
    "SELECT count(*) count FROM moderator_reviews WHERE reviewer_id='reviewer_site_automated_pass_v1'"
  ).get().count, 0);
  assert.equal(db.prepare(
    "SELECT count(*) count FROM claim_decision_amendments WHERE amendment_id='amendment_tb_2026_16_spain'"
  ).get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM public_research_briefs WHERE brief_id IN ('brief_russia_r3','brief_ecuador_2023_r1','brief_moth_2024_r1')").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) count FROM public_research_briefs WHERE brief_id='brief_charles_2022_r1'").get().count, 0);
});

test("automated pass clears the backlog: dup withdrawn, three published, Spain amended", async () => {
  const env = makeEnv();
  seedBacklog(env);
  const db = env.DB.db;

  const dup = db.prepare(
    "SELECT claim.visibility, item.status FROM claims claim " +
    "JOIN review_work_items item ON item.claim_id=claim.claim_id WHERE claim.claim_id=?"
  ).get(OIL_DUP);
  assert.equal(dup.visibility, "draft");
  assert.equal(dup.status, "withdrawn");

  const russia = db.prepare("SELECT * FROM claims WHERE claim_id=?").get(RUSSIA);
  assert.equal(russia.outcome_status, "false");
  assert.equal(russia.visibility, "published");
  assert.equal(russia.score_eligible, 1);
  assert.equal(russia.source_timestamp_seconds, 151);
  assert.equal(russia.transcript_warning, null);
  assert.match(russia.atomic_proposition, /formally declared war/);
  assert.match(russia.criteria, /not a special military operation announcement/);

  const ecuador = db.prepare("SELECT * FROM claims WHERE claim_id=?").get(ECUADOR);
  assert.equal(ecuador.outcome_status, "partial");
  assert.equal(ecuador.visibility, "published");
  assert.equal(ecuador.deadline, "2023-12-31");

  const moth = db.prepare("SELECT * FROM claims WHERE claim_id=?").get(MOTH);
  assert.equal(moth.outcome_status, "not_falsifiable");
  assert.equal(moth.statement_type, "symbolic_statement");
  assert.equal(moth.visibility, "published");
  assert.equal(moth.score_eligible, 0);
  assert.equal(db.prepare(
    "SELECT status FROM review_work_items WHERE claim_id=?"
  ).get(MOTH).status, "complete");

  assert.equal(db.prepare(
    "SELECT status FROM review_work_items WHERE claim_id=?"
  ).get(RUSSIA).status, "complete");
  assert.equal(db.prepare(
    "SELECT status FROM review_work_items WHERE claim_id=?"
  ).get(ECUADOR).status, "complete");
  assert.equal(db.prepare(
    "SELECT count(*) count FROM moderator_reviews WHERE reviewer_id='reviewer_site_automated_pass_v1'"
  ).get().count, 3);

  for (const stored of db.prepare(
    "SELECT * FROM moderator_reviews WHERE reviewer_id='reviewer_site_automated_pass_v1'"
  ).all()) {
    const recomputed = reviewDecisionFingerprint({
      claimType: stored.claim_type, outcomeStatus: stored.outcome_status,
      noveltyStatus: stored.novelty_status,
      baselineProbability: stored.baseline_probability == null ? null : Number(stored.baseline_probability),
      evidenceIds: JSON.parse(stored.evidence_ids_json), priorReceiptId: stored.prior_receipt_id || null,
    });
    assert.equal(stored.decision_fingerprint, recomputed);
  }

  for (const id of [RUSSIA, ECUADOR, MOTH]) {
    const claimRow = db.prepare("SELECT * FROM claims WHERE claim_id=?").get(id);
    const evidence = db.prepare("SELECT * FROM evidence WHERE claim_id=?").all(id);
    const reviewRow = db.prepare(
      "SELECT review.*, attribution.display_name public_reviewer_name, " +
      "NULL doc_attestation_id, NULL doc_ref, NULL doc_title, NULL doc_verbatim_verdict, NULL doc_rubric_version " +
      "FROM moderator_reviews review " +
      "LEFT JOIN reviewer_public_attributions attribution ON attribution.reviewer_id=review.reviewer_id " +
      "WHERE review.claim_id=?"
    ).get(id);
    const result = evaluatePublication(claimRow, evidence, [], [reviewRow]);
    assert.equal(result.state, "published");
    assert.equal(result.lane, "interactive");
    assert.equal(result.outcomeStatus, claimRow.outcome_status);
    assert.deepEqual(result.reviewerNames, ["Site review"]);
  }

  const profile = await getPersonProfile(env.DB, "troy-black");
  assert.equal(profile.claims.length, 154);
  assert.equal(db.prepare("SELECT count(*) count FROM public_research_briefs WHERE brief_id='brief_charles_2022_r1'").get().count, 1);
  for (const [id, outcome] of [[RUSSIA, "false"], [ECUADOR, "partial"], [MOTH, "not_falsifiable"]]) {
    const claim = profile.claims.find((item) => item.claim_id === id);
    assert.equal(claim.outcome_status, outcome);
    assert.equal(claim.humanDecision.reviewerName, "Site review");
    assert.equal(claim.humanDecision.outcomeStatus, outcome);
    assert.match(claim.humanDecision.rationale, /automated verification pass/);
  }
  const spain = profile.claims.find((item) => item.claim_id === SPAIN);
  assert.equal(spain.outcome_status, "true");
  assert.equal(spain.humanDecision.outcomeStatus, "true");
  assert.equal(spain.humanDecision.correction.previousOutcomeStatus, "undetermined");
  assert.equal(spain.humanDecision.correction.reviewerName, "Site review");
  assert.match(spain.humanDecision.correction.rationale, /Spain beat Argentina/);
  assert.equal(db.prepare("SELECT outcome_status FROM claims WHERE claim_id=?").get(SPAIN).outcome_status,
    "undetermined");
  assert.equal(db.prepare("SELECT outcome_status FROM moderator_reviews WHERE claim_id=?").get(SPAIN).outcome_status,
    "undetermined");

  assert.equal(db.prepare("SELECT count(*) count FROM public_research_briefs WHERE brief_id IN ('brief_russia_r3','brief_ecuador_2023_r1','brief_moth_2024_r1')").get().count, 3);
  assert.equal(db.prepare("SELECT count(*) count FROM public_research_references WHERE brief_id IN ('brief_russia_r3','brief_ecuador_2023_r1','brief_moth_2024_r1')").get().count, 9);
  for (const id of [RUSSIA, ECUADOR, MOTH]) {
    const brief = profile.researchRecords.find((item) => item.id === id);
    assert.ok(brief);
    assert.equal(brief.humanDecision.reviewerName, "Site review");
    assert.deepEqual(brief.missingGates, []);
  }
  env.DB.exec(readFileSync(join(ROOT, "migrations", "0067_automated_pass_backlog.sql"), "utf8"));
  assert.equal(db.prepare(
    "SELECT count(*) count FROM moderator_reviews WHERE reviewer_id='reviewer_site_automated_pass_v1'"
  ).get().count, 3);
  assert.equal(db.prepare("SELECT count(*) count FROM claim_revisions").get().count, 153);
});
