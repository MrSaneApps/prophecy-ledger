# AGENTS.md — The Prophecy Ledger

Read this file before changing the project.

## Product boundaries

- Assess public statements and evidence, never character, motive, sincerity,
  salvation, prophetic office, fraud, or divine causation.
- AI may draft; only two distinct matching human reviews can publish an
  adjudication. Community submissions add evidence, not votes.
- Preserve exact quotations, source dates and URLs, deadlines, evidence roles,
  contemporaneous-information search receipts, and append-only history.
- Keep outcomes and prior-information novelty separate.
- Non-falsifiable, pending, and undetermined statements never count as misses.
- Partial outcomes count as misses in the primary strict score.
- Preserve every source-bound version and every stated element. Correlated
  statements may share a scoring cluster only to prevent repetition from
  inflating the denominator; never synthesize a stronger composite prophecy
  from selected fragments across sources or discard details that failed.
- If an original source is removed, preserve its claim record, archived words,
  source metadata, and append-only review history. Mark only the original link
  unavailable and record the disappearance without inferring motive.
- Candidate first-party accounts require moderator confirmation.

## Operating boundaries

- Canonical machine is the Mac Mini. Build, test, and browser-QA there only.
- The live noindex MVP uses Cloudflare Pages plus a separate Queue-producing and
  Queue-consuming Worker. Public Pages has no Queue binding.
- Public `/api/intake` is save-only: it records a normalized video link as
  `pending_identity`. It must not dispatch work or attach an unconfirmed video
  to a person's public profile.
- Scanner admin routes are bearer-token gated. Never commit, print, log, or
  expose `SCANNER_ADMIN_TOKEN` or reviewer credentials.
- `SCAN_ENABLED=0` is the safe default. It blocks scheduled scans; a deliberate
  secret-gated manual start is still required for a canary or full run.
- The deployed Queue consumer uses `max_concurrency=5`. Change that only with a
  new bounded-load receipt; never enable scheduled scanning as a side effect.
- Never scrape captions, mirror video/audio, bypass platform access controls, or
  treat missing transcript text as a claim. For a trusted public YouTube source,
  Gemini may generate a transcript through Google's documented API. Store it in
  private R2, label every section `GEMINI-GENERATED, NEEDS HUMAN CHECK`, and keep
  the body and raw model output off public APIs.
- Workers AI may turn first-party titles/descriptions into neutral possible-claim
  leads only. Description text is never an exact quotation or a rating.
- Exact claim extraction requires a private quality-labeled artifact and a quote
  that occurs uniquely in it. Clip bounds are approximate locators, not exact
  word timestamps. A rating still requires two distinct matching authenticated
  human reviews.
- Do not collect donations or claim nonprofit status. Keep the preview noindex
  until public indexing is explicitly approved.
- Use numbered D1 migrations and keep ledger/review rows append-only.
- Keep the five standard docs current. Do not create orphan documentation.
- Prefer Node built-ins and small Pages Function modules.
- Tests must be green before completion is claimed.
- Do not commit or push unless the user explicitly asks.

## Public repository boundary

- The repository's software is licensed under `AGPL-3.0-or-later`; keep the
  package metadata and `LICENSE` file aligned.
- Third-party quotations, source excerpts, names, titles, URLs, and other source
  material remain subject to their owners' rights and are not relicensed by the
  software license.
- Private transcripts, raw model output, reviewer identities and records,
  database dumps, secrets, and operational receipts must stay out of Git.
- The Prophecy Ledger and SaneApps names, logos, and visual identity are not
  licensed for reuse. Forks must use distinct branding and must not imply
  endorsement.
- Keep maintainer-only research and handoff state in ignored `.codex/` and
  `SESSION_HANDOFF.md` paths. Durable public decisions belong in the standard
  project documentation without live run identifiers or private artifact paths.
