# ADR — production topology, state authorities and failure semantics

Status: **proposed**, for the integrator to accept before Track A–F work begins.
Supersedes `docs/production-hardening/ARCHITECTURE-GATE.md` §"Architecture decision record"
(ADR-001), which is kept as history; the corrections are listed in
`FINDING-MATRIX.md` §0.

Baselines: application `master` = `45d0658`; branch `hardening/integration` = `fe8feea`.
Plugins `main` = `5730b3a`; branch `hardening/plugin-provenance` = `6fb81b7`.

Constraint accepted from the brief: **prefer the existing PostgreSQL and adapter code.**
No Redis, no queue service, no ORM, no framework upgrade is introduced by any decision here.
Nothing below authorises a production migration, cutover, secret rotation, package publish or
default-branch mutation.

---

## D-1. There are four state authorities, and they are named

| Authority | Selector | Implementation | Holds |
|---|---|---|---|
| **Product store** | `ZENITH_STORE` (`src/lib/env.ts:69`) | `FileStore` (`src/lib/db/file-store.ts`) or `PostgresStore` over PostgREST (`src/lib/db/postgres-store.ts`) | Every field of `Database` (`src/lib/db/types.ts:50-76`): workspaces, members, invites, connections, projects, environments, settings, revisions, deployments, findings, navigator runs, alert rules/events/outbox, plus deployment events, audit rows and cold manifests through the delegates |
| **Hosted control authority** | `ZENITH_HOSTED_STORE` (`src/lib/hosted/config.ts:40`) | embedded SQLite (`src/lib/hosted/authority/sqlite.ts`) or the `hosted` schema over a direct pooled Postgres connection (`src/lib/hosted/authority/pg/**`) | apps, grants, invites, invite deliveries, sessions, exchanges, jobs, outbox, artifacts, releases, quota counters, usage ledger, revocation ledger, backup manifests, hosted events |
| **Artifact store** | `ZENITH_HOSTED_STORE` + `ZENITH_ARTIFACT_*` | local dir or Supabase Storage (`src/lib/hosted/artifacts/storage-store.ts`) | published build outputs, content-addressed |
| **Agent-control journal** | `ZENITH_AGENT_CONTROL` / `ZENITH_AGENT_WRITES` | SQLite under `${ZENITH_DATA}/agent-control/` (`control/journal.ts`, `control/rate-limit.ts`) | proposals, operations, grants, uploads, rate-limit buckets |

**Secrets are not a fifth authority.** They follow `ZENITH_STORE`
(`src/lib/secrets/backend.ts:93-99`) but do not pass through `Store`
(`src/lib/db/pg/delegates.ts:10-13`). They are a *sub-authority of the product store* and are
documented as such: one row per `(workspace, ref)`, AES-256-GCM sealed in
`src/lib/secrets/index.ts` under `ZENITH_SECRET_KEY`, with the backend never holding the key.

**Decision.** These four names are the vocabulary. Every doc, error message, runbook row and
readiness field must say which authority it is talking about. "The database" is not an
acceptable term in this codebase.

**Decision.** The stale prose that contradicts this — `src/lib/db/store.ts:16-20`,
`src/lib/db/postgres-store.ts:39-58` ("HYBRID BOUNDARY — Phase 3 debt"), `docs/ARCHITECTURE.md`
ADR 1 — is corrected as part of Track A, not left to generate the next false audit finding.

---

## D-2. The product store has exactly one reader boundary, and RSC is inside it

`PostgresStore` is synchronous because a snapshot is loaded *before* the caller runs
(`postgres-store.ts:10-21`). Two entry points install one:
`route()` (`src/lib/server/request.ts:173-174`) and `cron` (`src/lib/server/cron.ts:138-140`),
plus the two agent scopes (`control/runtime.ts:41`, `zenith-reader.ts:140`).
Outside those, `currentSnapshot()` falls back to `processSnapshot()`
(`postgres-store.ts:277-285,309-311`), which is an **empty snapshot over the file store**.

React Server Components are outside all of them
(`src/app/(product)/overview/page.tsx:32`, `src/app/preview/[deploymentId]/[serviceId]/page.tsx:40-52`).

**Decision.** In `ZENITH_STORE=postgres`, an unprimed process snapshot is a **fault, not a
fallback**. `processSnapshot()` must refuse — throw a boot-shaped error naming
`primeProcessSnapshot()` — rather than hand back the file-store graph. Scripts, the seed and
tests already prime explicitly (`scripts/migrate-alert-secrets.ts:22`, `cron.ts:139`), so the
refusal costs them nothing.

**Decision.** Server components that need product state go through a small, explicit
RSC scope that primes a per-request snapshot for the signed-in user (the same call
`route()` makes), or they stop reading the store and consume the same JSON the client does.
Either is acceptable; silently reading `FileStore` is not. Choosing between them is Track A's
first design decision and must be recorded in the handoff.

**Decision.** `PostgresStore.save()`/`flush()`/`flushPending()` must stop writing
`state.json` in Postgres mode (`postgres-store.ts:646-673`). The `FileStore.onChange`
subscription at `:585` stays, because it is the local SSE echo, not a durability path.

---

## D-3. Async access on hot paths; the synchronous bridge is deleted, not policed

`src/lib/db/pg/sync-rest.ts` parks the calling thread on `Atomics.wait` while a worker does a
PostgREST round trip, and says so (`sync-rest.ts:26-38`). PR #9 widened the call sites; it did
not remove the contract that requires the bridge.

**Decision.** The target state is that `restSync` has no callers and the file is deleted.
The path there, in order:
1. Delete the now-unreachable synchronous compatibility surfaces:
   `buildAccountExport` (`src/lib/server/account.ts:280`), `deployedManifest` and sync
   `changesetFor` (`src/lib/actions/defs/deploy.ts:125-136`), and the sync secret accessors
   once their last file-mode callers move (`src/lib/secrets/index.ts:182,190,202,265,290`).
2. Widen `Store`'s audit readers (`readAuditPage`, `readAudit`, `countAudit`), `appendAudit`,
   `readEvents` and `revisionManifest` to promises in `src/lib/db/types.ts`, letting the
   compiler enumerate the call sites — which is what `types.ts:11-20` already says the
   plan is.
3. Give the preview page an awaited manifest read (`revisionManifestAsync`), removing the last
   live `restSync` caller (`history.ts:252`).

**Decision.** No new blocking substitute, no unawaited required write, no process-global
mutable request state. Caches are projections: `manifestCache`
(`src/lib/db/pg/history.ts:220-233`) and `eventTails` (`:493-518`) may only ever be
re-derivable from the authority.

**Decision.** `src/lib/db/pg/async-repository.ts` is either adopted as the tenant-scoped
boundary for new async storage access, or deleted. Shipping a tested module with zero
production callers, and citing it as evidence of a fix, is the failure mode this ADR exists to
prevent. Preference: **adopt it** — its refusal on missing tenant and its body-tenant binding
(`async-repository.ts:50-70`) are the invariant we want, and the direct `restAsync` call sites
in `audit.ts`/`history.ts`/`pg-backend.ts` do not have them.

---

## D-4. Transaction boundaries, stated honestly

**Within one authority.** Business state, its audit/operation record, its idempotency key and
its outbox intent commit together **only where a real transaction exists**:
- Hosted authority: yes, both backends — `src/lib/hosted/authority/tx.ts:129-138`
  (`BEGIN IMMEDIATE … COMMIT`) and `pg/tx.ts:107` (`sql.begin`, resolving after COMMIT).
  `admitJob` (`authority/jobs.ts:103-129`) is the reference shape.
- Agent-control journal: yes — SQLite transactions with `UNIQUE(workspace, subject, request_key)`
  (`control/journal.ts:69`).
- **Product store over PostgREST: no.** A flush is a sequence of HTTP requests
  (`postgres-store.ts:482-510`); several PostgREST requests are not one transaction.

**Decision.** The product store does **not** claim cross-table atomicity, and no feature may be
built that requires it. Where one is genuinely needed, the options are, in order of
preference: (a) put the state in the hosted authority, which has real transactions;
(b) a single Postgres RPC/function applied as a new migration, as
`supabase/migrations/0004_hosted_app_data_atomic.sql` already does for the hosted data plane;
(c) a durable intent plus reconciliation. Adding a second connection style to the product
store is explicitly **not** on this list in this round.

**Decision.** Row-level optimistic concurrency stays as the product store's concurrency
contract: `version bigint`, guarded update, zero rows = `409`, never last-writer-wins
(`postgres-store.ts:22-30,384-395`). Any new table follows it.

**Decision.** Two-authority writes (alert credential → secrets row **and** settings row,
`src/lib/alerts/channels.ts:325-347`) are compensating, not atomic, and must be documented at
the call site and in the runbook with the observable failure mode (an orphaned secret row) and
its reconciliation.

---

## D-5. Idempotency

**Decision.** One contract, three implementations, no exceptions:
a key is scoped by **tenant + principal + operation**, bound to a **canonical payload hash**;
same key + same payload returns the retained outcome; same key + different payload is a
**conflict**.

- Agent journal already complies (`control/journal.ts:113-121`).
- Hosted jobs already comply (`authority/jobs.ts:109-116`).
- `src/lib/actions/core.ts:152-191,311-317` does **not**: the key is
  `${actor.id}:${actionId}:${key}` with no payload hash, held in a 500-entry in-memory Map
  that a restart empties. This is brought into compliance in Track B.

**Decision.** Outbox rows keep derived-string keys (`deliver.ts:582-586`,
`hosted/access/invites.ts:435`, `grants.ts:243`) because they are *effect* identities, not
request identities — but the DB uniqueness on them stays mandatory
(`supabase/migrations/0001_system_of_record.sql:291-292`,
`src/lib/hosted/authority/schema.ts:179`).

---

## D-6. External effects

**Decision.** Never an exactly-once claim. Durable intent, then dispatch, then provider
idempotency where it exists, bounded retry with backoff, then operator reconciliation. A
unique outbox row proves one *intent*, not one *send*.
Current numbers, which stay unless measured otherwise: alert delivery 3 attempts
(`src/lib/alerts/deliver.ts:299-300`), hosted outbox 5 attempts with `[200,800,2000,5000]`
backoff and a 120 s lease (`authority/outbox.ts:35-47`).

**Decision.** `failed` is not terminal for an operator. A dead-letter listing and a re-drive
that reuses the same idempotency key are required before production operation (Track F);
both implementations already name this as their upgrade path
(`deliver.ts:29-32`, `authority/outbox.ts:18-23`).

**Decision.** A lost settle must not be swallowed. `src/lib/alerts/deliver.ts:718-722`
currently logs a warning on a settle conflict and moves on, which converts a coordination
failure into a silent duplicate send at lease expiry. Either retry the guarded settle per row
or make the duplicate an explicit, documented, metered outcome.

---

## D-7. Authorization is rechecked at execution

**Decision.** Unchanged and preserved: every mutation and worker rechecks tenant/principal,
approval digest, target state, expiry and lease/fence before returning a protected result or
finalising work. An agent cannot self-approve. The fences PR #9 added — operation expiry,
durable OAuth grant revocation, membership/app-role digests — stay.

**Decision.** DB-enforced claims/leases/fencing remain the only acceptable multi-writer
primitive: `hosted_jobs` single-flight partial unique index
(`src/lib/hosted/authority/schema.ts:173`), `lease_owner`/`lease_until` (`:162-163`),
`fence_token` on every write (`:164`), `app_grants_active` (`:77`),
`app_invites_pending_email` (`:328-331`). Process-local gates may sit **in front of** these as
a fast path; they may never be the only guard.

---

## D-8. The agent-control PostgreSQL write refusal stays

**Decision.** `src/lib/agent-access/control/runtime.ts:29` is not removed, weakened, or made
configurable. Nor is the serverless refusal at `:23`, nor the account-deletion refusal at
`src/app/api/account/route.ts:69-77`.

**What would have to be proven to lift it** — all of it, with evidence, before the line is
touched:
1. A coordinated transaction spanning the agent journal and the product store, or the agent
   journal moved into an authority that shares a transaction with product state. Today the
   journal is SQLite and the product store is PostgREST; they cannot commit together.
2. A durable, DB-enforced single-writer or fencing primitive replacing the `.zenith.lock`
   PID file (`src/lib/data-lock.ts:14-17,58-95`) — because today a process-local lock is what
   keeps `Journal.recover()` (`control/journal.ts:213-221`) from poisoning another instance's
   `running` rows, `workerId` being per-instance (`:47`).
3. Multi-instance lease and fence tests that actually run in separate OS processes —
   the pattern exists (`tests/hosted/authority/busy.test.ts:1-13,39-52`); the agent-control
   tests do not use it (`tests/agent-control-journal.test.ts:93-110` is two connections in one
   process).
4. Revocation-race tests: a grant revoked between approval and finalisation must deny.
5. Restart-and-uncertainty tests: an operation `running` at kill must resolve to a defined
   state, once, on exactly one instance.
6. A live PostgreSQL CI lane proving 1–5 against a real database, not a mock.

Until every one of those exists and is green, `writes_disabled` is the correct answer and
removing it is a regression, however green the rest of the suite looks.

---

## D-9. Secret handling

**Decision.** Secret values never enter settings, manifests, revisions, diffs, audit rows,
exports, responses or logs — only `vault:` references. This is already the design
(`src/lib/secrets/index.ts:1-25`) and stays.

**Decision.** Without `ZENITH_SECRET_KEY` the store is *not configured* and every write is
refused; it never degrades to plaintext (`src/lib/secrets/index.ts:22-25`). Legacy plaintext
alert rows are **delivery-disabled**, not silently used, until migrated.

**Decision.** The alert-secret migration is versioned, dual-read, resumable, journaled per
channel, and reversible; it is run by an explicit operator action
(`npm run migrate:alert-secrets -- --apply`), never at boot, and never in Postgres mode until
the coordinated transaction of D-4 exists — which is what `channels.ts:610-613` already
enforces.

**Decision.** Plaintext copies are not deleted without a retention decision recorded in the
runbook.

---

## D-10. API compatibility: agent control v1/v2

**Decision.** `CONTROL_VERSION` (`src/lib/agent-access/control/contracts.ts`) is the
compatibility surface. Existing v1 tool names, argument shapes and error codes
(`control_disabled`, `writes_disabled`, `identity_denied`, `membership_denied`,
`idempotency_conflict`, `not_found`, `app_scope_denied`) are frozen for this round. New
behaviour arrives as additive fields or a new version, never as a changed meaning.

**Decision.** Capability advertisement stays truthful: `runtime.ts:204,217` already hides
write tools when writes are unavailable. A tool that cannot run must not be advertised.

**Decision.** `ZENITH_AGENT_*` move into a validated schema alongside the rest of `ZENITH_*`.
They are currently the only family read raw from `process.env`
(`runtime.ts:23,29`, `zenith-reader.ts:134`, `oauth.ts:7,14-18`). They fail closed today —
strict `=== '1'` — but `ZENITH_AGENT_WRITES=true` silently disables writes with no diagnostic,
which is a support burden, not a security hole. Additive and behaviour-preserving for the
documented values.

---

## D-11. Supported vs experimental store combinations

Both selectors are independent and both default safely. The previous blanket mixed-mode
refusal was correctly reverted; this ADR does **not** reintroduce one. Instead each cell gets
an explicit support status and the boot path refuses only *demonstrated* unsupported pairs.

| `ZENITH_STORE` | `ZENITH_HOSTED_STORE` | Host | Status |
|---|---|---|---|
| `file` | `sqlite` | long-lived single host | **Supported — local development.** Single writer, PID-claimed (`src/lib/server/boot.ts:60`). The only mode where agent control may be enabled. |
| `postgres` | `postgres` | Vercel (serverless) | **Target supported production**, conditional on D-2, D-3 and the Track F evidence. |
| `postgres` | `sqlite` | long-lived single host | **Supported, documented hybrid** (`docs/HOSTED-POSTGRES.md`). No cross-authority atomicity is implied. |
| `postgres` | `sqlite` | **serverless** | **Unsupported — must fail closed.** The hosted SQLite authority lives on a per-instance ephemeral `/tmp`, and `assertHostedPreconditions()` (`src/lib/hosted/index.ts:42-63`) does not currently refuse it. Acknowledged hosted state would vanish per instance — a durability-invariant violation. This is the one *demonstrated* unsupported pair, so this is the one new boot refusal this ADR authorises. |
| `file` | `postgres` | any | **Experimental.** Legal to configure, no acceptance evidence. Product state single-writer while hosted state is shared is a coherent but untested topology. |
| `file` | anything | serverless | **Unsupported — must fail closed.** Per-instance `/tmp`, and the PID claim is deliberately skipped (`boot.ts:60`, `src/lib/serverless.ts:11-17`). |

**Decision.** The two new refusals are `isServerless() && (ZENITH_STORE === "file" ||
ZENITH_HOSTED_STORE === "sqlite")`, each with a `Fix:` sentence naming the variable to change.
No other combination gains a guard in this round.

**Decision.** Agent control and reviewed writes remain confined to the first row —
long-lived, single-writer, file store — and that is enforced in code today
(`runtime.ts:23,29`).

---

## D-12. Build runners

**Decision.** `ZENITH_BUILD_RUNNER` keeps its `none` default and fail-closed validation
(`src/lib/hosted/config.ts:43`; unknown value throws at `:106-111`;
`src/lib/hosted/build/registry.ts:26-30,47-48`). Selection is not permission — each runner
re-checks `availability()`.

**Decision.** Supply-chain policy is a property of the *image*, not of the job. Every install
surface must be both lockfile-frozen and script-free; none is today (see
`FINDING-MATRIX.md` SEC-04). `docker/recipe/Dockerfile:27` is the priority because the
`docker` runner's isolation depends on that image.

**Decision.** `recipe-local` is documented as a process boundary, not a sandbox
(`runner-recipe-local.ts:86-88`), and is never a production runner for untrusted source.
`docker` has the strongest, tested network policy (`runner-docker.ts:46-67`,
`tests/hosted/build/runners-isolated.test.ts:463-496`). `e2b` stays on hold until live
egress/teardown evidence exists.

**Decision.** `RECIPE_IMAGE` moves from the mutable tag `zenith-recipe:v1`
(`runner-docker.ts:30`) to a digest pin, for the same reason E2B template tags are rejected.

---

## D-13. Migration, cutover and rollback

**Decision.** New versioned migrations only. `supabase/migrations/**` is append-only:
`0001`–`0005` are shipped and are never edited. The authority's `MIGRATIONS` array
(`src/lib/hosted/authority/schema.ts:333-338`) gains entries, never edits.

**Decision.** Boot verifies the *deployed* schema, not only the ledger version. PR #9's check
of both the migration name and the actual `app_invites_pending_email` index definition
(`src/lib/hosted/authority/pg/index.ts:165-191`, `pg/repos/migrations.ts:45-82`) is the
pattern every future structural migration follows.

**Decision.** Any data-shape migration is: validate → resumable backfill → dual-read → count
and decryptability reconciliation → feature-flag cutover → forward recovery. Plaintext or
pre-migration copies are retained until a retention decision is recorded.

**Decision.** `0005_pending_invite_uniqueness.sql` cannot apply while duplicate live pending
rows exist — by design (the index and the version marker are in one transaction). A
reconciliation query and its expected output must be in the runbook before it is applied
anywhere real.

**Decision.** Rollback for this round is a Git revert of the implementation and documentation
commits, or a cherry-pick of individual fixes. No production data transformation is introduced
by the branch, so there is nothing to undo in a database.

---

## D-14. Failure semantics

**Decision.** Fail closed and say which variable to set. The repository already has this shape
(`src/lib/hosted/config.ts:106-113`, `src/lib/hosted/index.ts:47-63`,
`src/lib/db/pg/registry.ts:195-201`) and every new refusal matches it: what happened, why, and
a `Fix:` sentence.

**Decision.** Degraded is a *reported* state, never a silent one. If the product store cannot
be reached, requests fail; they do not quietly answer from a file. If a hosted migration is
behind, reads and writes refuse rather than half-work — which is already the behaviour
(`pg/index.ts:165-191`).

**Decision.** A readiness endpoint must exist and must report, per authority: reachable,
migration version, selector value, and whether the process is serverless. It is the only
sanctioned way for an operator to learn which topology is actually running. It reports state;
it never mutates.

---

## Consequences

- Track A must make an RSC decision (prime vs stop reading) before touching anything else.
- Track B gains one non-negotiable: `actions/core.ts` idempotency becomes payload-bound.
- Track F owns the first honest statement of what is *not* verified, and the CI lane that
  turns the existing skipped contract tests into evidence.
- Two new boot refusals ship (D-11). They are narrow, evidence-backed, and each names its fix.
- Nothing here lifts the agent-control refusal, and D-8 is the only document that says what
  would.
