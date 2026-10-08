# J1 single-database revision report

Worktree: Z:/Projects/Spawned.ai/zenith-wt/prod6-j1-default-stack, branch prod/j1-default-stack.
Revision base: orchestrator commit 08d7d4b5. Changes are uncommitted for integration.
The owner's round-2 decision replaces the separate-server topology. No .git writes,
package installations/edits, new migrations, published SQL edits, Docker operations,
real credentials or cloud calls were made on the builder. Only PKG-04/06 ledger notes
changed; both implementation statuses remain implementation_complete_verification_pending.

## Changed files (21)

- scripts/deploy/installation.mjs: exact shared runtime URL, same-project direct/session
  migrator validation, derived local direct URL, v2 format and explicit v1 refusal,
  no platform.env, corrected disposable resource plan; private/TLS/source guards retained.
- deploy/self-hosted/compose.disposable.yml: remove platform-db, its volume/dependencies;
  keep pinned Temporal. compose.yml and production.input.example.json: supported topology.
- scripts/acceptance/default-stack/config.mjs, up.mjs: one Supabase DB, direct migration
  network alias, no-op migration status/apply check, default pool size 15 (lean 5).
- scripts/acceptance/default-stack/readiness.mjs, pooler-probe.mjs, verify-database.mjs:
  actual native database/system identifier comparison, max migration equals the highest
  registered version imported from migrations/index.ts, no private schema USAGE for
  anon/authenticated, RLS on every platform table, real PostgREST PGRST106 refusals,
  one backup/restore covering public/hosted/agent/platform. Peer HTTP probes preserve
  canonical Host on the declared second transport port.
- src/lib/controlplane/db/repos/workflow-start-deploy-authority.ts: export pure
  mcpCompositionFromEnv. Endpoint comparison predicate, opened-handle provenance,
  actual database/role/schema query, default REST-client check and both rechecks retained.
  workflow-start-intents.ts and its permanent attempt CAS are unchanged.
- tests/deploy/installation.test.ts, default-stack.test.ts, default-stack.engine.test.ts,
  tests/controlplane/mcp-product-endpoint.test.ts: derived/mismatched URLs, migration
  realm validation, v1 format, absent platform service/env/volume, exact API/worker URLs,
  installer-to-MCP local/hosted contracts, canonical peer Host and real engine assertions.
- tests/deploy/installation.native.test.ts (new): original private directory, symlink,
  keyring, effective-env, HTTP and actual Compose assertions retained for the POSIX
  successor, plus actual v1 private-directory refusal. Explicit gate:
  ZENITH_ACCEPTANCE_INSTALLATION_PRIVATE=1. No assertion deleted or weakened.
- docs/platform/INSTALLATION.md, docs/adr/0002-platform-control-store.md,
  docs/build/production/verify/PKG-04.md, PKG-06.md, J1-REPORT.md and
  docs/build/production/ledger.json: one-authority architecture, runtime postgres role,
  unsupported future split without a new DUR protocol, exact lean Mac setup/pooler,
  browser human approval, two actual API claims, native Temporal history and cleanup.

Cleanup code itself already enumerates only exact ownership labels and contains no
platform service/database selector. It continues to clean owned v1 resources, including
obsolete platform containers/volumes, before fresh v2 preparation. No global prune.

## Exact verification commands and counts

All PowerShell invocations prepend C:\Users\user\.local\sdk\node22 to PATH.
Git Bash starts with export PATH="/c/Users/user/.local/sdk/node22:$PATH".
Counts below are cases for Vitest and command invocations for compiler/lint/syntax.
Repeated runs overlap and do not constitute additional unique coverage.

| Command | Pass / fail / skip |
| --- | --- |
| bash /z/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh, first run | 0 / 1 / 0; exit 2, TS2353 in installation.test.ts:117 (excess-property fixture typing) |
| Same serialized compiler after fixes | 1 / 0 / 0; exit 0, no diagnostics |
| npx vitest run tests/deploy/installation.test.ts tests/deploy/default-stack.test.ts tests/controlplane/mcp-product-endpoint.test.ts tests/deploy/installation.native.test.ts tests/deploy/default-stack.engine.test.ts --no-file-parallelism --maxWorkers=2 | 94 / 0 / 68; 3 passed files, 2 gated files |
| npx vitest run tests/deploy/installation.test.ts tests/deploy/default-stack.test.ts tests/controlplane/mcp-product-endpoint.test.ts tests/deploy/installation.native.test.ts tests/deploy/default-stack.engine.test.ts tests/controlplane/mcp-deploy-admission.test.ts --no-file-parallelism --maxWorkers=2 | 95 / 0 / 86; 3 passed files, 3 gated files |
| npx eslint scripts/deploy/installation.mjs scripts/acceptance/default-stack/*.mjs src/lib/controlplane/db/repos/workflow-start-deploy-authority.ts tests/deploy/installation.test.ts tests/deploy/installation.native.test.ts tests/deploy/default-stack.test.ts tests/controlplane/mcp-product-endpoint.test.ts | 1 / 0 / 0; 0 errors, 0 warnings |
| npx eslint scripts/deploy/installation.mjs scripts/acceptance/default-stack/*.mjs src/lib/controlplane/db/repos/workflow-start-deploy-authority.ts tests/deploy/installation.test.ts tests/deploy/installation.native.test.ts tests/deploy/default-stack.test.ts tests/deploy/default-stack.engine.test.ts tests/controlplane/mcp-product-endpoint.test.ts | 1 / 0 / 0; 0 errors, 0 warnings |
| npx eslint tests/deploy/installation.test.ts tests/controlplane/mcp-product-endpoint.test.ts tests/deploy/installation.native.test.ts, after typing fixes | 1 / 0 / 0; 0 errors, 0 warnings |
| Syntax loop below, initial (without final gateway check) | 8 / 0 / 0 |
| Full syntax loop below | 9 / 0 / 0 |
| node --check scripts/deploy/installation.mjs, after footprint correction | 1 / 0 / 0 |
| PKG-04 inline Node blocks piped to node --input-type=module --check, first/successor/final | 4 / 0 / 0, 5 / 0 / 0 and 5 / 0 / 0; syntax only, including nested Temporal history script, no requests executed |
| Node JSON integrity checks using git show HEAD:docs/build/production/ledger.json and JSON.parse of production.input.example.json | 2 / 0 / 0; unowned ledger rows unchanged, example JSON valid |
| git diff --check (five focused runs, including final report) | Each 1 / 0 / 0 |

Exact full syntax loop:

~~~powershell
Get-ChildItem -LiteralPath scripts/acceptance/default-stack -Filter '*.mjs' | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
node --check scripts/deploy/installation.mjs
node --check deploy/self-hosted/supabase-gateway.mjs
~~~

The type error was fixed by storing the intentionally unknown-key input in a variable
before runtime validation, preserving the exact unknown-field rejection assertion.
The cross-contract fixture also has an explicit InstallationInput annotation. No
expectation changed for typing. The final Vitest increase is the peer-origin regression.

Read-only inspection/edit commands are not acceptance checks (case counts N/A):
git status --short, git log --oneline -10, git diff --stat, git diff --numstat,
git diff --name-only, focused git diff, git show HEAD:docs/build/production/ledger.json;
rg / rg --files / Get-Content / Get-ChildItem over PREAMBLE, PLAN-100, WIP handoff,
ledger, serial compiler helper, installer/Compose/Dockerfile source, migration registry,
MCP source/tests and installed Temporal SDK declarations; Get-Item on the compiler
lock and Get-Process -Name node were diagnostics only. File edits used apply_patch
and private, literal Node scripts reading/writing only this worktree. Some exploratory
reads used non-existent guessed paths or unsupported PowerShell globs; the lock is a
directory so Get-Content on it returned exit 1. Those are inspection misses, not test
failures. No other job's process or lock was modified outside the mandated helper.

## Stale expectations changed, with justification

- Shared product/platform authority is now accepted; separate authority and differing
  host/port/database/user/password/TLS strings refuse with platform-authority-is-product-database.
  Old separate-server refusal and platform-only TLS error expectations contradict the decision.
- Production fixtures use a matching 20-character Supabase project and postgres pooler
  realm; migration fixtures use its direct/session port 5432. Disposable fixtures use
  the exact local CLI origin/pooler and derived direct Supabase DB.
- Disposable services/volumes/dependencies no longer contain platform-db/platform-data;
  only the pinned Temporal engine remains in its overlay. Assertions now require absence.
- Prepared fixtures are schemaVersion 2; v1 explicitly requires re-prepare without copying data.
- The engine restore assertion reads authorityRecovery instead of productRecovery;
  it still requires authorizationPreserved=true for the one dump containing all schemas.
- Existing native admission and source-authority suites, gates and assertions are unchanged.
  The private filesystem/Compose suite is explicitly gated to the Mac testing split;
  its original assertions are retained, with pure URL checks also run here.

## Pending and scope

65 POSIX/private-installation cases, 3 Docker stack cases and 18 native PostgreSQL
admission cases were not run here (86 gated cases in the final command). They need
POSIX permissions, Docker/Compose, pinned Supabase CLI, real PostgreSQL/Temporal and
the Mac successor. PKG-04/06 contain exact commands, required env vars and expected
results. Hosted Supabase/cloud acceptance remains deferred. The real browser consent,
linked credential, local customer target/revision and operation fixture remain J2's
join; OAuth interoperability remains J10's join. The documented Mac commands use
actual APIs, native approval/attempt rows and Temporal history and never fabricate
an approval or write an attempt. No production verification is claimed.

No topology deviation from the owner's decision. Necessary supporting changes:
explicit native test file/gate for unavailable POSIX/Compose requirements; canonical
Host routing for the peer readiness/MCP verification. Neither relaxes an admission
predicate. No migration, package, alternate role, proof flag or callback was added.

Suggested commit: fix(deploy): share Supabase authority for MCP admission
