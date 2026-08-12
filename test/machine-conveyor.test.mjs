import test from "node:test";
import assert from "node:assert/strict";
import {
  machineConveyorDiscoverySql, parseMachineConveyorArgs, runMachineConveyor,
} from "../scripts/machine-conveyor.mjs";

function conveyorHarness(candidate = null, { initialWork = false, concurrentLose = false,
  insertMismatch = false, persistError = null } = {}) {
  const state = { work: initialWork, writes: [], persisted: [], concurrentLose, insertMismatch };
  return { state, operationClient: {
    async persistOperationReceipt(kind, terminal) {
      if (persistError) throw Object.assign(new Error(persistError), { code: persistError });
      state.persisted.push({ kind, terminal: structuredClone(terminal) });
      return { persisted: true };
    },
  }, d1: { state,
    read(sql) {
      if (sql.includes("ORDER BY ready.readiness_created_at")) return candidate ? [candidate] : [];
      if (sql.includes("JOIN transcript_artifacts artifact")) return candidate ? [{ ...candidate,
        artifact_sha256: candidate.transcript_sha256,
        section_input_sha256: candidate.section_sha256, section_status: "completed",
        analysis_sha256: candidate.transcript_sha256, extraction_sha256: candidate.section_sha256,
        extraction_prompt: candidate.gate_version, platform: "youtube",
        platform_item_id: "Video001", canonical_url: "https://youtube.example/Video001" }] : [];
      if (sql.includes("ready_work_count")) return [{ ready_count: candidate ? 1 : 0,
        work_count: state.work ? 1 : 0, ready_work_count: state.work ? 1 : 0,
        work_item_id: state.work ? `work_candidate_${candidate.candidate_id}` : null,
        promotion_count: 0 }];
      if (sql.includes("(SELECT COUNT(*) FROM claims) claims")) return [{ claims: 2,
        candidate_promotions: 0, candidate_decisions: 0, moderator_reviews: 0,
        review_assignments: 0, claim_revisions: 0, publication_evaluations: 0 }];
      if (/INSERT INTO review_work_items/.test(sql)) {
        state.writes.push(sql); state.work = true;
        return concurrentLose ? [] : [{ work_item_id: insertMismatch ? "work_wrong"
          : `work_candidate_${candidate.candidate_id}` }];
      }
      return [];
    },
  } };
}

const CANDIDATE = { candidate_id: "cand_safe", readiness_id: "ready_safe",
  analysis_section_id: "sec_safe", transcript_id: "tx_safe", source_item_id: "src_safe",
  extraction_run_id: "ext_safe", gate_version: "gate-v1",
  transcript_sha256: "a".repeat(64), section_sha256: "b".repeat(64),
  readiness_created_at: "2026-08-03T10:00:00Z" };
const NOW = "2026-08-03T10:00:00Z";

test("machine conveyor enforces limit 25", () => {
  assert.deepEqual(parseMachineConveyorArgs(["--limit", "25", "--local"]),
    { limit: 25, local: true, dryRun: false });
  assert.throws(() => parseMachineConveyorArgs(["--limit", "0"]), /invalid_limit/);
  assert.throws(() => parseMachineConveyorArgs(["--limit", "26"]), /invalid_limit/);
});

test("discovery recovers existing work lacking a successful item receipt", () => {
  const sql = machineConveyorDiscoverySql(25);
  assert.match(sql, /machine_conveyor_item_receipts/);
  assert.match(sql, /receipt\.outcome IN \('promoted','reused'\)/);
  assert.match(sql, /receipt_run\.status='completed'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM candidate_review_decisions decision/);
  assert.match(sql, /decision\.candidate_id=ready\.candidate_id/);
  assert.doesNotMatch(sql, /NOT EXISTS \(SELECT 1 FROM review_work_items/);
});

test("machine conveyor creates only candidate-verification work and persists via admin", async () => {
  const h = conveyorHarness(CANDIDATE);
  const terminal = await runMachineConveyor({ limit: 25, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW,
  });
  assert.equal(terminal.itemFinals.length, 1);
  assert.deepEqual({ considered: terminal.summary.considered, verified: terminal.summary.verified,
    classified: terminal.summary.classified, promoted: terminal.summary.promoted,
    reused: terminal.summary.reused, failed: terminal.summary.failed,
    pendingPromotions: terminal.summary.pendingPromotions },
  { considered: 1, verified: 1, classified: 1, promoted: 1, reused: 0,
    failed: 0, pendingPromotions: 0 });
  assert.equal(terminal.exit.exitCode, 0);
  const workWrites = h.state.writes.filter((sql) => /INSERT INTO review_work_items/.test(sql));
  assert.equal(workWrites.length, 1);
  assert.match(workWrites[0], /ON CONFLICT\(candidate_id\) DO NOTHING RETURNING work_item_id/);
  assert.match(workWrites[0], /'candidate_verification'/);
  assert.doesNotMatch(workWrites[0], /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(?:claims|moderator_reviews|candidate_review_decisions|publication_evaluations)/i);
  assert.equal(h.state.persisted.length, 1);
  assert.equal(h.state.persisted[0].kind, "machine_conveyor");
});

test("an existing ready work item is rediscovered and receipted as reused", async () => {
  const h = conveyorHarness(CANDIDATE, { initialWork: true });
  const terminal = await runMachineConveyor({ limit: 25, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW,
  });
  assert.equal(terminal.itemFinals[0].status, "reused");
  assert.equal(terminal.itemFinals[0].classification, "review_ready_reused");
  assert.equal(terminal.summary.promoted, 0);
  assert.equal(terminal.summary.reused, 1);
  assert.equal(terminal.summary.pendingPromotions, 0);
  assert.equal(terminal.summary.status, "completed");
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.state.persisted.length, 1);
});

test("a concurrent conveyor loser reuses the winner", async () => {
  const h = conveyorHarness(CANDIDATE, { concurrentLose: true });
  const terminal = await runMachineConveyor({ limit: 25, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW,
  });
  assert.equal(terminal.itemFinals[0].status, "reused");
  assert.equal(terminal.summary.reused, 1);
  assert.equal(terminal.summary.pendingPromotions, 0);
});

test("an anomalous insert identity is a persistable failed terminal", async () => {
  const h = conveyorHarness(CANDIDATE, { insertMismatch: true });
  const terminal = await runMachineConveyor({ limit: 25, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW,
  });
  assert.equal(terminal.itemFinals[0].classification, "insert_receipt_mismatch");
  assert.equal(terminal.itemFinals[0].status, "failed");
  assert.deepEqual({ classified: terminal.summary.classified, promoted: terminal.summary.promoted,
    reused: terminal.summary.reused, failed: terminal.summary.failed,
    pending: terminal.summary.pendingPromotions },
  { classified: 0, promoted: 0, reused: 0, failed: 1, pending: 1 });
  assert.equal(terminal.summary.fatalCode, null);
  assert.equal(h.state.persisted.length, 1);
  assert.equal(terminal.exit.exitCode, 1);
});

test("operation receipt mismatch is a typed conveyor fatal", async () => {
  const h = conveyorHarness(CANDIDATE, { initialWork: true,
    persistError: "operation_receipt_readback_mismatch" });
  const terminal = await runMachineConveyor({ limit: 25, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW,
  });
  assert.equal(terminal.summary.status, "failed");
  assert.equal(terminal.summary.fatalCode, "operation_receipt_readback_mismatch");
  assert.equal(terminal.exit.exitCode, 1);
});

test("zero eligible candidates emits and persists explicit final counts", async () => {
  const h = conveyorHarness();
  const terminal = await runMachineConveyor({ limit: 25, local: true, dryRun: false }, {
    d1: h.d1, operationClient: h.operationClient, nowIso: () => NOW,
  });
  assert.equal(terminal.summary.status, "zero_work");
  assert.deepEqual({ considered: terminal.summary.considered, verified: terminal.summary.verified,
    classified: terminal.summary.classified, promoted: terminal.summary.promoted,
    reused: terminal.summary.reused, failed: terminal.summary.failed,
    pendingPromotions: terminal.summary.pendingPromotions },
  { considered: 0, verified: 0, classified: 0, promoted: 0, reused: 0, failed: 0,
    pendingPromotions: 0 });
  assert.equal(h.state.persisted.length, 1);
  assert.equal(terminal.exit.exitCode, 0);
});
