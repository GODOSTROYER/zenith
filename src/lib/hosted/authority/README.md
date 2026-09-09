# hosted/authority — the control authority

One SQLite file (`<ORRERY_DATA>/control.sqlite`), one connection per process,
one transaction rule. Apps, grants, invitations, sessions, exchanges, jobs,
releases, quotas, usage, revocations, backups and events live here and nowhere
else. The legacy JSON store keeps the infrastructure product; nothing in this
directory writes to it.

The rule everything else is built on:

```ts
const { app } = authority().tx((db) => { /* … */ });  // returns after COMMIT
return NextResponse.json({ app });                     // only then, ACK
```

`index.ts` is the only barrel. Import `@/lib/hosted/authority`, never a file
inside it.

## Spine

| File | Owns | Must not |
| --- | --- | --- |
| `index.ts` | The barrel: the one public surface of this directory | Re-export a repository's internals, or gain a dependency on `jobs.ts` / `outbox.ts` (that is why `lifecycle.ts` is separate) |
| `lifecycle.ts` | Opening, holding and closing the one connection. Pragmas read back before the process continues; a corrupt file is copied aside and the open refuses | Replace an unopenable file with an empty one, or hold the connection anywhere but `globalThis` (HMR would leak a second `DatabaseSync`) |
| `tx.ts` | `transact()` — `BEGIN IMMEDIATE … COMMIT`, synchronous, bounded retry with backoff on busy | Accept an async `fn`, or let `fn` do anything but database work — it may run more than once |
| `sql.ts` | Row readers, the prepared-statement cache, SQLite error classification, and `nowIso()` | Coerce a missing or wrongly-typed column instead of refusing it; format a timestamp any way but fixed-width ISO-8601 UTC |
| `schema.ts` | The ordered migration list. Every enum a CHECK, every relationship a FOREIGN KEY | Edit the SQL of a version that has shipped — add a version, never change one. (Forward-only: there is no `down`.) |
| `repos.ts` | The repository set: one object holding every repository bound to one connection | Reach for the global authority — a repository takes its `DatabaseSync`, which is what lets any combination run inside one `tx()` |
| `jobs.ts` | Job admission and the idempotency rule: same UUID + same intent hash is a retry; same UUID + different intent is `idempotency_conflict` (409) | Silently resolve a conflicting retry to either operation |
| `outbox.ts` | Draining the outbox: claim durably, perform, settle. Five attempts inside one claim | Claim a row whose kind has no registered handler — it stays `pending` and visible. `failed` is terminal (`ponytail:` — no dead-letter queue yet) |

## Repositories — `repos/`

One file per table. Each takes a `DatabaseSync`, maps its rows in exactly one
place, and holds no state of its own.

| File | Table | Owns / must not |
| --- | --- | --- |
| `apps.ts` | `apps` | The app record and the durable active-release pointer. `setActiveRelease` is a compare-and-swap on `active_fence`, so a worker holding a stale token gets `false` rather than pointing a live hostname at a superseded release |
| `grants.ts` | `app_grants` | Who may open an app, and in what role. The partial unique index on `(app_id, subject) WHERE state='active'` makes "one live grant per person per app" a database property. Revoked rows are kept, never deleted — a deleted row cannot prove a removal |
| `invites.ts` | `app_invites` | Single-use, hashed, expiring invitations. The token is never stored, only its SHA-256; `accept` is one conditional UPDATE so two tabs produce one grant. The expiry boundary is strict |
| `deliveries.ts` | `invite_deliveries` | One row per attempt to put an invitation in front of a person, plus the sealed payload a retry needs. `sent` means the transport accepted it — never that a mailbox received it. `clearSealedPayload` bounds how long a working link exists in the database |
| `sessions.ts` | `app_sessions` | The opaque per-app session, keyed by the hash of the cookie value. Termination is a state change, never a delete: the gateway must tell "ended" from "never existed". Bulk terminators by subject, grant and app |
| `exchanges.ts` | `app_exchanges` | The 60-second single-use code carrying an identity to an app host. `consume` is one conditional UPDATE guarded on `consumed_at IS NULL`. `state` is the browser's opaque value and must never be overwritten with a lifecycle word — `status` is the lifecycle |
| `jobs.ts` | `hosted_jobs` | Durable operations: single flight per app (partial unique index on `(app_id) WHERE status='running'`), leases (`reclaimExpired` is the only way a stuck job moves), and fence tokens conditioning every subsequent write |
| `releases.ts` | `releases` | The immutable record of one attempt to put an artifact in front of users. `candidate → verified → active → superseded` (or `failed` / `rolled_back`). The durable choice of what is live is `apps.active_release_id`, not here. `nextNumber` must be called inside `tx()` |
| `artifacts.ts` | `artifacts` | The index of content-addressed build outputs. Create-only: a repeat digest is ignored, not overwritten. `verified_at` is set only by the trusted publisher after re-hashing the stored bytes |
| `outbox.ts` | `hosted_outbox` | Side effects committed with the state that justifies them. `idempotency_key` is UNIQUE and enqueue is `INSERT OR IGNORE`, so a retry writes one row. Nothing that leaves the process may happen inside the transaction |
| `quotas.ts` | `quota_counters` | Requests per app per UTC day, and how many were denied. `increment` is one upsert with `RETURNING`, so the number a caller acts on is the number that committed. The caller passes the day |
| `usage.ts` | `usage_ledger` | Append-only measurements: build ms, requests, stored bytes, emails, provider dollars. Append-only so a total can be re-summed by anyone who doubts it |
| `revocations.ts` | `revocation_ledger` | Append-only, monotonically numbered record of every grant taken away. Designed to be read *outside* this database: rows are copied off-host so a restore knows what was revoked after the snapshot. No foreign key to `apps`, no update, no delete |
| `backups.ts` | `backup_manifests` | What each backup contained — payload digest and size, per-file hashes, the key id, and the last revocation sequence included, which is what makes reconciliation possible |
| `events.ts` | `hosted_events` | The durable analytics envelope. `(event, logical_id)` is unique, so a replayed operation records once. Only `subject_hash` is stored; `props` is for counts, codes and durations, never content |
