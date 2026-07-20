# The Prophecy Ledger

A neutral, evidence-first public record for statements publicly attributed to
God or prophecy. For each claim, the public site answers four questions: what
was said, what happened, what was already publicly known, and what still needs
checking. Internal safeguards remain strict, but reader-facing language stays
ordinary.

A noindex live preview is available at https://prophecy-ledger.pages.dev. The
public site runs on Cloudflare Pages and D1; a separate secret-gated Worker owns
background ingestion. Deployment identifiers and run receipts are maintainer
operational state, not repository documentation.

## Live ingestion system

```text
Pages UI and API -------------------------> shared D1 public catalogue
  `-- save-only video intake                  people, sources, reviews, ratings

secret-gated scanner admin / disabled cron
       -> prophecy-ledger-ingestion Queue
              -> scanner Worker -> shared D1
                    |-> bounded official-site fetches
                    |-> Workers AI neutral description triage
                    |-> direct Gemini public-YouTube transcription
                    |-> Workers AI exact-quote candidate extraction
                    |-> private prophecy-ledger-artifacts R2
                    `-> prophecy-ledger-ingestion-dlq after retry exhaustion
```

The product is a reusable people-first ledger. Troy Black is the first pilot,
using his public `Prophetic Words` website archive as the first dependable
corpus. Source totals are kept separate from linked videos, available
transcripts, possible-claim posts, specific claim candidates, human checks, and
final ratings. Raw posts and videos never enter the accuracy score.

Workers AI may label a first-party title and description as a possible-claim
lead. For a trusted public YouTube source, Gemini 3.1 Flash-Lite may acquire a
private, clip-labeled generated transcript through Google's live API. Workers AI
then proposes exact-quote candidates only when the quote exists uniquely in that
private artifact. The system does not scrape captions or mirror media. Generated
transcripts and candidates remain `needs human check`; publication still
requires two distinct matching authenticated human reviews.

Production reviewer access is an invited-team surface protected by Cloudflare
Access at `/review` and `/api/review/*`. The Pages Function verifies the Access
JWT again and derives a pseudonymous reviewer identity from its issuer and
subject. Migration 0014 adds leased assignments, append-only candidate
promotion/rejection decisions, blinded claim-review work, and idempotent
two-review publication reconciliation. No static production reviewer token is
accepted.

`SCAN_ENABLED=0` is the deployed default, so the daily cron cannot start a scan.
Canary and full runs use a secret-gated manual admin route. The admin token and
reviewer credentials are not stored in this repository.

## Safety and publication state

- The public source browser exposes source metadata and public review material,
  but never transcript bodies, private object keys, raw model output, leases, or
  reviewer identities.
- Public intake is save-only. It records a normalized video ID as
  `pending_identity`, has no Queue binding, and cannot attribute an unconfirmed
  source to a person.
- Generated transcripts and model-proposed candidates remain private and marked
  as needing human review. Two distinct matching authenticated human reviews are
  required before a claim adjudication can be published.
- Live run IDs, database exports, cost receipts, reviewer records, and private
  artifacts belong in ignored maintainer state rather than the public repository.

## What the MVP proves

- Page-by-page, idempotent source discovery with immutable revisions and honest
  blocked/partial-source receipts.
- Separate source, transcript, possible-claim, human-check, and rating counts.
- Neutral AI-assisted triage without AI adjudication.
- Private Gemini-generated transcript acquisition with an eight-hour daily
  reservation cap, bounded five-minute clips, resumable Queue jobs, and explicit
  human-check labeling.
- Separate claim-outcome and prior-public-information analysis.
- A two-human-review publication gate and append-only review/event history.
- A deterministic public PDF export that excludes draft verdicts, private
  artifacts, and reviewer data.

## Troy pilot boundaries

The seed contains selected records, not a complete catalogue:

1. The September 10, 2020 Southeast Asia oil-boom brief records that the
   speaker-authored archive acknowledges the stated timing did not match.
   Independent reporting cites regional 2021 oil-and-gas production falling from
   5.06 to 4.86 million boe/day. The meaning of `oil boom`, geographic scope,
   treatment of gas, original context, and final human review remain open.
2. The December 7, 2021 Russia brief records that the full-scale invasion began
   February 24, 2022, while literal declaration and spring-timing language remain
   unresolved. NATO and Axios published material invasion warnings before the
   claim date. The atomic split, meaning of `full shift`, cutoff-bound receipt,
   original context, and final human review remain open.

The discovery page is titled `All Fulfilled Prophecies`; it is speaker-authored
and outcome-selected, so it can locate statements but cannot establish a complete
track record. Gemini clip boundaries are approximate source locators, not
word-level timestamps. No reviewer identities, verdicts, or completeness claims
are invented.

## Cost controls

The Worker independently caps transcript reservations at 28,800 media seconds
per UTC day. Provider pricing and usage receipts are reviewed as operational
data because preview terms and model prices can change. Cloudflare Workers AI
usage is separately metered and limited to claim extraction rather than
transcription.

## Development

```bash
npm ci
npm run check
npm run dev
```

For the local reviewer mutation demo, run `npm run dev:review` and configure a
different `DEMO_REVIEWER_N_ID` / `DEMO_REVIEWER_N_TOKEN` pair for each principal.
Demo credentials work only on loopback when `REVIEW_DEMO_MODE=1`. Production
uses Cloudflare Access and rejects static bearer credentials. No reviewer token
is stored in this repository.

Apply local D1 migrations before manual API QA:

```bash
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state
```

The scanner has its own `scanner/wrangler.toml`. Do not run its admin routes
without an explicitly supplied `SCANNER_ADMIN_TOKEN`, and do not change
`SCAN_ENABLED` from `0` merely to test configuration. `npm run check` covers the
Pages/API, scanner fetch guards, parsers, Queue leases and retries, AI output
validation, ordered migrations, public source projection, UI, and PDF.

## Preview indexing and security

The preview is intentionally blocked from indexing by the HTML robots meta,
`robots.txt`, and `X-Robots-Tag`. `public/_headers` protects static Pages files;
the root Functions middleware applies the same policy to APIs and PDF downloads.
Before a public launch, remove the three noindex controls deliberately; do not
weaken the security headers. Once a public repository URL exists, add a visible
`Source` link to that exact revision or repository before publishing a modified
network deployment.


## Routes

- `/` — reusable public people directory
- `/people/troy-black` — Troy pilot profile, coverage, sources, and video intake
- `/people/troy-black/claims/southeast-asia-oil-2021` — full oil claim review
- `/people/troy-black/claims/russia-spring-2022` — full Russia claim review
- `/claims/:id` — legacy-compatible claim route
- `/biblical-prophecy` — public Biblical Fulfillment Pattern Study method, examples, and honest audit status
- `/methodology` — plain-language explanation of ratings and track records
- `/privacy` — plain-language public privacy notice
- `/review` — credential-gated reviewer tool
- `/api/people/:slug/report` — public-only downloadable PDF
- `/api/people/:slug/sources` — keyset-paged public-safe source catalogue
- `/api/intake`, `/api/people/:slug`, `/api/claims/:id`, `/api/review/:id`

The Worker's `/admin/health`, `/admin/status`, `/admin/start`, and
`/admin/transcript-canary` routes require the scanner bearer token. They are
operational routes, not public product APIs.

## License and content boundaries

The software in this repository is licensed under the GNU Affero General Public
License, version 3 or any later version (`AGPL-3.0-or-later`). See `LICENSE`.
If you modify the software and make it available over a network, the license's
source-availability requirements apply.

The software license does not grant rights to third-party quotations, source
excerpts, names, titles, URLs, or other source material included for attribution,
research, criticism, or verification. Those materials remain subject to their
owners' rights, and no separate public dataset license is granted here.

Private transcripts, raw model output, reviewer identities and records, and
database dumps are intentionally excluded from the repository and are not
licensed as public code or data. The Prophecy Ledger and SaneApps names, logos,
and visual identity are also excluded from the software license. Forks must use
distinct branding and must not imply endorsement.

See `ARCHITECTURE.md` and `DEVELOPMENT.md` for implementation and testing details.
