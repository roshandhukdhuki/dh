# Artha Domain Lab

Meaning-first .com research dashboard for English and Nepali words. This repository contains the Cloudflare Worker + D1 application and a separate Python local prototype.

## What works
- Dictionary-backed 4–10 ASCII letter candidates, length and meaning search.
- Industry and personal-brand use-case filters, based on transparent keyword matching.
- Persistent shortlist, shortlist/review/rejected triage stages, rejection reasons, action history and source-review queue.
- Reviewed Nepali definition and romanization approval/rejection.
- Persistent D1 batch leases to avoid duplicate checks, with dated observation history.
- On-demand English Datamuse requests, with English Wiktionary fallback, and small Nepali Wiktionary batches for review.
- Import of dated, manually verified Namecheap observations. Availability is unknown without an observation.

The naming score is a heuristic, not an appraisal, trademark clearance or purchase recommendation. A dictionary definition is not proof of availability. Expiry is not guaranteed deletion. No registrar API, automatic background scheduler, purchase, drop-catching or 24/7 uptime is included. Sanskrit and Sabdasakha are not connected. Nepali source text and romanization require review before promotion.

## Hosted application
The existing deployment is owner-private; its URL is intentionally omitted from public source. Publishing this source does not grant access to its private database or dashboard. The OpenAI authentication gate is enforced by the hosting platform, not this Worker. **Do not deploy the Worker on an unauthenticated public route with personal data.** Configure an appropriate authentication layer before any independent deployment.

## Build and test
Node.js with ES modules, no third-party dependencies:

    npm test
    npm run build

Build emits `dist/server/index.js`. It optionally copies private `.openai/hosting.json` when present; this file is intentionally absent from GitHub. Do not copy secrets or existing hosting identifiers into public source. Hosting setup is not performed by this repository.

Bind a Cloudflare D1 database as `DB` and apply the SQL files in `drizzle/` in lexical order using your authorized deployment mechanism. The Worker serves its embedded HTML and requires DB for API requests. The seed contains public dictionary evidence, not registrar observations or personal shortlist data.

## Local prototype
See `local-prototype/README.md`. Python standard library only:

    cd local-prototype
    python3 -m unittest -v
    python3 app.py --port 8877

Starts an empty local SQLite database. No original private database, old shortlist, personal watchlist or imported observations are shipped. Collection and observation-import scripts are included, but they do not establish an unattended production feed.

## Verification and limitations
On 2026-10-20 the source unit checks and local prototype tests passed. Hosted API loading, dictionary refresh, shortlist persistence, invalid import rejection and request cooldown were tested. The owner authentication gate was later resolved and visual filter tests were completed. Four actual Namecheap observations were imported through the UI; a fifth loading result remained unknown. Live observations and private dashboard data are not included in this source archive. Data feeds can deny or rate-limit requests and source failures must remain visible. Stop affected fetches on denial; do not bypass restrictions.

## Data and security
Definitions retain source attribution in `seed.json`. Read `THIRD_PARTY_NOTICES.md` before redistributing dictionary text. No license to third-party trademarks or domains is implied. Never commit credentials, deployment metadata, database snapshots, historical personal datasets or session tokens. No new open-source license grant for application code is asserted by this repository.

## Visible registrar batch workflow
Use **Reserve next batch** to lease 1–20 names for a visible manual registrar review. **Resume selected batch** reads the saved active lease without reserving more names; **Release selected batch** releases only that batch. Retries use an idempotency ID kept in the browser session. Active, expired and released state is retained in the existing history/lease tables; no migration is needed. No registrar request, purchase or domain reservation is made by these controls. The existing hosting authentication boundary and same-origin write checks remain in place.
