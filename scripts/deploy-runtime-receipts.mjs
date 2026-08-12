import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function redact(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:api[_ -]?key|token|secret|password)\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]")
    .replace(/([?&](?:key|token|secret|signature|auth)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim().slice(0, 1_500);
}

export function sanitizedCommandFailure(result, machineOutput = "") {
  const entries = String(machineOutput || "").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const failures = entries.filter((entry) => entry?.type === "command-failed"
    && entry.version === 1 && typeof entry.message === "string");
  if (failures.length) {
    const failure = failures.at(-1);
    return { source: "wrangler_machine_jsonl", type: "command-failed", version: 1,
      code: ["string", "number"].includes(typeof failure.code) ? failure.code : null,
      message: redact(failure.message), eventCount: failures.length };
  }
  const bounded = redact(result?.stderr || result?.stdout || "command failed without output");
  return { source: "bounded_command_output", exitCode: Number.isInteger(result?.exitCode)
    ? result.exitCode : null, message: bounded || "command failed without output" };
}

export function commandFailureError(code, result, machineOutput = "", partialReceipts = null) {
  const error = new Error(code);
  error.safeDetail = sanitizedCommandFailure(result, machineOutput);
  if (partialReceipts) error.partialReceipts = partialReceipts;
  return error;
}

function lastNumber(transcript, label) {
  const matches = [...transcript.matchAll(new RegExp(`^(?:ℹ|#) ${label} ([0-9.]+)$`, "gm"))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

export function parseNpmCheckReceipt(result) {
  if (result?.exitCode !== 0) throw new Error("npm_check_failed");
  const stdout = String(result?.stdout || ""); const stderr = String(result?.stderr || "");
  const transcript = `${stdout}\n${stderr}`;
  const tests = lastNumber(transcript, "tests");
  const passed = lastNumber(transcript, "pass");
  const failed = lastNumber(transcript, "fail");
  const durationMs = lastNumber(transcript, "duration_ms");
  if (!Number.isInteger(tests) || tests < 1 || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("npm_check_test_summary_missing");
  }
  if (passed !== tests || failed !== 0) throw new Error("npm_check_tests_not_green");
  const markers = transcript.split(/\r?\n/).filter((line) => line.startsWith("IMPORT_CHECK_EXIT "));
  if (markers.length !== 1) throw new Error("npm_check_import_receipt_missing");
  let imports;
  try { imports = JSON.parse(markers[0].slice("IMPORT_CHECK_EXIT ".length)); }
  catch { throw new Error("npm_check_import_receipt_invalid"); }
  if (imports?.contract !== "import-check-v1" || imports?.status !== "success"
      || imports.exitCode !== 0 || !Number.isInteger(imports.considered) || imports.considered < 1
      || imports.passed !== imports.considered || imports.failed !== 0) {
    throw new Error("npm_check_import_receipt_invalid");
  }
  return { tests, passed, failed, durationMs, importCheck: true,
    importCount: imports.considered,
    outputSha256: sha256(Buffer.from(`stdout\0${stdout}\0stderr\0${stderr}`)) };
}

export function workerArtifactReceipt(directory) {
  const root = realpathSync(directory);
  const names = readdirSync(root).filter((name) => /^index\.js(?:\.map)?$/.test(name)).sort();
  if (!names.includes("index.js")) throw new Error("scanner_dry_bundle_missing");
  const files = names.map((name) => {
    const path = join(root, name);
    if (lstatSync(path).isSymbolicLink() || relative(root, realpathSync(path)).startsWith("..")) {
      throw new Error("scanner_bundle_path_invalid");
    }
    const bytes = readFileSync(path);
    return { name, bytes: statSync(path).size, sha256: sha256(bytes) };
  });
  const bundleSha256 = sha256(Buffer.from(files.map((file) =>
    `${file.name}\0${file.bytes}\0${file.sha256}\n`).join("")));
  return { directory: root, entrypoint: join(root, "index.js"), bundleSha256, files };
}

export function validateWorkerArtifact(artifact, expectedSha256) {
  if (!artifact?.directory || basename(artifact?.entrypoint || "") !== "index.js") {
    throw new Error("scanner_deploy_artifact_missing");
  }
  const fresh = workerArtifactReceipt(artifact.directory);
  if (fresh.entrypoint !== artifact.entrypoint || fresh.bundleSha256 !== expectedSha256) {
    throw new Error("scanner_deploy_artifact_changed");
  }
  return fresh;
}

export function workerDeployArgs(artifact, expectedSha256) {
  const exact = validateWorkerArtifact(artifact, expectedSha256);
  return ["wrangler", "deploy", exact.entrypoint, "--no-bundle",
    "--config", "scanner/wrangler.toml", "--strict"];
}
