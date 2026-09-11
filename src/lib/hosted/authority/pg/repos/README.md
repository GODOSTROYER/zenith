# `pg/repos` — writing a Postgres repository

One file per table, mirroring `authority/repos/<table>.ts` statement for
statement. Every table has one.

**The target is behavioural identity, not similarity.** The contract test in
`tests/hosted/authority/contract/` runs the same scenarios against both stores
and expects the same answers, including the failures: the same `HostedError`
code, the same message, the same `details`. A Postgres repository that is
*better* than its SQLite twin is a bug, because a caller cannot tell which one
it is talking to.

## The API you write against

```ts
import type { Sql, TransactionSql } from "../client";

export function createPg<Table>Repo(sql: Sql | TransactionSql): <Table>Repo { … }
```

- **`sql`** is the postgres.js tag function, and it is *either* the process
  client or one transaction's own tag. Your file never chooses: `bindPgRepos`
  in `./index.ts` is called once per transaction with that transaction's tag,
  and once with the process client for the autocommitted repositories on
  `authority().repos`. Write every statement as `` sql`…` `` and it is correct
  in both.
- **Never import `postgres` here, and never call `pgAuthorityClient()`.** A
  repository that reaches for the client is a repository that cannot be run
  inside somebody else's transaction, which is the whole reason the tag is a
  parameter.
- **The return type is the *promised* interface** — `JobsRepo` from
  `../../repos`, not `JobsRepo` from `../../repos/jobs`. The SQLite files
  implement the synchronous shape and are promised by a wrapper; these
  implement the promised shape directly, so every method is `async`.
- **Register it** by replacing its `stub<…>(…)` line in `./index.ts` with
  `createPg<Table>Repo(sql)`. That is the only other file that changes.

## Transactions

Do not open one. `tx()` is the caller's, `sql.begin` is `../tx.ts`'s, and a
repository that started its own would break the one promise this whole
subsystem is built on — that the grant, the session terminations, the ledger
append and the outbox row commit together or not at all.

`../tx.ts` exports `transactPg`, `currentPgTransaction`, `savepointName`,
`TX_MAX_ATTEMPTS` and `TX_BACKOFF_MS`. A repository needs none of them.

## Row mapping — `../rows.ts`

Use these and nothing else. They refuse a column that is missing or of the
wrong shape rather than coercing it, exactly as `authority/sql.ts` does.

| Reader | For |
| --- | --- |
| `readText` / `readOptionalText` / `readNullableText` | `text` |
| `readNumber` | `integer`, `double precision`, and `bigint` (which arrives as a **decimal string** — see below) |
| `readBoolean` | `boolean` |
| `readBytes` | `bytea` (a Node `Buffer`, which is a `Uint8Array`) |
| `readJson` / `readOptionalJson` | a `text` column holding JSON |
| `writeJson` / `writeOptionalJson` / `writeOptional` / `writeBoolean` | the write side of the same |
| `changeCount(result)` | rows affected — postgres.js puts it on `result.count` where `node:sqlite` uses `changes` |

Three conventions that are load-bearing:

1. **Timestamps are ISO-8601 UTC `text`, on both stores.** `Date#toISOString()`
   is fixed width, so lexicographic comparison *is* chronological comparison,
   and `expires_at > ${now}` / `lease_until <= ${now}` are plain string
   predicates. Use `nowIso()` from `../../sql` — never `now()`, never
   `current_timestamp`, never a `timestamptz` column. A timestamp written any
   other way breaks those predicates silently.
2. **Booleans are real booleans.** SQLite stored 0/1 under a CHECK; the
   migration made every flag column `boolean`. `hosted_events.assisted` is the
   only one today.
3. **`bigint` columns come back as strings.** postgres.js returns `int8` as a
   decimal string so that values past 2^53 are not quietly rounded. `readNumber`
   handles it and refuses anything unsafe. The columns are `active_fence`,
   `fence_token`, `byte_size`, `file_count`, `number`, `requests`, `denied`,
   `revocation_seq` and `revocation_ledger.seq`.

## Statements

- **Map a row in exactly one place per file** — a `map(row: PgRow)` function,
  as the SQLite repositories do.
- **`select *`** is fine and preferred: the column list is the migration's, and
  a repeated list here is one more place to forget a column.
- **`INSERT OR IGNORE` is `on conflict (<col>) do nothing`**, and
  `changeCount(result) === 1` still tells you whether this call created the row.
- **`RETURNING`** works the same, and is still the way to make a claim and its
  read one statement.
- **A `LIMIT`ed claim needs `for update skip locked`** in the subquery. SQLite
  serialises writers, so "take the oldest hundred pending rows" could not
  overlap; Postgres does not, and two drainers would block on each other and
  then claim rows the other already holds. See `outbox.ts` `claimPending`.
- **An interpolated identifier or list** uses the tag itself: `sql(kinds)`
  produces a parenthesised value list for `kind in ${sql(kinds)}`. Never build
  SQL by string concatenation; a parameter goes in `${…}` and stays out of band.

## Errors — `../errors.ts`

| Helper | Use |
| --- | --- |
| `isUniqueViolation(err)` | SQLSTATE `23505`. Same name and meaning as `sql.ts`'s, so "a UNIQUE failure here means the single-flight index" reads identically in both files |
| `isRetryable(err)` | `40001` / `40P01` / `53300` / `08006` / `08003`. `../tx.ts` already acts on it; a repository should not |
| `pgErrorCode` / `pgConstraintName` | when a repository needs to tell two constraints apart |

When you turn a constraint violation into a `HostedError`, **copy the SQLite
repository's message, fix and details verbatim** — see `singleFlight` in
`jobs.ts`. A caller reads `.code` and shows `.fix`; those are the API.

## What the schema gives you

`supabase/migrations/0002_hosted_authority.sql` is `authority/schema.ts`
translated literally into the `hosted` schema: every CHECK, every foreign key,
and the three partial unique indexes (`app_grants_active`,
`hosted_jobs_single_flight`, `hosted_events_logical`). Rely on them the way the
SQLite repositories do — the database refusing a bad state is the point — and
if you need a new one, add it to **both** `schema.ts` (a new version) and the
migration file. Never edit an applied version of either.
