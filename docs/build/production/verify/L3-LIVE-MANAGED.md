# L3-LIVE-MANAGED builder verification and handoff

Worktree: `Z:/Projects/Spawned.ai/zenith-wt/prod6-l3-live-managed`; branch `prod/l3-live-managed`; base `443bfeaf`. Working-tree changes only. No commit, push, migration, SQL aggregate or dependency changes. No real cloud, credentials, Docker, PostgreSQL, Temporal, kind or browser run.

## Files

8 harness files: `scripts/acceptance/managed-acceptance.sh`; `scripts/acceptance/live/managed/{plan,runner,transport,cli}.ts`; `scripts/acceptance/live/mixed/{probes.ts,acceptance.sh}`; `scripts/acceptance/live/release/acceptance.sh`.

3 tests: `tests/acceptance/live-managed.test.ts`, `live-managed-transports.test.ts`, `live-l3.gated.test.ts`.

27 per-requirement verify documents for MAN/MIX/OPS/REL; `docs/build/production/ledger.json` changes only 27 implementation-status/note pairs. Acceptance text, requirement state/evidence and all release flags are unchanged. Owner runbook: `docs/build/production/LIVE-ACCEPTANCE-MANAGED.md`. This report and `L3-COMMANDS.json` preserve the builder audit. Total: 42 changed/added files.

## Commands and actual outcomes

Every PowerShell shell invocation prepended Node 22 to PATH. The Git Bash syntax command exported `/c/Users/user/.local/sdk/node22` first. Detected runtime: `v22.23.3`. Exact shell invocations (including read-only inspections and file-generation commands) are in [L3-COMMANDS.json](L3-COMMANDS.json). Read-only inspections and mutations have no test pass/fail/skip counts; their non-test outcomes are described below.

### Targeted test attempts

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; $env:ZENITH_LIVE_MANAGED='0'; $env:ZENITH_LIVE_MIXED='0'; $env:ZENITH_LIVE_RELEASE='0'; npx vitest run tests/acceptance/live-managed.test.ts tests/acceptance/live-l3.gated.test.ts --no-file-parallelism --maxWorkers=2
```
35 passed, 0 failed, 3 skipped; 1 passed file, 1 skipped file.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; $env:ZENITH_LIVE_MANAGED='0'; $env:ZENITH_LIVE_MIXED='0'; $env:ZENITH_LIVE_RELEASE='0'; npx vitest run tests/acceptance/live-managed.test.ts tests/acceptance/live-l3.gated.test.ts tests/release/live-scope-coverage.test.ts --no-file-parallelism --maxWorkers=2
```
78 passed, 0 failed, 3 skipped; 2 passed files, 1 skipped file.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; $env:ZENITH_LIVE_MANAGED='0'; $env:ZENITH_LIVE_MIXED='0'; $env:ZENITH_LIVE_RELEASE='0'; npx vitest run tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts tests/release/live-scope-coverage.test.ts tests/acceptance/mixed-evidence.test.ts tests/acceptance/mixed-connectivity-probe.test.ts tests/acceptance/mixed-traffic.test.ts --no-file-parallelism --maxWorkers=2
```
143 passed, 0 failed, 3 skipped; 6 passed files, 1 skipped file.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; $env:ZENITH_LIVE_MANAGED='0'; $env:ZENITH_LIVE_MIXED='0'; $env:ZENITH_LIVE_RELEASE='0'; npx vitest run tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts tests/release/live-scope-coverage.test.ts tests/acceptance/mixed-evidence.test.ts tests/acceptance/mixed-connectivity-probe.test.ts tests/acceptance/mixed-traffic.test.ts --no-file-parallelism --maxWorkers=2
```
144 passed, 0 failed, 3 skipped; 6 passed files, 1 skipped file.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; $env:ZENITH_LIVE_MANAGED='0'; $env:ZENITH_LIVE_MIXED='0'; $env:ZENITH_LIVE_RELEASE='0'; npx vitest run tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts tests/release/live-scope-coverage.test.ts tests/acceptance/mixed-evidence.test.ts tests/acceptance/mixed-connectivity-probe.test.ts tests/acceptance/mixed-traffic.test.ts --no-file-parallelism --maxWorkers=2
```
Final post-review run: 145 passed, 0 failed, 3 skipped; 6 passed files, 1 skipped file. All skipped cases are the 3 explicit owner-cloud profiles, not acceptance passes.

### Lint

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; npx eslint scripts/acceptance/live/managed scripts/acceptance/live/mixed/probes.ts tests/acceptance/live-managed.test.ts tests/acceptance/live-l3.gated.test.ts
```
Exit 1: 2 unused-import errors, 0 warnings; corrected in runner.ts and transport.ts.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; npx eslint scripts/acceptance/live/managed scripts/acceptance/live/mixed/probes.ts tests/acceptance/live-managed.test.ts tests/acceptance/live-l3.gated.test.ts
```
Exit 0: 0 errors, 0 warnings.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; npx eslint scripts/acceptance/live/managed scripts/acceptance/live/mixed/probes.ts tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts
```
Exit 0: 0 errors, 0 warnings.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; npx eslint scripts/acceptance/live/managed scripts/acceptance/live/mixed/probes.ts tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts; git diff --check; git diff --numstat; git ls-files --others --exclude-standard
```
Exit 0: 0 errors, 0 warnings.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; npx eslint scripts/acceptance/live/managed scripts/acceptance/live/mixed/probes.ts tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts
```
Final post-review lint: exit 0, 0 errors, 0 warnings. No existing assertion was weakened, removed or skipped. No stale test expectation was changed.

### Typecheck

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH; bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
```

Final serial invocation: exit 0, 0 TypeScript diagnostics (1 successful check, 0 failed, 0 skipped). It covers the numeric-bound and OCI-account validation fixes. The earlier invocation was still queued when this result arrived; it was interrupted with Ctrl-C to avoid a redundant compile (exit 1, no diagnostics, no typecheck result). Both used the mandatory serial lock script; no direct whole-repo tsc was run and no shared lock or other job's process was changed.

### Shell syntax and CLI plan smoke

```bash
export PATH="/c/Users/user/.local/sdk/node22:$PATH"
for script in scripts/acceptance/managed-acceptance.sh scripts/acceptance/live/mixed/acceptance.sh scripts/acceptance/live/release/acceptance.sh; do bash -n "$script" || exit; done
node --version
```

Exit 0: 3 shell syntax checks passed, 0 failed, 0 skipped; Node v22.23.3.

Each profile wrapper was run with --plan: 3 passed commands, 0 failures, 0 skips; all emitted callsMade=0, credentialsRead=false, approval=not_approved and explicitly incomplete placeholder estimates. Managed/mixed have 6 pending scenarios; release has 24. No cloud was called. Exact loop invocation is in the command audit.

git diff --check: exit 0, no whitespace errors. Git status/log/diff/branch/show/ls-files were read-only. The optional Win32_Process diagnostic returned Access denied; Get-Process subsequently supplied safe process metadata. A later lookup of an already exited Node PID returned no process (shell exit 1); the final compiler exit 0 was obtained from its own session. Initial reads of nonexistent owned/verify files reported missing paths and were followed by creation of those required files. One apply_patch attempt failed atomically due to an incomplete documentation line match; it was reapplied correctly. These are not test passes or blocked acceptance evidence.

## Remaining work and joins

All real-cloud/operational/engine/browser checks: NOT RUN (needs the Mac verifier, operated disposable stack, actual cloud/Stripe/DNS/ACME/source fixtures and accountable approvals). Root permissions remain unapproved and lack managed/release mutation grants. Owner exact-plan approval FILEs and a shared conservative budget book are mandatory.

Existing L1 helpers are AWS-specific. This handoff uses the allowed helper fallback under live/managed, with the shared release Scope/digest and existing MIX checkers. Integrator must join L1/L2 provider-specific inventories and budget book, J1/J2/J4/J5/J6/J11/J14/J15 actual receipt producers and J12 dossier/signoff. Generic tag indexes do not prove every global/untaggable kind absent; OCI native inventory is explicitly unsupported. Full scenario assertions and both connectivity vantages require owner review. No schema need in L3.

Cleanup is always attempted for accepted runs, including failures/SIGINT/SIGTERM; SIGKILL/power loss cannot run finally, and expired/revoked product permissions still refuse. Original journals permit bounded cleanup-only recovery; no forward mutation replay or privileged fallback.

No scope deviation: tests, requirement verify docs and pending ledger notes are explicitly authorized by the job. No commits; orchestrator owns integration and commits.

Suggested commit: `feat(acceptance): add gated managed mixed and release live harnesses`
