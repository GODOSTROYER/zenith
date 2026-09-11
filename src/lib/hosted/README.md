# lib/hosted — the hosted-apps subsystem

The second product in this repository: private apps, built from a pinned
recipe, served on `<slug>.<ZENITH_APP_DOMAIN>`, behind a grant list that is the
only authority on who may open them. It is ~103 files and about a fifth of
`src`, and it shares nothing with the infrastructure product except the process
and the data directory.

Its own store is `<ZENITH_DATA>/control.sqlite`, reached only through
`authority/` — or the `hosted` schema of a Supabase Postgres project when
`ZENITH_HOSTED_STORE=postgres`, which is the same interface over
`authority/pg/**` and is what a serverless deployment runs on. That one flag
also moves the per-app data plane (`data/`) and the artifact store
(`artifacts/`); the operational side of it — schema, variables, cut-over,
troubleshooting — is
[docs/HOSTED-POSTGRES.md](../../../docs/HOSTED-POSTGRES.md). Nothing here writes
to `.data/state.json`, and nothing in `src/lib/db` knows this directory exists.
Longer prose:
[docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md); the layer rules:
[docs/MODULE-MAP.md](../../../docs/MODULE-MAP.md); the decisions this code
cites by number (`R3-*`, `G*`): [docs/hosted/](../../../docs/hosted/).

## The three loose files

`config.ts` validates every `ZENITH_*` variable in one place, the same
discipline `@/lib/env` applies to `ZENITH_*`; secrets are presence-only here
and read at exactly one call site each. It must not read the store or decide
policy. `digest.ts` is the one SHA-256 and tree-digest rule, so a source, an
artifact, a bundle and an intent cannot drift apart in how they are named; it
must not know what it is hashing. `edge.ts` runs inside `src/middleware.ts` and
rewrites an app-host request onto the gateway route before the platform session
gate sees it; it runs on the edge runtime, so it must not import `node:`,
`config.ts`, or anything that touches the store.

`index.ts` is the boot entry (below). It must not export anything a route
would import — the barrels below are what routes use.

## The sixteen subdirectories

| Directory | Owns | Must not |
| --- | --- | --- |
| `contracts/` | Types, zod schemas, error codes, host rules, the tracker and source contracts, behind one barrel | Import `node:`, env or any store — this is what the browser fixture and the edge share |
| `authority/` | The control authority: one SQLite file, one connection, `tx()`, the per-table repositories, the outbox | Do any async work inside a transaction, or write to the JSON store |
| `access/` | Who may open an app: grants, invitations, exchange codes, app sessions, the live identity check | Let workspace membership or a JWT claim add or restore a grant |
| `gateway/` | The app host's front door: admission in contract order, reserved routes, the broker surface, artifact serving, the response guard | Touch an artifact's bytes or the app store before admission has finished |
| `artifacts/` | Content-addressed build outputs and the trusted re-hash a release must pass | Mutate a stored artifact — a different byte is a different digest |
| `source/` | The untrusted-input boundary: bounded tar reading, the supported-source contract, materialisation | Execute, install from, or load as configuration anything a builder submitted |
| `build/` | One pinned recipe (`RECIPE_V1`) and three runners: local child process, E2B, Docker | Read a submitted build script or config, or install from the source tree |
| `release/` | Apps, publish jobs, releases, rollback, suspension, and the 250 ms job runner | Move an app off a healthy release before a candidate is built, stored, re-verified and probed |
| `runtime/` | `local` and `cloudflare` behind one `HostedRuntime` interface. The Cloudflare adapter's binding allowlists live in `cloudflare-bindings.ts` and its embedded release worker in `cloudflare-worker-module.ts` | Let a caller branch on which runtime is selected, or claim a capability it has not proven |
| `data/` | The per-app customer data layer — the fixed broker's storage side, on SQLite, D1, or the `hosted.app_*` tables over PostgREST (`pg-backend.ts`) when `ZENITH_HOSTED_STORE=postgres`. `TrackerDataStore` (`tracker-store.ts` + `tracker-rows.ts`) is the reference `AppDataStore`, not the only possible one | Be reachable from app-published code; the app's JS calls the broker over HTTP |
| `quota/` | Requests per app per UTC day, body limits, the enforcement table | Keep a counter in module scope, or decide who the caller is |
| `usage/` | The usage ledger, the spending estimate, the 50/75/90 % alerts and the build pause | Call an estimate a bill, or stop a running app to save money |
| `events/` | Pseudonymous activation and lifecycle events, deduped per logical operation, and the scorecard | Store a subject, or let a recording failure break the request it was recording |
| `health/` | Real health checks and real logs for one app, attributed to the release that served them | Emit `simulated: true`; a probe that cannot run answers `ok: false` with the reason |
| `backup/` | Encrypted off-host backup, clean-host restore, revocation reconciliation, the deliberate reopen step | Reopen an install automatically, or restore in a way that re-admits somebody revoked since the snapshot |
| `export/` | The "you can leave" file: records and access *intent*, in a shape another install can read | Claim an import restored access — every imported grant arrives `needs_reapproval` |

Each of `authority/`, `access/`, `data/`, `gateway/` and `release/` has its own
`README.md` with one line per file.

## Boot order

`src/lib/server/boot.ts` claims the data directory and then calls
`ensureHosted()` from `index.ts` — synchronously, so nothing can read hosted
state through a half-open authority. Verified in both files, the order is:

1. **config** — `assertHostedPreconditions()` calls `hostedConfig()`, which
   validates every `ZENITH_*` variable and throws naming the offender. In
   hosted mode it additionally requires an identity provider and Node ≥ 22.16.
   Hosted mode fails closed: a missing precondition stops the process rather
   than serving a private app on guesswork.
2. **authority** — the one place the implementation is chosen. On SQLite,
   `openAuthority()` opens `control.sqlite`, reads back every pragma, and
   refuses to start on a file that fails `quick_check` rather than replacing it
   with an empty one. On Postgres, `createPostgresAuthority()` is installed:
   `SUPABASE_DB_URL` must be set (checked in step 1, by variable name), and the
   `hosted.schema_migrations` check starts here and is awaited by every later
   read and write, refusing with the migration file named. Both are synchronous
   to build, which is what keeps `ensureHosted()` synchronous.
3. **access** — `registerAccessOutboxHandlers()` registers the invitation-email
   handler.
4. **usage** — `registerOpsOutboxHandlers()` registers the revocation-ledger
   and spending-alert handlers.
5. **release** — `startHostedJobRunner()` starts the 250 ms ticker.
6. **outbox replay** — scheduled on the next tick and `unref`'d, so a slow
   transport never holds boot and never holds the process open. Handlers are
   registered *before* this, which is why a row left `sending` by a dead
   process is drained by the right handler instead of being skipped.

`gateway/` and `runtime/` are deliberately **not** in that list. The gateway is
entered per request, from `src/app/hosted-gateway/[host]/[[...path]]` after
`edge.ts` rewrites; a runtime is selected when a release stages or an app is
created. Neither has boot-time state.

## The HTTP layers

`access/http.ts` and `release/http.ts` are the `/api` layers for the hosted
control routes. Neither directory's barrel re-exports its `http.ts` — the
gateway and the job runner import the barrels and have no business pulling the
request layer in behind them. Those two files are also the repository's three
open import cycles (they reach back into `@/lib/server/context` and
`@/lib/actions/core`); the intended fix is to move them to the server layer.
See [docs/MODULE-MAP.md](../../../docs/MODULE-MAP.md), "Known violations".
