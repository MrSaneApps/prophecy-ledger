#!/bin/zsh
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:/usr/bin:/bin:/usr/sbin:/sbin
source "$HOME/.config/nv/env"
cd /Users/stephansmac/SaneApps/websites/prophecy-ledger || exit 1
mkdir -p outputs/batch-watchdog
output=$(/opt/homebrew/opt/node@24/bin/node scripts/batch-watchdog.mjs 2>&1)
watchdog_exit_code=$?
print -r -- "$output" >> outputs/batch-watchdog/launchd.log
print -r -- "$output"
if (( watchdog_exit_code != 0 )); then
  exit "$watchdog_exit_code"
fi
print -rn -- "$output" | /opt/homebrew/opt/node@24/bin/node -e '
  const fs = require("node:fs");
  const prefix = "BATCH_WATCHDOG_RECEIPT ";
  const lines = fs.readFileSync(0, "utf8").split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) process.exit(2);
  const receipt = JSON.parse(lines[0].slice(prefix.length));
  if (receipt.contract !== "batch-watchdog-v2" || typeof receipt.healthy !== "boolean" ||
      !receipt.preActionSnapshotSha256 || !receipt.postActionSnapshotSha256 ||
      typeof receipt.incidents?.deliveryComplete !== "boolean" ||
      receipt.queueMetrics?.contract !== "queue-operations-status-v1" ||
      !Array.isArray(receipt.queueMetrics?.queues) ||
      !receipt.analysisDebt || !Number.isInteger(Number(receipt.analysisDebt.failedSections)) ||
      !Number.isInteger(Number(receipt.analysisDebt.failedVideos))) process.exit(2);
' || exit 2
