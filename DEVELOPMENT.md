# Development

## Current verification contract (2026-08-03)

Run repository work on the Mac Mini. Keep acquisition, analysis, human review,
and publication assertions separate: a green acquisition receipt does not prove
analysis, a green model/research receipt does not prove human review, and no
deployment is complete without exact artifact, deployment, stable-alias,
public-route, queue, and reviewer read-backs. Stateful production operations use
the canonical runners only; never substitute ad-hoc D1, Queue, Worker, Pages, or
email commands when their runner is missing or incomplete.

## Requirements

- Node.js 24
- npm 11
- Wrangler 4.104.0 (pinned in devDependencies)

## Commands

```bash
npm ci
npm test
npm run check
npm run dev
npm run dev:review
npm run deploy:runtime
```

`npm run check` runs all tests plus syntax/import checks. The development server
is temporary: stop it after QA and verify its port is closed.

`npm run deploy:runtime` is the canonical plan-only deployment preflight. It
freezes the source manifests, requires counted tests/imports and a dry Worker
artifact, and performs no remote apply. The maintainer-controlled apply path is
`node scripts/deploy-runtime.mjs --apply`; it requires separately configured
Wrangler credentials and must finish with the complete deployment receipt and
post-deploy parity checks. Credentials never belong in the repository.

## Local D1

`wrangler.toml` declares the Pages project and remote D1 binding. Local commands
retain `--local` and `--persist-to .wrangler/state`; those flags keep development
data off the remote database.

```bash
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state
npm run dev:review
```

The numbered migrations create the append-only ledger, public research records,
and source-ingestion pipeline. Reapplying the idempotent migrations does not
duplicate seeded records.

Migration 0005 appends the plain-language revision of both working reviews.
Migration 0006 adds ingestion runs/jobs, permanent source identities, immutable
source revisions, source links and availability receipts, transcript attempts
and private-artifact metadata, extraction runs, and possible-claim records. It
does not add an AI rating path.
Migration 0007 extends the Queue job constraint and adds append-only Gemini
video-analysis evidence, cross-check, agreement, and escalation tables.
Migrations 0008–0013 add daily media reservations, private transcript chunks and
artifacts, duration provenance, explicit generated-transcript quality labels,
authenticated operator-duration fallback provenance, per-suggestion extraction
rejection receipts, and deterministic quote-offset correction counts.
Migration 0014 adds reviewer assignments, expiring leases, append-only candidate
decisions, promotion receipts, blinded claim-adjudication work, and content-free
review audit events. Apply migrations in filename order. Remote migration state,
backup paths, and run receipts are maintainer-only operational records.
Migration 0042 recreates the candidate-readiness insert trigger so a candidate's
section must belong to the same completed extraction run. Archive review tests
also prove that source receipt matching, the archive decision, conveyor rows,
assignment submission, and work completion commit atomically or not at all.
Migrations 0043–0048 add append-only pending-source dispositions, incident and
notification events, physical Gemini request/debit/result ledgers, Workers AI
started/terminal receipts, counted operations-run receipts, queue observations,
deployment receipts, and the durable analysis-reprocess dispatch outbox. Tests
must prove those migrations preserve completed counts, transcript artifacts,
candidate/reviewer/publication history, and the isolated acquisition/analysis
queue boundary.
Migrations 0049–0056 add canonical source-unavailable reasons, exact
analysis-generation lineage/dispositions, recovery of historical manual holds,
provider-aware text-AI attempt receipts, and immutable Gemini generations through
v13. Deployed generations and receipts are never edited or replayed; a repair
must create an exact sparse successor under the next registered generation.

## Test coverage

- YouTube URL allowlist, canonicalization, and hostile-input rejection
- Idempotent save-only public intake, pending-identity disclosure, no Queue
  capability, and no attribution of arbitrary video IDs to a public profile
- Bounded official-site fetches, redirect/DNS/private-address protection, parser
  terminal conditions, and exact embedded-video links
- Queue message validation, deterministic IDs, leases, retries, replay-safe
  successor dispatch, reconciliation, and dead-letter behavior
- Description triage that produces neutral possible-claim leads only; transcript
  quote/offset validation fails closed on invention or malformed model output
- Direct live Gemini `generateContent` requests for public YouTube clips,
  five-minute non-overlapping planning, full-text stitching, duration provenance,
  daily atomic reservations, retryable chunk jobs, private R2 artifacts, and
  `gemini_generated_needs_human_check` quality labeling
- Abortable Gemini transcript extraction through Cloudflare AI Gateway with a
  mode-bounded schema-HTTP400-to-plain fallback, fenced-JSON parsing, exact unique
  quote enforcement, deterministic offset correction, per-suggestion rejection,
  bounded-deadline policy, binding-native JSON Schema placement, explicit output
  budget, supported fallback-model configuration, and no public rating path
- Provider-native Gemini Interactions routed through Cloudflare AI Gateway with
  strict public-video output, cache bypass, one upstream attempt, immutable
  primary/verifier/tie-breaker audit rows, full-body timeout, metadata-only
  gateway logging, bounded failure receipts, deterministic agreement, and replay
  and concurrent-start protection
- Category-correct corpus coverage and a public-safe, filter-bound keyset source
  catalogue with no transcript/R2/AI/reviewer leakage
- Classification, atomicity, deadline lifecycle, and fail-closed publication
- Distinct matching reviews, same-reviewer rejection, disagreement, and AI ban
- Contemporaneous-information cutoff enforcement
- Public API and PDF exclusion of draft claims, draft verdicts, and private notes
- Safe public `researchRecords`, twelve-source projection, and newest append-only
  research-revision selection
- Deterministic PDF bytes, filename/content type, provisional-evidence usefulness,
  and report eligibility filtering
- Cluster deduplication, strict partial handling, coverage, baselines, expected
  hits, predictive advantage, Poisson-binomial tails, and significance gates
- Ordered migrations, append-only triggers, and idempotent seed
- Troy pilot incompleteness/provisional disclosure
- Cloudflare Access JWT validation, wrong issuer/audience/signature/expiry
  rejection, stable pseudonymous principals, production bearer-token rejection,
  assignment ownership, blinded second reviews, and idempotent publication
- Static accessibility and responsive-overflow guards
- Biblical fulfillment study routing, unmeasured-status honesty, five method
  examples, official WEBP/canon disclosure, human-review boundary, and dedicated
  bright-white 390px-responsive styles
- Preview indexing blocks and security-header parity for static and Function responses

The static UI suite also rejects the internal phrases removed from the public
shell, including `final adjudication`, `evidence dossier`, `evidence brief`,
`source register`, `pre-cutoff`, `novelty boundary`, and `Reviewer demo`.

## Runtime QA

Exercise the directory, person profile, claim detail, biblical fulfillment study,
methodology, privacy, and reviewer surfaces at desktop and 390px mobile widths.
Verify HTTP success, no
horizontal overflow or console errors, touch targets of at least 44 by 44 pixels,
and no transcript body, private object key, raw model output, lease, or reviewer
identity in public API responses. Runtime screenshots and API read-back receipts
belong in ignored maintainer output, not version control.

## PDF verification

Render every page of the deterministic public report and inspect it for clipping,
overlap, missing citations, draft ratings, reviewer identities, private notes,
and accidental public scores. Generated PDFs, rendered pages, hashes, and visual
receipts belong in ignored maintainer output.

## Preview release surface

`public/_headers` configures Cloudflare Pages static responses. The root
`functions/_middleware.js` repeats those protections for Function routes because
Pages `_headers` does not cover Function responses. The CSP permits same-origin
modules, styles, API calls, and PDF downloads while allowing normal navigation to
external YouTube and evidence links.

Remove the robots meta, `robots.txt` disallow, and `X-Robots-Tag` together only
when public indexing is approved. Before publishing a modified network
deployment, configure a visible `Source` link to the public repository so users
can obtain the corresponding source required by the AGPL.

The stable preview serves the plain-language Pages bundle and D1 migrations
0001–0014. Keep the noindex controls, donation boundary, and
no-nonprofit-claim copy intact until the user explicitly approves those separate
changes.

## Scanner development and operations

The separate Worker is configured by `scanner/wrangler.toml` and deployed as
`prophecy-ledger-scanner`. It shares D1 with Pages and binds:

- Queue producer/consumer `prophecy-ledger-ingestion`
- dead-letter queue `prophecy-ledger-ingestion-dlq`
- Queue producer/consumer `prophecy-ledger-analysis`
- dead-letter queue `prophecy-ledger-analysis-dlq`
- private R2 bucket `prophecy-ledger-artifacts`
- Workers AI binding `AI` retained for fail-closed compatibility tests
- provider-native Cloudflare AI Gateway transport for Gemini video and structured text analysis
- direct Google Gemini API transport for private transcript acquisition

The acquisition and analysis consumers are operationally isolated. Their
current batch/concurrency/retry settings remain declared in
`scanner/wrangler.toml`; changing those settings requires a fresh bounded-load
and queue-observation receipt.

Root `wrangler.toml` intentionally has no Queue producer. Public `/api/intake`
only saves `ingest_requests.status='pending_identity'`; it neither creates an
ingestion run/job nor calls the scanner. Queue jobs originate inside the
secret-gated scanner after a registered-source lookup. A trusted
`video_metadata` job must carry both the validated YouTube ID and the stable
source-item ID created by that discovery path.

Pages binds the main ledger as `DB`, the separate transcript index as
`SEARCH_DB`, and the private artifact bucket as `ARTIFACTS`. These non-secret
bindings stay in `wrangler.toml` so a deploy cannot silently drop the reviewer
search, capture, or archive-conveyor dependencies.

`SCAN_ENABLED=0` is the committed and deployed default. The scheduled handler
does no work in that state. Manual `/admin/start`, `/admin/status`, and
`/admin/health` calls require `SCANNER_ADMIN_TOKEN`; never paste that token into
commands that will be logged, tests, fixtures, source, or handoff documents.

Video analysis additionally requires `AI_GATEWAY_ACCOUNT_ID`,
`AI_GATEWAY_ID`, and secret `AI_GATEWAY_TOKEN`. When
`AI_GATEWAY_BYOK=1`, Gemini is stored in Cloudflare and the Worker omits
`GEMINI_API_KEY`; otherwise the Worker must also have that provider secret.
The committed production default is BYOK on after a provider-native Interactions
canary. `GEMINI_ANALYSIS_MODEL` and `GEMINI_ANALYSIS_FALLBACK_MODEL` route text
analysis through the same secret without exposing a provider key. Gateway and
client timeouts make that fetch abortable; only `ai_timeout_confirmed` may advance
to the fallback. Never deploy either path with a missing gateway Run token, and
never silently fall back to direct Gemini.

The scanner fetcher only permits the registered public website hosts, validates
DNS and every redirect, caps time and bytes, and saves parsed metadata rather
than full HTML or media. It does not scrape captions. For an authenticated
trusted public YouTube source, `/admin/transcript-canary` resolves duration,
atomically reserves media seconds, calls Gemini 3.1 Flash-Lite directly in clips
of at most 300 seconds, and stores only a generated private artifact in R2. When
`YOUTUBE_DATA_API_KEY` is present, duration is read from the official YouTube
Data API v3 `videos.list` `contentDetails.duration` field. The secret is
API-restricted and never appears in health, receipts, logs, or public
projections; health exposes only `youtubeDataApi: true`.

`POST /admin/transcript-batch` requires an explicit `start` or `resume` action
and an idempotency key. The controller freezes trusted, exactly linked videos
oldest-first and processes one video at a time. Durable dispatch state is written
before Queue delivery and recoverable after interruption. Rate limits, budget
limits, and duration failures pause without advancing. The scheduled handler may
resume an existing eligible batch only when `TRANSCRIPT_BATCH_ENABLED=1`; it does
not create batches or discover sources. `SCAN_ENABLED=0` remains independent and
continues to prohibit scheduled source scanning.

A terminally failed active item is never retried after its transcript plan has
changed. The authenticated `skip_active_item` action is allowed only while the
batch is paused and the active run has a terminal failed job. It preserves the
failed job, appends an `item_skipped` event, and activates exactly one successor
under the current plan version.

An unavailable pending source uses the canonical quarantine action only when an
operator explicitly supplies the exact batch/item/transition binding. The action
appends one disposition and may activate one successor; it does not delete or
complete the unavailable item. The daily watchdog never enters that mode by
default.

Every transcript section is labeled `GEMINI-GENERATED, NEEDS HUMAN CHECK`.
Exact claim extraction may run only against that private artifact; a candidate
is retained only when its exact quote occurs uniquely. No generated transcript
or raw AI output is public.

The direct transcript path requires secret `GEMINI_API_KEY`; authenticated
health reports binding booleans without exposing keys. The daily cap is 86,400
physical request seconds. Every root/split/retry call reserves before fetch and
writes a terminal physical result; a one-time cutover debit fails closed for
legacy usage. `SCAN_ENABLED=0` remains unchanged. Gemini clip boundaries are
approximate locators and must not be presented as word-level timestamps.

### Operational receipts

Keep full-scan, idempotency, transcript, model-usage, pricing, database-backup,
and private-artifact receipts outside Git. Public documentation should describe
the invariant being tested rather than copying live run IDs, counts, hashes,
private storage keys, or controller-specific paths.

Canonical completion boundaries are machine-readable and fail closed:

- Analysis reconciliation emits `ANALYSIS_RECONCILIATION_ITEM_FINAL` for every
  discovered section, then `ANALYSIS_RECONCILIATION_SUMMARY` and
  `ANALYSIS_RECONCILIATION_EXIT`; failed or manual-required work is not success.
  Its implicit limit is five so one 15-minute receipt window remains bounded;
  operators may explicitly select 1 through 25, and deadline finals remain real
  failures rather than accepted or hidden pending work. The canonical
  `npm run reconcile:analysis` shortcut inherits this implicit limit.
- Research emits one `RESEARCH_WORKER_CLAIM` per discovered claim plus
  `RESEARCH_WORKER_SUMMARY` and `RESEARCH_WORKER_EXIT`. `draft=false` is a
  completed manual-research result, not a silent success.
- The conveyor emits one `MACHINE_CONVEYOR_ITEM_FINAL` per considered candidate,
  then counted `MACHINE_CONVEYOR_SUMMARY` and `MACHINE_CONVEYOR_EXIT` receipts;
  pending promotions or failed preservation/read-back make the run fail.
  Discovery must exclude every candidate with a human decision so completed
  rejections and atomic promotions cannot be requeued or counted as pending;
  existing ready work without a decision remains eligible for receipt recovery.
- Deployment emits `DEPLOY_RUNTIME_SUMMARY` and `DEPLOY_RUNTIME_EXIT`. Apply is
  complete only with Worker version/deployment and Pages deployment IDs, exact
  scanner artifact hash, complete migrations, four queue read-backs, deployment
  URL and stable-alias asset parity, public-route parity, and both deployment and
  stable reviewer-smoke receipts.
- The watchdog's `batch-watchdog-v2` receipt distinguishes current/recovered
  incidents and accepted-pending/delivered/bounced opening notices. Pending
  opening delivery is nonblocking but `deliveryComplete=false`; bounced/failed
  opening delivery persists as a blocker until manually resolved. Recovery is
  append-only D1/receipt state and does not send email, because owner email is
  reserved for current error-level alerts.

An HTTP 2xx, provider acceptance, process exit zero, heading, or partial JSON is
never a substitute for the final marker set and agreeing durable read-back.

## Reviewer authentication and demo security

Production review access is protected by Cloudflare Access at exact `/review`
and `/api/review/*` paths. The Pages Function verifies the Access JWT using
`CF_ACCESS_ISSUER`, `CF_ACCESS_AUD`, and `CF_ACCESS_JWKS_URL`. These values are
identifiers and endpoints, not secrets. The stable reviewer principal is derived
from the verified token; request-body identities and static production bearer
tokens are rejected.

Review access is available only when both are true:

1. Request hostname is `localhost` or `127.0.0.1`.
2. `REVIEW_DEMO_MODE=1` is present in the runtime environment.

Local requests also require an `x-demo-reviewer-token` matching one configured
`DEMO_REVIEWER_N_ID` / `DEMO_REVIEWER_N_TOKEN` pair. The stable reviewer
principal always comes from that credential, never the request body. Missing or
invalid configuration returns 404 so a private surface is not advertised.

## Reviewer click E2E (durable)

Click-testing as a reviewer is documented in `docs/REVIEWER_CLICK_E2E.md`.

- Local (no Access OTP): `npm run e2e:reviewer` creates a fresh migrated temporary
  D1 and loopback Pages server, then removes only that isolated test state.
- Live prod (reuse Mini Brave Access session, no new tabs): `npm run e2e:reviewer:live`
- API-only gate remains `npm run test:reviewer-workflows`; deploy smoke is `npm run smoke:reviewer`

The click runner must select only `claim_adjudication` assignments or openable
claim rows for its Accept/Send-back assertion. A candidate-verification assignment
has a different terminal form and must never be used as a generic fallback, or the
test creates a false UI failure while the reviewer workspace is working correctly.

Demo tokens live in gitignored `.dev.vars` (see `.dev.vars.example`). Playwright injects
`x-demo-reviewer-token` on loopback only; the static UI never sends that header.

## Data ethics

Never invent quotations, timestamps, transcripts, evidence, reviews, or corpus
coverage. A research proposal belongs in draft state. A source authored by the
speaker is labeled as such and does not independently establish fulfillment.

The repository's `AGPL-3.0-or-later` license covers the software, not third-party
quotations or source material, private transcripts, raw model output, reviewer
records, database dumps, or Prophecy Ledger/SaneApps branding. Keep those private
materials and all maintainer-only `.codex/`, handoff, and generated-output state
out of Git. See `README.md` and `LICENSE` for the public distribution boundary.

## One-human decision and adversarial AI gate

One authenticated reviewer owns each final claim decision. An accepted review
publishes immediately after the ordinary source, evidence, novelty, and frozen-
draft gates pass. A send-back is append-only, cannot publish, and requires a
newer AI draft before another human decision can become eligible. The reviewer
chooses a public display name once; public projections show that name and the
review rationale without exposing the credential-derived reviewer identifier.

Research remains machine-only until that human decision. The canonical worker
can ask Cloudflare-hosted Nemotron to challenge the primary draft and use
Cloudflare-hosted Qwen as the deciding AI check. This lane is disabled before
network access unless `RESEARCH_CLOUDFLARE_ADVERSARIAL_ENABLED=1` is deliberately
configured after an account-wide billing review. A D1 reservation is made before
each enabled inference. The trigger caps reservations at 7,800 neurons per UTC
day, below Cloudflare's 10,000-neuron free daily allocation; failed calls and
retries retain their reservations. Disabled, exhausted, or incomplete work fails
closed to manual research and never authorizes paid overflow.
