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
| `public.*` (22 tables) | Product A's system of record: workspaces, members, projects, environments, revisions, deployments, alerts, audit, secrets, and the waitlist queue/admissions/rate limits | `src/lib/db/postgres-store.ts` and `src/lib/waitlist/postgres.ts` over PostgREST as the service role | `supabase/migrations/0001_system_of_record.sql` + `0008_workspace_ownership.sql` + `0009_waitlist.sql` |
| `hosted.*` — the control schema (16 tables) | The hosted control authority: `apps`, `app_grants`, `app_invites`, `invite_deliveries`, `app_sessions`, `app_exchanges`, `hosted_jobs`, `hosted_outbox`, `artifacts`, `releases`, `quota_counters`, `usage_ledger`, `revocation_ledger`, `backup_manifests`, `hosted_events`, plus `schema_migrations` | `src/lib/hosted/authority/pg/**` over a **direct Postgres connection** (postgres.js, through Supavisor) | `0002_hosted_authority.sql` + `0005_pending_invite_uniqueness.sql` |
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
these are correctness, not tuning:

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
4. `supabase/migrations/0004_hosted_app_data_atomic.sql` — atomic create/update
   RPCs when the hosted data plane uses PostgreSQL.
5. `supabase/migrations/0005_pending_invite_uniqueness.sql` — one pending
   invitation per normalized app/address; **reconcile duplicate pending rows
   first — the query and the fix are in §3.1 below**. This also records
   authority migration version 3, which is the version this build refuses to
   boot without.

### 3.1 Before `0005`: reconcile duplicate pending invitations

`0005` creates `app_invites_pending_email`, a unique index on
`(app_id, lower(email))` `where state = 'pending'`, and inserts the version-3
ledger row **in the same transaction**. So if any app has two live pending
invitations for one address, the whole migration rolls back: no index, no
version row. That is deliberate — silently keeping one of two rows would
discard a bearer link somebody is holding — but it means the reconciliation is
an operator decision, taken before the deploy, not during it.

**Step 1 — the check. It writes nothing; run it on its own first.**

```sql
select app_id, lower(email) as address, count(*) as pending
from hosted.app_invites
where state = 'pending'
group by 1, 2
having count(*) > 1
order by pending desc;
```

Expected output on a project that is ready: **`0 rows`** (psql prints
`(0 rows)`; the SQL editor prints "Success. No rows returned"). With `0 rows`,
skip to applying `0005` — nothing below is needed.

**Step 2 — supersede the older duplicates.** Only if step 1 returned rows. Each
group keeps its **newest** invitation pending; every older one becomes
`superseded`, which is a state the schema already has and the access list
already renders. Read it before running it: this is the step that decides whose
link stops working.

```sql
begin;

with ranked as (
  select id,
         row_number() over (
           partition by app_id, lower(email)
           order by created_at desc, id desc
         ) as rn,
         first_value(id) over (
           partition by app_id, lower(email)
           order by created_at desc, id desc
         ) as newest_id
  from hosted.app_invites
  where state = 'pending'
)
update hosted.app_invites as i
   set state = 'superseded',
       supersedes = ranked.newest_id
  from ranked
 where i.id = ranked.id
   and ranked.rn > 1;

-- Re-run the check inside the transaction. Commit only on 0 rows.
select app_id, lower(email) as address, count(*) as pending
from hosted.app_invites
where state = 'pending'
group by 1, 2
having count(*) > 1;

commit;   -- or `rollback;` if that select returned anything
```

Then run step 1 again after the commit and confirm **`0 rows`**, and apply
`0005`.

Three things worth knowing before you run it:

- **The older links stop working.** An invitation that is not `pending` cannot
  be accepted, so anyone holding one of the superseded links needs the newest
  one — or a fresh **Resend** from the app's access list, which mints a new
  token and supersedes whatever is outstanding. The newest link is deliberately
  the survivor: it is the one the last person to act intended.
- **The `supersedes` pointer runs the other way here, and that is fine.** At
  runtime the *new* invitation records `supersedes = <old id>` (one old row per
  new one). A bulk reconciliation cannot do that for a group of three or more,
  so each superseded row instead records the id of the invitation that replaced
  it. The column is provenance — nothing reads it to make a decision — and the
  foreign key and the state CHECK are satisfied either way.
- **`created_at` is ISO-8601 UTC text**, so `order by created_at desc` is
  chronological. `id desc` only breaks a tie between two rows written in the
  same millisecond.

Rules that hold for all migration files:

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
to fix. Stated plainly, because it decides the order of every deploy below:
**this build does not serve a single hosted request until `0005` is applied and
its index verifies.** The check reads `hosted.schema_migrations` for version 3
*and* the definition of `hosted.app_invites_pending_email`; until both are
there, every hosted read and every hosted write fails closed with the message
below. A deploy that ships this build to a project still at version 1 or 2 is a
hosted outage that lasts until somebody runs the SQL — which is why §3.1's
reconciliation and `0005` come **before** the deploy, not after it.

**No URL.** `assertHostedPreconditions()` in `src/lib/hosted/index.ts` checks
before anything opens:

> ZENITH_HOSTED_STORE=postgres needs a database to connect to, and
> SUPABASE_DB_URL is not set. Fix: set SUPABASE_DB_URL to the Supavisor
> transaction-mode pooler URI (port 6543) from the Supabase dashboard, or set
> ZENITH_HOSTED_STORE=sqlite for the embedded control authority.

**Schema behind or drifted.** `createPostgresAuthority()` returns synchronously
with a schema check *in flight*: it reads `hosted.schema_migrations`, verifies
the newest migration's version **and name**, and checks the v3 pending-invite
unique index definition. Every `tx()` and every repository call awaits that
check before its first statement, so it gates every read and every write without
gating construction. A failure is remembered and re-thrown to every later
caller rather than retried into a storm — the answer will not change until
somebody applies or repairs the schema.

The refusal is a `HostedError("internal")` reading either

> The hosted control database has no hosted.schema_migrations rows, so its
> schema has never been applied, and this build needs version 3
> ("one-pending-invite-per-app-email").

or, when some versions are present,

> The hosted control database records schema versions 1, and this build needs
> version 3 ("one-pending-invite-per-app-email"), which is not valid for this build.

with the fix:

> Apply supabase/migrations/0002_hosted_authority.sql through
> supabase/migrations/0005_pending_invite_uniqueness.sql in order (SQL editor,
> or `psql` against SUPABASE_DB_URL) and start again. Re-applying the
> idempotent migrations is safe; reconcile duplicate pending invites before
> 0005. Nothing was read or written in the meantime.

"Reconcile duplicate pending invites before 0005" in that fix is **§3.1** above:
the check, the supersede statement, and the `0 rows` it must print before `0005`
will commit.

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

0. **Pre-deploy check — before anything is deployed or flipped.** Run §3.1
   step 1 against the project. It must print **`0 rows`**; if it does not, run
   §3.1 step 2 and re-check. Then apply the migrations, `0005` included, and
   confirm it committed:

   ```sql
   select version, name from hosted.schema_migrations order by version;
   -- must include: 3 | one-pending-invite-per-app-email
   select indexdef from pg_indexes
    where schemaname = 'hosted' and indexname = 'app_invites_pending_email';
   -- must return one row
   ```

   This step is first because the build refuses every hosted request until both
   of those are true (§4). Deploying before it is an outage, not a slow start.
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

### How deployments advance, per host

`ZENITH_STORE=postgres` turns the engine's 250 ms ticker **off**: `db()` reads a
snapshot loaded before the caller ran, a timer callback has no caller, and an
unprimed read is a fault rather than an answer from the wrong authority. Boot
skips the durable catch-up (`resumeInFlight`, the outbox replay, the alert
evaluator) for the same reason. So "what advances a deployment" depends on the
host, and there are only two answers:

| Host | What ticks | You must schedule |
| --- | --- | --- |
| **Serverless** (Vercel — the topology this document is written for) | nothing in-process; `nudge()` advances a watched deploy on the request path | **yes** — `/api/internal/tick/{engine,alerts,outbox,jobs}` with the bearer. That is `tick.yml`'s job |
| **Long-lived** (Docker, a VM, `npm start`) | the **in-process scheduler**: `startCronScheduler()` (`src/lib/server/cron.ts`), started by `boot()` — an unref'd 2 s interval running the engine pass every tick and the alerts and outbox passes every eighth, each inside `inCronScope()`, single-flight. The hosted publish-job runner keeps its own 250 ms ticker (`ensureHosted()`), because it reads the authority rather than the product snapshot | no — optional. The same passes, so pointing cron at the routes as well is safe |

Boot says which one this process has, in one line:
`{"msg":"durable catch-up deferred to the scheduler","scheduler":"in-process"}`.
`"external"` means this process starts no timer, so something else must call the
routes — if you see `"external"` on a host you expected to tick itself, check
`ZENITH_SERVERLESS`/`VERCEL` in its environment. **Run one process per install
either way:** two long-lived copies are two schedulers, and cross-instance
leases for the engine do not exist yet.
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
| `42P01` — relation does not exist | A migration was not applied (or was applied to the wrong project) | Apply the file the error or the boot refusal names. The migration files are idempotent |
| Boot refuses: "records schema versions … and this build needs version 3" or reports a missing pending-invite index | `0002`–`0005` are missing, the migration ledger name is wrong, or the v3 index definition drifted | Run the §3.1 check, supersede any duplicates it finds, then apply `0002` through `0005` in order and restart. Every hosted request fails closed until this is done |
| `0005` fails with `could not create unique index "app_invites_pending_email"` / `duplicate key value` | Two or more live `pending` invitations share one `(app_id, lower(email))`. The whole migration rolled back — no index, no version row | §3.1: run the check, then the supersede statement, then re-run the check for `0 rows` and apply `0005` again |
| Boot refuses: "SUPABASE_DB_URL is not set" | `ZENITH_HOSTED_STORE=postgres` with no connection string | Set `SUPABASE_DB_URL` (port 6543), or set the flag back to `sqlite` |
| `53300` — too many connections, usually as `policy_unavailable` after retries | The pooler is out of slots | Retry; check the project's connection count. Confirm nothing runs with a pool larger than 1, and that the URL is the 6543 pooler and not 5432 |
| `40001` / `40P01` — serialization failure, deadlock | Two writers on one row. Already retried with backoff | If it persists, look for a hot row (one app's job queue, one quota counter) rather than tuning the retry |
| `prepared statement "s…" does not exist` | Something is talking to the pooler with named prepares on | The connection must be created through `createPgAuthorityClient()`, which sets `prepare: false`. Check the URL is the transaction pooler |
| **401** from `/api/internal/*` | The bearer did not match `CRON_SECRET` | Make the Vercel variable and the GitHub Actions secret the same value. Vercel attaches the header to its own cron requests automatically |
| **503** from `/api/internal/*` | `CRON_SECRET` is not set on the deployment | Set it and redeploy. The routes run nothing rather than running unauthenticated |
| Object storage refuses with 4xx, or "the project URL and service-role key are not set" | Bucket missing, wrong project, or `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` unset | Create the private bucket, check the key belongs to this project |
| The project is paused | No activity for a week | Resume it in the dashboard and check the daily keepalive cron is still scheduled and authorised |

---

## 9. The `agent` schema — migrations `0006` and `0007`

The linked-agent feature adds one schema, `agent`, with its own migration
ledger. It is deliberately not `hosted.*`: that schema is gated by the hosted
boot check, which refuses every request below version 3, and an agent-link
outage must not be coupled to a hosted-apps migration. It is deliberately not
`public.*` either: that schema is served by PostgREST and frozen by `0001`,
and nothing in the `agent` schema should ever be reachable over the Data API.

| file | ledger row | tables |
| --- | --- | --- |
| `0006_agent_link.sql` | `1 \| agent-link-v1` | `agent_credentials`, `agent_link_codes`, `agent_rate_limits` |
| `0007_agent_control.sql` | `2 \| agent-control-v1` | `agent_operations`, `agent_operation_events`, `agent_uploads` |

Both create the schema if it is absent, both are idempotent, and both carry the
full `service_role` grant block, so either order applies and re-applying is a
no-op — exactly as `0002`/`0003` already do. They are listed in numeric order
below because that is the order to run them in when you have the choice.

### 9.1 Runbook

Nothing here is run by an agent. Migrations are applied by hand, as §3 requires.

**0. Pre-check.** In the SQL editor:

```sql
select version, name from hosted.schema_migrations order by version;   -- expect 1, 2, 3
select 1 from information_schema.schemata where schema_name = 'agent';  -- expect 0 rows
```

Confirm on Vercel that `ZENITH_STORE=postgres`, `ZENITH_HOSTED_STORE=postgres`,
`SUPABASE_DB_URL` (the 6543 pooler), `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` **and `ZENITH_SECRET_KEY`** are all
set. If `ZENITH_SECRET_KEY` is missing, stop and set it first: the link code's
`secret_ct` is encrypted with it, and every link attempt would answer `503
link_unavailable` rather than storing a token in the clear.

**1. Apply `supabase/migrations/0006_agent_link.sql`.** Verify:

```sql
select version, name from agent.schema_migrations order by version;  -- 1 | agent-link-v1
select count(*) from agent.agent_credentials;                        -- 0
```

**2. Apply `supabase/migrations/0007_agent_control.sql`.** Verify:

```sql
select version, name from agent.schema_migrations order by version;  -- 1, 2
select indexname from pg_indexes where schemaname = 'agent' order by 1;
-- agent_credentials_live, agent_credentials_subject, agent_link_codes_expiry,
-- agent_operation_events_op, agent_operations_leased, agent_operations_pending_expiry,
-- agent_operations_review, agent_operations_scope, agent_rate_limits_bucket,
-- agent_uploads_workspace   (plus the primary-key and UNIQUE indexes PostgreSQL names itself)
select has_schema_privilege('service_role','agent','USAGE');         -- t
```

**Do not add `agent` to Settings → API → Exposed schemas.** Nothing reaches it
over PostgREST — the journal and the credential authority speak direct Postgres
through `postgres.js`, reusing the same `max: 1` pooled client the hosted
authority already holds, so the connection budget does not change. Exposing the
schema would publish credential rows to the Data API surface.

**3. Set two new Vercel variables**, production **and** preview:

```text
ZENITH_AGENT_CONTROL=1
ZENITH_AGENT_ORIGIN=https://tryzenith.cloud
```

Do **not** set `ZENITH_AGENT_WRITES` — it governs the file store only. Do
**not** set `ZENITH_AGENT_CREDENTIAL_FILE` — there is no file authority on
Vercel, and setting it would name a `/tmp` path that no other instance sees.

**4. Add the fifth tick** to `.github/workflows/tick.yml`: `POST
$BASE_URL/api/internal/tick/agent` with the same bearer and the same failure
handling as the other four. It reconciles expired leases to `uncertain`,
expires unreviewed proposals, sweeps link codes and deletes expired uploads —
all bounded, all idempotent.

**5. Redeploy.** Environment changes reach functions only through a new
deployment, and `NEXT_PUBLIC_*` are build-time.

**6. Verify by request, not by boot** — the `agent` schema check is lazy, as
`hosted`'s is. In this order, each before the next:

1. `POST /api/internal/tick/agent` with the bearer → `{"pass":"agent","ok":true,…}`,
   not 401 or 503.
2. `POST /api/agent/link/start` → 201 with an eight-character user code.
3. Open the verification URL signed in — the approval screen renders a
   workspace and at least one project.
4. Approve; the terminal prints the granted scope (never the token).
5. `GET /api/agent/v2/tools` with the bearer lists `zenith_prepare_change` and
   `zenith_execute_operation`.
6. One prepare → browser approve → execute → the simulated deployment moving on
   the canvas.
7. `/integrations` lists the linked agent; Revoke; the next agent call is 401.

**7. Record the run.** Paste the transcripts of step 6 into the PR with their
exit codes. No document may claim a run that did not happen.

### 9.2 Rollback

Three independent levers, smallest first. **Nothing is dropped and nothing is
deleted.**

| symptom | lever | effect |
| --- | --- | --- |
| link or control misbehaving | unset `ZENITH_AGENT_CONTROL`, redeploy | the capability probe answers `control: false`; `/api/agent/v2/*` answers `503 control_disabled` and the link endpoints answer `503 link_unavailable`. Issued credentials stop working; every row stays |
| one agent misbehaving | Integrations → Linked agents → **Revoke** | `revoked_at` is set; effective on that credential's next request |
| the whole feature is wrong | revert the application deployment to the previous one in Vercel | the `agent` schema is simply unreferenced by the old build. No migration runs backwards |

There is deliberately **no down-migration**. `agent.*` is additive, touches
nothing in `public.*` or `hosted.*`, and dropping it would destroy the audit
trail of operations that already ran. If the schema really must go, that is a
separate, deliberate `drop schema agent cascade` by the operator, with its own
runbook entry written first — never part of a rollback.

An operation left `running` when the feature is switched off resolves to
`uncertain` on the next `tick/agent` pass **if** the feature is switched back
on. While it is off the row simply sits there, which is the honest state:
nobody can say what happened to its side effect.

### 9.3 Troubleshooting

| Symptom | Means | Do |
| --- | --- | --- |
| every v2 call answers `503 control_disabled` | `ZENITH_AGENT_CONTROL` is unset, or `SUPABASE_DB_URL` is unreachable, or `agent.schema_migrations` is behind | the message names which. Run §9.1 step 0 and 2's verification queries |
| every link call answers `503 link_unavailable` | `ZENITH_SECRET_KEY` is not set, or the credential authority cannot be reached | set the key **before** the deploy; a link would otherwise have to store a token in the clear, which it will not do |
| `42P01 agent.agent_operations does not exist` | `0007` was not applied, or was applied to a different project | apply it; the file is idempotent |
| an operation sits at `uncertain` | its dispatch could not be confirmed — a killed instance, a lost version guard, or an authority that moved mid-flight | inspect the linked deployment or job on `/integrations`. **Do not** re-run it with a new request key; that is the silent replay this design refuses |
| `zenith_get_capabilities` reports `coordination: "process-gate"` on production | the deployment is running the file store, not Postgres | check `ZENITH_STORE`. The advertisement is truthful by design, so this is the symptom doing its job |

---

## 10. Workspace sharing and waitlist — migrations `0008` and `0009`

Apply `supabase/migrations/0008_workspace_ownership.sql` followed by
`supabase/migrations/0009_waitlist.sql` before deploying the sharing and waitlist
features on a PostgreSQL installation. These migrations extend `public` and do
not change the `hosted` or `agent` migration ledgers.

`0008` adds a durable workspace owner and invitation expiry/revocation fields.
It preserves existing administrator access, chooses a deterministic real
administrator as the initial owner, and gives existing invitations a seven-day
grace period. It revokes duplicate pending invitations while retaining the
newest offer. Membership changes, invitations, acceptance and ownership
transfers run through `public.zenith_workspace_sharing`, serialized on the
workspace row.

`0009` adds the waitlist queue, admission batches and durable rate limits. Queue
joins normalize email addresses and preserve the first submission. Batch
admissions serialize with joins and persist their request key and exact result,
including an empty batch, so retries cannot admit additional people. The
waitlist tables are independent of the product snapshot. No landing-page form
is installed by this migration.

Both migrations expose only service-role RPCs, use `SECURITY INVOKER`, and keep
browser identities away from direct table and function access. Supabase's
`service_role` must retain its `BYPASSRLS` capability. The existing public
PostgREST schema is sufficient; never expose the service-role key to a browser.

The PostgreSQL CI job applies every committed migration and runs the direct-SQL
contracts in `tests/db/contract/workspace-sharing.test.ts` and
`tests/waitlist/pg-contract.test.ts`. Independent connections exercise ownership
and admission races; `SET ROLE` checks use disposable `service_role`, `anon`
and `authenticated` stand-ins. This verifies SQL and application grants; it
does not verify a deployed Supabase project's role graph or PostgREST setup.

## See also

- [AGENT-LINK.md](AGENT-LINK.md) — the linked-agent flow this schema backs, for
  the operator and the user.
- [AGENT-CONTROL.md](AGENT-CONTROL.md) — the capability table that decides
  whether control and writes are available at all.
- [RUNNING.md](RUNNING.md) — product A on Postgres, the tick routes, the full
  environment-variable table.
- [MODULE-MAP.md](MODULE-MAP.md) — which module owns which store.
- [`src/lib/hosted/authority/README.md`](../src/lib/hosted/authority/README.md)
  — the authority interface and the repositories.
- [`src/lib/hosted/authority/pg/repos/README.md`](../src/lib/hosted/authority/pg/repos/README.md)
  — how a Postgres repository is written.
- [hosted/RUNBOOK-DEPLOY.md](hosted/RUNBOOK-DEPLOY.md) — the single-process
  self-hosted topology, which is the alternative to all of the above.
