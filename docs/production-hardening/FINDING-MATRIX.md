# Finding matrix — production hardening

Checkout inspected: the `hardening/integration` branch of this repository.
Head moved during this pass: evidence was gathered at **7302ac1**; the branch is now at
**fe8feea** ("test: align invitation fixtures with the one-pending-invite invariant"),
which changes only `tests/hosted/authority/access.test.ts` and
`tests/scripts/migrate-hosted-to-postgres.test.ts` (`git diff 7302ac1..HEAD --stat`:
2 files, 9 insertions, 4 deletions). No `src/` evidence below is affected.
Plugins: `GODOSTROYER/Zenith-plugins` branch `hardening/plugin-provenance` @ `6fb81b7`.

All line numbers are at those commits. Classifications are one of
**reproduced** / **partially addressed** / **disproved-superseded** / **unverified**.

Severity is re-assessed here, not copied from the report.

---

## 0. Summary of corrections to the prior agent's matrix

| # | Prior claim (`docs/production-hardening/ARCHITECTURE-GATE.md` / `IMPLEMENTATION-STATUS.md`) | Correction |
|---|---|---|
| 1 | "UI routing/polling/accessibility items — **Source and browser gates passed** … hosted browser journey passed 24/24" | **Wrong.** `git diff 45d0658..7302ac1 --stat` touches no file named in UI-1..UI-7. `scripts/hosted-browser.ts` is gate 12 — the *hosted-app recipient* journey against a generated app; its diff is browser-discovery plumbing only and adds zero assertions. UI-1..UI-5 reproduce unchanged; UI-6 partially; UI-7 was already false at baseline. |
| 2 | "the async repository binds tenant bodies" offered as evidence for the sync-rest widening | **Misleading.** `src/lib/db/pg/async-repository.ts` has **zero production callers** (`grep -rn "createAsyncRepository\|PostgrestAsyncRepository" src/` → definition only; the only importer is `tests/db/async-repository.test.ts`). The actual widening went through `restAsync` directly in `audit.ts` / `history.ts` / `secrets/pg-backend.ts`, which do **not** pass through the tenant-binding repository. |
| 3 | ARCH-1 framed as "file store remains durable authority for deployment history, audit, alerts, findings, Navigator, secrets" | **Mostly disproved at the baseline, for a reason the report missed.** Every collection in `Database` has a registered Postgres adapter, and manifests/events/audit delegates are replaced — landed in `6414ade` (2026-09-11), i.e. *before* baseline `45d0658`. But three genuine residuals survive, one of them **High** and not in any report (see ARCH-1b). |
| 4 | Store-authority documentation | `src/lib/db/store.ts:16-20` and `src/lib/db/postgres-store.ts:39-58` still describe the Phase-2 hybrid ("everything else … still goes to `FileStore`"). Stale prose contradicting `src/lib/db/pg/all.ts:6-9`. Docs must be corrected or they will keep generating false findings. |
| 5 | SEC-04 "E2B builds run `npm install` at job time" | **Disproved for E2B**, but the hole moved: `docker/recipe/Dockerfile:27` still runs `npm install --no-audit --no-fund --omit=dev` with **no lockfile and no `--ignore-scripts`**. |
| 6 | ARCH-5 "rate limits … are process-local" | **Disproved for agent control** (`src/lib/agent-access/control/rate-limit.ts:15-41` is a durable SQLite limiter). Reproduced for the mutation gate, the PID lock and the agent *reader* limiter. |
| 7 | ARCH-3 "durable SQL + process-local replay cache" located in the agent journal | **Relocated.** `src/lib/agent-access/control/journal.ts:45` explicitly has no replay cache. The process-local cache is `src/lib/actions/core.ts:152-191`, and it is **not bound to a payload hash** (`core.ts:311-317`) — a real invariant violation. |
| 8 | "the CI failure … `app_invites_pending_email`" | **Already fixed** at `fe8feea` — the index predicate was correct; two test fixtures inserted a second `pending` row for the same `(app_id, lower(email))` without superseding first. |

---

## 1. Architecture / durability findings

### ARCH-1a — Postgres authority for history / audit / alerts / findings / Navigator
**Classification: disproved-superseded.** **Severity: n/a.** **Track: A (doc fix only).**

Evidence: `src/lib/db/pg/all.ts:6-9` imports `core`, `history`, `audit`, `alerts`.
`registerCollection` calls cover every field of `Database` (`src/lib/db/types.ts:50-76`):
workspaces/members/invites/connections/projects/environments/settings
(`src/lib/db/pg/core.ts:66,84,117,142,161,189,222`), revisions/deployments
(`src/lib/db/pg/history.ts:428,467`), findings/navigatorRuns/alertRules/alertEvents/alertOutbox
(`src/lib/db/pg/alerts.ts:123,147,166,193,221`). Delegates replaced:
`history.ts:716-717` (`manifests`, `events`), `audit.ts:318` (`audit`).
`git log --diff-filter=A` puts all four files in `6414ade` (2026-09-11), before baseline.

Reproduces: it does not. Required work: correct the stale prose at
`src/lib/db/store.ts:16-20` and `src/lib/db/postgres-store.ts:39-58`, and
`docs/ARCHITECTURE.md` ADR 1.
Regression test: extend `tests/db/contract/` so the Postgres factory row asserts that
every key of `Database` has a registered adapter (a registry-completeness test) — this is
the test that stops the hybrid boundary silently reopening.
Live verification: none needed.

### ARCH-1b — Server components silently read the file store in `ZENITH_STORE=postgres` *(new; not in the report)*
**Classification: reproduced (new finding).** **Severity: High.** **Track: A.**
**Depends on:** nothing. **Blocks:** any honest "hosted Postgres works" claim.

Evidence:
- `src/lib/db/postgres-store.ts:277-285` — `processSnapshot()` returns
  `emptySnapshot(FileStore.db())` when nothing has primed a snapshot.
- `src/lib/db/postgres-store.ts:309-311` — `currentSnapshot()` = request snapshot **or**
  that process snapshot.
- `runWithSnapshot` is installed only by `src/lib/server/request.ts:173-174` (API routes),
  `src/lib/server/cron.ts:138-140`, `src/lib/agent-access/control/runtime.ts:41` and
  `src/lib/agent-access/zenith-reader.ts:140`. **No React Server Component path primes it**:
  `src/lib/server/boot.ts:51-93` never calls `primeProcessSnapshot`, and
  `currentWorkspace()` (`src/lib/server/workspace.ts:119-123`) does not either.
- Reproduces at: `src/app/(product)/overview/page.tsx:32` (`const data = db()`, then
  `data.projects` / `data.revisions` / `data.deployments`) and
  `src/app/preview/[deploymentId]/[serviceId]/page.tsx:40,49,51,52`
  (`q.deployment` / `q.revision` / `q.project` / `q.environment`).
- `docs/ARCHITECTURE.md:238-241` states the rule the code breaks: "Outside a request … there
  is a process-global snapshot instead, **primed explicitly**."

How it reproduces: boot with `ZENITH_STORE=postgres` and real data in Postgres; request
`/overview` — the project grid renders from `FileStore.db()` (empty on a fresh Vercel
instance). Request a preview URL for a real deployment — the page returns
"No such deployment". This is the durability invariant ("hosted never silently falls back to
files/memory") failing in the product UI.

Secondary hazard on the same path: `currentWorkspace()` calls `ensureMember(user)`
(`src/lib/server/workspace.ts:121`), which mutates `db()` and can `save()`
(`src/lib/server/membership.ts:75-110`). Against an empty snapshot with no baseline, a
subsequent flush would take the **insert** branch (`postgres-store.ts:371-381`) for a row
that already exists in Postgres. This must be proven either impossible or harmless.

Regression test that must exist: a node-project test that, with a mocked PostgREST, renders
(or directly calls) the overview/preview data path with no request scope and asserts it
**throws or refuses** rather than returning file-store data. Plus a guard test that
`processSnapshot()` in postgres mode is never silently empty.
Live verification: hosted smoke against a Supabase project — load `/overview` and one
preview URL and assert non-empty. **Blocked on this machine** (no Supabase credentials).

### ARCH-1c — `PostgresStore.save()` still writes the file store
**Classification: reproduced.** **Severity: Medium.** **Track: A.**

Evidence: `src/lib/db/postgres-store.ts:646-648` — `save()` calls `FileStore.save(projectId)`
with the comment "The Phase-3 half of the graph lives in the file store". That half no longer
exists (ARCH-1a), so in Postgres mode every save also rewrites `state.json` in `ZENITH_DATA`
(on Vercel, a per-instance `/tmp`). `flush()` (`:651-654`) and `flushPending()` (`:660-673`)
do the same. `onChange` also attaches `FileStore.onChange` (`:585`).

Consequence: a pointless full-graph disk write on every mutation, a second failure mode on
the request path, and a file that looks like state but is not authoritative — exactly the
artefact that makes operators trust the wrong copy.
Required: decide and encode whether the file write is (a) removed, (b) retained only as a
local-dev convenience behind an explicit flag. Do not remove `FileStore.onChange` without
replacing the local SSE echo it provides.
Regression test: assert no `state.json` is written by a Postgres-mode mutation.

### ARCH-1d — Secrets are a fourth authority, outside `Store`
**Classification: partially addressed.** **Severity: Medium.** **Track: A/C.**

Evidence: `src/lib/db/pg/delegates.ts:10-13` ("Secrets are deliberately absent: they never
went through `Store` at all"). `src/lib/secrets/backend.ts:17-21,93-99` selects
`FileSecrets` / `PostgresSecrets` by `ZENITH_STORE`. So secrets *do* follow the product
store selector, but through a separate module with its own sync and async surfaces.
The residual is that an alert-channel credential write touches **two** authorities —
`public.secrets` and the `settings` row — with a compensating rollback
(`src/lib/alerts/channels.ts:325-347`) rather than a transaction. That is an accepted
pattern, but it must be stated as such, not implied to be atomic.

### ARCH-2 — File store acknowledges coalesced writes before durability
**Classification: reproduced.** **Severity: High for any file-mode production claim; Low if file mode is dev-only.** **Track: A.**

Evidence: `src/lib/db/file-store.ts:12-17` states it outright ("`save()` returns *before* its
coalesced write runs …, **nothing here calls fsync**, and a torn trailing JSONL line is
skipped on read rather than repaired"). `save()` debounce at `:305-330`; `writeState()`
tmp+rename with no `fsyncSync` at `:285-291`; `appendAudit` bare `appendFileSync` at `:514`;
`appendEvent` at `:397`.

New sub-issue introduced by PR #9: `appendAuditBatch` (`file-store.ts:517-531`) reads the
**entire** audit log into memory, concatenates, writes a temp file and renames — O(total log)
per account deletion, still without fsync, and it drops any line appended concurrently
between the read and the rename. The mutation gate makes the concurrency safe on one
process; the cost and the missing fsync are not addressed.

Required: pick one — (a) label `ZENITH_STORE=file` dev/single-host only in code (a boot
refusal when `ZENITH_HOSTED_MODE=1`), or (b) add `fsyncSync` on the snapshot fd, the
directory fd after rename, and the JSONL fds, with a crash test.
Regression test: a crash-injection test (child process killed after ack, before the debounce
window closes) asserting the acknowledged mutation is present on restart. Plus a bounded-cost
test for `appendAuditBatch`.
Live verification: none required; this is testable locally.

### ARCH-3 — Split idempotency
**Classification: partially addressed / relocated; still reproduces.** **Severity: Medium.** **Track: B.**

Evidence:
- **Disproved where the report put it:** `src/lib/agent-access/control/journal.ts:45`
  ("never an in-memory replay cache"); durable uniqueness at `journal.ts:69`
  (`UNIQUE(workspace, subject, request_key)`); payload binding and conflict at
  `journal.ts:113-121`; coordinator replay at
  `src/lib/agent-access/control/coordinator.ts:22-27`.
- **Reproduces one layer down:** `src/lib/actions/core.ts:152-191` — `globalThis.__zenithIdem`,
  a 500-entry / 10-minute in-memory Map, with the TODO at `:148-150` admitting a restart
  makes a retry apply twice. The key is `${ctx.actor.id}:${actionId}:${opts.idempotencyKey}`
  (`core.ts:311-313`) — **not bound to a canonical payload hash**, so same key + different
  payload silently returns the first result (`core.ts:314-317`) instead of conflicting.
  This violates the brief's idempotency invariant directly.
- Callers with no durable idempotency at all: `src/app/api/actions/[actionId]/route.ts:41`,
  `src/lib/navigator/run.ts:330`.
- Hosted jobs are correct by contrast: `src/lib/hosted/authority/jobs.ts:103-129`
  (actor/kind/app/workspace + `intentHash`, 409 on mismatch).

Required: bind `core.ts` keys to a canonical payload hash and return a conflict on mismatch,
matching `journal.ts:119`; give the two non-agent callers a durable record or make the
in-memory window explicit in the API response.
Regression test: same key + different payload ⇒ conflict, not stale replay; same key + same
payload ⇒ retained outcome; restart ⇒ no double-apply for the durable path.

### ARCH-4 — D1 / Cloudflare unproven live
**Classification: unverified.** **Severity: Medium (scope: experimental backend).** **Track: F.**

Evidence: `ZENITH_RUNTIME: z.enum(["local","cloudflare"]).default("local")`
(`src/lib/hosted/config.ts:41`); `ZENITH_CF_ACCOUNT_ID` / `_NAMESPACE` / `_PROBE_URL` /
`_BROKER_MODULE` (`config.ts:66-77`); `ZENITH_CF_API_TOKEN` is presence-only (`config.ts:5-7`).
No CI lane touches it (`grep -rn "cloudflare\|ZENITH_RUNTIME" .github/workflows/` → nothing).
Required: no code work. Mark Cloudflare **experimental, no acceptance evidence** in the
deployment matrix and refuse to imply otherwise.
Live verification: **blocked** (no Cloudflare credentials on this machine).

### ARCH-5 — Horizontal coordination gap
**Classification: partially addressed.** **Severity: Medium.** **Track: B.**

| Primitive | Location | Locality |
|---|---|---|
| Agent throttle | `src/lib/agent-access/control/rate-limit.ts:15-41,55` (SQLite, `BEGIN IMMEDIATE`) | **durable** — report disproved here |
| Agent journal + idempotency | `control/journal.ts:46-82` | durable |
| Journal worker fence | `control/journal.ts:47,182,200,208,213-221` | **process-local token over durable rows** |
| Mutation gate | `src/lib/actions/mutation-gate.ts:1-16` (AsyncLocalStorage + promise chain on `globalThis`) | process-local, self-declared |
| Action replay cache | `src/lib/actions/core.ts:152-191` | process-local |
| PID lock | `src/lib/data-lock.ts:14-17,22,58-95` (read-then-write, `process.kill(pid,0)`) | process/host-local |
| Agent *reader* limiter | `src/lib/agent-access/http.ts:37,62-65` (`new Map`) | process-local |
| Hosted jobs single-flight / leases / fences | `src/lib/hosted/authority/schema.ts:162-173` | DB-enforced, both backends |
| Hosted + alert outbox idempotency | `schema.ts:179`; `supabase/migrations/0001_system_of_record.sql:291-292` | DB-enforced |
| Alert outbox claim | `src/lib/db/pg/alerts.ts:362-372` — single `UPDATE … WHERE id=? AND version=?` | **atomic CAS**, not a race |

Sharpest concrete statement of the gap, not in the report and not covered by any test:
`Journal.workerId` is a per-instance UUID (`journal.ts:47`) and `recover()`
(`journal.ts:213-221`) flips **every** `running` row not owned by this worker to `uncertain`.
Two processes sharing `${ZENITH_DATA}/agent-control/operations.sqlite` would poison each
other's in-flight operations at boot. The only thing preventing that is the
read-then-write PID file — a process-local lock is load-bearing for a durable table.

Mitigating facts that must be preserved: the two paths where a second instance would corrupt
state refuse to run — agent-control writes (`src/lib/agent-access/control/runtime.ts:29`)
and account deletion in Product-Postgres mode (`src/app/api/account/route.ts:69-77`).
Also note `src/lib/server/boot.ts:60` skips the PID claim entirely when `isServerless()`
(`src/lib/serverless.ts:19`), so on Vercel there is no single-writer claim at all.

Required: (1) `O_EXCL` + advisory lock for the data-dir claim, or make `Journal.recover()`
refuse when it sees a foreign live `workerId`; (2) move the alert settle path off
swallow-on-conflict (`src/lib/alerts/deliver.ts:718-722` logs a warning); (3) leave the
distributed claim to the DB primitives that already exist.
Regression test: a `worker_threads`-based two-writer test for the journal (the pattern
already exists at `tests/hosted/authority/busy.test.ts:1-13,39-52`).
Live verification: cross-instance claim is already asserted at
`tests/db/contract/alerts.test.ts:245-273` but only runs under `ZENITH_CONTRACT_POSTGRES=1`
with a live database — see VER-3.

### ARCH-6 — Retention, dead-letter, backup/restore operator workflow
**Classification: reproduced, broadly.** **Severity: High for production operation.** **Track: F.**

Exists: deployments (`src/lib/engine/engine.ts:616-628`, called `:697`), navigator runs
(`src/lib/navigator/run.ts:104-115`), file-store revision history
(`src/lib/db/file-store.ts:230`), agent uploads + pending-op expiry
(`src/lib/agent-access/control/journal.ts:246-250`).

Implemented but **never called from `src/`** — only from tests:
`purgeExpired` sessions (`src/lib/hosted/authority/repos/sessions.ts:180`,
`pg/repos/sessions.ts:115`), exchanges (`repos/exchanges.ts:139`, `pg/repos/exchanges.ts:84`),
`purgeExpiredWrites` (`src/lib/hosted/data/tracker-store.ts:341`, `pg-backend.ts:1062`;
TODO at `tracker-store.ts:118`).

Missing entirely: alert outbox rows, hosted outbox rows, `audit_events`
(`src/lib/db/pg/audit.ts:131-135` says so), `hosted_events`, invites, artifacts, backups.

Dead-letter: both implementations admit the gap in their headers —
`src/lib/alerts/deliver.ts:29-32` and `src/lib/hosted/authority/outbox.ts:18-23`
("`failed` is terminal … the upgrade path is a dead-letter view an operator can re-drive
from"). `listPending` exists (`repos/outbox.ts:91,208`); there is no `listFailed`, no API
route (`grep -rn outbox src/app` → only `internal/tick/outbox`), and no script.

Backup/restore: scripts exist and are wired (`package.json:37-41`), but
`docs/hosted/RUNBOOK-DEPLOY.md:172-225` states the schedule, retention, key custody and RPO/RTO
are `unknown` and that the restore procedure **has never been run**.

Regression tests: unit tests for each new retention job (bounded, idempotent, dry-run first);
a dead-letter listing + re-drive test that proves re-drive reuses the same idempotency key.
Live verification: a restore drill against a disposable Supabase project — **blocked**.

---

## 2. Security findings

### SEC-01 — Blind SSRF via alert webhooks
**Classification: partially addressed.** **Severity: Medium → Low residual.** **Track: C.**

Evidence: new `src/lib/alerts/webhook-policy.ts` — https-only, no credentials in URL, no
fragment, localhost/`.localhost` refusal, literal-IP category refusal (`:28-54`), DNS
resolution with a 10 s budget and a 64 KiB response cap (`:4-5`).
Delivery pins the resolved address through `https.request` with a custom `lookup`
(`src/lib/alerts/deliver.ts:354-372`) and refuses redirects (`deliver.ts:315-316`).
Residual: `deliver.ts:273` — "TODO(ceiling): the timeout races the send rather than aborting
the socket". No live metadata-endpoint probe has been performed.
Regression test: already added in `tests/alerts/delivery.test.ts`; add a socket-abort test for
the timeout residual.
Live verification: an egress probe against a controlled non-routable target. Local-only part
is doable; a cloud metadata probe is **blocked/out of scope**.

### SEC-02 — Webhook/signing secrets plaintext in server state
**Classification: partially addressed; migration hold.** **Severity: Medium residual.** **Track: C.**

Evidence: new and updated credentials become encrypted references —
`setChannelSecret` / `setChannelTargetSecret` (`src/lib/alerts/channels.ts:349-377`) put the
value in the secret store and keep only a non-sensitive display string on the channel row
(`:371-376`). Async equivalents at `:198-243` are what the actions actually call
(`src/lib/actions/defs/alerts-channels.ts:216,340,415`).
Residuals: (a) legacy plaintext rows persist until `npm run migrate:alert-secrets -- --apply`
and delivery fails closed meanwhile; (b) `channelTable()` deliberately skips the legacy
migration in Postgres mode (`channels.ts:610-613`); (c) credential write + settings write are
two authorities with a compensating rollback (`channels.ts:325-347`), not a transaction;
(d) the whole scheme requires `ZENITH_SECRET_KEY`, which is not available here.
Regression test: rotation / tamper / tenant-binding / redaction tests exist in
`tests/alerts/delivery.test.ts` and `tests/api/bootstrap-redaction.test.ts`; add a test that
a failed settings flush after a successful secret write leaves no orphan secret.
Live verification: migration rehearsal against representative data — **blocked**.

### SEC-03 — Plugin hashes are integrity, not publisher authentication
**Classification: partially addressed.** **Severity: Medium residual.** **Track: D.**

Evidence (plugins @ `6fb81b7`): Ed25519 envelope over canonical-JSON manifests,
`packages/provenance/index.mjs` (algorithm forced `:95-96`; explicit trust allowlist,
no embedded key, no network fetch `:105-123`; static revocation `:153`; validity window
`:158-160`). Enforced **at runtime activation, fail-closed**: `packages/provenance/consumer.mjs:22,41`
makes the gate mandatory for any generated package (a path test, so
`ZENITH_REQUIRE_PROVENANCE=0` cannot disable it), wired as the first statement of
`packages/bridge/cli.mjs:94`. Out-of-tree launcher verifies before Node imports package code
(`packages/launcher/cli.mjs:51`); generated `.mcp.json` now invokes it (`scripts/build.mjs:44`,
asserted by `scripts/check.mjs:19-24`).
**Not** enforced at build time, release time, or install time: `scripts/release.mjs` is
unchanged and never signs; `provenance:verify` (`package.json:21`) is in no workflow and not
in `verify` (`:15`); `docs/provenance.md:80-85` states there is no installer callback.
Residual work: publisher key custody/distribution/rotation, a real revocation channel, a `bin`
entry so the launcher is installable and verifiable, release-signing as a gated step,
marketplace/installer wiring.
Regression test: 15 cases exist in `tests/provenance.test.mjs` (incl. "a generated plugin
cannot disable its activation gate with the environment" `:68`) plus `tests/launcher.test.mjs`.
Live verification: signed release + trusted install on a clean host — **blocked** (no key).

### SEC-04 — Job-time `npm install` without lockfile / install-script controls
**Classification: disproved-superseded for E2B; reproduced one layer down.** **Severity: Medium.** **Track: D.**

Disproved: no runner installs packages at job time. E2B runs a pinned-version assertion via
`node -e` (`src/lib/hosted/build/runner-e2b.ts:238-255`, failure text at `:254`), Docker
pre-bakes (`runner-docker.ts:6-9`), recipe-local resolves the platform's own `node_modules`
(`runner-recipe-local.ts:113-120`). Asserted at
`tests/hosted/build/runners-isolated.test.ts:270-273`.

Reproduced elsewhere:
- `docker/recipe/Dockerfile:27` — `npm install --no-audit --no-fund --omit=dev`, version pins
  but **no lockfile and no `--ignore-scripts`**; lifecycle scripts run at image build.
- `RECIPE_INSTALL_ARGS` (`src/lib/hosted/build/recipe.ts:26-35`) is still exported
  (`build/index.ts:18`) and asserted (`tests/hosted/build/recipe-local.test.ts:306-311`)
  while no runner calls it, and it carries no `--ignore-scripts`.
- `RECIPE_IMAGE` is the mutable tag `zenith-recipe:v1` (`runner-docker.ts:30,169-175`).

There is no install-script *policy* module anywhere; the behaviour is per-file convention,
and **no single install surface has both properties**:

| Where | Command | Lockfile frozen | Scripts blocked |
|---|---|---|---|
| `Dockerfile:16` (app deps) | `npm ci` | yes | **no** |
| `Dockerfile:78` (recipe-local toolchain, behind `ZENITH_RECIPE_LOCAL=1`) | `npm install --no-save --no-audit --no-fund --ignore-scripts <pins>` | **no** | yes |
| `docker/recipe/Dockerfile:27` (image the `docker` runner trusts) | `npm install --no-audit --no-fund --omit=dev` | **no** | **no** |
| `.github/workflows/ci.yml:50,98,137` | `npm ci` | yes | **no** |
| `.github/workflows/agent-control.yml:28` | `npm ci --ignore-scripts` | yes | yes |

`docker/recipe/Dockerfile:27` is the weakest of the five and the one whose output is the
sandbox boundary the `docker` runner depends on.

What the E2B attestation does **not** cover: the digest is a self-declared string inside the
image (`runner-e2b.ts:161-193`), never computed over image bytes; it says nothing about which
packages are in the template or how they were resolved; the toolchain check compares four
`package.json` `version` fields (`:244`), not integrity hashes.
Regression test: a Dockerfile/lockfile test asserting the recipe image installs from a
committed lockfile with `--ignore-scripts`; a CI-workflow test (extend
`tests/ci/release-gates.test.ts`) pinning the install flags.

### SEC-05 — E2B egress unrestricted; no Docker-parity network policy
**Classification: partially addressed (source); unverified live.** **Severity: Medium.** **Track: D/F.**

Evidence: `allowInternetAccess: false` is in the factory type and passed at creation
(`src/lib/hosted/build/runner-e2b.ts:67-72,83,213`); teardown is in a `finally` on every path
(`:302-309`). Docker's policy is **stronger** and already tested —
`--network none`, `--read-only`, `--tmpfs /tmp`, memory/cpu/pids caps, `/src:ro`
(`runner-docker.ts:46-67`), asserted at `tests/hosted/build/runners-isolated.test.ts:463-496`.
`recipe-local` has **no network policy at all** — a child process with full host networking,
env-allowlisted only (`runner-recipe-local.ts:31,38-54`), and its boundary string admits it is
"not a hostile-code sandbox" (`:86-88`).
Gap: **no test asserts the E2B factory receives `allowInternetAccess: false`**
(`grep allowInternetAccess` hits only the source file) — the Docker equivalent is asserted.
Live verification: provider-side egress enforcement, VM reclamation, inter-job contamination —
**blocked** (no `E2B_API_KEY`).

---

## 3. UI findings

PR #9 changed no file named in any of these. `scripts/hosted-browser.ts` (gate 12) drives a
*generated hosted app*, not the product shell, at 1280×800 and 375×812; its PR #9 diff is
browser-discovery plumbing with zero new assertions. It asserts nothing about notification
routing, toasts, the product breakpoints, or the integrations page.

| ID | Classification | Severity | Evidence | Exact change | Regression test |
|---|---|---|---|---|---|
| UI-1 | **reproduced** | High | `src/components/shell/activity-bell.tsx:75-76` computes one `activityHref` from the current path or `boot.projects[0]`; every row uses it (`:134-142`). `ToastRecord` carries no project (`src/components/ui/toast.tsx:19-32`); 29 `toasts.push` sites pass none. Buffer persists in `sessionStorage["zenith-activity"]` (`activity-bell.tsx:16,20-37`), so stale records outlive the page. | Add optional `projectSlug` to `ToastInput`/`ToastRecord` (`toast.tsx:19-32`); stamp it in `push` (`toast.tsx:123-130`) from provider context so the 29 call sites stay untouched; compute `href` per row in `activity-bell.tsx:75-76,132-147`, guarded against `boot.projects`; render the existing non-link branch (`:143-145`) with an explanatory `title` for legacy/inaccessible targets. | New `tests/shell/activity-bell.test.tsx`: three seeded records (alpha, beta, no slug) with pathname `/p/alpha/...` ⇒ beta row links to `/p/beta/activity`, legacy row is not a link; record for a project absent from `boot.projects` ⇒ not a link. Note `tests/shell/workbench.test.tsx:20` currently mocks the bell out. |
| UI-2 | **reproduced** | Medium | Layout `<main id="main">` at `src/app/(product)/layout.tsx:27-29`; page opens a second at `src/app/(product)/integrations/integration-control.tsx:17` (closing `:48`). Only nested `<main>` in the product shell. | `<main>` → `<div>` at `:17`/`:48`. | `tests/screens/integrations.test.tsx`: `container.querySelectorAll("main").length === 0`. |
| UI-3 | **reproduced** | Medium | No `tailwind.config.*`; tokens are the `@theme inline` block at `src/app/globals.css:116-143`. `text-muted-foreground` is defined nowhere and used at `integration-control.tsx:18` (×2) and `:33` — Tailwind v4 emits nothing for an unknown utility, silently. The file also uses raw `rounded border px-4 py-2` buttons (`:20,29,31,44`), raw `input`/`label`/`fieldset` (`:24-28`) and `text-3xl font-semibold` instead of `.app-page-title` (`globals.css:235`). | `text-muted-foreground` → `text-ink-mute`; re-skin against `src/components/ui/{button,card,field,input,checkbox,select,callout,table,empty-state}`. Adding a `muted-foreground` token is the wrong fix. | `tests/ui/theme-tokens.test.ts`: parse `@theme inline`, scan `.tsx` for `(text\|bg\|border)-<token>` colour utilities, assert each resolves. |
| UI-4 | **reproduced** | Medium | `src/components/shell/workbench.css:55` hides `.workbench-context-evidence` and `.workbench-pending` below **1190px** with no replacement; `:74` also hides the production `ShieldCheck` and the divider below 520px, leaving colour as the only prod signal. Content is real: cost at `src/components/shell/project-chrome.tsx:42-44`, pending-change link at `:45-47`. | Replace deletion with a condensed form (numeral-only pending link; cost behind an affordance or in the account/overflow menu), or render a copy into the mobile drawer (`workbench.css:52-53`). Keep the prod icon at `:74`; drop the chevron divider instead. | `tests/ui/workbench-breakpoints.test.ts`: parse the CSS, deny-list `display:none` inside `@media` for `.workbench-context-evidence`, `.workbench-pending`, `.workbench-environment-production > svg`. |
| UI-5 | **reproduced** | Medium | `workbench.css:78` — `.workbench-project-name, .workbench-project-select { width: 66px }` at ≤380px (a fixed width overriding `:71`'s `max-width:110px; width:26vw`); env select 96px (`:72`) / prod 110px (`:79`). Both are real `<Select>`s (`project-chrome.tsx:26-31,35-40`) whose options include the synthesized `"Production · <name>"` (`:38-39`). At 13px font (`:36`) 66px is ~3-4 characters, and a native `<select>` has no ellipsis. | `width:auto; min-width:96px; max-width:34vw` at `:78`; or move project/environment selection into the mobile drawer below 380px and keep only an ellipsized name. Accessible names already exist via `aria-label`/`title`. | Extend `tests/ui/workbench-breakpoints.test.ts`: every declared width on those selectors is `auto` or ≥96px. |
| UI-6 | **partially addressed** (report partly wrong) | Low | `DISMISS_MS = 6000` confirmed (`src/components/ui/toast.tsx:43`). **Pause on hover and focus already exists** (`:210-213`), and `role="status"` + `aria-live` polite/assertive already exist (`:202-203,207-209`) — both halves of the report's claim are disproved. What remains: no `onPointerDown`/touch pause; errors and actionable toasts auto-dismiss on the same 6 s clock (`arm()` unconditional at `:138`); `resume` re-arms a full window, not the remainder. | Add `onPointerDown={() => pause(t.id)}` at `:210-213`; do not `arm()` when `kind === "err"` or `input.action` is present (`:138`); consider `prefers-reduced-motion` and ≥8 s when a `body` is present. | New `tests/ui/toast.test.tsx` with fake timers: info dismisses at 6 s; `pointerdown` keeps it; `err` never auto-dismisses; actionable toast survives 60 s; aria attributes asserted. |
| UI-7 | **disproved-superseded** | n/a | The 800 ms is a floor, not a fixed interval: `src/lib/client/api.ts:85-89` `pollDelay` is exponential (`base * 2**steps`, `MAX_IDLE_STEPS = 2` at `:75`) ⇒ 800→1600→3200 ms once responses stop changing; polling stops in a hidden tab (`:91,226,238`); conditional GET/ETag counts a 304 as idle (`:244-255`); no overlapping requests (`:235-242`). Covered by `tests/client/poll.test.ts:9-40` and `tests/client/use-json.test.tsx:73,86,114`. | None required. Optional consistency item only: add `GET /api/navigator/runs/[id]/stream` and use `useEventStream` + `streamedPollMs` as `deployment-detail.tsx:94` does. | Existing tests suffice. |

---

## 4. Verification items

| ID | Item | Classification | Evidence | What must exist |
|---|---|---|---|---|
| VER-1 | "typecheck / lint pass" | unverified here | Not re-run in this read-only pass. CI `verify` job runs them (`.github/workflows/ci.yml`), and CI on `7302ac1` reports `verify` FAIL for the invite-fixture reason, now fixed at `fe8feea`. | Integrator re-runs `npm run typecheck` and `npm run lint` at `fe8feea` and records exit codes. |
| VER-2 | "vitest 206 passed / 33 failed under Node 26 (jsdom localStorage, long hooks)" | partially addressed | PR #9 added `tests/dom-setup.ts` (a Web Storage shim when Node 26 disables jsdom's native `localStorage`) and wired it plus an explicit jsdom `url` into `vitest.config.ts`. The "long hooks" half is untouched. | One whole-suite run by the integrator on the supported Node (CI uses Node 22; this machine has Node 24.19.0), with failures classified environment vs product. Do not weaken assertions. |
| VER-3 | "no live Postgres / D1 / Cloudflare / provider acceptance" | **reproduced, and worse than stated** | `grep -rn "postgres\|services:" .github/workflows/` → **zero hits**: no service container, no `SUPABASE_DB_URL` in CI. Every live lane is `describe.skipIf(...)` on `postgresContractEnabled()` (`tests/db/contract/factories.ts:31`, `tests/hosted/authority/contract/_factories.ts:80`) and skips **silently**: `tests/db/contract/{alerts,history}.test.ts`, `tests/scripts/migrate-hosted-to-postgres.test.ts:593`, `tests/hosted/data/pg-contract.live.test.ts:139,339`, `tests/hosted/artifacts/storage-store.test.ts:351`. `postgresSkipReason()` exists (`_factories.ts:84-89`) but nothing prints it. `npm run test:contract` is invoked by no workflow. | A CI job with a `postgres` service container running the contract lanes, plus a reporting rule that a skipped live lane prints its reason and is visible as **blocked**, never green-by-absence. |
| VER-4 | Plugins "verify 130 passed / 2 skips" | partially verified | Not re-run. `package.json:15` — `verify` = `typecheck && build && test && contracts:check && check`; `contracts:check` (`:22`) **is** in `verify`. `provenance:verify` (`:21`) is in no workflow. Both plugin workflows use `npm ci --ignore-scripts` (`verify.yml:24`, `attest.yml:38`) and `git diff --exit-code` the generated `plugins/` output. | Plugin owner re-runs `npm run verify` and records counts; add `provenance:verify` to a release lane. |
| VER-5 | CI failure `UNIQUE constraint failed: index 'app_invites_pending_email'` | **fixed at `fe8feea`** | The index is correct (`src/lib/hosted/authority/schema.ts:328-331`; `supabase/migrations/0005_pending_invite_uniqueness.sql:4-5`). The production path supersedes in the same transaction (`src/lib/hosted/access/invites.ts:399-400`) and maps a genuine hit to a 409 (`:452-465`). The failures were fixtures inserting a second `pending` row: `tests/hosted/authority/access.test.ts` (one hard-coded address used twice against one app) and `tests/scripts/migrate-hosted-to-postgres.test.ts` `seed()` (resend without supersede). `fe8feea` parameterises the address and adds `await repos.invites.supersede(inviteId)`. | Integrator confirms CI green at `fe8feea`. **Open residual:** nothing transitions an invite to `expired` — the only `invites.setState` call writes `"revoked"` (`src/lib/hosted/access/invites.ts:160`); expiry is evaluated lazily in the accept predicate (`repos/invites.ts:150-156`). An expired invite therefore holds the unique-index slot forever, and the 409 fix text at `invites.ts:453-454` ("wait for it to expire") is wrong. Track B. |

---

## 5. The five task-brief corrections

| # | Statement | Verdict | Evidence |
|---|---|---|---|
| 1 | `src/lib/db/pg/all.ts` imports core/history/audit/alerts; history implements revision/manifest/deployment/event persistence; audit is PG; alerts covers findings, Navigator runs, alert rules/events/outbox with cross-instance claim logic. | **Confirmed.** | `all.ts:6-9`; registrations at `history.ts:428,467`, `audit.ts:318`, `alerts.ts:123,147,166,193,221`; delegates `history.ts:716-717`, `audit.ts:318`; claim is a single version-guarded `UPDATE` (`alerts.ts:362-372`). Caveat: the surrounding persist→refresh→claim→settle sequence is several PostgREST round trips, not one transaction, and a lost settle is only logged (`deliver.ts:718-722`). |
| 2 | `src/lib/secrets/index.ts` encrypts application secrets and selects a PG backend; that does **not** prove alert-channel secrets / webhook URLs use it. | **Confirmed, and it is now partly moot.** | Backend selection `src/lib/secrets/backend.ts:93-99`. Alert channels *do* use it as of PR #9 — `src/lib/alerts/channels.ts:198-243` (async) and `:349-377` (sync), called by `src/lib/actions/defs/alerts-channels.ts:216,340,415`. Residual: legacy plaintext rows, and the write spans two authorities with compensating rollback rather than a transaction (`channels.ts:325-347`). |
| 3 | `sync-rest.ts` bridges network calls through `worker_threads` + `Atomics.wait`, blocking the event loop. | **Confirmed; substantially narrowed, not removed.** | Mechanism and self-assessment at `src/lib/db/pg/sync-rest.ts:1-46` ("It blocks the event loop for the duration of the query… TODO(ceiling): the real fix is widening `Store`'s audit readers and the secret accessors to promises"). Remaining `restSync` callers, **complete list**: `audit.ts:201` (`appendAudit`), `:221` (`readAuditPage`), `:279` (`countAudit`); `history.ts:252` (`readManifest`), `:567` (`maxSeqSync`), `:705` (`events.readEvents`); `secrets/pg-backend.ts:80,90,105,117` (sync `get`/`list`/`set`/`remove`). See §6 for which are still reachable. |
| 4 | `docs/AGENT-CONTROL.md` refuses reviewed PG writes / serverless control; removing the refusal alone would be a regression. | **Confirmed, and the refusal is in code, not only docs.** | `docs/AGENT-CONTROL.md:30`; implemented at `src/lib/agent-access/control/runtime.ts:23` (control requires a long-lived host: `ZENITH_AGENT_CONTROL === '1' && !isServerless()`) and `:29` (writes refuse `isPostgres()`); reinforced at `:204,217`; mirrored for account deletion at `src/app/api/account/route.ts:69-77`. |
| 5 | `ZENITH_STORE` and `ZENITH_HOSTED_STORE` select different subsystems. | **Confirmed.** | `ZENITH_STORE` — `src/lib/env.ts:69`, consumed by `src/lib/db/store.ts:52-70` and `src/lib/secrets/backend.ts:93-99`. `ZENITH_HOSTED_STORE` — `src/lib/hosted/config.ts:40`, consumed by `src/lib/hosted/index.ts:84`. Independent by design; both fail closed on an unknown value (zod `safeParse` throw at `config.ts:106-111`, `env.ts:191`). Note `ZENITH_AGENT_*` are the only `ZENITH_*` family **outside** a validated schema — read raw with strict `=== '1'` comparisons (`runtime.ts:23,29`, `zenith-reader.ts:134`, `oauth.ts:7,14-18`), so they fail closed but a typo disables silently. |

---

## 6. `restSync` reachability after PR #9 (the specific question asked)

| Call site | Function | Still reachable on a request/worker hot path? |
|---|---|---|
| `src/lib/db/pg/audit.ts:201` | `appendAudit` (sync `Store` method) | **No live caller found.** The only repo-wide `appendAudit` callers are `src/lib/server/account.ts:378` (`appendAuditBatch`, file-mode only — Postgres deletion refuses at `api/account/route.ts:69-77`) and `src/lib/actions/core.ts:377`, which uses `appendAuditAsync`. Reachable only through the `Store` interface if a future caller uses the sync façade. |
| `audit.ts:221` / `:279` | `readAuditPage` / `countAudit` | **No** on the API path — `src/app/api/projects/[id]/audit/route.ts:96-101` branches on `isPostgres()` to the async variants. **Yes** via `readAudit` in `src/lib/server/account.ts:284` (`buildAccountExport`, a "synchronous compatibility export" with no caller — the route uses `buildAccountExportAsync`, `src/app/api/account/export/route.ts:18`) and `:363` (inside the account-delete path, file-mode only). Both are effectively dead in Postgres mode but are not *prevented* from running. |
| `history.ts:252` | `readManifest` → `manifests` delegate → `q.revisionManifest` | **Yes, in React Server Components.** `src/app/preview/[deploymentId]/[serviceId]/page.tsx:49-50` reads `revision.manifest` (the lazy accessor). Every other caller is async (`payload.ts:60`, `revisions/[id]/route.ts:15`, `deploy.ts:132`, `secrets.ts:150`, `runtime.ts:174`, `zenith-reader.ts:98,120`, `verification.ts:39`). The sync `deployedManifest`/`changesetFor` (`src/lib/actions/defs/deploy.ts:125-136`) have no remaining callers. |
| `history.ts:567` | `maxSeqSync` | **Only in file mode** — `src/lib/engine/engine.ts:169` returns `nextEventSeq(...)` first when `isPostgres()`. Reachable in Postgres mode only as the seq-collision fallback inside `nextEventSeq`. |
| `history.ts:705` | `events.readEvents` (sync delegate) | **No** on the SSE path — `src/app/api/deployments/[id]/events/route.ts:48-50` branches to `readEventsAsync`. Reachable through the sync façade only. |
| `secrets/pg-backend.ts:80,90,105,117` | sync `get`/`list`/`set`/`remove` | **No.** The only sync-secret consumers are in `src/lib/alerts/channels.ts` (`:62,78,89,98,109,293,295,305,308,310,354,357,369,388,418,422`), and every one of them sits behind `channelTable()`'s `if (!isPostgres())` guard (`channels.ts:610-613`) or behind the sync `setChannel*` functions, whose only callers are the async variants' file-mode twins. The actions use `*Async` (`alerts-channels.ts:216,340,415`). |

**Conclusion.** The honest statement is: `restSync` is no longer on any *awaited request path*
except one — the preview React Server Component's manifest read — but the synchronous `Store`
and secret contracts still exist and nothing prevents a new caller from re-entering the
bridge. The sync surfaces that are now dead (`buildAccountExport`, `deployedManifest`,
`changesetFor`, the sync secret accessors) should be deleted, and the `Store` audit/manifest
readers widened, so the bridge can be removed rather than policed. That is the remaining
Track A work.

## Disposition at the integration head

Recorded after every wave-1 packet and the post-review fixes merged; the
evidence for each row is the command and exit code in
`IMPLEMENTATION-STATUS.md` section 3.2 and the CI record in section 3.2a.

| ID | Status | Evidence |
|---|---|---|
| ARCH-1a (history/audit/alerts authority) | disproved-superseded; prose corrected | `src/lib/db/pg/all.ts`, `history.ts`, `audit.ts`, `alerts.ts` are the Postgres authority; headers and ADR 1 rewritten |
| ARCH-1b (server components read the file store) | fixed | `processSnapshot()` throws when unprimed; `/overview` runs in `runInStoreScope()`, `/preview` reads by id; `tests/db/rsc-scope.test.ts` |
| ARCH-1c (`save()` mirrors `state.json`) | fixed | `PostgresStore.save/flush` no longer call `FileStore`; local echo via `announce()` |
| ARCH-1d (one shared graph per process) | fixed | `loadSnapshot` builds over `emptyGraph()`; `tests/db/snapshot-isolation.test.ts` fails on the old line |
| ARCH-2 (file store acks before fsync) | partially addressed | bounded tail-repairing audit append with idempotent retry (`tests/db/audit-batch.test.ts`); `fsync` and a crash test remain (packet A2); file mode documented local/single-writer |
| ARCH-3 (split idempotency) | contract fixed; window still process-local and disclosed | key = workspace + actor + action + key bound to a canonical payload hash; retained only after the durable flush; `idempotency_in_flight` while pending; `tests/actions/idempotency.test.ts`, `tests/api/actions-idempotency-commit.test.ts` |
| ARCH-4 (D1/Cloudflare) | unverified | no credentials, no lane; experimental in `DEPLOYMENT-MATRIX.md` |
| ARCH-5 (process-local coordination) | narrowed | outbox fence token + renew in both backends; catalog-based index check; leased boot replay; in-process cron scheduler for long-lived Postgres hosts; still process-local: mutation gate, reader limiter, data-dir claim |
| ARCH-6 (retention / dead letters / restore drill) | open | packet F2 in `WORK-GRAPH.md` |
| SEC-01 (webhook SSRF) | addressed; residual low | transition ranges and obfuscated literals blocked, port policy, pinned connection, socket-closing deadline, bounded fan-out; `tests/alerts/webhook-policy.test.ts` |
| SEC-02 (plaintext alert secrets) | addressed on the file store; explicit and operable on Postgres | encrypted refs with tenant/channel AAD; Postgres legacy rows enumerated, migration exits 1 naming them; `docs/hosted/PROVIDERS.md` |
| SEC-03 (plugin provenance) | partially addressed (substantially), companion PR | launcher bin, verified private copy, descriptor binding, mandatory expiry, rollback floor, gated release signing; installer wiring and key custody remain |
| SEC-04 (job-time installs) | addressed at the committed inputs | no runner installs at job time (asserted); frozen script-free image installs; CI `--ignore-scripts`; the application image built in CI; the recipe image is unbuilt |
| SEC-05 (E2B egress) | partially addressed; unverified live | factory options asserted, abort forwarded, teardown bounded, attestation v2; docker digest-pinned; recipe-local refuses in hosted mode |
| UI-1 to UI-6 | fixed | `tests/shell/**`, `tests/ui/**`, `tests/screens/**`; browser screenshots at seven widths |
| UI-7 | disproved at baseline; residual gaps closed | 2 s base with jitter, cancellation, terminal stop, stale completion fixed; 76 to 28 requests/min measured |
| VER (Node 26 failures, no Postgres lane, POSIX-only tests) | addressed | whole suite green on Node 24 and CI Node 22; Postgres CI lane executed 161 assertions; POSIX-only suites skip with a printed reason on win32 |
