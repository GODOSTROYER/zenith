# hosted/data — the per-app data plane

One app, one database file, one store object. This directory is the fixed
broker's *storage* side: the half that opens an app's own database, validates
what goes into it, versions it, meters it and refuses the rest. The transport
side — who the caller is, whether the app admits them at all — is `gateway/`,
and nothing here re-does that work.

Two properties this directory holds:

- **An app reaches its own data and nothing else.** No statement in `sql.ts`
  names an app. The only way to reach another app's records is to open that
  app's file with `openAppData()`, so isolation is a file boundary rather than
  a `WHERE` clause somebody could forget.
- **An acknowledged write is durable, and a refused one leaves nothing.** The
  version check, the quota comparison, the write-id ledger and the row itself
  all commit in the same transaction as the write.

`TrackerDataStore` is the **reference `AppDataStore` implementation**, not "the"
store: it serves the equipment-request tracker, the app this pilot ships. A
second app kind means a second store in this directory implementing the same
contract interface, against the same backends — which is why the tracker's
files carry its name.

| File | Owns | Must not |
| --- | --- | --- |
| `index.ts` | The barrel. Wave-2 consumers import `openAppData` and `TrackerDataStore` from here | — |
| `backend.ts` | The two ways a database is spoken to: `SqliteBackend` (local, synchronous, with pragma readback) and `D1HttpBackend` (Cloudflare, batched) behind one `DataBackend` | Let a caller branch on which backend it got |
| `pg-backend.ts` | `PgDataBackend`: the same statements against Supabase Postgres over PostgREST, and `PgTrackerStore`, the tracker's store over it. Selected by `ZENITH_HOSTED_STORE=postgres` | Reach a table without `app_id = eq.<this app>`, or approximate a statement it has no mapping for |
| `app-ops.ts` | `AppDataOps`: the three whole-database operations that are not reads or writes of one record — integrity check, record count, bulk import — implemented once per store (`sqliteOps`, `postgresOps`). What `hosted/health`, `hosted/backup/reopen` and `hosted/export` use through `OpenAppData.ops` | Take an app id per call; a request-time read or write (those belong on `store`) |
| `open.ts` | Opening, caching and closing one app's database, and the disposable test database a candidate is probed against | Hand out a store bound to a different app than the one asked for |
| `schema.ts` | The tracker migrations and the recorded schema version. A rollback target is compared against it | Apply a migration that is not additive — older code has to still read the data |
| `sql.ts` | Every statement, with the CHECK constraints that make the enum casts in `tracker-rows.ts` safe | Name an app in a statement |
| `bytes.ts` | What "logical bytes" means, and the disclosure that says so wherever a quota is reported | Call a logical byte a stored byte |
| `intent.ts` | The canonical hash of a write, so a retried `writeId` carrying different content is refused rather than replayed | Hash anything the caller did not send |
| `tracker-store.ts` | `TrackerDataStore`: *when* a write is allowed — role, version, quota, idempotency — all inside the write's own transaction | Decide who the caller is. Admission is the gateway's job; the role check here is the second line of defence |
| `tracker-rows.ts` | *What* is written and what a stored row means: `insertColumns` (the 17 bound values, in column order), `toRecord`, `roleRank`, the page cursor, and the four refusals the store throws | Touch a backend, a transaction or a role. Everything here is pure |
| `store.ts` | A re-export of `tracker-store.ts`, kept so existing imports resolve | Grow. New code imports the barrel |

`insertColumns` is exported rather than private because `export/index.ts` builds
the same 17-column insert when it imports an app's history; two hand-written
copies of a column order is exactly the drift that puts a record's `neededBy`
into its `version`.

## Two stores, one contract: `ZENITH_HOSTED_STORE`

`sqlite` (the default) gives every app its own file. `postgres` gives every app
its own rows in three shared tables, created once by
`supabase/migrations/0003_hosted_app_data.sql`. `openAppData()` picks between
them; a caller that only uses `.store` cannot tell which it got, because
`TrackerDataStore` and `PgTrackerStore` parse with the same schemas, measure with
the same `logicalBytes()`, hash with the same `writeIntentHash()`, page with the
same cursor and refuse with the same builders in `tracker-rows.ts`.

The isolation property changes shape and must not change meaning. On SQLite an
app reaches only its own data because it opens only its own file. On Postgres
`app_id` is the first column of every primary key, one `PgDataBackend` is bound
to one app id, and every request it builds carries `app_id = eq.<that id>` —
there is no method on it that takes an app id per call.

### `PgDataBackend`: statement → PostgREST

Every statement in `sql.ts` the store issues at request time has a mapping; the
`default` arm of `execute()` refuses anything else by name rather than
approximating it.

| `sql.ts` statement | PostgREST request | Notes |
| --- | --- | --- |
| `SELECT_REQUEST_BY_ID` | `GET app_records?app_id=eq.A&record_id=eq.<id>&limit=1` | row → `RequestRow` from `body` plus the promoted columns |
| `SELECT_REQUESTS_PAGE` | `GET app_records` with `body->>status`, `body->>category`, `or=(created_at.lt.X,and(created_at.eq.X,record_id.lt.Y))`, `order=created_at.desc,record_id.desc`, `limit` | the same keyset order, so a cursor means the same position on both stores |
| `INSERT_REQUEST_WITHIN_QUOTA` | `POST rpc/app_record_insert_within_quota` | the import path only. Returns 1 accepted / 0 refused; the comparison, the insert and the counter are one statement under one row lock |
| create (`INSERT_REQUEST_WITHIN_QUOTA` + `INSERT_WRITE` + `UPDATE_STORAGE_ADD`) | `POST rpc/app_record_create_atomic` | migration 0004. Quota compare, write-id reservation, record insert and counter move in one transaction, returning an outcome envelope (`ok`, `quota_exceeded`, `write_id_taken`, `record_exists`) so a refusal needs no second read |
| update (`UPDATE_REQUEST_CAS` + `INSERT_WRITE` + `UPDATE_STORAGE_ADD`) | `POST rpc/app_record_update_atomic` | migration 0004. Row lock, version guard, quota on growth only, write-id reservation, row write and counter delta in one transaction; `stale_version` carries the stored record back |
| `UPDATE_REQUEST_CAS` | `PATCH app_records?app_id=eq.A&record_id=eq.<id>&version=eq.<expected>` | the version guard is in the request, so 0 rows means `stale_version`. Reads the current `body` first — PostgREST cannot merge keys into jsonb |
| `UPDATE_STORAGE_ADD` | `POST rpc/app_storage_add` | PostgREST cannot express `logical_bytes = logical_bytes + ?`. An accepted **create** does not issue it — the admission function already moved the counter under the same lock; only an update's byte delta goes through it |
| `SELECT_STORAGE_BYTES` | `GET app_storage?app_id=eq.A` | absent row reads as 0 |
| `SELECT_WRITE_BY_ID` | `GET app_writes?app_id=eq.A&write_id=eq.<id>` | `result` is jsonb here and TEXT on SQLite, so it is re-serialised for the one reader both stores share |
| `INSERT_WRITE` | `POST app_writes` | a unique violation becomes the same `idempotency_conflict` refusal |
| `DELETE_WRITES_BEFORE` | `DELETE app_writes?app_id=eq.A&at=lt.<cutoff>` | the retention sweep, within one app |
| `COUNT_REQUESTS` / `COUNT_WRITES` | `HEAD` with `count=exact` | reconciliation and tests |

### Applying it

1. Run `supabase/migrations/0003_hosted_app_data.sql` and then
   `0004_hosted_app_data_atomic.sql` against the project. Until 0004 is applied,
   create and update answer `runtime_unavailable` naming it.
2. Add `hosted` to the project's **exposed schemas** (Settings → API). PostgREST
   serves no schema it has not been told about; without this every request
   answers `PGRST106`, which `PgDataBackend` turns into a `runtime_unavailable`
   refusal naming this step.
3. Set `ZENITH_HOSTED_STORE=postgres`, with `NEXT_PUBLIC_SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` in the server environment.

### What differs in postgres mode

- **Integrity is logical, not physical.** There is no file to `PRAGMA
  quick_check`; `postgresOps.integrity()` reads the app's rows back and checks
  that `hosted.app_storage` equals `sum(logical_bytes)` of its records. The
  verdict says so in `kind: "logical"`; check ids are the same on both stores.
- **Import is not one transaction.** PostgREST offers none, so the bundle's
  total bytes are checked against the app's headroom before anything is
  written. A concurrent writer filling the app mid-import can leave the
  already-written prefix in place; on SQLite the import is all or nothing.
- **The probe namespace** (`<appId>::test`) is emptied by
  `PgDataBackend.purgeTestNamespace()`, which refuses any id that does not end
  in `::test`.
