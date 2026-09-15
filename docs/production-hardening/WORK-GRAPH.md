# Work graph — remaining production-hardening work

Scope: what is **still open** after PR #9 (`hardening/integration` @ `fe8feea`) and
plugins PR #6 (`hardening/plugin-provenance` @ `6fb81b7`). Work PR #9 already did correctly is
not re-done; where PR #9's *documentation* overstated what it did, the correction is a doc
packet, not a re-implementation.

Every packet is sized for **one focused agent, a few hours, with real test evidence**.
Workers use one isolated git worktree per track (app) and a separate plugins
checkout. Do not run `npm install` in a worker worktree; `node_modules` is shared
from the integration checkout.

---

## Shared-file ownership schedule

One owner at a time. Everyone else **proposes the edit in their handoff** instead of making it.

| Shared path | Wave 1 owner | Wave 2 owner | Wave 3 owner |
|---|---|---|---|
| `package.json`, `package-lock.json` | **integrator only** (nobody) | **F** (new `retention:*` / `outbox:*` script entries only) | integrator only |
| `supabase/migrations/**` | nobody — no new migration in wave 1 | **B** (only if the invite-expiry fix needs one; default is no migration) | nobody |
| `src/lib/hosted/authority/schema.ts` | nobody | **B** | nobody |
| `src/lib/db/types.ts` | nobody | nobody | **A** (packet A3, sole owner) |
| `.github/workflows/**`, `tests/ci/release-gates.test.ts` | **F** | **F** | **F** |
| `docs/**` | **F** owns `docs/hosted/**` + `docs/production-hardening/**`; each packet may edit only the one doc named in its own packet | same | same |
| generated contracts (`src/lib/agent-access/control/contracts.ts`, plugin `plugins/**` generated output) | frozen — no edits | frozen | frozen |
| `src/lib/db/store.ts` (façade) | **A** | **A** | **A** |

Contracts frozen for every packet, in every wave:
`CONTROL_VERSION` and the agent-control error codes
(`control_disabled`, `writes_disabled`, `identity_denied`, `membership_denied`,
`idempotency_conflict`, `not_found`, `app_scope_denied`); the `Store` method *names* in
`src/lib/db/types.ts` until A3; the hosted `Authority` interface; the PostgREST row shapes in
`supabase/migrations/0001`–`0005`; the public HTTP surface of `/api/**`.

Three guards that no packet may remove, weaken or make configurable:
`src/lib/agent-access/control/runtime.ts:23` (serverless control refusal),
`runtime.ts:29` (PostgreSQL reviewed-write refusal),
`src/app/api/account/route.ts:69-77` (Product-Postgres account-deletion refusal).

---

## Wave 1 — six packets, all start immediately, fully parallel

Owned path sets below are **disjoint**. Verified: no path appears in two wave-1 packets.

---

### A1 — Product-store authority is never silently the file store
**Track A · Size M (half day) · Prerequisites: none · Blocks: A3, F2 readiness fields**

**Objective.** In `ZENITH_STORE=postgres`, make an unprimed snapshot a fault instead of a
silent file-store read, fix the two React Server Components that rely on it, and stop the
redundant `state.json` write. Closes ARCH-1b (High, new) and ARCH-1c.

**Owns (exclusive write):**
```
src/lib/db/postgres-store.ts
src/lib/db/store.ts
src/lib/db/request-snapshot.ts
src/app/(product)/overview/page.tsx
src/app/preview/[deploymentId]/[serviceId]/page.tsx
tests/db/store-facade.test.ts
tests/db/rsc-scope.test.ts            (new)
docs/ARCHITECTURE.md                   (ADR 1 prose only)
```
**Forbidden:** `src/lib/db/types.ts`, `src/lib/db/file-store.ts`, `src/lib/db/pg/**`,
`src/lib/server/request.ts`, `src/lib/server/workspace.ts`, everything under
`src/components/**`, `src/app/(product)/integrations/**`, `.github/workflows/**`.

**Required implementation.**
1. `processSnapshot()` (`postgres-store.ts:277-285`) throws a `Fix:`-shaped error in postgres
   mode naming `primeProcessSnapshot()`, instead of returning `emptySnapshot(FileStore.db())`.
   Keep the existing explicit-priming entry points working
   (`cron.ts:139`, `scripts/migrate-alert-secrets.ts:22`, contract tests).
2. Choose and implement **one** RSC strategy (record the choice in the handoff):
   (a) an explicit RSC scope that primes a per-user snapshot and wraps the page body in
   `runWithSnapshot`, or (b) the two pages stop calling `db()`/`q.*` and read the same API
   payload the client does. Prefer (b) for `preview`, which needs a single deployment.
3. `save()`/`flush()`/`flushPending()` (`postgres-store.ts:646-673`) stop calling
   `FileStore.*` in postgres mode. **Keep** `FileStore.onChange` at `:585` — it is the local
   SSE echo, not durability.
4. Correct the stale hybrid prose at `store.ts:16-20` and `postgres-store.ts:39-58`.

**Regression tests to add/run.**
- New: unprimed `db()` in postgres mode throws (not "returns empty").
- New: overview/preview data path with a mocked PostgREST returns real rows and never
  `FileStore` rows; with no scope it refuses.
- New: a postgres-mode mutation writes no `state.json` under a temp `ZENITH_DATA`.
- Run: `npx vitest run tests/db --no-file-parallelism`, `tests/api`.

**Acceptance.** All three new tests pass; `npm run typecheck` exit 0; no file under
`ZENITH_DATA` is created by the postgres-mode test; the three frozen guards untouched.

---

### B1 — Idempotency becomes payload-bound; invite expiry stops holding the unique slot
**Track B · Size M · Prerequisites: none · Blocks: nothing**

**Objective.** Bring `src/lib/actions/core.ts` into compliance with the idempotency invariant
(ARCH-3), and close the invite-expiry residual found while diagnosing the CI failure (VER-5).

**Owns (exclusive write):**
```
src/lib/actions/core.ts
src/lib/actions/mutation-gate.ts
src/lib/hosted/access/invites.ts
src/lib/hosted/authority/repos/invites.ts
src/lib/hosted/authority/pg/repos/invites.ts
tests/actions/idempotency.test.ts          (new)
tests/hosted/access/invites-expiry.test.ts (new)
tests/agent-control-coordinator.test.ts
```
**Forbidden:** `src/lib/agent-access/control/runtime.ts` (the guards),
`src/lib/hosted/authority/schema.ts` (wave 2), `supabase/migrations/**`,
`src/lib/db/**`, `src/lib/alerts/**`, `.github/workflows/**`.

**Required implementation.**
1. `core.ts:311-313` — the cache key becomes `tenant + principal + actionId + key`, and the
   entry stores a **canonical payload hash**. Same key + same payload ⇒ retained outcome
   (current behaviour); same key + different payload ⇒ conflict, matching
   `control/journal.ts:119` and `authority/jobs.ts:115`. Do not change the window size or the
   cache's existence in this packet — bounding it durably is a separate decision.
2. Make the in-memory window visible: the API response (or a documented header) states that
   replay protection is best-effort and process-local, so a caller can reason about it.
   `src/app/api/actions/[actionId]/route.ts:41` and `src/lib/navigator/run.ts:330` are the
   affected callers — **read them, do not edit them** (they belong to other owners); if a
   change there is needed, propose it in the handoff.
3. Invites: introduce an explicit `pending → expired` transition so an expired invitation
   stops occupying the `app_invites_pending_email` slot forever. Prefer a lazy transition in
   the existing read/accept path plus a bounded sweep called from the invite service — **not**
   a new migration. Fix the wrong operator text at `invites.ts:453-454`
   ("wait for it to expire" is false).

**Regression tests.** Same key + different payload ⇒ conflict; same key + same payload ⇒ one
execution; an expired invite no longer blocks a new invitation to the same address; the 409
message names resend/revoke/supersede. Run `npx vitest run tests/actions tests/hosted/access
tests/agent-control-coordinator.test.ts --no-file-parallelism`.

**Acceptance.** New tests pass; `tests/hosted/authority/access.test.ts` and
`tests/scripts/migrate-hosted-to-postgres.test.ts` still pass (they were fixed at `fe8feea`);
no migration added; typecheck 0.

---

### C1 — Webhook egress and secret-lifecycle residuals
**Track C · Size S-M · Prerequisites: none · Blocks: nothing**

**Objective.** Close the three named residuals on SEC-01/SEC-02 without touching the parts
PR #9 got right.

**Owns (exclusive write):**
```
src/lib/alerts/deliver.ts
src/lib/alerts/webhook-policy.ts
src/lib/alerts/channels.ts
src/lib/actions/defs/alerts-channels.ts
scripts/migrate-alert-secrets.ts
tests/alerts/delivery.test.ts
tests/alerts/outbox.test.ts
tests/alerts/webhook-policy.test.ts   (new)
```
**Forbidden:** `src/lib/secrets/**` (read-only for this packet), `src/lib/db/**`,
`src/lib/hosted/**`, `package.json`, `.github/workflows/**`.

**Required implementation.**
1. `deliver.ts:273` — the timeout must abort the socket, not race the send. Replace the
   `withTimeout` race on the pinned `https.request` path with a real `destroy()`/`AbortSignal`
   on the request object.
2. `deliver.ts:718-722` — a settle conflict is no longer swallowed into `log.warn`. Either
   retry the version-guarded settle for that row, or emit an explicit, counted
   "duplicate send possible at lease expiry" outcome. Document whichever is chosen at the call
   site.
3. `channels.ts:325-347` — document the two-authority compensating write at the call site and
   add the missing failure test: a successful secret write followed by a failed settings
   flush must leave no orphan secret (or must leave one that the migration script reconciles;
   state which).
4. Do **not** change `channelTable()`'s `!isPostgres()` guard (`channels.ts:610-613`) — it is
   correct until ADR D-4's transaction exists.

**Regression tests.** A hung endpoint is aborted at the deadline with the socket closed (not
leaked); a settle conflict produces the documented outcome; the orphan-secret case.
Run `npx vitest run tests/alerts tests/actions/security-alerts-isolation.test.ts
tests/api/bootstrap-redaction.test.ts --no-file-parallelism`.

**Acceptance.** New tests pass; the existing address-pinning / redirect / bounded-response
tests still pass; no live network call is made by any test.

---

### D1 — Build supply chain: frozen, script-free, digest-pinned
**Track D · Size M · Prerequisites: none · Blocks: nothing (D2 is the plugins follow-on)**

**Objective.** Close SEC-04's real residual (image-build installs) and SEC-05's test gap.

**Owns (exclusive write):**
```
docker/recipe/Dockerfile
docker/recipe/**                        (incl. a new committed lockfile)
Dockerfile
src/lib/hosted/build/recipe.ts
src/lib/hosted/build/index.ts
src/lib/hosted/build/runner-docker.ts
src/lib/hosted/build/runner-e2b.ts
src/lib/hosted/build/runner-recipe-local.ts
tests/hosted/build/**
```
**Forbidden:** `.github/workflows/**` (F owns them — hand F the exact two-line change),
`package.json`, `package-lock.json`, `src/lib/hosted/config.ts`, `src/lib/hosted/authority/**`.

**Required implementation.**
1. `docker/recipe/Dockerfile:27` — commit a recipe lockfile and switch to
   `npm ci --ignore-scripts` (frozen **and** script-free). This image is the boundary the
   `docker` runner's isolation rests on.
2. `Dockerfile:78` — add a lockfile for the recipe-local toolchain so it is frozen as well as
   script-free. `Dockerfile:16` (`npm ci`) — add `--ignore-scripts` if the app build survives
   it; if it does not, record exactly which package needs a lifecycle script and why.
3. `runner-docker.ts:30,169-175` — pin `RECIPE_IMAGE` by digest instead of the mutable
   `zenith-recipe:v1` tag, with the same refusal shape E2B uses for tags.
4. Delete `RECIPE_INSTALL_ARGS` (`recipe.ts:26-35`) and its re-export (`index.ts:18`) and the
   assertions at `tests/hosted/build/recipe-local.test.ts:306-311`. It advertises a
   script-enabled install line no runner calls.
5. Add the missing SEC-05 regression: assert the E2B factory receives
   `allowInternetAccess: false` and a bare template ID (`runner-e2b.ts:67-72,83,213`) — the
   Docker equivalent is already asserted at `runners-isolated.test.ts:463-496`.
6. Add an explicit note at `runner-recipe-local.ts:86-88` that it has **no** network policy,
   and make `availability()` refuse when `ZENITH_HOSTED_MODE=1` unless an explicit
   acknowledgement variable is set. (Propose, do not add, any new variable to
   `src/lib/hosted/config.ts` — that file is not owned by this packet.)

**Regression tests.** The five above, plus re-run
`npx vitest run tests/hosted/build --no-file-parallelism`.
**Acceptance.** `docker build -f docker/recipe/Dockerfile .` succeeds locally from the
committed lockfile; every build test passes; the install-flag table in
`FINDING-MATRIX.md` SEC-04 becomes all-yes/all-yes except the CI rows, which are handed to F.

---

### E1 — All seven UI findings
**Track E · Size M · Prerequisites: none · Blocks: nothing**

**Objective.** Fix UI-1..UI-5, the real half of UI-6, and add the tests that would have caught
them. UI-7 needs no change — record the disproof rather than "fixing" it.

**Owns (exclusive write):**
```
src/components/shell/activity-bell.tsx
src/components/shell/project-chrome.tsx
src/components/shell/workbench.css
src/components/ui/toast.tsx
src/app/(product)/integrations/integration-control.tsx
src/app/(product)/integrations/page.tsx
tests/shell/activity-bell.test.tsx        (new)
tests/ui/toast.test.tsx                   (new)
tests/ui/workbench-breakpoints.test.ts    (new)
tests/ui/theme-tokens.test.ts             (new)
tests/screens/integrations.test.tsx       (new)
tests/shell/workbench.test.tsx
```
**Forbidden:** `src/app/globals.css` (read the `@theme inline` block only — adding a
`muted-foreground` token is the wrong fix), `src/lib/client/api.ts`,
`src/components/navigator/**`, `src/app/(product)/overview/**`, `src/app/preview/**`
(A1 owns those), `src/lib/**`, `scripts/hosted-browser.ts`.

**Required implementation.** Exactly as specified per row in `FINDING-MATRIX.md` §3.
Two notes that determine whether this packet stays bounded:
- **UI-1 must stamp the project in `ToastProvider.push`**, not at the 29 `toasts.push` call
  sites. Per-site stamping would spread the write set across most of the product tree and
  collide with every other packet.
- UI-6 is *narrower than the report*: hover pause, focus pause, `role="status"` and
  `aria-live` already exist (`toast.tsx:202-213`). Add `onPointerDown` pause and stop arming
  the timer for `kind === "err"` and for toasts carrying an `action`.

**Regression tests.** The five new files above; `tests/shell/workbench.test.tsx:20` currently
mocks `ActivityBell` away — leave the mock but add the new dedicated test file.
Run `npx vitest run tests/shell tests/ui tests/screens`.

**Acceptance.** Five new test files pass; `npm run lint` and `npm run typecheck` exit 0; no
`text-muted-foreground` string remains in `src/`; no `<main>` inside the product layout; no
`display:none` on the three deny-listed selectors inside a media query; no selector width
below 96px.

---

### F1 — A PostgreSQL CI lane, and live lanes that report blocked instead of green
**Track F · Size M · Prerequisites: none · Blocks: VER-3 evidence for every other track**

**Objective.** Turn the repository's existing-but-skipped contract suites into evidence, and
make an absent live lane visible as *blocked* rather than silently green. This is the packet
that changes what "the tests pass" means.

**Owns (exclusive write):**
```
.github/workflows/ci.yml
.github/workflows/tick.yml
.github/workflows/agent-control.yml
tests/ci/release-gates.test.ts
tests/db/contract/factories.ts
tests/hosted/authority/contract/_factories.ts
docs/production-hardening/**
```
**Forbidden:** everything under `src/`, `package.json` (propose the script entries to the
integrator), `supabase/migrations/**`.

**Required implementation.**
1. Add a `postgres` job to `ci.yml` with a PostgreSQL **service container**, applying
   `supabase/migrations/0001`–`0005`, exporting `SUPABASE_DB_URL` and
   `ZENITH_CONTRACT_POSTGRES=1`, and running the currently-skipped lanes:
   `tests/db/contract/**`, `tests/hosted/authority/contract/**`,
   `tests/scripts/migrate-hosted-to-postgres.test.ts`,
   `tests/hosted/data/pg-contract.live.test.ts`. Node 22, matching the other jobs.
   Note that the product store speaks PostgREST, not raw Postgres — if the product-store
   contract lane cannot run against a bare Postgres container without Supabase/PostgREST,
   say so explicitly in the handoff and scope the job to the hosted-authority lanes, which use
   a direct connection (`src/lib/hosted/authority/pg/client.ts`). Do not fake it.
2. Make skipping loud: `postgresSkipReason()` already exists
   (`tests/hosted/authority/contract/_factories.ts:84-89`) — print it, and add a CI step that
   fails, or emits `::warning::`, when a lane that the job intended to run was skipped.
3. Normalise the two workflows: `ci.yml` uses Node `22` while `agent-control.yml:` pins
   `22.16.0`, and the two pin different `actions/checkout` SHAs. Pick one of each.
4. Add `--ignore-scripts` to `ci.yml:50,98,137` (the change D1 hands over), and extend
   `tests/ci/release-gates.test.ts` to pin the install flags so it cannot regress.
5. Rewrite `docs/production-hardening/IMPLEMENTATION-STATUS.md` so every claimed number is
   traceable to a command and an exit code, and every unverified item says **blocked** and why.
   Delete the "UI … source and browser gates passed" row — it is false
   (`FINDING-MATRIX.md` §0.1).

**Regression tests.** `tests/ci/release-gates.test.ts` extended; the new job green on a PR.
**Acceptance.** A CI run shows the Postgres lane executing at least the hosted-authority
contract tests with a non-zero test count; any lane that could not run is visible as blocked;
`IMPLEMENTATION-STATUS.md` contains no unattributed number.

---

## Wave 2 — starts when its named prerequisite lands

### A2 — File-store durability (ARCH-2)
**Track A · Size M · Prerequisite: A1 merged (avoids `src/lib/db` churn overlapping)**

Owns: `src/lib/db/file-store.ts`, `tests/db/store.test.ts`,
`tests/db/file-store-durability.test.ts` (new).
Forbidden: `src/lib/db/postgres-store.ts`, `src/lib/db/types.ts`, `src/lib/db/pg/**`.

Implement **one** of, and say which: (a) `fsyncSync` on the snapshot fd, the directory fd after
rename, and the JSONL append fds — turning `save()`'s acknowledgement into a durability claim;
or (b) a boot refusal making `ZENITH_STORE=file` unusable with `ZENITH_HOSTED_MODE=1`, and a
`file-store.ts` header that stops implying production suitability. Also bound
`appendAuditBatch` (`file-store.ts:517-531`), which currently reads and rewrites the entire
audit log per call and drops concurrent appends between read and rename.

Tests: a child process killed after an acknowledged mutation and before the 50 ms debounce
closes; assert the mutation is present (option a) or that the mode refused to boot (option b).
A bounded-cost test for `appendAuditBatch`.
Acceptance: the crash test is real (an actual killed child process), not a mocked timer.

### B2 — Durable coordination for the agent journal
**Track B · Size M · Prerequisite: B1 merged · Shared-file owner this wave: `src/lib/hosted/authority/schema.ts`, `supabase/migrations/**`**

Owns: `src/lib/data-lock.ts`, `src/lib/agent-access/control/journal.ts`,
`src/lib/agent-access/control/rate-limit.ts`, `src/lib/agent-access/http.ts`,
`tests/agent-control-journal.test.ts`, `tests/agent-control-rate-limit.test.ts`,
`tests/agent-control-multiprocess.test.ts` (new).

Implement: replace the read-then-write `.zenith.lock` claim (`data-lock.ts:58-95`) with an
`O_EXCL` create plus an advisory lock, **or** make `Journal.recover()` (`journal.ts:213-221`)
refuse when it observes a foreign live `workerId` instead of marking every foreign `running`
row `uncertain`. Move the agent reader's in-memory limiter (`http.ts:37,62-65`) onto the
existing durable limiter. Move `ZENITH_AGENT_*` into a validated schema (ADR D-10) —
behaviour-preserving for the documented values.

Tests: a genuine two-OS-process test using the `worker_threads` pattern already proven at
`tests/hosted/authority/busy.test.ts:1-13,39-52`.
**Must not** remove `runtime.ts:23` or `:29`.

### D2 — Plugin provenance residuals *(different repository — may run concurrently with any app packet)*
**Track D · Size M · Prerequisite: none (independent checkout)**

Checkout: the companion plugins repository (private), branch `hardening/plugin-provenance`.
Owns: `packages/provenance/**`, `packages/launcher/**`, `scripts/release.mjs`,
`scripts/provenance.mjs`, `docs/provenance.md`, `.github/workflows/**` (plugins repo),
`package.json` (plugins repo), `tests/provenance.test.mjs`, `tests/launcher.test.mjs`.
Forbidden: any generated output under `plugins/**` (it comes from `scripts/build.mjs` and CI
diffs it); **never copy plugin source into the public application repo or PR**.

Implement: a `bin` entry so `zenith-plugin-launcher` is installable and verifiable rather than
hand-placed on PATH; release signing as a gated step (today `scripts/release.mjs` never
touches provenance); add `provenance:verify` (`package.json:21`, currently orphaned) to a
release lane; write down the key custody, distribution and revocation story, including that
static `status:"revoked"` (`packages/provenance/index.mjs:153`) has no freshness requirement;
state the installer/marketplace gap (`docs/provenance.md:80-85`) as accepted or closed.
Acceptance: `npm run verify` green with counts recorded; new tests for the `bin` path and the
release-signing gate; no live publish.

### E2 — UI evidence and the responsive gate
**Track E · Size S · Prerequisite: E1 merged**

Owns: `scripts/hosted-browser.ts` **only if F has released it**, otherwise a new
`scripts/product-browser.ts` and `tests/ui/**`.
Implement: a real browser gate for the *product shell* (the existing gate 12 only drives a
generated hosted app) covering per-notification routing, the 1190/520/380 breakpoints and
toast persistence. Record viewport-by-viewport results.
Acceptance: the gate fails on a reverted UI-1 fix.

### F2 — Retention, dead-letter re-drive, health/readiness
**Track F · Size M (split into F2a/F2b if it runs long) · Prerequisite: F1 merged · Shared-file owner this wave: `package.json` script entries**

Owns: `src/app/api/internal/**`, a new `src/app/api/health/route.ts`,
`scripts/hosted/retention.ts` (new), `scripts/hosted/outbox.ts` (new),
`src/lib/hosted/authority/outbox.ts`, `src/lib/hosted/authority/repos/outbox.ts`,
`src/lib/hosted/authority/pg/repos/outbox.ts`, `docs/hosted/DATA-LIFECYCLE.md`,
`docs/hosted/RUNBOOK-DEPLOY.md`, `tests/hosted/retention.test.ts` (new).

Implement:
1. **Wire the retention code that already exists and is never called**: `purgeExpired` for
   sessions (`repos/sessions.ts:180`, `pg/repos/sessions.ts:115`) and exchanges
   (`repos/exchanges.ts:139`, `pg/repos/exchanges.ts:84`), and `purgeExpiredWrites`
   (`src/lib/hosted/data/tracker-store.ts:341`, `pg-backend.ts:1062`). Bounded batches,
   idempotent, dry-run by default.
2. **Dead-letter**: add `listFailed` alongside the existing `listPending`
   (`repos/outbox.ts:91,208`) for both backends, plus a re-drive that **reuses the same
   idempotency key**, exposed as a script (not a public route).
3. **Readiness**: one endpoint reporting, per authority, reachable / migration version /
   selector value / `isServerless()`. Read-only, behind the existing constant-time cron bearer
   (`src/lib/server/cron.ts:95-116`) or an equivalent — never unauthenticated, never mutating.
4. Replace the `unknown`s in `docs/hosted/RUNBOOK-DEPLOY.md:172-225` with decisions, or mark
   each as an explicit open risk with an owner.

Acceptance: each retention job has a bounded-batch test and a dry-run test; a failed outbox row
can be listed and re-driven without producing a second effect; the readiness endpoint's fields
match what `ZENITH_STORE`/`ZENITH_HOSTED_STORE` actually selected.

---

## Wave 3 — serial; runs close to alone in its area

### A3 — Widen the `Store` contract and delete `sync-rest`
**Track A · Size M-L (split if needed) · Prerequisites: A1 and A2 merged · Sole owner of `src/lib/db/types.ts`**

This packet edits call sites across `src/app/api/**`, `src/lib/actions/**`,
`src/lib/engine/**` and `src/lib/server/**`, so **no other packet may run in those trees
while it is open**. Only D2 (plugins repo) and F3 (docs) may run concurrently.

Owns: `src/lib/db/types.ts`, `src/lib/db/pg/**`, `src/lib/db/store.ts`,
`src/lib/secrets/**`, and whatever call sites the compiler names.

Implement, in this order:
1. Delete the dead synchronous compatibility surfaces: `buildAccountExport`
   (`src/lib/server/account.ts:280`), `deployedManifest` and sync `changesetFor`
   (`src/lib/actions/defs/deploy.ts:125-136`), and the sync secret accessors
   (`src/lib/secrets/index.ts:182,190,202,265,290`) once their last file-mode callers move.
2. Widen `readAuditPage`/`readAudit`/`countAudit`/`appendAudit`/`readEvents`/`revisionManifest`
   in `types.ts` to promises and let the compiler enumerate call sites.
3. Give the preview RSC an awaited manifest read, removing the last live `restSync` caller
   (`src/lib/db/pg/history.ts:252`).
4. Adopt `src/lib/db/pg/async-repository.ts` at the remaining direct `restAsync` call sites in
   `audit.ts`/`history.ts`/`secrets/pg-backend.ts` **or** delete it. Do not leave a tested
   module with zero production callers (ADR D-3).
5. Delete `src/lib/db/pg/sync-rest.ts` when `grep -rn restSync src/` is empty.

Acceptance: `grep -rn "restSync" src/` returns nothing; `Atomics.wait` appears nowhere under
`src/lib/db/`; typecheck 0; `tests/db`, `tests/api`, `tests/actions`, `tests/secrets` pass.

### F3 — Backup/restore rehearsal and the final evidence matrix
**Track F · Size M · Prerequisite: F2 merged**

Owns: `docs/hosted/**`, `docs/production-hardening/**`, `scripts/hosted/**`.
Implement: a restore drill against a disposable target (LocalStack for the S3 path via the
existing `npm run hosted:backup-live-check`, which already exercises put/get byte-equality,
listing, ledger appends and an `If-Match` probe), measured RPO/RTO, and a completed evidence
matrix that names every cell that is still blocked and why.
**Blocked portion:** a Supabase-backed restore drill needs credentials this machine does not
have. Record it as blocked; do not simulate it.

---

## Dependency graph

```
wave 1 (parallel, 6 workers)
  A1 ──┬─> A2 ──> A3
  B1 ──┼─> B2
  C1   │
  D1 ──┼─> D2   (D2 is repo-independent; may also start in wave 1 with a 7th worker)
  E1 ──┼─> E2
  F1 ──┴─> F2 ──> F3
```
Serial constraints, in one sentence each:
- **A3 blocks everything in `src/app/api/**`, `src/lib/actions/**`, `src/lib/server/**`** while
  open — schedule it when no other packet is live in those trees.
- **B2 owns `src/lib/hosted/authority/schema.ts` and `supabase/migrations/**` for its wave**;
  B1 must add no migration so that ownership is free when B2 starts.
- **F owns `.github/workflows/**` in every wave**; D1 and anyone else hands F their workflow
  change as a diff in the handoff.
- **`package.json` is the integrator's** except for F2's script entries.

## Explicitly not in this graph

- Removing or weakening `runtime.ts:23`, `runtime.ts:29` or `api/account/route.ts:69-77`.
  ADR D-8 lists the six things that would have to be proven first; none can be proven in this
  round because item 6 requires a live PostgreSQL lane that F1 is only just creating.
- Any production migration, cutover, secret rotation, package publish, or default-branch push.
- A blanket mixed-store boot refusal. Only the two evidence-backed serverless refusals of
  ADR D-11 are authorised, and they belong to a future packet once F2's readiness endpoint can
  report the topology they refuse.
- Cloudflare/D1 work. No credentials, no evidence, no packet.
