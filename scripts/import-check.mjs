#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const roots = ["public", "functions", "scanner/src", "scripts"];

function filesUnder(directory, files = []) {
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name); const stat = statSync(absolute);
    if (stat.isDirectory()) filesUnder(absolute, files);
    else if (/\.(?:js|mjs)$/.test(name)) files.push(absolute);
  }
  return files;
}

let considered = 0; let passed = 0; let failed = 0; let fatalCode = null;
try {
  const files = roots.flatMap((directory) => filesUnder(join(ROOT, directory)));
  considered = files.length;
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { cwd: ROOT, encoding: "utf8" });
    if (result.status === 0) passed += 1;
    else {
      failed += 1;
      process.stderr.write(result.stderr || `syntax_check_failed:${file}\n`);
    }
  }
  if (!considered) fatalCode = "import_check_empty";
} catch (error) {
  fatalCode = String(error?.code || "import_check_failed").slice(0, 80);
}
const success = !fatalCode && failed === 0 && passed === considered;
const receipt = { schemaVersion: 1, contract: "import-check-v1",
  status: success ? "success" : "failure", considered, passed, failed,
  fatalCode, exitCode: success ? 0 : 1 };
console.log(`IMPORT_CHECK_EXIT ${JSON.stringify(receipt)}`);
process.exitCode = receipt.exitCode;
