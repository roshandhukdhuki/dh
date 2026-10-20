# Cloudflare-native private deployment variant

This variant supplies a native `scheduled()` handler and a `*/4 * * * *` UTC cron configuration. It needs no external scheduler grant, service token, browser timer or running development computer. It is prepared code, not evidence of an active deployment. Keep the existing private Site canonical until backup, validation and the authorized cutover finish. Do not deploy this variant over the existing Site through its publication mechanism.

## Private access and configuration

Use only the approved existing Cloudflare account on its verified Free plan. Confirm that Workers, D1, the intended hostname and Cloudflare Access are available without charges or an account upgrade. Stop if the supported setup requires a new account, new persistent credential, permission expansion or payment. Account login/security confirmations belong to the account holder; this repository contains no deployment credentials.

The [example configuration](wrangler.example.jsonc) has placeholder D1 identifiers, no routes, disabled `workers.dev` and version URLs, and discovery disabled. Copy configuration only into a private ignored file; keep account IDs, real owner identity and database exports outside this public checkout. The native build is `dist/cloudflare/index.js`, not the Sites artifact `dist/server/index.js`.

Before enabling a hostname, configure a supported [Cloudflare Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) for the entire hostname and all paths. Allow only the actual owner identity and exclude bypass, public and service-token allow policies. Use an already-controlled hostname. If the authorized operator deliberately selects a [workers.dev hostname](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), protect that hostname with Access before enabling it and bind the exact origin below. Keep version/preview URLs disabled. Check the dashboard settings as well as the configuration file; there must be no alternate unprotected route.

The Worker independently validates the signed `Cf-Access-Jwt-Assertion` for **every** HTML, script and API request. It verifies RS256, the configured issuer and application audience, expiry, owner email and optional owner subject. It fetches bounded public verification keys only from the configured team's documented certificate URL; public keys are cached. It ignores the unauthenticated email header and never accepts Sites testing/bypass credentials. This follows Cloudflare's [JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/). Configuration booleans alone never authorize HTTP requests.

| Setting | Required value |
| --- | --- |
| `DB` | Binding to the approved **new** private D1, never the canonical Site database. |
| `CF_APP_ORIGIN` | Exact HTTPS origin of the protected app, without a path. Requests to another origin fail closed. |
| `CF_ACCESS_TEAM` | Bare team subdomain, without URL syntax. |
| `CF_ACCESS_AUD` | Audience from this Access application. |
| `CF_ACCESS_OWNER_EMAIL` | The verified owner identity allowed by Access. Configure privately. |
| `CF_ACCESS_OWNER_SUB` | Optional verified owner subject pin. Use when available; never invent a value. |
| `CLOUDFLARE_PRIVATE_READY` | Leave `false` until the Access policy, all routes and intended origin are verified; then set `true` through the authorized configuration mechanism. JWT validation still runs. |
| `SCHEDULER_ENABLED` | Leave `false` during setup; approved canary and activation require `true` **and** resumed database control. |

`RUN_PROFILE=cloudflare-free` is forced by the native entry point. Local development access and the external scheduler endpoint are forced off. `/api/engine/tick` is unavailable even to the owner. Registrar automation is hard-disabled, including when credentials or an old database switch are present. Do not configure registrar credentials for this variant. Manual dated observations and visible batch reserve/resume/release remain available to the authenticated owner.

## Build and validate without cloud changes

```sh
npm test
npm run build:cloudflare
npm run benchmark:cloudflare
```

Tests use ephemeral local SQLite and synthetic dictionary/provider responses. They exercise owner JWT checks, all-route denial, cross-origin mutations, issuer key isolation, the native cron handler, the persistent daily cap, pause/cancel fencing, queue evidence gates and migration preservation. No live record or registrar is touched. The benchmark is a local Node CPU proxy, not a hosted Free-tier certification; see [the measurement and acceptance criteria](CPU_BENCHMARK.md).

## Backup, new D1 and migration sequence

1. Through the existing authorized hosting operator, obtain a private backup/export and a tested restore path for the canonical database. Verify its deployed schema/journal and take private counts and representative observations, favorite/reject decisions, reviews, batch request IDs and leases. Never commit the export or read private data through an unsupported route.
2. Prepare the approved new D1 and a private paused Worker. First validate the exact reviewed artifact and all migrations on an empty database with synthetic fixtures. The migration files in `drizzle/` are additive; local tests exercise their order and rollback.
3. Copy the verified backup into the new D1 through the supported private operator mechanism. Preserve its schema and original journal. Apply **only** pending migrations: a database through `0005_exact_sources` needs `0006_autonomous` and `0007_cloudflare_free`; one already through `0006` needs only `0007`. An empty database needs the complete sequence `0000`–`0007`. Never apply historical migrations over an imported current schema or reset/replace the canonical database. Reconcile the host's migration ledger explicitly if its format differs from Wrangler's; do not guess from filenames.
4. `0006` preserves legacy data and manual reservation history, marks historical meanings unverified and starts discovery paused with provider checking off. `0007` adds the persistent native daily budget and status indexes. Read back the private baseline counts and samples from the **new** database and compare every preserved field. Test an existing batch resume without allocating another batch. Stop on any mismatch.
5. Validate unauthenticated and wrong-owner access to `/`, `/app.js`, read APIs and mutation APIs, plus workers.dev, version and any old routes. They must be blocked by Access or disabled, with the Worker also denying requests without a valid owner JWT. Validate a real owner login and origin checks. Keep sensitive HTTP headers and assertions out of logs.
6. Perform an approved bounded cloud canary on the new database, keeping registrar checks off. Inspect real Worker CPU/outcomes and D1 row metrics before cutover. Verify pause, resume, cancellation, crash recovery and one source failure. Confirm a genuine platform cron event and the corresponding stored `last_scheduled_at`, run, source revision and next eligible time. A manual invocation does not prove a scheduler is active.
7. Immediately before the approved cutover, quiesce writes through the supported canonical workflow and refresh/reconcile the copy so newer manual observations are retained. Revalidate counts and samples, then designate the private native app canonical. Keep the original app paused and its backup available for rollback. Do not allow two discovery writers against one database or silently split new research between apps.

Use only the authorized operator's verified deployment mechanism. These steps do not authorize token generation, credential storage, migration or deployment from a development checkout. If private export/restore, owner Access setup, D1 binding or Free CPU validation is unavailable, leave the original Site canonical and the new pipeline paused; report the specific missing prerequisite.

## Bounded execution and Free-plan acceptance

Each due native tick holds the shared execution lease and handles **at most one job**, one dictionary entry and one source request. The source page has a 32 KiB response bound and an 8,000-character wikitext bound. A persistent UTC budget allows at most 360 execution attempts per day, including owner-triggered attempts. Manual requests cannot bypass that budget, lease, source cooldown or job fence. Nepali has preference in two of every three nominal cron slots; English has the third. A source backoff or exhausted corpus can result in no request. An entry can require review or fail the quality/evidence gate; a tick is not a promise of a usable name.

The Free profile's 12-second wall-time guard bounds waiting; it is **not a CPU allowance**. Cloudflare documents a [10 ms Free CPU limit for both HTTP and cron](https://developers.cloudflare.com/workers/platform/limits/) and [50 D1 queries per invocation](https://developers.cloudflare.com/d1/platform/limits/). Waiting on network and D1 is distinct from CPU execution. The local near-cap cron benchmark used at most 26 SQL statements. The light owner dashboard poll runs once per visible minute with indexed recent-run/job queries, avoiding periodic full-corpus counts. Full state, search and imports still consume quota when requested.

Check actual account-wide [D1 row read/write and storage usage](https://developers.cloudflare.com/d1/platform/pricing/), query plans, available cron slots and other workloads before activation. SQL statement counts are not row billing counts, and indexes also cost writes. At 360 ticks/day, jobs, source evidence and audit history continue growing; monitor database size and preserve/export history privately before any approved retention change. There is no automatic destructive history cleanup.

Acceptance requires hosted cold and warm CPU measurements, source success and failure cases, no exceeded-CPU outcomes, and enough headroom below 10 ms for both the scheduler and owner HTTP requests. If CPU, storage or row quotas fail, pause discovery, retain the canonical app and optimize/reduce work; do not upgrade to a paid plan without approval. Quota exhaustion and runtime termination must be treated as outages, not successful discovery. Verify stored jobs/leases recover after termination.

The UI exposes the configured profile, daily attempt count/cap, source health, last/next run, jobs and provider blockers. A recent scheduled event is evidence of one invocation, not an uptime guarantee. Native cron changes can take time to propagate under Cloudflare's [cron contract](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Availability stays unknown until an independently authorized legitimate provider or dated manual observation supplies it.
