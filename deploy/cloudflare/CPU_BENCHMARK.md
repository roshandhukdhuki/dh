# Local native-profile CPU measurement

Run `npm run benchmark:cloudflare`. It invokes the actual native scheduled handler with local SQLite and synthetic, bounded responses. It performs no network request, authentication grant, cloud operation or private-data access. Each scenario has one initial invocation and 120 subsequent samples. SQL execution CPU is timed separately and subtracted from total process CPU to produce a compute proxy; network and database waiting are not modeled.

Reference run: Node v25.9.0, macOS arm64. These are measurements of that local process, not Cloudflare's runtime or CPU accounting.

| Scenario | Response bytes | First compute proxy | Warm proxy p50 / p95 / max | Max SQL statements | Max requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| Near-cap Nepali dictionary success | 23,718 | 50.612 ms | 0.677 / 1.782 / 3.677 ms | 26 | 1 |
| HTTP 429 with Retry-After | 0 | 1.149 ms | 0.279 / 0.921 / 1.956 ms | 22 | 1 |

First-call total local CPU for the dictionary case was 52.958 ms, including 2.346 ms of SQLite execution. Warm total CPU p95 was 4.660 ms. First-call runtime initialization, garbage collection, asynchronous crypto and SQL timing differ from a hosted Worker. Subtraction cannot turn these measurements into production CPU evidence.

The initial dictionary invocation exceeded Cloudflare's documented [10 ms Free CPU budget](https://developers.cloudflare.com/workers/platform/limits/) in this proxy. Warm measurements justify a bounded cloud canary, **not a Free-capacity promise or production cutover**. The response bounds and one-job limit must remain in place during that canary.

Before activation, the authorized operator must measure actual cold and warm cron and owner HTTP CPU on the new private Worker, including signature verification, near-cap parsing, source failures and recovery. Inspect exceeded-CPU outcomes and D1 row metrics as well as percentiles. Keep headroom below the limit. A canary that fails remains paused while the implementation is optimized; it never authorizes fees or an automatic paid upgrade.
