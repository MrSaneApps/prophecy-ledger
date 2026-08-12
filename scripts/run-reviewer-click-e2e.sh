#!/usr/bin/env bash
# Canonical Mini wrapper. Live mode reuses the authenticated browser; local mode
# creates a fresh disposable D1 so earlier E2E decisions never consume the seed.
set -euo pipefail
HOST="$(hostname -s 2>/dev/null || hostname)"
if [[ "$HOST" != *[Mm]ini* && "${ALLOW_AIR_REVIEWER_CLICK:-}" != "1" ]]; then
  echo "Run on Mini (ssh mini). Current host=$HOST"
  echo "Or set ALLOW_AIR_REVIEWER_CLICK=1 for an explicit exception."
  exit 2
fi
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"

MODE="local"
PREVIOUS=""
for ARG in "$@"; do
  if [[ "$PREVIOUS" == "--mode" ]]; then MODE="$ARG"; fi
  case "$ARG" in
    --live|--mode=live) MODE="live" ;;
    --local|--mode=local) MODE="local" ;;
  esac
  PREVIOUS="$ARG"
done

if [[ "$MODE" == "live" ]]; then
  exec node scripts/reviewer-click-e2e.mjs "$@"
fi

E2E_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prophecy-reviewer-e2e.XXXXXX")"
E2E_SERVER_PID=""
E2E_LOG="$E2E_STATE_DIR/wrangler.log"
cleanup() {
  if [[ -n "$E2E_SERVER_PID" ]] && kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
    kill "$E2E_SERVER_PID" 2>/dev/null || true
    wait "$E2E_SERVER_PID" 2>/dev/null || true
  fi
  if command -v trash >/dev/null 2>&1; then
    trash "$E2E_STATE_DIR" >/dev/null 2>&1 || true
  else
    echo "WARN isolated reviewer state retained at $E2E_STATE_DIR"
  fi
}
trap cleanup EXIT

E2E_PORT="$(node -e 'const n=require("node:net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});')"
npx wrangler d1 migrations apply DB --local --persist-to "$E2E_STATE_DIR"
npx wrangler pages dev public --persist-to "$E2E_STATE_DIR" \
  --binding REVIEW_DEMO_MODE=1 --ip 127.0.0.1 --port "$E2E_PORT" >"$E2E_LOG" 2>&1 &
E2E_SERVER_PID="$!"

E2E_READY=0
for _ in {1..60}; do
  if ! kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
    tail -40 "$E2E_LOG"
    echo "Reviewer demo server exited before readiness"
    exit 2
  fi
  if node -e "fetch('http://127.0.0.1:$E2E_PORT/review').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    E2E_READY=1
    break
  fi
  sleep 0.25
done
if [[ "$E2E_READY" != "1" ]]; then
  tail -40 "$E2E_LOG"
  echo "Reviewer demo server did not become ready"
  exit 2
fi

node scripts/reviewer-click-e2e.mjs "$@" --base "http://127.0.0.1:$E2E_PORT"
