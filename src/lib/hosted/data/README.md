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
