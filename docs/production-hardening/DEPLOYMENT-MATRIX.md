# Deployment matrix — what is supported, what is experimental, what is unproven

Evidence commit: `hardening/integration` @ `fe8feea` (src evidence gathered at `7302ac1`;
the two intervening commits touch only test fixtures).

Three columns of status are used and they mean different things:
- **Supported** — the topology is intended, the code enforces its preconditions, and
  acceptance evidence exists or is scheduled in `WORK-GRAPH.md`.
- **Experimental** — legal to configure, no acceptance evidence, must not be implied as
  production-ready anywhere.
- **Unsupported / must fail closed** — a durability or authorization invariant is violated;
  the boot path should refuse.

"Evidence available here" means: gatherable on this Windows machine with no provider
credentials. "Blocked" means it needs credentials or a provider account that is not present.

---

## 1. Local development

| Dimension | Value |
|---|---|
| Selectors | `ZENITH_STORE=file`, `ZENITH_HOSTED_STORE=sqlite`, `ZENITH_BUILD_RUNNER=none` or `recipe-local`/`docker` |
| Host | one long-lived process, one data directory |
| Status | **Supported** |
| Authorities | product = `FileStore`; hosted = embedded SQLite; artifacts = local dir; agent journal = SQLite under `${ZENITH_DATA}/agent-control/` |
| Single-writer guarantee | PID claim on the data dir (`src/lib/server/boot.ts:60`, `src/lib/data-lock.ts:58-95`) — a pid file, not a real lock (`data-lock.ts:14-17`) |
| Agent control | the **only** mode where it may be enabled (`src/lib/agent-access/control/runtime.ts:23,29`) |

**Measurable acceptance criteria**
1. `npm run typecheck` exit 0; `npm run lint` exit 0.
2. `npm test` (vitest, whole suite) — a single integrator run on Node 22; every failure
   classified environment vs product, no assertion weakened.
3. `npm run smoke` and `npm run gimbal:verify` exit 0.
4. `npm run hosted:acceptance` — publish/invite/launch/conflict/revoke/backup/restore/
   post-restore-denial checks pass.
5. **Crash durability, currently missing:** a child process killed after an acknowledged
   mutation and before the 50 ms coalescing window closes still has that mutation after
   restart — or file mode is explicitly labelled non-durable and refuses hosted mode.
   (Packet A2.)
6. Restart resumes from disk with no manual step.

**Evidence available here:** 1–4 and 5–6 are all local. Nothing in this row is blocked.
**Evidence currently missing:** 5 has no test at all. `src/lib/db/file-store.ts:12-17` states
the loss window in prose; there is no test that measures it.

---

## 2. Supported hosted production — Vercel + Supabase Postgres + Supabase Storage

| Dimension | Value |
|---|---|
| Selectors | `ZENITH_STORE=postgres`, `ZENITH_HOSTED_STORE=postgres`, `ZENITH_HOSTED_MODE=1` |
| Host | Vercel serverless (`vercel.json`, `regions: ["bom1"]`); `isServerless()` true (`src/lib/serverless.ts:19`) |
| Product store | PostgREST as the service role, `public.*` (19 tables), migration `0001` |
| Hosted authority | `hosted.*` over a direct pooled Postgres connection (Supavisor transaction mode, port 6543), migrations `0002`–`0005` (`docs/HOSTED-POSTGRES.md`) |
| Artifacts | Supabase Storage bucket `zenith-artifacts` (`src/lib/hosted/artifacts/storage-store.ts`) |
| Scheduling | GitHub Actions `tick.yml`, `*/5 * * * *`, POSTs `engine`/`alerts`/`outbox`/`jobs` to `/api/internal/tick/*` with a constant-time bearer; plus `vercel.json` keepalive cron at 06:00 |
| Agent control | **unavailable** — refused twice (`runtime.ts:23` serverless, `:29` postgres) |
| Account deletion | **unavailable** — refused before any side effect (`src/app/api/account/route.ts:69-77`) |
| Status | **Supported target**, with two open correctness blockers (below) |

**Open blockers that must close before this row can be called supported**
- **ARCH-1b (High).** React Server Components read the file store instead of Postgres
  (`src/lib/db/postgres-store.ts:277-285,309-311`; reproduces at
  `src/app/(product)/overview/page.tsx:32` and
  `src/app/preview/[deploymentId]/[serviceId]/page.tsx:40-52`). On Vercel the file store is a
  fresh per-instance `/tmp`, so `/overview` renders empty and every preview URL 404s.
  Packet A1.
- **VER-3.** No CI lane exercises Postgres at all
  (`grep -rn "postgres\|services:" .github/workflows/` → nothing); every live contract lane
  is `describe.skipIf`-ed and skips silently. Packet F1.

**Measurable acceptance criteria**
1. Migrations `0001`–`0005` applied; the boot schema check passes both the version **and** the
   name **and** the `app_invites_pending_email` index definition
   (`src/lib/hosted/authority/pg/index.ts:165-191`, `pg/repos/migrations.ts:45-82`).
2. `ZENITH_CONTRACT_POSTGRES=1` + `SUPABASE_DB_URL` set: `tests/db/contract/**` and
   `tests/hosted/authority/contract/**` run with a non-zero count and pass — including
   `tests/db/contract/alerts.test.ts:245-273` ("exactly one of two snapshots claims a pending
   row"), which is the repository's only real cross-instance assertion.
3. `/overview` and one preview URL render real data from Postgres with an empty `ZENITH_DATA`.
4. Tenant isolation: an object id from workspace A returns 404 for a member of workspace B on
   every id-resolving route (`inWorkspace`, `src/lib/db/store.ts:235-236`).
5. No blocking bridge on any awaited request path: `grep -rn restSync src/` reduces to the set
   in `FINDING-MATRIX.md` §6 and then to empty (packet A3). Event-loop lag measured under
   concurrent audit reads.
6. Every mutating request commits before the response leaves (`flushPendingAsync` awaited in
   `route()`); a 409 is returned on a version conflict, never a silent overwrite.
7. Outbox: a failed row is listable and re-drivable with the same idempotency key (packet F2).
8. Retention jobs run bounded and idempotent for sessions, exchanges, write ledger, audit,
   hosted events, outbox (packet F2).
9. Backup taken, restored to a clean target, `reopen` gate passes, post-restore revocations
   re-applied; measured RPO/RTO recorded.
10. Readiness endpoint reports, per authority: reachable, migration version, selector,
    serverless.

**Evidence available on this machine, no credentials:** 4 and 5 (static + unit), and the
readiness endpoint's shape once it exists. A local PostgreSQL container could satisfy 2 for the
**hosted authority** lanes (direct connection) — that is exactly what packet F1 builds.
**Blocked without credentials:** 1, 3, 6 end-to-end, 7 and 8 against real data, 9 against
Supabase, and anything measuring Vercel instance behaviour. The product-store contract lanes
speak PostgREST, so a bare Postgres container may not satisfy them; F1 must say so rather than
fake it.

**Known truth-in-advertising conflict to resolve:**
`docs/hosted/RUNBOOK-DEPLOY.md:226` is titled "Vercel is not a valid host for this topology",
while `vercel.json` and `tick.yml` (default `base_url` `https://tryzenith.cloud`) describe a
live Vercel deployment. One of the two is wrong. Nothing in CI or config encodes a split
between the control service and the main app. Packet F2/F3 must reconcile this in writing
before this row is signed off.

---

## 3. Supported hybrid — product Postgres + hosted SQLite, long-lived host

| Dimension | Value |
|---|---|
| Selectors | `ZENITH_STORE=postgres`, `ZENITH_HOSTED_STORE=sqlite` |
| Host | one long-lived process (**not** serverless) |
| Status | **Supported, documented** (`docs/HOSTED-POSTGRES.md`); the blanket mixed-mode refusal that PR #9 tried was correctly reverted |
| Caveat | no cross-authority atomicity is implied, and none exists |

**Acceptance criteria:** as row 2 items 1–6 for the product half, plus the SQLite authority's
own acceptance (`npm run hosted:acceptance`) on a persistent disk, plus an explicit statement
in the runbook that a product-store write and a hosted-authority write are two commits.
**Evidence here:** available. **Blocked:** the product-store Postgres half.

---

## 4. Unsupported — must fail closed

| Combination | Why | Current behaviour | Required |
|---|---|---|---|
| `ZENITH_HOSTED_STORE=sqlite` on serverless | the control authority's SQLite file and per-app files live on a per-instance ephemeral `/tmp`; acknowledged hosted state (grants, sessions, jobs, outbox) vanishes per instance — a direct durability-invariant violation | **No guard.** `assertHostedPreconditions()` (`src/lib/hosted/index.ts:42-63`) checks `SUPABASE_DB_URL` for the postgres case and Supabase keys + the Node floor for hosted mode, and never looks at `isServerless()`. `grep -rn "isServerless\|VERCEL" src/lib/hosted/` hits only `release/runner.ts:66`. | a boot refusal with a `Fix:` sentence (ADR D-11) |
| `ZENITH_STORE=file` on serverless | per-instance `/tmp` product state, and the PID claim is **deliberately skipped** (`src/lib/server/boot.ts:60`, `src/lib/serverless.ts:11-17`) so there is no single-writer claim at all | no guard | a boot refusal |
| Agent-control reviewed writes with `ZENITH_STORE=postgres` | request-isolated snapshots are not protected by the process mutation gate; no coordinated transaction exists | **correctly refused** (`src/lib/agent-access/control/runtime.ts:29`) | keep. ADR D-8 lists the six proofs required to lift it |
| Agent control on serverless | control assumes a long-lived single-writer host | **correctly refused** (`runtime.ts:23`) | keep |
| Self-service account deletion with `ZENITH_STORE=postgres` | Supabase identity deletion and product-state deletion cannot commit together | **correctly refused before any side effect** (`src/app/api/account/route.ts:69-77`) | keep until a durable cross-authority workflow exists |

---

## 5. Experimental backends

| Backend | Selector | Status | What exists | What is missing / blocked |
|---|---|---|---|---|
| **Cloudflare / D1 runtime** | `ZENITH_RUNTIME=cloudflare` (`src/lib/hosted/config.ts:41`) + `ZENITH_CF_ACCOUNT_ID`, `_NAMESPACE`, `_PROBE_URL`, `_BROKER_MODULE` (`:66-77`), `ZENITH_CF_API_TOKEN` presence-only | **Experimental — zero acceptance evidence** | config validation and adapter code | no CI lane touches it (`grep -rn cloudflare .github/workflows/` → nothing); no live probe, no deploy, no teardown evidence. **Blocked** — no Cloudflare credentials. Do not imply support anywhere. |
| **E2B build runner** | `ZENITH_BUILD_RUNNER=e2b` + `E2B_API_KEY` + `ZENITH_E2B_TEMPLATE` + `_DIGEST` + `_ATTESTATION_PUBLIC_KEY` | **Hold — local policy implemented, live gate open** | bare-template-ID enforcement and tag/`latest` rejection (`config.ts:45-54`); signed Ed25519 attestation verified before upload and the provider-resolved ID re-checked (`runner-e2b.ts:161-193`); no job-time package install (`:238-255`); `allowInternetAccess: false` (`:67-72,83,213`); teardown in a `finally` on every path (`:302-309`); 23-case isolated suite | the digest is a **self-declared string inside the image**, never computed over image bytes, and says nothing about which packages the template holds or how they were resolved (`:244` compares four `package.json` version fields). No test asserts `allowInternetAccess: false` is actually passed. Provider-side egress enforcement, VM reclamation, inter-job contamination, controller access: **blocked** without `E2B_API_KEY`. |
| **Docker build runner** | `ZENITH_BUILD_RUNNER=docker` | **Closest to supportable of the three runners** | strongest network/filesystem policy and it is **tested**: `--network none`, `--read-only`, `--tmpfs /tmp`, memory/cpu/pids caps, `/src:ro` (`runner-docker.ts:46-67`, asserted `tests/hosted/build/runners-isolated.test.ts:463-496`) | image is a **mutable tag** `zenith-recipe:v1` (`runner-docker.ts:30,169-175`), not a digest; the image's own install is neither lockfile-frozen nor script-free (`docker/recipe/Dockerfile:27`). Both closable here — packet D1. |
| **`recipe-local` runner** | `ZENITH_BUILD_RUNNER=recipe-local` | **Development only** | env allowlist and forbidden-prefix filtering (`runner-recipe-local.ts:31,38-54`), SIGKILL on timeout/cancel, bounded logs | **no network policy at all** — a child process with full host networking; its own boundary string says it is "not a hostile-code sandbox" (`:86-88`). Must refuse under `ZENITH_HOSTED_MODE=1` without an explicit acknowledgement. Note CI's `hosted` job runs with `ZENITH_BUILD_RUNNER=recipe-local`, which is correct for CI and must not be read as production endorsement. |
| **Hosted SQLite authority** | `ZENITH_HOSTED_STORE=sqlite` | **Supported on a long-lived host; unsupported on serverless** (row 4) | full repo parity with the Postgres backend — 15 repos each, real transactions (`authority/tx.ts:129-138`), leases, fencing tokens, single-flight indexes | `node:sqlite` is an experimental Node API on the minimum supported runtime (`docs/AGENT-CONTROL.md:30`); Node ≥22.16 is enforced only in hosted mode (`src/lib/hosted/index.ts:57-62`) |
| **File-mode agent control** | `ZENITH_AGENT_CONTROL=1` + `ZENITH_AGENT_WRITES=1`, file store, long-lived host | **The only supported agent-control topology** | durable SQLite journal with `UNIQUE(workspace, subject, request_key)` and payload-hash binding (`control/journal.ts:69,113-121`); durable SQLite rate limiter (`control/rate-limit.ts:15-41`); re-entrant mutation gate widened across grant/member/account paths | the process-local PID file is load-bearing for a durable table's correctness: `Journal.workerId` is per-instance (`journal.ts:47`) and `recover()` (`:213-221`) marks every foreign `running` row `uncertain`. No multi-OS-process test exists (`tests/agent-control-journal.test.ts:93-110` is two connections in one process). Packet B2. |

---

## 6. What can be gathered here, and what is blocked — one list

**Gatherable on this machine, no provider credentials:**
- typecheck, lint, the whole vitest suite, `smoke`, `gimbal:verify`, `test:contract`
  (SQLite rows only), `hosted:acceptance`, `hosted:browser` (needs a local Chromium).
- A crash-durability test for the file store (packet A2).
- A local PostgreSQL container for the **hosted authority** contract lanes, which use a direct
  connection (`src/lib/hosted/authority/pg/client.ts`).
- Every static/unit assertion in this document: tenant isolation, install-flag policy,
  workflow shape (`tests/ci/release-gates.test.ts`), CSS breakpoint rules, token resolution.
- `npm run hosted:backup-live-check` against LocalStack (`docker compose up -d localstack`),
  which exercises put/get byte-equality, listing, two ledger appends and an `If-Match` probe.

**Blocked without credentials — record as blocked, never simulate:**
- Anything against a real Supabase project: product-store PostgREST contract lanes, migration
  rehearsal for `0005`, hosted Postgres authority against Supavisor, Storage-bucket artifact
  round trips, alert-secret migration rehearsal, the Postgres half of
  `tests/scripts/migrate-hosted-to-postgres.test.ts`.
- Anything on Vercel: instance freezing behaviour, per-instance `/tmp`, cold-start readiness,
  the `tick.yml` schedule hitting a live origin.
- E2B: egress enforcement, teardown/VM reclamation, contamination, terms.
- Cloudflare/D1: everything.
- A live webhook SSRF probe against a real metadata endpoint (and it should not be attempted).
- A Supabase-backed backup/restore drill and therefore a measured RPO/RTO.
- Plugin publisher-key operations: key generation in real custody, a signed release, a trusted
  install, marketplace installation.
