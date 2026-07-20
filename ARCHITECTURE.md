# Architecture

## 1. Shape

The MVP keeps the public application on Cloudflare Pages and runs background
source research in a separate Worker:

```text
public UI -> Pages Functions ---------------------------> shared D1
              `-> save-only pending-identity intake       ledger + ingestion

secret-gated scanner admin / disabled cron
              -> prophecy-ledger-ingestion Queue
                       -> prophecy-ledger-scanner Worker
                            |-> bounded public fetcher
                            |-> Workers AI description triage
                            |-> direct Gemini transcript acquisition
                            |-> Workers AI exact-quote extraction
                            |-> private R2 transcript artifacts
                            `-> Queue retry / DLQ
```

The `prophecy-ledger` Pages project and shared D1 serve a noindex preview. The
Worker is deployed separately so Pages can remain the stable public/read and
human-review surface while the Worker consumes Queue jobs. There is no caption
scraper, media mirror, public transcript body, AI publication path, or donation
flow. Local development uses persisted local D1 state.

## 2. Intake

`POST /api/intake` accepts only HTTPS YouTube video URLs in explicit watch,
short, live, embed, or `youtu.be` forms. It normalizes the eleven-character ID
and inserts one deterministic `ingest_requests` record with status
`pending_identity`. Public Pages has no Queue binding and the
route does not create an ingestion run/job or attach the video to Troy's source
inventory. It returns an honest save-only state: no automatic transcript, claim,
or rating was created. A duplicate reuses the same pending request.

Only the trusted scanner path may send `video_metadata` work after source
discovery has created a stable source-item ID. The Queue envelope must contain
both that trusted ID and the validated YouTube ID.

## 3. Claims and evidence

Outcome and novelty are different fields. Evidence has a role:

- original contemporaneous statement
- contemporaneous follow-up
- retrospective fulfillment claim
- independent outcome evidence
- contemporaneous public-information evidence

Public-information evidence may not postdate the claim cutoff. Each claim has
an atomic criterion, deadline/as-of lifecycle, transcript state, and cluster.
Non-testable statements are catalogued but excluded from scoring.

## 4. Publication gate

A public adjudication requires two distinct credential-derived human principals
matching exactly on statement type, outcome, novelty, baseline, cited evidence
set, and prior-information receipt. Identity never comes from a request body.
Every publication needs a verified original statement. Resolved findings need
independent outcome evidence, testable predictions need a deadline, and assessed
novelty needs a completed receipt frozen to the source-date cutoff.

Public endpoints use explicit projections. The person profile exposes neutral
catalogue metadata, published findings, and a safe `researchRecords` projection.
Each research record contains the archived quotation, test framing, provisional
evidence summary, prior-public-information summary, corpus warning, missing gates,
and public supporting references. It contains no draft verdict, transcript warning,
reviewer identity, or private notes. The home dossier and claim-detail pages hydrate
from this projection and show an explicit source-metadata fallback if it is
unavailable.

Every source-bound statement remains a distinct historical record even when the
speaker revisits the same topic or the original link later disappears. A later
retelling cannot replace earlier details. Reviewers may relate records for analysis,
but may not construct a stronger composite prophecy from favorable fragments across
separate sources or omit details that did not occur.

Draft decisions are available only through the credential-gated reviewer API.
Cloudflare Access protects exact `/review` and `/api/review/*` paths. The Pages
Function validates the RS256 Access JWT against the configured issuer, audience,
and JWKS and derives the stable pseudonymous reviewer principal from `iss + sub`.
Static bearer credentials are rejected outside the explicitly enabled loopback
demo. Candidate and claim assignments use expiring ownership leases; a second
reviewer remains blind to the first review until the matching-review gate is
evaluated.
Reviews, receipts, events, public research revisions, and publication revisions
are append-only. A database trigger requires the immutable publication revision
before a claim can become public and prevents later mutation or deletion.

## 5. Scoring

The score anchor is one unique cluster, preventing correlated repetitions from
inflating the denominator. Clustering is only a denominator policy; it never merges,
deletes, or rewrites the source-bound claim records and never authorizes selective
cross-video stitching. Resolved clusters are true, false, or partial.
Strict hits require every eligible atomic component to be true; partial is a
strict miss. Pending, undetermined, and not-falsifiable records are excluded.

Expected hits are the sum of moderator-approved conservative baseline
probabilities. Predictive advantage is strict hits minus expected hits. The
one-sided significance p-value is the Poisson-binomial tail for claim-specific
baselines.

The UI says `insufficient sample` unless there are at least 30 independent
resolved clusters, at least 90% valid coverage, complete criteria and baselines,
a frozen corpus, a versioned frozen rubric, and p < .01. Coverage fails closed if
reviewed videos exceed discovered videos. Even a passing result means
statistically above the documented baseline, not proof of divine causation.

## 6. Troy pilot

The seed is intentionally incomplete. Migration 0004 adds two append-only public
research briefs and twelve references:

- Southeast Asia oil: the speaker archive acknowledges the stated 2021 timing
  did not match; independent reporting cites regional production contraction.
- Russia: the broad invasion outcome aligned, but pre-claim warnings were public
  and the literal declaration, spring timing, and `full shift` wording remain
  unresolved.

Both records link the original YouTube source and label the archive as
speaker-authored and outcome-selected. Neither has a final public adjudication,
novelty rating, score, or implication about motive or divine causation.

Migration 0005 appends revision 2 of both records. It preserves every source URL
and fact while rewriting the public summaries, questions, warnings, open checks,
and source notes in ordinary language. Revision 1 is untouched; the newest-
revision query selects revision 2 and its copied reference set.

## 7. Immutability and source loss

Published claims and publication revisions cannot be updated or deleted. Public
research corrections use numbered append-only revisions; the profile projects
only the newest revision and its linked references. The MVP does not yet promise
an adjudication appeal path. Source loss changes availability without erasing the
claim or inferring why it disappeared.

## 8. Public PDF export

`GET /api/people/:slug/report` builds a deterministic PDF with `pdf-lib` from the
same public profile projection. Published findings remain separately gated, while
the current report makes working research useful without converting it into a
verdict. The report is a SaneApps-styled evidence record built around what was
said, what happened, what was already public, and what still needs checking.
Generated reports, rendered pages, and hash receipts remain ignored operational
artifacts.

## 9. Source ingestion

Migration 0006 separates operational work from permanent evidence:

- `ingestion_runs` and `ingestion_jobs` hold Queue status, leases, attempts, and
  replay-safe successor dispatch.
- `source_items` hold stable public identities; immutable
  `source_item_revisions` preserve changed titles, descriptions, dates, and
  exact embedded-video pointers without storing full HTML.
- source links, availability events, and scan receipts preserve what was found
  and expose partial/blocked platform access without inventing completeness.
- transcript attempts record missing, authorization-required, provided,
  verified, failed, or needs-human-check states. Successful transcript artifacts
  live in private `prophecy-ledger-artifacts` R2; D1 stores metadata and hashes.
- extraction runs and claim candidates are append-only. A first-party
  description can create only a neutral `description_lead`, never an exact quote
  or rating.

The public profile reports seven independent counts: official posts, linked
videos, available transcripts, possible-claim posts, specific claim candidates,
claims checked by people, and final ratings. Raw source totals never enter scoring. The public source
catalogue uses filter-bound keyset pagination, puts official posts before linked
companions, treats `unknown` availability as needing more work, and projects no
transcript text, R2 keys, model internals, leases, or reviewer identities.

The Worker fetches only registered public hosts, rejects private/DNS-rebound and
foreign redirects, caps response size and time, and processes bounded jobs. A
Queue message is versioned and allowlisted; at-least-once delivery is safe because
run jobs, source identities, revisions, and candidates have deterministic or
unique identities. Retry exhaustion goes to `prophecy-ledger-ingestion-dlq` and
cannot make a run appear cleanly complete.

Workers AI uses structured output to triage first-party title/description text.
It may write a neutral possible-claim lead. Exact quotation extraction requires
a private quality-labeled transcript artifact. Every retained quote must occur
exactly once in that artifact; deterministic code corrects model offset arithmetic
or rejects missing/ambiguous quotes. AI cannot populate an outcome or bypass the
two-human publication gate.

Migration 0007 preserves the earlier experimental primary, verifier, and
tie-breaker video-analysis
attempts, extracted candidates, independent cross-checks, deterministic agreement
results, and escalation events. The scanner sends one trusted public YouTube URL
per Gemini Interactions request through provider-native Cloudflare AI Gateway.
Gemini remains the model provider; Cloudflare is the authenticated transport.
Attempts preserve model/prompt versions, request hashes, raw and structured
outputs, timestamps, gateway/log identity, and immutable failures. Gateway cache
and hidden retries are disabled per request so Queue retries remain visible.
Cloudflare keeps metadata logs but not request/response payloads; bounded
secret-redacted failure bodies and HTTP status remain in the append-only D1 row.
The client timeout covers the complete response body, not only first byte.

Those AI-extracted or AI-cross-verified records are private evidence-labor candidates,
not ledger claims, outcomes, ratings, or publication decisions. A separate pass
reopens the video and independently checks each proposal. Deterministic quote,
timestamp, deadline, type, and meaning checks either agree, request a third pass,
or escalate to a human. Only the existing two-human gate can publish a verdict.

All scanner HTTP admin routes use timing-safe bearer-token authentication.
`SCAN_ENABLED=0` blocks the daily scheduled start by default; deliberate manual
canary/full starts remain secret-gated. The deployed Queue consumer uses
`max_concurrency=5` while scheduled scanning remains disabled.

Full-scan, canary, idempotency, model-usage, and inventory receipts are
maintainer-only operational evidence. They remain outside Git because they may
contain live run identifiers, private storage references, or deployment-specific
counts. The public architecture contract is enforced by tests: replay does not
duplicate source identities or revisions, exhausted work cannot appear complete,
and public projections never disclose private transcript, model, lease, or
reviewer data.

## 10. Transcript acquisition and claim extraction

Migrations 0008–0019 implement the current transcript-first path. An
authenticated operator may start one trusted public YouTube source or explicitly
start/resume a frozen transcript batch. When `YOUTUBE_DATA_API_KEY` is bound,
duration comes from the official YouTube Data API v3 `videos.list`
`contentDetails.duration` field and is recorded as
`youtube_data_api_v3_content_details`. The key is restricted to that API and is
never stored in receipts. Without the binding, the existing bounded public-HTML
lookup remains available; a manual duration may be accepted only on the
authenticated single-source route and is labeled
`operator_supplied_authenticated`.

For transcript batches, the binding also defines receipt authority: activation
may reuse an exact source item's prior `youtube_data_api_v3_content_details`
receipt, but an older HTML or authenticated-operator receipt never suppresses a
fresh official lookup. Data API errors pause the batch without HTML or operator
fallback. This same rule applies to initial activation, crash repair,
post-stitch advancement, manual resume, and scheduled resume.

The batch controller freezes eligible linked videos oldest-first, runs at most
one video at a time, persists dispatch state before Queue delivery, and repairs
interrupted dispatches without creating a second active video. Quota exhaustion,
Gemini rate limits, duration failures, and terminal errors pause the batch rather
than advancing. Scheduled execution may resume an already approved batch only
when `TRANSCRIPT_BATCH_ENABLED=1`; it never discovers sources or creates a batch.
The Worker atomically reserves no more than 28,800 media seconds per UTC day
before any Gemini request.

The video is divided into non-overlapping clips of at most 300 seconds. Each job
calls Google's live `v1beta/models/gemini-3.1-flash-lite:generateContent` endpoint
directly with the public video URL and `videoMetadata` clip bounds. The response
must finish normally and contain plain transcript text. Chunks are immutable and
resumable; the stitched private R2 artifact labels each section
`GEMINI-GENERATED, NEEDS HUMAN CHECK`. Clip boundaries are approximate source
locators, not word-level timestamps.

Workers AI analyzes the private transcript and ignores encouragement, prayer,
exhortation, symbolism, theology, personal interpretation, and vague or unbounded
prophecy. Retained types are `testable_prediction`,
`present_or_past_factual_claim`, and `conditional_prediction`; future and
conditional candidates require a bounded deadline. Structured JSON mode is tried
first, followed by an explicit plain-JSON contract on the same model because the
provider documents that JSON Mode may not always be met. Bad individual
suggestions are rejected without discarding good candidates, and all rejection
and correction counts remain append-only.

The public surface exposes safe counts only; transcript bodies and chunks,
private object keys, raw AI output, and reviewer identities remain private. No
candidate is a ledger claim, human review, or final rating.

## 11. Repository and licensing boundary

The `AGPL-3.0-or-later` license applies to the software in this repository. It
does not relicense third-party quotations, source excerpts, names, titles, URLs,
or other source material. Private transcripts, raw model output, reviewer records,
database dumps, and operational receipts are excluded from the repository and
are not a public dataset. The Prophecy Ledger and SaneApps names, logos, and
visual identity are not licensed for reuse; forks must use distinct branding and
must not imply endorsement.

## 12. Biblical fulfillment pattern study

`/biblical-prophecy` is a public static methodology surface. It treats Scripture
as the reference standard and studies only source-to-fulfillment connections the
canonical text itself makes. It does not use external history to adjudicate the
Bible. The first defined corpus is the public-domain World English Bible
Protestant Edition, pinned to a retrieval date and checksum across its 66 books.

The page publishes an explicitly unmeasured common-elements matrix until
reviewed pairs exist. Candidate pairs, 5W1H provenance, linkage types, and
element comparisons require two independent matching human reviews; AI may
suggest passage pairs only. Repeated or parallel sources are deduplicated before
metrics, unresolved links remain outside results, and every published result
must show its numerator, denominator, corpus version, and audit coverage.

## 13. Deferred

- Self-service contributor registration and identity management beyond the
  current exact-email Cloudflare Access invitation policy
- Additional public-platform inventories beyond the dependable official-site
  corpus, with honest blocked/partial receipts
- Replace the temporary broad Cloudflare Worker token with an account-scoped
  AI Gateway Run-only token before any bounded video batch
- A separately approved bounded multi-person batch; Troy is the only approved
  batch and scheduled discovery remains disabled
- Evidence-submission moderation and abuse controls
- Replication corpora and published statistical claims
- Nonprofit formation, governance, donation processing, and public indexing
