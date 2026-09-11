# Hosted apps on Supabase Postgres — runbook

How the hosted-apps subsystem (product B, `src/lib/hosted/**`) runs against a
Supabase project instead of local files: what lives where, which variables
select it, how the schema is applied, how to check it, how to cut over and how
to go back.

Product A's own store (`ZENITH_STORE`) is a separate decision with its own
section in [RUNNING.md](RUNNING.md), "Running on Vercel with Postgres". The two
are independent flags; this document covers the hosted side and says where they
touch.

Everything below is read off the code as it stands. Where a step is manual, it
is manual because the code refuses to do it, and the refusal is quoted.

---

## 1. What lives where

One Supabase project holds four separate things.

| Where | Holds | Reached by | Applied by |
| --- | --- | --- | --- |
| `public.*` (19 tables) | Product A's system of record: workspaces, members, projects, environments, revisions, deployments, alerts, audit, secrets | `src/lib/db/postgres-store.ts` over PostgREST as the service role | `supabase/migrations/0001_system_of_record.sql` |
| `hosted.*` — the control schema (16 tables) | The hosted control authority: `apps`, `app_grants`, `app_invites`, `invite_deliveries`, `app_sessions`, `app_exchanges`, `hosted_jobs`, `hosted_outbox`, `artifacts`, `releases`, `quota_counters`, `usage_ledger`, `revocation_ledger`, `backup_manifests`, `hosted_events`, plus `schema_migrations` | `src/lib/hosted/authority/pg/**` over a **direct Postgres connection** (postgres.js, through Supavisor) | `supabase/migrations/0002_hosted_authority.sql` |
| `hosted.*` — the per-app data plane (`app_records`, `app_writes`, `app_storage`, plus the functions `hosted.app_record_insert_within_quota` and `hosted.app_storage_add`) | Each hosted app's customer records — what one SQLite file per app held before | `src/lib/hosted/data/pg-backend.ts` over **PostgREST** as the service role | `supabase/migrations/0003_hosted_app_data.sql` |
| Storage bucket `zenith-artifacts` | Published build outputs, content-addressed: `sha256/<digest>/manifest.json` and `sha256/<digest>/files/<path>` | `src/lib/hosted/artifacts/storage-store.ts`, service-role HTTP against `/storage/v1/…` | created by hand in the dashboard |

Two consequences worth keeping straight:

- The control authority does **not** go through PostgREST. It speaks Postgres
  directly, so the Data API's "exposed schemas" setting is irrelevant to it.
  The per-app data plane *does* go through PostgREST, and is not reachable
  until `hosted` is exposed (§4).
- Both `hosted.*` groups live in one schema and are applied by two different
  files. `0002` and `0003` each `create schema if not exists hosted` and each
  carry their own grant block, so either order works.

Row-level security is **on** for every table in `public` and `hosted`, with no
policies defined. The service role bypasses RLS and is the only identity that
ever reaches these tables; `anon` and `authenticated` see nothing. The browser
never talks to PostgREST for either product.

---

## 2. Environment variables

| Variable | What it selects | Default |
| --- | --- | --- |
| `ZENITH_STORE` | `file` \| `postgres` — product A's store (`src/lib/db/store.ts`). Independent of the hosted flag | `file` |
| `ZENITH_HOSTED_STORE` | `sqlite` \| `postgres` — the hosted subsystem. One flag switches three things at once: the control authority, the per-app data plane and the artifact store | `sqlite` |
| `SUPABASE_DB_URL` | The Supavisor **transaction-mode** pooler URI (port 6543) the control authority connects through | unset |
| `ZENITH_ARTIFACT_BUCKET` | The Storage bucket published artifacts live in when the hosted store is `postgres` | `zenith-artifacts` |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL. Used by the per-app data plane and the artifact store (and by product A). **Build-time** | unset |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only. The identity the per-app data plane and the artifact store use | unset |
| `CRON_SECRET` | Bearer token for `/api/internal/keepalive` and `/api/internal/tick/*` | unset |

### `ZENITH_HOSTED_STORE=postgres` — what it actually switches

- `src/lib/hosted/index.ts` installs `createPostgresAuthority()` instead of
  opening `<ZENITH_DATA>/control.sqlite`.
- `src/lib/hosted/data/open.ts` opens `PgDataBackend`/`PgTrackerStore` for an
  app's records instead of a per-app SQLite file.
- `src/lib/hosted/release/deps.ts` and `gateway/deps.ts` publish to and serve
  from `StorageArtifactStore` (the bucket) instead of `FsArtifactStore` (the
  artifact directory).

### `SUPABASE_DB_URL`

It must be the **transaction-mode pooler** string on port 6543, not the direct
5432 host. Three settings in `authority/pg/client.ts` follow from that, and all
three are correctness, not tuning:

- **`prepare: false`.** Transaction-mode pooling hands the next transaction a
  different backend connection, so a named prepared statement created on one is
  absent on the next (`prepared statement "s1" does not exist`). Parameters are
  still sent out of band, so nothing about injection changes.
- **`max: 1`.** A serverless invocation serves one request and freezes. A pool
  of ten would hold ten pooler slots this instance is not using while other
  instances wait; on the free tier's pooler budget that is the difference
  between slow and "no connections available".
- **A short `idle_timeout` (20 s) and a finite `connect_timeout` (10 s).** A
  frozen instance cannot close anything, so the connection gives itself up
  before the pooler's own cutoff; and a connection attempt that is still
  waiting after ten seconds is a failure worth reporting rather than a hang.

The URL **carries the database password**. `src/lib/env.ts` validates it for
shape and never reads its value; a validation failure prints only its length.
The driver's notice logging is silenced so the host never reaches stdout. On
Vercel, set it as a **Secret** (Sensitive) environment variable, and never paste
it into a shell that is recorded, a log or an issue. `Authority.path` on the
Postgres authority is `postgres://<host>/<database>` — no user, no password —
which is what diagnostics print.

---

## 3. Applying the migrations

**The application never applies DDL against Postgres.** From
`authority/pg/index.ts`: this process runs as a serverless function that can
start a hundred copies of itself in a second, and a hundred copies racing
`CREATE TABLE` against a free-tier pooler is not a migration strategy. So every
file is applied by hand, deliberately, by whoever owns the project.

Apply in order, in the Supabase dashboard's SQL editor (or with `psql` against
the project):

1. `supabase/migrations/0001_system_of_record.sql` — needed only if
   `ZENITH_STORE=postgres`.
2. `supabase/migrations/0002_hosted_authority.sql` — the control schema.
3. `supabase/migrations/0003_hosted_app_data.sql` — the per-app data plane.

Rules that hold for all three:

- **Each is idempotent.** `create schema / table / index if not exists`,
  `create or replace function`, and `on conflict do nothing` for the
  `hosted.schema_migrations` seed. Re-applying one is a no-op, so a partial run
  is finished by running it again.
- **Never edit a file that has been applied.** `authority/schema.ts` and the
  migration file are the same schema written twice; a change is a *new* version
  added to both, never an edit to a shipped one.
- **Each must include its `service_role` grant block**, and each already does:
  `grant usage on schema …`, `grant select, insert, update, delete on all
  tables`, `grant usage, select, update on all sequences`, plus the matching
  `alter default privileges` so a table added later is covered. `0003`
  additionally grants `execute` on its two functions. A new migration that adds
  a table to `hosted` must repeat that block, or the service role will not be
  able to read the table it just created.

### The Data API exposed schemas

PostgREST serves only the schemas listed under **Settings → API → Exposed
schemas**. `hosted` must be added there. Without it every request from
`PgDataBackend` answers `PGRST106`, which the backend turns into a
`runtime_unavailable` refusal naming this step. The control authority is
unaffected — it does not use PostgREST.

### The artifact bucket

Create `zenith-artifacts` (or whatever `ZENITH_ARTIFACT_BUCKET` names) by hand,
and make it **private**. Nothing in the code creates it. Every read and write is
a service-role request; nothing is served to a browser directly — the gateway
reads the bytes and serves them itself.

---

## 4. The boot schema check

Two refusals guard a Postgres hosted install, and both name the variable or file
to fix.

**No URL.** `assertHostedPreconditions()` in `src/lib/hosted/index.ts` checks
before anything opens:

> ZENITH_HOSTED_STORE=postgres needs a database to connect to, and
> SUPABASE_DB_URL is not set. Fix: set SUPABASE_DB_URL to the Supavisor
> transaction-mode pooler URI (port 6543) from the Supabase dashboard, or set
> ZENITH_HOSTED_STORE=sqlite for the embedded control authority.

**Schema behind.** `createPostgresAuthority()` returns synchronously with a
schema check *in flight*: it reads `hosted.schema_migrations` and compares the
newest version in `MIGRATIONS` (today version 2,
`invite-delivery-transport-none`) against what is recorded. Every `tx()` and
every repository call awaits that check before its first statement, so it gates
every read and every write without gating construction. A failure is remembered
and re-thrown to every later caller rather than retried into a storm — the
answer will not change until somebody applies the file.

The refusal is a `HostedError("internal")` reading either

> The hosted control database has no hosted.schema_migrations rows, so its
> schema has never been applied, and this build needs version 2
> ("invite-delivery-transport-none").

or, when some versions are present,

> The hosted control database records schema versions 1, and this build needs
> version 2 ("invite-delivery-transport-none"), which is not among them.

with the fix:

> Apply supabase/migrations/0002_hosted_authority.sql to the Supabase project
> (SQL editor, or `psql` against SUPABASE_DB_URL) and start again. It is
> idempotent, so re-applying it is safe. Nothing was read or written in the
> meantime.

A missing `hosted.schema_migrations` table (`42P01`) is read as an empty list
rather than thrown, so "never applied" produces the message above instead of the
driver's `relation … does not exist`.

---

## 5. Running the live contract suites

There are four live suites. All of them write to a **real** Supabase project, so
each needs `ZENITH_CONTRACT_POSTGRES=1` *plus* the credentials it uses — the
credentials say a project exists, the flag says you meant it. With either
missing the Postgres half skips and the suite still passes on its local
implementation, which is what CI and a fresh clone get.

| Suite | Needs | Writes to |
| --- | --- | --- |
| `tests/db/contract` (product A store) | `ZENITH_CONTRACT_POSTGRES=1`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `public.*` |
| `tests/hosted/authority/contract` | `ZENITH_CONTRACT_POSTGRES=1`, `SUPABASE_DB_URL` | `hosted.*` control tables |
| `tests/hosted/data/pg-contract.live.test.ts` | `ZENITH_CONTRACT_POSTGRES=1`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `hosted.app_records` / `app_writes` / `app_storage` |
| the live block of `tests/hosted/artifacts/storage-store.test.ts` | `ZENITH_CONTRACT_POSTGRES=1`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | the artifact bucket |

```bash
# Product A's store contract. The npm script already serialises the files.
ZENITH_CONTRACT_POSTGRES=1 npm run test:contract

# The hosted control authority, both implementations, same scenarios.
ZENITH_CONTRACT_POSTGRES=1 npx vitest run tests/hosted/authority/contract --no-file-parallelism

# The per-app data plane and the artifact bucket.
ZENITH_CONTRACT_POSTGRES=1 npx vitest run \
  tests/hosted/data/pg-contract.live.test.ts \
  tests/hosted/artifacts/storage-store.test.ts --no-file-parallelism
```

`--no-file-parallelism` matters: these files share one project, and two files
writing the same tables at once turn a contract failure into a scheduling
puzzle. `npm run test:contract` is `vitest run tests/db/contract
--no-file-parallelism` for exactly that reason.

**Every row a run writes is namespaced and deleted afterwards.** Ids carry a
`contract-<random>` prefix minted per process, so two runs against one project
cannot collide; the columns the schema constrains to 64 hex characters
(`artifacts.digest`, `app_sessions.id`, `app_exchanges.code_hash`,
`app_invites.token_hash`, `hosted_jobs.intent_hash`) carry a random hex prefix
instead and are filtered the same way. `afterAll` deletes them in reverse
foreign-key order — and clears `apps.active_release_id` first, because it points
at `releases`. The storage suite writes under a `contract-` key prefix and
removes it. Nothing deletes a row or object it did not mint.

If a run is killed mid-suite it can leave `contract-` rows behind. They are
inert; delete them with the same `like 'contract-%'` filters, in the order
`tests/hosted/authority/contract/_factories.ts` lists.

---

## 6. Cut-over and rollback

The cut-over is a flag. There is no data migration behind it (see below).

1. **Prepare the project.** Apply `0002` and `0003`, add `hosted` to the exposed
   schemas, create the private artifact bucket.
2. **Set the variables on Vercel** (production and preview): `ZENITH_HOSTED_STORE=postgres`,
   `SUPABASE_DB_URL` (Secret), `ZENITH_ARTIFACT_BUCKET` if it is not the
   default, and — if they are not already set —`NEXT_PUBLIC_SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`.
3. **Redeploy.** Environment changes reach running functions only through a new
   deployment, and `NEXT_PUBLIC_*` are build-time.
4. **Verify.** A missing `SUPABASE_DB_URL` stops boot outright; a missing or
   stale schema does **not** — the check is awaited by the first hosted read or
   write, so it surfaces on the first hosted request, with the message in §4.
   So verify by making requests, not by watching the process start:
   - `GET /api/internal/keepalive` with the bearer returns counts (that read is
     product A's store, so it proves `CRON_SECRET` and the project, not the
     hosted flag);
   - `POST /api/internal/tick/jobs` answers `{"pass":"jobs",…}` rather than 401
     or 503;
   - create an app, publish, and open it — the release path exercises the
     authority, the bucket and the per-app tables in one pass.
5. **Rollback is the same flag, flipped.** Set `ZENITH_HOSTED_STORE=sqlite` and
   redeploy. Nothing in Postgres is deleted; the install simply stops reading
   it.

### What is **not** migrated automatically

- **There is no hosted equivalent of `npm run migrate:postgres`.** That script
  moves product A's data (`public.*`) only. Nothing copies
  `<ZENITH_DATA>/control.sqlite` into `hosted.*`.
- **Existing apps, grants, invitations, sessions, releases and jobs do not
  follow the flag.** A SQLite install that flips to Postgres boots against an
  empty control schema: no apps, and every app session ends because the sessions
  table is somewhere else.
- **Artifacts already on disk are not uploaded.** `FsArtifactStore` and
  `StorageArtifactStore` are separate stores; a release whose bytes are only in
  the artifact directory cannot be served from the bucket.
- **Per-app records do not move.** Each app's SQLite file stays where it is.

So a flip in either direction on an install with real apps is a migration
project, not a configuration change. On a fresh install it is one variable.

---

## 7. Free-tier facts

- **A free Supabase project is paused after a week of inactivity**, and a paused
  project is an outage nobody caused. `vercel.json` schedules
  `GET /api/internal/keepalive` daily (`0 6 * * *`); it performs a real store
  read, which on Postgres is a round trip to the project. That is the whole
  point of the route.
- **Vercel Cron on the Hobby plan runs at most once per day**, so it cannot
  drive the background passes. `.github/workflows/tick.yml` curls the four tick
  routes (`engine`, `alerts`, `outbox`, `jobs`) every five minutes — GitHub's
  own floor — on `schedule` plus `workflow_dispatch`. GitHub disables a schedule
  after 60 days without repository activity; if ticks stop, look there first.
- **Pooler slots are the scarce resource.** Hence `max: 1` per instance and the
  20-second idle timeout. When the pooler is out of slots Postgres reports
  `53300`, which `authority/pg/tx.ts` treats as retryable and replays the whole
  transaction after a backoff.
- **Retry is bounded and replay-safe.** `40001`, `40P01`, `53300`, `08006` and
  `08003` are retried; everything else is raised. `08006`/`08003` can in
  principle arrive after a COMMIT was sent and before its acknowledgement, so
  every transaction in the authority is written to be safe to run twice —
  conditional updates, `on conflict do nothing`, idempotency keys. When the
  attempts run out the caller gets `policy_unavailable` and the promise that
  nothing was half-written.

---

## 8. Troubleshooting

| Symptom | Means | Do |
| --- | --- | --- |
| `PGRST106` — "The schema must be one of the following" (surfaced as a `runtime_unavailable` refusal from the per-app data plane) | `hosted` is not in the Data API's exposed schemas | Settings → API → Exposed schemas, add `hosted`. Nothing was written |
| `PGRST205` / `42883` from the same place | The table or the quota/storage function is missing | Apply `supabase/migrations/0003_hosted_app_data.sql` |
| `42P01` — relation does not exist | A migration was not applied (or was applied to the wrong project) | Apply the file the error or the boot refusal names. All three are idempotent |
| Boot refuses: "records schema versions … and this build needs version 2" | `0002` is missing or older than this build | Apply `supabase/migrations/0002_hosted_authority.sql` and restart |
| Boot refuses: "SUPABASE_DB_URL is not set" | `ZENITH_HOSTED_STORE=postgres` with no connection string | Set `SUPABASE_DB_URL` (port 6543), or set the flag back to `sqlite` |
| `53300` — too many connections, usually as `policy_unavailable` after retries | The pooler is out of slots | Retry; check the project's connection count. Confirm nothing runs with a pool larger than 1, and that the URL is the 6543 pooler and not 5432 |
| `40001` / `40P01` — serialization failure, deadlock | Two writers on one row. Already retried with backoff | If it persists, look for a hot row (one app's job queue, one quota counter) rather than tuning the retry |
| `prepared statement "s…" does not exist` | Something is talking to the pooler with named prepares on | The connection must be created through `createPgAuthorityClient()`, which sets `prepare: false`. Check the URL is the transaction pooler |
| **401** from `/api/internal/*` | The bearer did not match `CRON_SECRET` | Make the Vercel variable and the GitHub Actions secret the same value. Vercel attaches the header to its own cron requests automatically |
| **503** from `/api/internal/*` | `CRON_SECRET` is not set on the deployment | Set it and redeploy. The routes run nothing rather than running unauthenticated |
| Object storage refuses with 4xx, or "the project URL and service-role key are not set" | Bucket missing, wrong project, or `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` unset | Create the private bucket, check the key belongs to this project |
| The project is paused | No activity for a week | Resume it in the dashboard and check the daily keepalive cron is still scheduled and authorised |

---

## See also

- [RUNNING.md](RUNNING.md) — product A on Postgres, the tick routes, the full
  environment-variable table.
- [MODULE-MAP.md](MODULE-MAP.md) — which module owns which store.
- [`src/lib/hosted/authority/README.md`](../src/lib/hosted/authority/README.md)
  — the authority interface and the repositories.
- [`src/lib/hosted/authority/pg/repos/README.md`](../src/lib/hosted/authority/pg/repos/README.md)
  — how a Postgres repository is written.
- [hosted/RUNBOOK-DEPLOY.md](hosted/RUNBOOK-DEPLOY.md) — the single-process
  self-hosted topology, which is the alternative to all of the above.
