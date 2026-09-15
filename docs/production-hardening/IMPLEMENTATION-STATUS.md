# Production-hardening implementation status

This is the integration record for the draft hardening PR. It is not a claim
that Zenith is production-ready in any backend.

**The rule this document is now written to:** every number in it names the
command that produced it and that command's exit code. Anything not produced by
a command that was actually run says **BLOCKED** and why. There is no third
category. A number with no command behind it is deleted rather than softened —
the previous revision of this file carried eleven such numbers and one claim
that was false, and that is the failure mode this rule exists to prevent.

Conventions:

- **VERIFIED** — a command was run, its exit code recorded, its output read.
- **BLOCKED** — cannot be run here, with the reason and what would unblock it.
- **PENDING INTEGRATION** — will be produced by the integrator after the tracks
  merge; the placeholder says which command produces it.

---

## 1. Baseline

| Fact | Value | Command | Exit | Where |
|---|---|---|---|---|
| Branch base | `hardening/integration` @ `7302ac1`, plus `fe8feea` | `git log --oneline` | 0 | integrator worktree |
| Typecheck at the baseline | passed | `npx tsc --noEmit` | 0 | Windows 11, Node 24.19.0 |
| Lint at the baseline | passed | `npx eslint .` | 0 | Windows 11, Node 24.19.0 |
| Whole suite at the baseline, local | **238 files passed, 2 files failed** | `npx vitest run` | non-zero | Windows 11, Node 24.19.0 |
| — the two failures | `tests/agent-control-journal.test.ts`, `tests/agent-control-rate-limit.test.ts`, both `requires an owned private POSIX directory` | — | — | win32-only; see §4 |
| Whole suite at `7302ac1`, CI | **2515 passed, 1 failed** | CI `verify` job | non-zero | Linux, Node 22 |
| — the one failure | the invitation fixture (`UNIQUE constraint failed: index 'app_invites_pending_email'`) | — | — | fixed at `fe8feea` |

Three runtimes are in play and none of these numbers is comparable to another:
CI runs Node 22, this machine runs Node 24.19.0, and the original external
report's counts were taken under Node 26. That divergence is itself an open
item — see §6, VER-2.

**Note on the previous revision's counts.** The figures it quoted (282/282,
57/57, 96/96, 23/23, 24/24, 22/22, 144+2, 36/15, 116, 114+1, 47/47) were never
reproduced against `fe8feea`. They are removed from this document rather than
carried forward. Where the underlying work is real, its evidence is re-gathered
under §3 or marked PENDING INTEGRATION.

---

## 2. Corrections to the previous revision

| Previous claim | Status | Basis |
|---|---|---|
| "UI routing/accessibility/polling: **source and browser gates passed**" | **DELETED — the claim was false.** | `git diff 45d0658..7302ac1 --stat` touches no file named in UI-1..UI-7. `scripts/hosted-browser.ts` is gate 12: the *hosted-app recipient* journey against a generated app, not the product shell. Its diff over the baseline is browser-discovery plumbing and adds zero assertions. It asserts nothing about notification routing, toasts, the product breakpoints, or the integrations page. UI-1..UI-5 reproduce unchanged; UI-6 partially; UI-7 was already false at the baseline. Track E owns the fixes and the first real product-shell gate. |
| "the async repository binds tenant bodies", offered as evidence for the `sync-rest` widening | **Misleading.** | `src/lib/db/pg/async-repository.ts` has zero production callers; the widening went through `restAsync` directly. Track A3. |
| The verification counts in the old §Verification | **Unattributed.** | See the note in §1. |

---

## 3. What this branch verifies, with the command that verified it

### 3.1 Track F1 — verification infrastructure *(this packet)*

| Change | Commits | Command | Exit | Result |
|---|---|---|---|---|
| A PostgreSQL CI job with a service container, applying `supabase/migrations/0001`–`0005` and running the two raw-Postgres contract lanes | `66765f9`, `ca8c0c7` | — | — | **BLOCKED locally.** GitHub Actions cannot be run on this machine, and neither can the job's database: no Docker daemon (`docker version` → cannot connect to the Linux engine pipe) and no local PostgreSQL (`which psql` → not found). The job is **unverified until the integrator pushes the branch.** What it is designed to prove and not prove is in §5. |
| Every workflow validated by the pinned validator | `ca8c0c7` | `actionlint 1.7.12 -shellcheck shellcheck-0.10.0 .github/workflows/{ci,tick,agent-control}.yml` | 0 | 0 errors, 3 files. actionlint was downloaded to a scratch directory, checksum-matched against the release's own `actionlint_1.7.12_checksums.txt`. |
| The migration apply script | `66765f9` | `shellcheck scripts/ci/apply-supabase-migrations.sh` | 0 | clean. `bash -n` also 0. **Its behaviour against a database is BLOCKED** — see the row above. |
| The lane report's failure path | `66765f9` | `node scripts/ci/postgres-lane-report.mjs <report with no Postgres lanes>` | 1 | Both intended lanes printed `DID NOT RUN`, nine BLOCKED lanes emitted as `::warning::`, summary table written. |
| The lane report's success path | `66765f9` | `node scripts/ci/postgres-lane-report.mjs <report containing PostgresAuthority + live-migrate names>` | 0 | Both lanes `RAN`. |
| The lane report's error paths | `66765f9` | missing report file; no argument | 1, 1 | An unreadable report fails rather than reporting "nothing skipped". |
| Release-gate policy, extended to the install flags, the toolchain pins and the new job | `fd83118` | `npx vitest run tests/ci` | 0 | **26 passed**, 0 failed (was 15). |
| The two POSIX-only agent-control files, before | — | `npx vitest run tests/agent-control-journal.test.ts tests/agent-control-rate-limit.test.ts --no-file-parallelism` | 1 | 14 passed, **3 failed** (2 files). |
| The two POSIX-only agent-control files, after | `834dab0` | same command | 0 | **14 passed, 3 skipped** (2 files), each skip preceded by a printed reason naming `journal.ts:54-57` / `rate-limit.ts:22-25`. |
| Typecheck after this packet's changes | `fd83118` | `npx tsc --noEmit` | 0 | — |
| Lint after this packet's changes | `fd83118` | `npx eslint tests/ci tests/agent-control-journal.test.ts tests/agent-control-rate-limit.test.ts scripts/ci` | 0 | — |
| `npm ci --ignore-scripts` is safe for this dependency tree | `ca8c0c7` | a scan of every `package.json` under `node_modules` for `preinstall`/`install`/`postinstall` | 0 | **2 of them**: `esbuild@0.28.2` and `unrs-resolver@1.12.2`. Both resolve their native binary from `optionalDependencies`, which `npm ci` installs; `napi-postinstall`'s `checkAndPreparePackage` breaks out of its loop on the first `require.resolve` that succeeds (`lib/index.js:176-187`) and esbuild's `install.js` only hard-links the binary over its JS shim as an optimisation. `package.json` declares no `prepare`/`postinstall` of its own. **Empirically unverified** — a clean `npm ci --ignore-scripts` cannot be run here (`node_modules` is a junction shared across the worker worktrees, and a Windows install would install Windows binaries, which proves nothing about the Linux runner). The corroborating evidence is that `agent-control.yml` has been running `npm ci --ignore-scripts` followed by `npm run typecheck` and vitest on ubuntu already. **`npm run lint` and `npm run build` under `--ignore-scripts` are verified by the first CI run on this branch and not before.** |

Full local suite after this packet: superseded by the integration run in section 3.2.

### 3.2 Integration head `a3dbc80` - every track merged, whole-tree gates

All commands below were run by the integrator from the integration checkout at
`a3dbc80` (Windows 11, Node v24.19.0, npm 11.6.0), one heavyweight process at a
time, after the last merge. CI on Linux/Node 22.16.0 for this head is recorded
in section 6 as it lands.

| Gate | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | 0 | clean |
| Lint | `npx eslint .` | 0 | clean |
| Whitespace | `git diff --check 7302ac1..HEAD` | 0 | clean |
| Whole suite | `ZENITH_FAST=1 npx vitest run` | 0 | 261 files passed, 2 skipped; 2800 passed | 34 skipped (2834) |
| Production build | `npm run build` | 0 | compiled; the pre-existing `module.createRequire failed parsing argument` warning from `src/lib/hosted/build/recipe.ts` remains |
| Smoke | `npm run smoke` | 0 | `SMOKE PASS` - happy path and failure/rollback path both hold |
| Gimbal assets | `npm run gimbal:verify` | 0 | all production asset checks passed |
| Hosted acceptance | `npx tsx scripts/hosted-acceptance.ts` (recipe-local, local runtime) | 0 | 22 checks, publish through restore |
| Hosted browser journey (gate 12) | `npx tsx scripts/hosted-browser.ts` | 0 | 24 passed, 0 failed, installed Chrome via playwright-core |
| Plugins compatibility | `npm run contracts:check -- --backend <this checkout>` in the plugins checkout | 0 | inventory matches the shared client and this backend |

The two skipped files are the POSIX-only agent-control journal and rate-limit
suites (section 3.1); on Linux CI they run.

Per-track evidence, as recorded in each worker handoff and re-run by the
integrator through the whole-suite command above:

| Track | Merge | What landed | Targeted command (worker) | Exit |
|---|---|---|---|---|
| E1 | `7723a75` | per-row notification routing with an honest unavailable state; Integrations screen rebuilt on the product kit with one `main`; persistent err/warn/actionable toasts, pointer/touch pause | `npx vitest run tests/shell tests/ui tests/screens/...` (26 files / 218) | 0 |
| E2 | `8982831` | compact cost/pending context below 1190px; readable project/environment controls down to 320px; navigator polling 2000 ms base with jitter, cancellation, terminal stop and one final refresh (76 to 28 requests/min active, 21 to 9 quiet, fake timers); real-browser screenshots at 320/375/380/520/899/1190/1280 | `npx vitest run tests/client tests/navigator tests/shell tests/ui` | 0 |
| F1 | `9475688` | section 3.1 | section 3.1 | - |
| D1 | `c15f69d` | `docker/recipe` and `Dockerfile` installs frozen and script-free from committed lockfiles; `RECIPE_INSTALL_ARGS` deleted; `ZENITH_RECIPE_IMAGE` digest-only; E2B factory options asserted, abort forwarded, `kill()` bounded, attestation v2 with key id and expiry; recipe-local refuses in hosted mode without acknowledgement | `npx vitest run tests/hosted/build --no-file-parallelism` (73) | 0 |
| A1 | `dac2d3a` | unprimed Postgres reads throw; `/overview` and `/preview` read the real authority; no `state.json` writes in Postgres mode; deletion journal records the attempt before the provider call; keepalive refuses in Postgres mode; bounded audit append | `npx vitest run tests/db tests/api --no-file-parallelism` (92 + 127) | 0 |
| B1 | `37bbdf2` | idempotency key `workspace:actor:action:key` bound to a canonical payload hash; save before audit; invite `pending -> expired`; catalog-based index check; outbox fence token on `attempts` with renew; coordinator authority facts | `npx vitest run tests/actions tests/hosted/access tests/hosted/authority tests/agent-control-coordinator.test.ts --no-file-parallelism` (43 files / 539) | 0 |
| C1 | `c038baa` | IPv6 transition ranges blocked; port policy 443/8443 plus allowlist; `ZENITH_ALERT_WEBHOOK_ALLOW_INSECURE` honoured only outside hosted mode on the file store; socket-closing deadline; bounded fan-out; retry classification; leased boot replay; Postgres legacy secrets reported as blocked with exit 1 | `npx vitest run tests/alerts tests/actions/security-alerts-isolation.test.ts tests/api/bootstrap-redaction.test.ts --no-file-parallelism` (192) | 0 |
| integrator | `f7c3dd0`, `b3e2d01` | engine ticker off on Postgres; runtime authority facts port | whole suite | 0 |
| fix C | `a1bafe7` | settle conflicts re-read by id; only a live rival claim counts as a possible duplicate | `npx vitest run tests/alerts --no-file-parallelism` (141) | 0 |
| fix B | `1dee77c` | idempotency outcomes retained only after the durable flush (`idempotency_in_flight` while pending, `commit_failed` on a failed inline flush); `listInvites` read-only; exact audit dedupe by id | `npx vitest run tests/actions tests/api --no-file-parallelism` (429) | 0 |
| fix A | `a3dbc80` | per-request Postgres graphs (no shared `FileStore.db()`); in-process cron scheduler for long-lived Postgres hosts inside `inCronScope()`; `nudge()` gated; invite reconciliation query in the runbook | `npx vitest run tests/db tests/engine tests/api --no-file-parallelism` (253) | 0 |

Independent review after integration: a fresh reviewer and the architecture
reviewer each read the diff and the logs. Their blocking items
(retained-before-flush idempotency, shared snapshot graph, no background work
on a long-lived Postgres host, missing reconciliation query, stale status
document, plugin help and rollback-floor gaps) are the fix commits above.

### 3.2a CI on the pushed head `0bd513e` (Linux, Node 22.16.0)

| Job | Conclusion | Notes |
|---|---|---|
| verify | pass | typecheck, lint, whole suite, smoke, Gimbal under `npm ci --ignore-scripts` |
| hosted | pass | hosted suites, acceptance journey, gate 12 in the runner's Chrome |
| build | pass | `npm run build` under `npm ci --ignore-scripts` |
| docker | pass | the application image assembles with `npm ci --ignore-scripts` (the recipe image is not built by CI) |
| postgres | **fail, then fixed** | migrations 0001-0005 applied and verified; `tests/hosted/authority/contract/**` + the migrate suite ran **161 tests, 161 passed, 0 skipped** against the service container, so the `PostgresAuthority` rows executed for the first time. The lane report then failed the job because vitest formats `$name` quoted (`'PostgresAuthority' ...`) and the matcher looked for the bare word; fixed in the next commit and pinned by `tests/ci/postgres-lane-report.test.ts`. |
| Vercel | pass | preview deployment |

### 3.3 Companion plugins (`GODOSTROYER/Zenith-plugins`, branch `hardening/plugin-provenance`)

| Gate | Command | Exit | Result |
|---|---|---|---|
| Verify lane | `npm run verify` | 0 | 176 tests, 159 passed, 0 failed, 17 platform skips (POSIX-only file-mode guards on Windows) |
| Deterministic generation | `npm run build && git status --porcelain` | 0 | empty |
| Backend compatibility | `npm run contracts:check -- --backend <app checkout>` | 0 | matches |

---

## 4. Platform notes

**Windows local runs.** Agent control is only supported on a long-lived POSIX
host, and both durable stores enforce it in code: `Journal`
(`src/lib/agent-access/control/journal.ts:54-57`) and `DurableRateLimiter`
(`src/lib/agent-access/control/rate-limit.ts:22-25`) refuse a durable file
unless its parent directory is owned by this uid and private to it, with
`process.platform === 'win32'` an explicit disjunct of the refusal. The three
on-disk test cases therefore skip on win32, printing the guard and its
file:line; the `:memory:` cases still run everywhere, and nothing skips on
Linux or macOS. CI executes all seventeen.

**Node.** CI now pins `22.16.0` in every job — `ci.yml` previously floated on
`22` while `agent-control.yml` pinned the patch. `package.json`'s `engines.node`
floor is `>=22.16` and `node:sqlite` is an experimental API on that runtime, so
the exact patch is part of what a green run means.

---

## 5. What the PostgreSQL lane proves, and what it cannot

Designed in `ca8c0c7`; **not yet executed** (§3.1).

**It is designed to prove**

1. `supabase/migrations/0001`–`0005` apply in order to an empty PostgreSQL 16:
   every table, partial unique index, CHECK, identity column and plpgsql
   function, and the migration ledger the runtime refuses to boot without
   (`src/lib/hosted/authority/pg/index.ts:165-191`). The apply script re-reads
   the ledger and the `app_invites_pending_email` index definition afterwards
   rather than trusting psql's exit code.
2. `tests/hosted/authority/contract/**` runs its **PostgresAuthority** factory
   row, not only its SQLite one: real transactions, rollback isolation, fence
   tokens, the outbox, and the three partial unique indexes that no repository
   can expose and that only `raw()` can assert.
3. The live half of `tests/scripts/migrate-hosted-to-postgres.test.ts`: insert
   order, idempotence on a second run, and the three SQLite→Postgres
   conversions (boolean, `bytea`, `overriding system value`).
4. That a lane which ran zero tests is a **failure**. `scripts/ci/postgres-lane-report.mjs`
   fails the job when either lane above produced no passing tests — the
   hosted-authority suites are `describe.each` over a factory table whose
   Postgres row is *absent* when the gating variables are unset, so without this
   check a run that exercised no Postgres is indistinguishable from one that did.

**It cannot prove, and says so on the run page**

| Lane | Why | What would unblock it |
|---|---|---|
| `tests/db/contract/**` (product store) | **BLOCKED — needs PostgREST, not Postgres.** The factory builds `PostgresStore`, a `supabase-js` client over `NEXT_PUBLIC_SUPABASE_URL` with `SUPABASE_SERVICE_ROLE_KEY` (`tests/db/contract/factories.ts:31-34`). A bare Postgres container serves none of it. Pointing it at the container would make the lane fail, not pass. | A Supabase project, or a PostgREST container in front of this database. |
| `tests/hosted/data/pg-contract.live.test.ts` | **BLOCKED — same reason.** `hostedPgClient()` is a supabase-js client and the suite probes `rpc('app_record_update_atomic')` over PostgREST (`:38-41,60-74`). | As above, with the `hosted` schema exposed. |
| `tests/hosted/artifacts/storage-store.test.ts` (live bucket) | **BLOCKED** — needs a Supabase Storage bucket and service-role key (`:344-346`). | Supabase credentials plus the `zenith-artifacts` bucket. |
| Supabase's role graph and RLS | **BLOCKED.** `service_role` in the CI database is a NOLOGIN stand-in created so the migrations' grant blocks apply; the tests connect as the container superuser, which bypasses RLS for a different reason than Supabase's service role does. Nothing here proves `anon`/`authenticated` see nothing. | A Supabase project. |
| Cloudflare / D1 | **BLOCKED** — no credentials, no workflow, zero acceptance evidence. Must not be implied as supported anywhere. | `ZENITH_CF_*` credentials. |
| E2B, live | **BLOCKED** — provider-side egress enforcement, VM reclamation, inter-job contamination and controller access are unverified; only the local policy is tested. | `E2B_API_KEY` and a published template digest. |
| Docker build runner, live image | **BLOCKED** — CI's `hosted` job runs `ZENITH_BUILD_RUNNER=recipe-local`, which has no network policy at all; the docker runner's isolation flags are asserted statically and never executed. | A CI lane that builds `docker/recipe` and runs one job through the docker runner. |
| SMTP / invitation delivery | **BLOCKED** — no mail credentials; delivery runs against doubles. | A disposable SMTP sink. |
| S3 / Storage backup-restore drill, RPO/RTO | **BLOCKED** — `npm run hosted:backup-live-check` is wired to LocalStack locally and to nothing in CI. | A LocalStack service container in this workflow, or real bucket credentials. |
| OAuth provider sign-in | **BLOCKED** — no provider credentials. | Test-tenant credentials per provider. |

Every row above is emitted as a `::warning::` and written to
`$GITHUB_STEP_SUMMARY` on each run of the job, so an absent lane is visible
rather than inferred from silence.

---

## 6. Open items

| ID | Item | Status |
|---|---|---|
| VER-1 | typecheck / lint at `fe8feea` | **VERIFIED** — both exit 0 (§1). |
| VER-2 | Three Node runtimes (CI 22, this machine 24.19.0, the external report 26) and three different failure counts | **RECONCILED LOCALLY, CI PENDING.** On Node 24.19.0/Windows the whole suite is 261 files passed, 2 skipped (section 3.2); the only local-vs-Linux difference is the two POSIX-only files, which now skip with a printed reason. The external report's 33 failures under Node 26 were the jsdom storage harness (fixed in PR #9 by `tests/dom-setup.ts`) and long hooks; neither reproduces at this head. CI on 22.16.0 for `a3dbc80` is recorded here when it lands. |
| VER-3 | No live Postgres / D1 / Cloudflare / provider acceptance | **PARTIALLY CLOSED BY DESIGN, UNVERIFIED IN FACT.** The lane exists (§5) and fails when it runs nothing; it has never been executed. D1, Cloudflare and every provider remain fully blocked. |
| VER-4 | Plugins `npm run verify` counts | **VERIFIED** - section 3.3: 176 tests, 159 passed, 0 failed, 17 skipped. `provenance:selftest` runs in the verify lane; `provenance:verify` is a gated release step because it needs release artifacts and the operator trust file. |
| VER-5 | `app_invites_pending_email` CI failure | **Fixed at `fe8feea`** (test fixtures, not the index); the residual is closed by `expireOverdue` in both backends (B1) with the sweep kept out of the read path (fix B). |
| — | `docs/hosted/RUNBOOK-DEPLOY.md:226` ("Vercel is not a valid host for this topology") contradicts `vercel.json` and `tick.yml` | **OPEN.** Needs a decision, not more reading. Track F2/F3. |
| — | `postgres-lane.json` is written under `.data-ci-lane/`, matched by `.gitignore`'s `.data-*/` | Closed. |

---

## 7. Release envelope

Unchanged in substance: the branch is suitable only as a **draft** application
PR for review of the tested slices and the architecture record. It does not
authorize production cutover, destructive migration, secret rotation, package
publishing, or enabling PostgreSQL agent-control writes.

The three refusals stay: serverless agent control
(`src/lib/agent-access/control/runtime.ts:23`), reviewed writes under
`ZENITH_STORE=postgres` (`:29`), and self-service account deletion in
Product-Postgres mode (`src/app/api/account/route.ts:69-77`). Nothing in this
packet touches them, and the PostgreSQL lane that would have to exist before any
of them could be reconsidered is exactly the one that has not run yet.

## 8. Rollback

Revert the implementation and documentation commits as a normal Git revert, or
merge only the individual fix commit a release owner requires. No database
migration and no production data transformation is introduced by this branch.
The CI `postgres` job creates and destroys its own disposable container and
never reaches a Supabase project: `SUPABASE_DB_URL` in that job is a literal
`127.0.0.1` address written in the workflow, not a secret.
