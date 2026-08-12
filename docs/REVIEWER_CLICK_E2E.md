# Reviewer click E2E (durable)

Minimal-friction way to **click-test Prophecy Ledger as a reviewer** again later.

## Canonical tool (preferred)

You do not need to remember npm paths. From Air or Mini:

```bash
ruby ~/SaneApps/infra/SaneProcess/scripts/SaneMaster.rb prophecy_reviewer_click
ruby ~/SaneApps/infra/SaneProcess/scripts/SaneMaster.rb prophecy_reviewer_click --mode live
ruby ~/SaneApps/infra/SaneProcess/scripts/SaneMaster.rb prophecy_reviewer_click --live --allow-live-submit
```

Ad-hoc `/tmp` Brave OTP scripts are **blocked** by `sane_bash_guards.rb`.

Canonical tree: Mini  
`/Users/stephansmac/SaneApps/websites/prophecy-ledger`

## Three layers (keep separate)

| Layer | Command | Proves |
|-------|---------|--------|
| API workflows | `npm run test:reviewer-workflows` | Queue/open/accept/send-back/feedback/archive without a browser |
| Deploy smoke | `npm run smoke:reviewer` | Live CDN markers + Access gate + D1 readiness (no clicks) |
| **Click E2E** | `npm run e2e:reviewer` | Real UI: auth principal → feedback receipt → claim Accept/Send-back → durable receipt |

Deploy stays on API + smoke only. Click E2E is opt-in so deploy does not need a GUI session.

## Path A — Local demo (default, lowest friction)

No Cloudflare Access OTP. Playwright injects `x-demo-reviewer-token` (the UI never sends that header itself).

```bash
ssh mini
cd ~/SaneApps/websites/prophecy-ledger
cp -n .dev.vars.example .dev.vars   # once
npm run e2e:reviewer
```

The canonical wrapper creates a fresh temporary D1, applies every migration,
starts a loopback Pages server on an available port, runs the click flow, stops
the server, and trashes only that isolated test state. Repeated runs cannot
consume or rewrite an earlier local decision, and never touch production D1.

What it does:
1. Opens `/review` as demo reviewer
2. Submits feedback → asserts receipt id + history
3. Opens a claim → asserts Accept/Send-back
4. Sends the incomplete seeded claim back (local) → asserts review receipt, research lesson, and Open next case
5. Writes `outputs/visual-audit-reviewer-click-YYYY-MM-DD/findings.json` + PNGs

## Path B — Live production (Access session already warm)

Uses **existing Mini Brave tabs only** (no new tabs, no OTP automation).

```bash
ssh mini
# Once per Access session: in Mini Brave, open https://prophecy-ledger.pages.dev/review and finish email OTP
cd ~/SaneApps/websites/prophecy-ledger
ALLOW_LIVE_QUEUE=1 npm run e2e:reviewer:live
# Production writes are off by default. Opt in to each lane explicitly:
ALLOW_LIVE_QUEUE=1 ALLOW_LIVE_FEEDBACK=1 npm run e2e:reviewer:live
ALLOW_LIVE_QUEUE=1 ALLOW_LIVE_SUBMIT=1 npm run e2e:reviewer:live
```

Loading the live reviewer queue itself appends auth/audit receipts, reconciles
publication state, and may lease ready work. Therefore live mode exits before
navigating unless `ALLOW_LIVE_QUEUE=1` explicitly authorizes those mutations.

If Brave shows Access login, the script exits `NEED_ACCESS_LOGIN` — complete OTP once, re-run.

## Resource rules

- Run on **Mini** only (Air orchestrates via `ssh mini`).
- Live mode **reuses** a `/review` tab or navigates the front tab — never `make new tab`.
- Close Simulator / headless profiles when done (`scripts/reap-idle-resources.sh --apply` in SaneProcess).

## Demo tokens

`.dev.vars` (gitignored) must define at least:

```
DEMO_REVIEWER_1_ID=reviewer_demo_one
DEMO_REVIEWER_1_TOKEN=demo-token-one-7f3a
DEMO_REVIEWER_2_ID=reviewer_demo_two
DEMO_REVIEWER_2_TOKEN=demo-token-two-9c1e
```

See `.dev.vars.example`.

## Related

- Auth contract: `DEVELOPMENT.md` → Reviewer authentication
- Access app: Prophecy Ledger Reviewers (`prophecy-ledger.pages.dev/review`)
- Admin emails in policy: Joshua + `stephanjoseph2007@gmail.com`
