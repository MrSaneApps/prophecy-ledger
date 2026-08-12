import { createHash } from "node:crypto";

export const PROVISIONED_QUEUES = [
  "prophecy-ledger-analysis",
  "prophecy-ledger-analysis-dlq",
];
const KNOWN_QUEUES = new Set([
  "prophecy-ledger-ingestion",
  ...PROVISIONED_QUEUES,
  "prophecy-ledger-ingestion-dlq",
]);
const HEAD = ["id", "name", "created_on", "modified_on", "producers", "consumers"];
const QUEUE_ID = /^[a-f0-9]{32}$/;
const CONFIG = "scanner/wrangler.toml";
const WRANGLER_BANNER = /^ ⛅️ wrangler (\d+\.\d+\.\d+)(?: \(update available (\d+\.\d+\.\d+)\))?$/;
const WRANGLER_SEPARATOR = /^─{16,80}$/;
const MAX_PREAMBLE_BYTES = 512;
const SAFE_PARSE_CODES = new Set(["queue_list_receipt_invalid", "queue_list_separator_invalid",
  "queue_list_preamble_invalid", "queue_list_multiple_tables", "queue_list_trailing_text",
  "queue_list_banner_inside_table", "queue_list_ambiguous",
  "queue_list_unexpected_prophecy_queue"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeCommandField(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(value) ? value : null;
}

function queueCommandFailureError(code, result, partialReceipts) {
  const stdout = Buffer.from(String(result?.stdout || ""));
  const stderr = Buffer.from(String(result?.stderr || ""));
  const error = new Error(code);
  error.safeDetail = { source: "queue_command_failure",
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    signal: safeCommandField(result?.signal),
    errorCode: safeCommandField(result?.error?.code || result?.code),
    errorName: safeCommandField(result?.error?.name),
    stdoutBytes: stdout.length, stdoutSha256: sha256(stdout),
    stderrBytes: stderr.length, stderrSha256: sha256(stderr) };
  error.partialReceipts = partialReceipts;
  return error;
}

function row(line, widths) {
  if (!line.startsWith("│") || !line.endsWith("│")) {
    throw new Error("queue_list_receipt_invalid");
  }
  const segments = line.slice(1, -1).split("│");
  if (segments.length !== HEAD.length || segments.some((segment, index) =>
    segment.length !== widths[index] || !segment.startsWith(" ") || !segment.endsWith(" "))) {
    throw new Error("queue_list_receipt_invalid");
  }
  return segments.map((segment, index) => {
    const match = segment.slice(1, -1).match(/^(\S+)( *)$/);
    if (!match || ` ${match[1].padEnd(widths[index] - 2)} ` !== segment) {
      throw new Error("queue_list_receipt_invalid");
    }
    return match[1];
  });
}

function border(line, left, joint, right, widths) {
  if (!line.startsWith(left) || !line.endsWith(right)) {
    throw new Error("queue_list_receipt_invalid");
  }
  const segments = line.slice(1, -1).split(joint);
  if (segments.length !== HEAD.length || segments.some((segment, index) =>
    !/^─+$/.test(segment) || (widths && segment.length !== widths[index]))) {
    throw new Error("queue_list_receipt_invalid");
  }
  return segments.map((segment) => segment.length);
}

function validUtcTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || hour > 23 || minute > 59 || second > 59) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const date = new Date(parsed); const milliseconds = Number(`${match[7] || ""}000`.slice(0, 3));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    && date.getUTCMilliseconds() === milliseconds;
}

function queueTablePayload(text) {
  const clean = String(text || "").replace(/\x1b\[[0-9;]*m/g, "");
  if (clean.includes("\r") || !clean.endsWith("\n")) {
    throw new Error("queue_list_preamble_invalid");
  }
  const lines = clean.split(/\r?\n/);
  const tableIndex = clean.indexOf("┌");
  const prefix = tableIndex < 0 ? clean : clean.slice(0, tableIndex);
  if (Buffer.byteLength(prefix) > MAX_PREAMBLE_BYTES || lines[0] !== ""
      || !WRANGLER_BANNER.test(lines[1] || "") || !WRANGLER_SEPARATOR.test(lines[2] || "")) {
    throw new Error("queue_list_preamble_invalid");
  }
  const payload = lines.slice(3);
  const tableStarts = payload.filter((line) => line.startsWith("┌")).length;
  if (tableStarts === 0) {
    if (payload.length === 2 && payload.every((line) => line === "")) return null;
    throw new Error("queue_list_preamble_invalid");
  }
  if (tableStarts !== 1) throw new Error("queue_list_multiple_tables");
  if (!payload[0].startsWith("┌")) throw new Error("queue_list_preamble_invalid");
  if (payload.some((line) => /(?:⛅️|\bwrangler\b)/i.test(line))) {
    throw new Error("queue_list_banner_inside_table");
  }
  const tableEnds = payload.flatMap((line, index) => line.startsWith("└") ? [index] : []);
  if (tableEnds.length !== 1) throw new Error("queue_list_receipt_invalid");
  if (tableEnds[0] !== payload.length - 2 || payload.at(-1) !== "") {
    throw new Error("queue_list_trailing_text");
  }
  return payload.slice(0, -1).join("\n");
}

export function parseWranglerQueueTable(text) {
  const table = queueTablePayload(text);
  if (table === null) return [];
  const lines = table.split("\n");
  if (lines.length < 4) throw new Error("queue_list_receipt_invalid");
  const widths = border(lines[0], "┌", "┬", "┐");
  const header = row(lines[1], widths);
  if (header.some((cell, index) => cell !== HEAD[index])) {
    throw new Error("queue_list_receipt_invalid");
  }
  border(lines[2], "├", "┼", "┤", widths);
  border(lines.at(-1), "└", "┴", "┘", widths);
  const body = lines.slice(3, -1);
  if (!body.length || body.length % 2 === 0) throw new Error("queue_list_separator_invalid");
  return body.filter((line, index) => {
    if (index % 2 === 1) {
      border(line, "├", "┼", "┤", widths);
      return false;
    }
    return true;
  }).map((line) => {
    const cells = row(line, widths);
    const [id, name, createdOn, modifiedOn, producers, consumers] = cells;
    if (!QUEUE_ID.test(id) || !/^[A-Za-z0-9_-]{1,63}$/.test(name)
        || !validUtcTimestamp(createdOn) || !validUtcTimestamp(modifiedOn)
        || !/^\d+$/.test(producers) || !/^\d+$/.test(consumers)) {
      throw new Error("queue_list_receipt_invalid");
    }
    return { id, name, createdOn, modifiedOn, producers: Number(producers),
      consumers: Number(consumers) };
  });
}

function rawPageEvidence(page, stdout) {
  const raw = Buffer.from(String(stdout || ""));
  return { page, rawStdoutBytes: raw.length, rawStdoutSha256: sha256(raw) };
}

function rawEvidence(phase, pages) {
  return { [phase === "prelist" ? "preListRawPages" : "postListRawPages"]: pages };
}

function failedReceipt(phase, items = [], evidence = {}) {
  return { contract: "deploy-queue-provision-v1", status: "failed", phase,
    targetCount: PROVISIONED_QUEUES.length, items, ...evidence };
}

function validateList(rows) {
  const ids = new Set(); const names = new Set();
  for (const queue of rows) {
    if (ids.has(queue.id) || names.has(queue.name)) throw new Error("queue_list_ambiguous");
    ids.add(queue.id); names.add(queue.name);
    if (queue.name.startsWith("prophecy-ledger-") && !KNOWN_QUEUES.has(queue.name)) {
      throw new Error("queue_list_unexpected_prophecy_queue");
    }
  }
  return rows;
}

function listAll(execute, phase, baseEvidence = {}) {
  const rows = []; const pages = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = execute(["wrangler", "queues", "list", "--config", CONFIG,
      "--page", String(page)]);
    pages.push(rawPageEvidence(page, result?.stdout));
    const evidence = { ...baseEvidence, ...rawEvidence(phase, pages) };
    if (result?.exitCode !== 0) {
      throw queueCommandFailureError(`queue_${phase}_failed`, result,
        { queueProvisioning: failedReceipt(phase, [], evidence) });
    }
    let pageRows;
    try { pageRows = parseWranglerQueueTable(result.stdout); }
    catch (error) {
      const causeCode = SAFE_PARSE_CODES.has(error?.message)
        ? error.message : "queue_list_receipt_invalid";
      error.safeDetail = { source: "queue_table_parser", phase, causeCode };
      error.partialReceipts = { queueProvisioning: failedReceipt(phase, [], evidence) };
      throw error;
    }
    rows.push(...pageRows);
    if (pageRows.length === 0) {
      try { return { rows: validateList(rows), pages }; }
      catch (error) {
        error.safeDetail = { source: "queue_table_parser", phase,
          causeCode: SAFE_PARSE_CODES.has(error?.message)
            ? error.message : "queue_list_receipt_invalid" };
        error.partialReceipts = { queueProvisioning: failedReceipt(phase, [], evidence) };
        throw error;
      }
    }
  }
  const error = new Error("queue_list_pagination_incomplete");
  error.partialReceipts = { queueProvisioning: failedReceipt(phase, [],
    { ...baseEvidence, ...rawEvidence(phase, pages) }) };
  throw error;
}

function listHash(rows) {
  return sha256(rows.map((queue) => `${queue.id}\0${queue.name}\0${queue.createdOn}\0${queue.modifiedOn}\0${queue.producers}\0${queue.consumers}\n`).join(""));
}

export function provisionDeploymentQueues({ execute }) {
  if (typeof execute !== "function") throw new Error("queue_executor_missing");
  const pre = listAll(execute, "prelist");
  const preNames = new Set(pre.rows.map((queue) => queue.name));
  const attempted = [];
  for (const queueName of PROVISIONED_QUEUES) {
    if (preNames.has(queueName)) continue;
    const result = execute(["wrangler", "queues", "create", queueName, "--config", CONFIG]);
    if (result?.exitCode !== 0) {
      throw queueCommandFailureError("queue_create_failed", result,
        { queueProvisioning: failedReceipt("create", attempted,
          { preListRawPages: pre.pages }) });
    }
    attempted.push({ queueName, createCommandCompleted: true, readBack: false });
  }
  const post = listAll(execute, "postlist", { preListRawPages: pre.pages });
  const items = PROVISIONED_QUEUES.map((queueName) => {
    const matches = post.rows.filter((queue) => queue.name === queueName);
    if (matches.length !== 1) {
      const error = new Error("queue_postlist_incomplete");
      error.partialReceipts = { queueProvisioning: failedReceipt("post_list", attempted,
        { preListRawPages: pre.pages, postListRawPages: post.pages }) };
      throw error;
    }
    return { queueName, outcome: preNames.has(queueName) ? "reused" : "created",
      readBack: true };
  });
  const createdCount = items.filter((item) => item.outcome === "created").length;
  const receipt = { schemaVersion: 1, contract: "deploy-queue-provision-v1",
    status: "completed", targetCount: PROVISIONED_QUEUES.length,
    createdCount, reusedCount: items.length - createdCount, readBackCount: items.length,
    preListCount: pre.rows.length, postListCount: post.rows.length,
    preListSha256: listHash(pre.rows), postListSha256: listHash(post.rows),
    preListRawPages: pre.pages, postListRawPages: post.pages, items };
  validateQueueProvisioningReceipt(receipt);
  return receipt;
}

export function validateQueueProvisioningReceipt(receipt) {
  const validPages = (pages) => Array.isArray(pages) && pages.length >= 1
    && pages.every((page, index) => page.page === index + 1
      && Number.isInteger(page.rawStdoutBytes) && page.rawStdoutBytes >= 0
      && /^[a-f0-9]{64}$/.test(page.rawStdoutSha256 || "")
      && Object.keys(page).sort().join(",") === "page,rawStdoutBytes,rawStdoutSha256");
  if (receipt?.contract !== "deploy-queue-provision-v1" || receipt.status !== "completed"
      || receipt.targetCount !== PROVISIONED_QUEUES.length
      || receipt.readBackCount !== PROVISIONED_QUEUES.length
      || receipt.createdCount + receipt.reusedCount !== PROVISIONED_QUEUES.length
      || !Number.isInteger(receipt.preListCount) || receipt.preListCount < 0
      || !Number.isInteger(receipt.postListCount) || receipt.postListCount < PROVISIONED_QUEUES.length
      || !/^[a-f0-9]{64}$/.test(receipt.preListSha256 || "")
      || !/^[a-f0-9]{64}$/.test(receipt.postListSha256 || "")
      || !validPages(receipt.preListRawPages) || !validPages(receipt.postListRawPages)
      || !Array.isArray(receipt.items) || receipt.items.length !== PROVISIONED_QUEUES.length) {
    throw new Error("queue_provision_receipt_incomplete");
  }
  for (const queueName of PROVISIONED_QUEUES) {
    const matches = receipt.items.filter((item) => item.queueName === queueName);
    if (matches.length !== 1
        || Object.keys(matches[0]).sort().join(",") !== "outcome,queueName,readBack"
        || !["created", "reused"].includes(matches[0].outcome)
        || matches[0].readBack !== true) throw new Error("queue_provision_receipt_incomplete");
  }
  if (receipt.items.filter((item) => item.outcome === "created").length !== receipt.createdCount
      || receipt.items.filter((item) => item.outcome === "reused").length !== receipt.reusedCount) {
    throw new Error("queue_provision_receipt_incomplete");
  }
  return receipt;
}
