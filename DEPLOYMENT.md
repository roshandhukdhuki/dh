# Deploying to the existing owner-private stack

This is a deployment plan, not evidence of production deployment. The build and tests run without cloud credentials. Do not deploy to a different service, create an account, widen sharing, generate credentials or enable paid resources as part of these steps.

## Prerequisites and current boundary

1. Identify the existing Site through the authorized Sites connection. Confirm the current user is its owner, its audience remains owner-only, and the same Worker and D1 binding will be updated. Keep the Site ID, private URL and hosting metadata outside the public repository.
2. Verify a supported way to attach native Cloudflare cron to **that existing hosted Worker**. The Sites tool surface supports publication and linked assistant schedules but does not expose a native Worker cron control. Do not put an invented cron capability into the Sites manifest or treat a linked assistant automation as a four-minute Worker trigger. The inactive external-runner implementation below is an alternative, but activation is blocked until production service authentication is documented and approved. A separate assistant task remains a distinct workflow.
3. Verify the existing account's plan, remaining quota, billing and runtime CPU before enabling unattended runs. This application does not authorize charges or a plan upgrade. Cloudflare documents [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Tests count SQL calls against the Free 50-query invocation ceiling; local SQLite tests do not prove hosted CPU, D1 or billing behavior.
4. Obtain a platform-supported private backup/restore point through the existing operator before an approved database upgrade. Do not export private data into the public checkout or use a new database in place of the live one.

## Prepare and validate

Run `npm test` and `npm run build`. Review the diff for credentials, private URLs, hosting IDs, personal history and accidental database files. The optional local fixture preview is a testing aid only; it must not be described or deployed as live discovery.

Use the host's existing source publication workflow. Retain its project identity and access policy, publish the exact reviewed commit, and use the owner-private deployment operation. The public GitHub repository is source delivery; a GitHub push does not deploy this Site. No automatic deployment workflow is added here.

## Additive migration

The old journal ends at `0005_exact_sources`. Verify the actual deployed journal before proceeding. Apply only pending `0006_autonomous.sql` with the existing migration runner; do not replay the historical provenance updates, drop tables, reset D1 or run a seed import.

The new migration keeps words, favorites, triage, reviews, manual leases, observations and earlier history. It copies legacy meanings into separately marked history and records legacy observations in the append-only event table. It creates source health, job leases, runs, events and structured dictionary records. New control state is paused and provider checks are disabled. Test the same upgrade on a non-production database containing synthetic records before authorizing a production migration. Local tests include rollback on a simulated migration failure.

Read back counts and representative existing observations, saved names, decisions and active manual leases after the upgrade. Stop if the deployed journal or binding does not match expectations. Recover through the existing operator's restore mechanism; do not reset the database. Rolling application code back can leave the additive schema intact, but old code using positional inserts into expanded tables must not be redeployed without a compatibility review.

## Runtime configuration

Configure values through the existing host's supported environment/secret controls. `.env.example` documents names only; it is not a credential source.

| Setting | Meaning |
| --- | --- |
| `ACCESS_MODE=platform` | Use the existing platform authentication boundary. |
| `PRIVATE_DEPLOYMENT_CONFIRMED=true` | Set only after verifying unauthenticated visitors cannot reach HTML, scripts or APIs. This flag itself is not authentication. |
| `SCHEDULER_ENABLED=true` | Allows due work once database control is resumed. It does not provision a schedule. Leave false during deployment validation. |
| `EXTERNAL_SCHEDULER_ENABLED=true` | Separately opts into the protected external tick endpoint; leave false until production service authentication and external access are approved. |
| `LOCAL_DEV` | Local loopback preview only. Never enable in the hosted deployment. |

Add `*/4 * * * *` through the verified native cron control; the [configuration fragment](deploy/cron.fragment.jsonc) is for the existing operator, not a standalone deployment. Cloudflare cron runs in UTC and changes can take time to propagate: [official cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

The handler uses a 90-second execution lease, a 25-second wall-time budget, up to three sequential jobs, at most ten entries per dictionary page and five domains per provider job. Upstreams have eight-second timeouts and bounded response bodies. The source cooldown is at least four minutes; Retry-After takes precedence. A finished corpus scan waits seven days before rescanning; exact revision and domain keys prevent duplicate discoveries. Failed jobs remain visible after three attempts. Denials block the source. Pause invalidates the lease; late results cannot commit. Cancellation cannot retract a read request already sent.

Keep logs free of full outgoing registrar URLs: Namecheap's documented GET authentication carries credentials in the query string. The adapter never persists or returns that request URL or raw error text. Verify the hosting account does not capture credential-bearing outbound URLs before enabling it.

## External cloud runner alternative: prepared, inactive

The repository includes [a GitHub Actions template](deploy/github-scheduler.workflow.yml), [a one-shot runner](scripts/cloud_tick.py), a protected `/api/engine/tick` endpoint and a minimal `/api/engine/status` readback. This keeps execution in cloud infrastructure and data in the same private Site/D1. No browser timer or local process is part of this design.

**Authentication is the current exact prerequisite.** Before activation, the hosting provider must document and supply an approved production service identity/credential for unattended access to this existing owner-private Site, its allowed operations, lifetime and revocation mechanism. No such production scope is established by this repository. A temporary `get_site`, testing, or Sign-in-with-ChatGPT bypass token must not be copied into GitHub Secrets or repurposed for production. The runner's header transport is implemented, but it does not establish the suitability of a credential. Do not generate or rotate one here.

If that supported production mechanism is available, obtain explicit action-time approval before granting ongoing Site access to GitHub Actions or storing any credential. The review must identify this repository and Site, allowed reads/writes, credential scope, duration, revocation and billing. The prepared activation sequence is:

1. Deploy this code and the additive migration privately, with scheduler controls paused and both scheduler flags false. Verify private access, existing records and the operator's plan/quota.
2. After the production-auth review and explicit approval, configure `ARTHA_SITE_ORIGIN` and `ARTHA_PRODUCTION_SERVICE_TOKEN` through GitHub Secrets, never files or command arguments. Set `ARTHA_PRODUCTION_AUTH_APPROVED=true` only after the documented production scope is established. These are runner settings, separate from registrar credentials.
3. Enable the two scheduler flags in the existing Site's authorized runtime configuration and resume discovery through its visible control. Copy the inactive template to `.github/workflows/artha-cloud.yml` on the reviewed default branch, then set `ARTHA_ENABLE_SCHEDULER=true` as a repository variable. The template does nothing unless this variable is explicitly enabled. It has no PR trigger, uses a pinned checkout action with persisted Git credentials disabled, and uploads no artifacts or caches.
4. Exercise one approved `workflow_dispatch`; verify its exact run ID is persisted and read back. Then verify a real scheduled GitHub event and the Site's recorded external request. Native cron, external schedule requests and manual dispatches have separate provenance; none is silently relabeled as another. Disable the workflow/variable and Site flag to stop external requests; database pause also prevents work.

GitHub's [schedule contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) has a five-minute minimum and can delay/drop invocations; inactive public-repository schedules can disable after 60 days. The template uses minutes 2, 7, …, 57 to avoid the hour boundary. It cannot promise exact four-minute delivery or perpetual uptime. The database's due time, leases and retry state remain authoritative after delayed/missed ticks. Standard runners for public repositories are currently [free under GitHub's published billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions), but verify the actual account configuration before enabling anything; no paid runner is requested.

If production service authentication is unavailable, leave this alternative inactive. The minimum remaining scheduler prerequisite is either the existing host's supported native cron control or its documented production service-access mechanism plus explicit approval of the external grant. Do not make the Site public, use a testing token, or invent an authentication route to remove that boundary. Registrar availability still remains unconfigured independently.

## Visible manual batch workflow

The dashboard includes a 1–20-name **Reserve next batch** control, retained active/expired/released state, a selected-batch view and explicit resume/release buttons. Reservation uses a browser-generated idempotency ID, so retrying an uncertain response cannot allocate another batch. Refreshing or resuming reads the saved lease; it does not reserve again. Domain-level leases and automatic jobs exclude each other. Releasing an old batch cannot release a newer lease on the same domain. The control makes no external registrar call and implies no availability result. Test this workflow in the local fixture preview before any approved private deployment.

## Optional registrar activation

Discovery can run with availability unknown. Do not enable registrar checking until all prerequisites are explicitly authorized and verified:

- Namecheap production API eligibility and terms accepted by the account holder. Its [API FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/) specifies eligibility alternatives, no additional reseller API fee, prohibition on drop catching, and limits of 50 calls/minute, 700/hour and 8,000/day across the whole key. Do not spend money to qualify without approval.
- An already-authorized key and username supplied through host secret bindings, plus a verified whitelisted static IPv4 route. A `ClientIp` parameter does not give an ordinary Worker static egress. Do not whitelist a random Worker IP or create a proxy/account here. [Namecheap setup](https://www.namecheap.com/support/api/intro/) and [global parameter requirements](https://www.namecheap.com/support/api/global-parameters/).
- Configure `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_CLIENT_IPV4`, `NAMECHEAP_ENVIRONMENT=production`, `NAMECHEAP_ACCESS_APPROVED=true` and `NAMECHEAP_EGRESS_CONFIRMED=true` only after the above review. The final two values are operator attestations, not proof generated by the app. Reserve a budget within the shared key's other usage.
- Exercise an approved small official lookup, read back its persisted observation and confirm redacted logs before unattended operation. Unit fixtures are not this verification. `domains.check` supports up to 50 names, but the scheduler uses at most five. Its [response contract](https://www.namecheap.com/support/api/methods/domains/check/) does not supply standard registration price, currency or duration; those fields remain null. Sandbox results stay explicitly sandbox-only and never enable production scheduling.

No authorized provider credentials or proven static egress are bundled. No other registrar connection is assumed. Manual dated Namecheap imports remain available without API access.

## Verification after an approved deployment

Confirm private HTML, script and API access, the existing D1 binding, migration version and preserved records. Enable the scheduler and resume discovery while keeping provider checks off. Exercise one bounded writer through the intended authorized access and read back its jobs, source revisions and cursor. Verify a real native scheduled invocation appears in both platform cron events and `last_scheduled_at`; the dashboard must show its last run and next eligible work. Inspect CPU, SQL counts, errors and quota. A manual run cannot establish unattended scheduling, and a recent event is not an uptime guarantee.

Verify pause, resume, cancellation, one source failure and recovery without changing the audience. Enable registrar checks separately only after their prerequisites and action-time approval are met. Keep the Mac off the production execution path: the cloud trigger and D1 must continue to operate without this checkout or a browser remaining open.
