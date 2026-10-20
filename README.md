# Artha Domain Lab

A meaning-first .com research dashboard for Nepali and English. The application targets the existing owner-private Cloudflare Worker + D1 stack. The code includes a persistent scheduled pipeline; **this repository does not establish that a cron is deployed or that registrar access is configured**.

## Discovery and research

- Nepali first, then English Wiktionary, with small sequential API requests, cursor continuation, exact revisions, attribution, licenses and retrieval timestamps.
- Genuine definitions and ASCII 4–10-letter domains only, grouped into 4, 5 and 6–10 letters. Dictionary validity is separate from brand suitability.
- Practical Nepali romanization with method, confidence and explicit automated-rule, assistant or owner provenance. Ambiguous spellings stay pending. Practical spellings are neither standardized nor source-attested.
- Separate meaning records preserve multilingual collisions. Historical research remains history; loading the dashboard never reimports the seed as fresh discovery.
- Brand ranking favors short spellings and flags source-marked rare/dated senses and spelling friction. Commonness stays unknown without usage evidence. Pronunciation signals are heuristics. Low-ranked words remain searchable; no automatic shortlist is created.
- Search, pagination, sorting, industry/persona/use-case explanations, favorites, triage reasons and dated availability history.

The persistent engine has one execution lease, idempotent jobs, bounded runs, retries with backoff and Retry-After, source health, pause/resume, cancellation, audit events and crash recovery. Source cursors and results commit in one fenced transaction. Denied sources stop until explicitly retried after access is resolved. A proposed four-minute Cloudflare cron is provided as a configuration fragment, subject to provider and hosting limits.

An inactive GitHub cloud-runner alternative is also implemented. Its five-minute minimum and possible delays differ from native cron. Activation requires documented production service authentication and explicit approval; temporary Sites test/bypass tokens must not be reused. The visible manual batch control supports bounded reservations, saved lease state, resume and release without registrar requests.

## Availability

The Namecheap adapter implements only the official read-only `namecheap.domains.check` command. It is unconfigured by default and requires approved, eligible API access plus verified whitelisted static IPv4 egress. The dashboard accepts switches, not credentials. Sandbox observations are not production availability.

States distinguish unknown, unavailable, manually observed registered, premium, standard registration offer and transient errors. Missing or malformed results never become offers. The adapter records supplied amounts; it does not invent regular prices, currency or registration terms. `Available=false` is recorded as unavailable, since it does not establish registration. Manual, dated Namecheap observations remain supported. There are no purchases, carts, undocumented registrar endpoints, automated CAPTCHA handling or bulk RDAP checks.

No score is a monetary valuation, trademark clearance or guarantee of availability. Expiry is not guaranteed deletion. Final checkout, taxes and any unsupplied renewal details remain unconfirmed.

## Build and test

Node.js 22.13 or later with ES modules and built-in SQLite, plus Python 3 for the optional cloud-runner tests; no third-party packages are needed.

```sh
npm test
npm run build
```

Tests use real local SQLite and controlled source/provider responses. They do not query a live registrar or modify a hosted database. Build emits a self-contained `dist/server/index.js` and the additive migration journal. Optional private `.openai/hosting.json` is ignored by Git; no private app URL or hosting identifier is required in this repository.

For an empty local development database with external traffic disabled:

```sh
npm run dev
```

For a clearly labeled, in-memory fixture preview with no external traffic:

```sh
npm run dev -- --fixtures
```

The local prototype HTML in `local-prototype/static/` is an earlier reference interface, not the autonomous service. No Python application is included in the tracked prototype directory.

## Deployment and data preservation

Read [DEPLOYMENT.md](DEPLOYMENT.md) before deployment. Reuse the existing private Site, Worker and D1 binding. Apply only pending migrations through the authorized deployment mechanism. Migration `0006_autonomous` adds tables and columns, preserves old records, and starts discovery and provider checking paused. Never reset, replace or seed the live database.

A separate [Cloudflare-native Free variant](deploy/cloudflare/README.md) prepares an owner Access JWT gate, a one-job `*/4` cron and a new D1 upgrade path. It is credential-free and inactive. The existing Site remains canonical until the separately authorized backup, private validation and cutover; real hosted CPU testing is required before any Free-capacity claim. Registrar automation stays disabled in that profile.

A new deployment fails closed until its existing platform authentication gate is confirmed. Do not expose this application on an unauthenticated public route. A scheduled handler alone does not provision a cron. Sites-linked assistant automations are distinct from native Worker cron execution.

Datamuse is not used by the autonomous pipeline and no topic matching is claimed. Sabdasakha and Sanskrit remain disconnected. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and source limitations. Do not commit credentials, deployment metadata, database copies, private research, logs or local environment files.
