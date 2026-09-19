#!/bin/zsh
# Mini-only. Confirms Gemini Project is unlinked from paid billing and AI Studio is Free.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

HOST="$(hostname)"
case "$HOST" in
  *mini*|*Mini*) ;;
  *) echo "HOST_FAIL $HOST" >&2; exit 2 ;;
esac

ROOT="${PROPHECY_LEDGER_ROOT:-$HOME/SaneApps/websites/prophecy-ledger}"
OUT_DIR="$ROOT/outputs/gemini-no-charge"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RECEIPT="$OUT_DIR/$STAMP.json"
LATEST="$OUT_DIR/latest.json"
GUI_RUN="$HOME/SaneApps/infra/SaneProcess/scripts/mini/mini-gui-run.sh"
INNER="$OUT_DIR/inner-dump.sh"

if [[ ! -x "$GUI_RUN" ]]; then
  echo "missing mini-gui-run.sh" >&2
  exit 2
fi

cat > "$INNER" <<'INNER'
#!/bin/bash
set -euo pipefail
URL="$1"
osascript "/Users/stephansmac/SaneApps/websites/prophecy-ledger/scripts/gemini-no-charge/brave-tab.applescript" "$URL" >/tmp/gemini-no-charge-front.txt
sleep 15
osascript "/Users/stephansmac/SaneApps/websites/prophecy-ledger/scripts/gemini-no-charge/brave-js.applescript" '(() => (document.body.innerText||"").replace(/\s+/g," ").slice(0,4000))()'
INNER
chmod 700 "$INNER"

dump_page() {
  local url="$1"
  local label="$2"
  "$GUI_RUN" --close-window --title "Gemini no-charge ${label}" -- "$INNER $(printf %q "$url")"
}

MANAGE_TEXT="$(dump_page "https://console.cloud.google.com/billing/019CCC-9218FF-F70EC7/manage" manage || true)"
PROJECTS_TEXT="$(dump_page "https://aistudio.google.com/projects?project=gen-lang-client-0748398267" projects || true)"

python3 - "$RECEIPT" "$LATEST" "$HOST" "$MANAGE_TEXT" "$PROJECTS_TEXT" <<'PY'
import json, sys
from pathlib import Path
receipt_path, latest_path, host, manage, projects = sys.argv[1:6]
failures = []
if "019CCC-9218FF-F70EC7" not in manage:
    failures.append("live_billing_page_missing")
if "gen-lang-client-0748398267" in manage:
    failures.append("gemini_project_relinked_to_paid_account")
if "saneapps-store-operations" not in manage:
    failures.append("store_operations_missing_from_live_account")
if "Free tier" not in projects:
    failures.append("ai_studio_not_free_tier")
if any(tag in projects for tag in ("Tier 1", "Tier 2", "Tier 3")):
    failures.append("ai_studio_shows_paid_tier")
if "Gemini Project" not in projects:
    failures.append("ai_studio_gemini_project_missing")
doc = {
    "contract": "gemini-no-charge-v1",
    "host": host,
    "ok": not failures,
    "failures": failures,
    "expect": {
        "liveBillingAccount": "019CCC-9218FF-F70EC7",
        "geminiProject": "gen-lang-client-0748398267",
        "storeProject": "saneapps-store-operations",
        "studioTier": "Free tier",
    },
}
text = json.dumps(doc, indent=2) + "\n"
Path(receipt_path).write_text(text)
Path(latest_path).write_text(text)
print(json.dumps(doc))
raise SystemExit(0 if not failures else 2)
PY
