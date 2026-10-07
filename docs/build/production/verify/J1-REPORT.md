# J1 builder report

Worktree: `Z:/Projects/Spawned.ai/zenith-wt/prod6-j1-default-stack`; branch `prod/j1-default-stack`; base `3a9de905`. All changes are uncommitted. No `.git` mutation, npm installation, package edit, migration edit, Docker execution or cloud call. PKG-04/06 implementation statuses are `implementation_complete_verification_pending`; acceptance states remain `in_progress`.

## Files changed or added (19)

Modified:

- `scripts/deploy/installation.mjs`
- `src/lib/controlplane/db/repos/workflow-start-deploy-authority.ts`
- `tests/deploy/installation.test.ts`
- `docs/build/production/ledger.json` (only PKG-04/06 rows)

Added:

- `deploy/self-hosted/supabase-gateway.mjs`
- `scripts/acceptance/default-stack/config.mjs`
- `scripts/acceptance/default-stack/runtime.mjs`
- `scripts/acceptance/default-stack/up.mjs`
- `scripts/acceptance/default-stack/readiness.mjs`
- `scripts/acceptance/default-stack/cleanup.mjs`
- `scripts/acceptance/default-stack/pooler-probe.mjs`
- `scripts/acceptance/default-stack/verify-database.mjs`
- `src/lib/controlplane/db/repos/mcp-product-endpoint.ts`
- `tests/deploy/default-stack.test.ts`
- `tests/deploy/default-stack.engine.test.ts`
- `tests/controlplane/mcp-product-endpoint.test.ts`
- `docs/build/production/verify/PKG-04.md`
- `docs/build/production/verify/PKG-06.md`
- `docs/build/production/verify/J1-REPORT.md`

## Executed verification commands

Every PowerShell invocation prepended `C:\Users\user\.local\sdk\node22` to `PATH`. Node version readback: **v22.23.3**. Compiler invocations additionally set `NODE_OPTIONS=--max-old-space-size=4096`. Unit rows count test cases; compiler/lint/syntax rows count command invocations. Repeated runs overlap and must not be summed into unique coverage.

| Exact command | Observed pass / fail / skip |
| --- | --- |
| `npx tsc --noEmit -p .` (first pass) | 1 / 0 / 0; exit 0, no diagnostics |
| `npx tsc --noEmit -p .` (incremental successor after fixes) | 1 / 0 / 0; exit 0, no diagnostics |
| `npx vitest run tests/deploy/default-stack.test.ts tests/controlplane/mcp-product-endpoint.test.ts tests/deploy/default-stack.engine.test.ts --no-file-parallelism --maxWorkers=2` (04:29 run) | 26 / 0 / 3; 2 passed files, 1 gated file |
| Same exact vitest command (04:38 successor) | 26 / 0 / 3; 2 passed files, 1 gated file |
| Same exact vitest command (04:46 successor) | 27 / 0 / 3; 2 passed files, 1 gated file |
| Same exact vitest command (04:51 final successor) | 27 / 0 / 3; 2 passed files, 1 gated file |
| `npx vitest run tests/controlplane/mcp-deploy-admission.test.ts --no-file-parallelism --maxWorkers=2` | 0 / 0 / 18; existing real-PostgreSQL gate, no native cases executed |
| ESLint command below, first run | 1 / 0 / 0; exit 0; 0 errors, 1 warning (`no-unused-expressions`), subsequently fixed |
| Same exact ESLint command, three successors | Each 1 / 0 / 0; exit 0; 0 errors, 0 warnings |
| `node --check scripts/acceptance/default-stack/up.mjs`; `node --check scripts/acceptance/default-stack/config.mjs`; `node --check scripts/deploy/installation.mjs` (initial syntax checks) | 3 / 0 / 0 |
| `node --check scripts/acceptance/default-stack/up.mjs`; `node --check scripts/acceptance/default-stack/runtime.mjs` (runner fix checks) | 2 / 0 / 0 |
| Syntax loop below (three complete runs) | Each 9 / 0 / 0 |
| `git diff --check` (repeated focused checks) | Every invocation exit 0; no whitespace errors |
| Node inline JSON comparison of `git show HEAD:docs/build/production/ledger.json` with the working tree, excluding only `PROD-PKG-04`/`PROD-PKG-06` | 1 / 0 / 0; `unownedLedgerRowsUnchanged=true` |

Exact ESLint command:

```powershell
npx eslint scripts/deploy/installation.mjs scripts/acceptance/default-stack/*.mjs deploy/self-hosted/supabase-gateway.mjs src/lib/controlplane/db/repos/mcp-product-endpoint.ts src/lib/controlplane/db/repos/workflow-start-deploy-authority.ts tests/deploy/default-stack.test.ts tests/deploy/default-stack.engine.test.ts tests/deploy/installation.test.ts tests/controlplane/mcp-product-endpoint.test.ts
```

Exact complete syntax loop (seven acceptance scripts plus installer and HTTPS gateway):

```powershell
Get-ChildItem -LiteralPath 'scripts/acceptance/default-stack' -Filter '*.mjs' | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
node --check scripts/deploy/installation.mjs
node --check deploy/self-hosted/supabase-gateway.mjs
```

Read-only inspection commands had no test-case counts: `git status --short`, `git status --short --untracked-files=all`, `git log --oneline -10`, `git diff --stat`, `git diff --numstat`, `git diff -- docs/build/production/ledger.json`, `git branch --show-current`, `git show HEAD:docs/build/production/ledger.json`; `rg`, `rg --files`, `Get-Content`, `Get-ChildItem`, `Get-Command` over the preamble, PLAN-100, handoff, ledger, skills, installer/compositions/Dockerfiles, MCP callers/tests, driver TLS code, existing verification records and parent AGENTS inventory. Node one-liners read/update only the two ledger rows; one later restored baseline escaping to keep other rows byte-for-byte unchanged. `Get-Process -Name node` was diagnostic only.

Inspection limitations: initially absent PKG-04/06 verify files were confirmed before creation; some exploratory guessed paths/PowerShell wildcard paths did not exist. `wsl --list --quiet` failed once with `WSL/E_ACCESSDENIED`; `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"` failed once with access denied. Neither was a test failure or a substitute for POSIX verification. No process belonging to another job was modified.

## Pending, deviations and integration

- Three stack-engine cases: **not run, needs Docker, pinned Supabase CLI, real PostgreSQL/Temporal and POSIX private permissions**. Existing installer suite: not run here, needs POSIX plus actual Compose config checks. Exact serial Mac setup/run/cleanup commands are in PKG-04/06.
- Native MCP admission's 18 skipped cases need the real-PostgreSQL successor. Added endpoint contracts do not substitute for it.
- The local endpoint admission fix is complete, but the existing atomic MCP final admission requires one opened product/platform database authority while the installer requires separate server authorities. Both predicates remain intact. A DUR cross-database admission join is still required; no fake success flag or privileged fallback was added.
- Two-worker execution, authenticated browser/customer-agent acceptance, clean-host recovery and hosted production acceptance remain their owners' joins. Lean 1+1 success cannot prove default 2+2 acceptance. Supabase vendor image identities are captured at first boot; reviewed snapshot input provides strict clean-host reproduction. The builder did not invent unobserved vendor digests.
- No scope or permission deviation. The only changed existing expectation is `additionalWorkerPreparationSupported: false -> true`: `prepare --join` now exists, preserves the exact private keyring and produces an independent scratch volume. New POSIX tests cover actual preparation and keyring-drift refusal; pure contracts passed here. No assertions or gates were weakened, removed or conditionally bypassed.

Suggested commit: `feat(deploy): add owned default stack and worker keyring joins`
