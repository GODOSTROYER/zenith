# J12 release status local handoff and command record

Worktree `Z:/Projects/Spawned.ai/zenith-wt/prod6-j12-release-status`, clean initial head `443bfeaf`. All 15 changed/added files remain uncommitted for the orchestrator. Node observed: `v22.23.3`. No Git mutations, installs, package/lock changes, migrations/aggregates, real credentials, cloud APIs or owner sign-off were performed.

## Files changed or added

- `scripts/release/status.mjs`, `status.d.mts`: shared evidence/sign-off schemas and release gates.
- `scripts/release/evidence-cli.mjs`: binds actual source coverage/counts/mode/exit/commit/environment to a receipt; preserves nonpassing outcomes.
- `scripts/release/signoff-cli.mjs`: unsigned review draft, interactive owner signing with a seed file, no overwrite.
- `scripts/release/dossier.ts`: real referenced file/source validation, coherent verification, explicit invalid/failed/skipped/unperformed states, external trust input, structured environment formatting.
- `scripts/release/scenarios.ts`: adds REL-03 and its contract tests to the existing release-governance lane.
- `scripts/build/production-ledger.mjs`: refuses invalid requested status before rendering/checking.
- `tests/release/status.test.ts`, `candidate.live.test.ts`, `dossier.test.ts`: synthetic contract/filesystem tests plus three gated real-file acceptance cases.
- `docs/build/production/ledger.json`: only REL-02/03 implementation notes/status/owner/tests changed; both `implementation_complete_verification_pending`, no verified state/evidence added.
- `docs/build/production/REQUIREMENTS.md`: regenerated derived output required for `--check`.
- `docs/build/production/verify/REL-02.md`, `REL-03.md`: contracts, exact Mac commands, expected results, joins and remaining work.
- This handoff file.

## Verification commands actually executed

Every PowerShell invocation began with the exact prefix:

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH;
```

Commands below are their literal commands after that prefix. Counts are per invocation and must not be summed across overlapping runs.

| Command | Result |
| --- | --- |
| `node --version` | PASS: v22.23.3 |
| `npx vitest run tests/release --no-file-parallelism --maxWorkers=2` (first run) | FAIL: 201 passed, 3 skipped, 1 suite failed to load, 9 files passed / 1 failed / 1 skipped. Existing object-valued ledger environment crashed the string-only dossier formatter; fixed in code. No failed test-case result was fabricated for a suite that never loaded. |
| Same release vitest command (second run) | PASS: 215 passed, 0 failed, 3 skipped; 10 files passed / 1 skipped. The 3 skips are real-candidate/sign-off acceptance, never counted as passes. |
| `npx vitest run tests/release/status.test.ts tests/release/dossier.test.ts --no-file-parallelism --maxWorkers=2` | PASS after final receipt-environment mapping fix: 45 passed, 0 failed, 0 skipped; 2 files passed. |
| Changed-file eslint command below, executed twice | PASS twice: 0 errors, 0 warnings. |
| `npx eslint scripts/release/dossier.ts tests/release/status.test.ts` | PASS: 0 errors, 0 warnings. |
| `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh` | PASS: one invocation through the mandatory shared serial wrapper, exit 0, no diagnostics. Shared lock wait was honored. |
| `node scripts/build/production-ledger.mjs` | PASS: rendered all 78 requirements. |
| `node scripts/build/production-ledger.mjs --check` | PASS: 3 invocations, exit 0 each. |
| `node --check scripts/release/status.mjs` | PASS: 2 invocations, exit 0 each. |
| `node --check scripts/release/signoff-cli.mjs` | PASS: 2 invocations, exit 0 each. |
| `node --check scripts/release/evidence-cli.mjs` | PASS: 2 invocations, exit 0 each. |
| `npx tsx scripts/release/acceptance-orchestrator.ts check` | PASS: 19 scenarios, 79 mapped files, all present. |
| `npx tsx scripts/release/dossier.ts --out "$env:TEMP\zenith-j12-dossier.md" --json "$env:TEMP\zenith-j12-dossier.json"` | PASS: 78 rows, 0 verified, 54 unperformed levels, 94 pending levels, 73 flagged rows. Real historical claims remain visible but do not satisfy new RC gates. Output is local tooling inspection, not a new ledger evidence item. |
| `git diff --check` | PASS: 4 invocations, exit 0 each, including final scope check. Final status confirms 6 modified and 9 new files, all within the release job and its documentation. |

Full changed-file eslint command (twice):

```powershell
npx eslint scripts/release/status.mjs scripts/release/status.d.mts scripts/release/signoff-cli.mjs scripts/release/evidence-cli.mjs scripts/release/dossier.ts scripts/release/scenarios.ts scripts/build/production-ledger.mjs tests/release/status.test.ts tests/release/dossier.test.ts tests/release/candidate.live.test.ts
```

The filesystem contract tests also launch the actual Node ledger/evidence entry points in isolated temporary fixture directories. Their deliberate refusal exits are passing negative assertions, not real release approval. Fixture keys are generated at runtime. The owner signing command was not executed.

## Read-only inspection commands

These commands read data, not acceptance test cases; pass/fail/skip test counts are not applicable. The initial reads of absent `verify/REL-02.md` and `verify/REL-03.md` produced two expected missing-file errors (the containing shell exited 1); both documents were then added. No other discovery failure was treated as test evidence.

```powershell
Get-Content -LiteralPath 'Z:\Projects\Spawned.ai\zenith-wt\.resume\PREAMBLE.md'
git status --short
git log --oneline -10
rg -n 'Zenith|zenith|production|release' 'C:\Users\user\.codex\memories\MEMORY.md'
rg --files -g AGENTS.md -g '*rel*' scripts/release tests docs/build/production/verify
Get-Content -LiteralPath 'scripts/build/production-ledger.mjs'
rg -n -C 12 'REL-02|REL-03' docs/build/production/ledger.json
Get-Content -LiteralPath 'Z:\Projects\Spawned.ai\zenith-wt\.resume\PLAN-100.md'
Get-Content -LiteralPath 'docs/build/production/verify/REL-02.md'
Get-Content -LiteralPath 'docs/build/production/verify/REL-03.md'
rg --files scripts/release
rg -n 'productionApproved|sandboxVerified|pilotReady|dossier|sign.off|production-ledger' scripts tests docs/build/production/verification
Get-Content -LiteralPath 'package.json'
rg --files -g AGENTS.md -g vitest.config.* -g eslint.config.*
rg --files tests/scripts | rg 'release|ledger'
rg --files docs/build/production/verify | rg 'REL|OPS-09'
rg -n -C 9 'PROD-REL-02|PROD-REL-03' 'Z:\Projects\Spawned.ai\zenith-wt\.resume\PLAN-100.md'
rg -n 'releaseStatus|evidenceLevels' docs/build/production/ledger.json
rg -n 'productionApproved|sandboxVerified|pilotReady|dossier|sign.off|production-ledger' scripts/release tests/scripts tests/ci
Get-Content scripts/release/dossier.ts
Get-Content tests/release/dossier.test.ts
Get-Content docs/build/production/verify/MIX-05-07-REL.md
Get-Content docs/build/production/verify/PROD-OPS-09.md
Get-Content scripts/release/acceptance-orchestrator.ts
Get-Content scripts/release/checkpoint.ts
Get-Content docs/build/production/ledger.json -TotalCount 145
Get-Content vitest.config.ts -TotalCount 150
Get-Content eslint.config.mjs
rg -n -C 2 'environment|"logs"|"result"' docs/build/production/ledger.json | Select-Object -First 120
rg --files scripts/supply-chain tests/supply-chain
Get-Content docs/build/production/ledger.json -TotalCount 62
Get-Content docs/build/production/verify/PROD-OPS-09.md -TotalCount 95
Get-Content scripts/supply-chain/release.d.mts -TotalCount 90
Get-Content scripts/release/checkpoint.ts -TotalCount 125
Get-Content scripts/release/acceptance-orchestrator.ts -TotalCount 105
rg -n 'canonical|SIGNING_PREFIX|privateKeyFromSeed|publicKeyEntry' scripts/supply-chain/release.mjs
Get-Content scripts/release/scenarios.ts | Select-Object -Skip 174 -First 30
Get-Content docs/build/production/verify/MIX-05-07-REL.md -TotalCount 145
Get-Content 'Z:\Projects\Spawned.ai\zenith-wt\.resume\codex\tsc-serial.sh'
rg -n 'production-ledger|REQUIREMENTS.md' tests
rg --files docs/build/production/evidence | Select-Object -First 25
Get-Content tsconfig.json
Get-Content scripts/supply-chain/zenith-verify-release.mjs -TotalCount 60
Get-Content docs/build/production/evidence/fresh-workflows-4a6bab7.json -TotalCount 75
Get-Content docs/build/production/evidence/ci-37060964289/workflows.json -TotalCount 65
Get-Content docs/build/production/evidence/PROD-LIFE-09/2026-10-07-integrated-controls-d3e710d2.json -TotalCount 80
Get-Content docs/build/production/evidence/PROD-CI-08/2026-10-07-reduced-resource-local.json -TotalCount 65
Get-Content scripts/supply-chain/release.mjs | Select-Object -Skip 194 -First 20
git diff --stat
git diff -- docs/build/production/ledger.json
rg -n 'sourceCommit|source.commit|GITHUB_SHA|--commit' scripts/release/acceptance-orchestrator.ts
rg -n '"counts"|exitCode|"command"|"summary"|"mode"' docs/build/production/evidence/fresh-workflows-4a6bab7.json | Select-Object -Last 10
Get-Content scripts/release/status.mjs
Get-Content scripts/release/signoff-cli.mjs
git diff -- scripts/build/production-ledger.mjs scripts/release/dossier.ts
rg -n 'production_signoff' docs/build/production/ledger.json
Get-Item -LiteralPath "$env:TEMP\zenith-tsc.lock" -ErrorAction SilentlyContinue | Select-Object FullName,LastWriteTime
```

Repeated read-only commands are listed once. The memory search supplied no relevant production-job history; current program files were the implementation authority.

## Every changed test expectation and justification

| Old expectation in `tests/release/dossier.test.ts` | New expectation | Why stale |
| --- | --- | --- |
| PROD-TST-01 is verified | It is not verified | Historical fixture has no real file/hash bindings, cross-commit entries and a skipped local entry; REL-02/03 requires real passing coherent evidence. Positive real-file verification is covered by the new status tests. |
| PROD-TST-05 contract is performed | Contract is pending | Fixture's prose entry has no referenced evidence file. |
| PROD-TST-02 contract is performed | Contract is pending | Fixture's prose entry has no referenced evidence file. |
| Summary verified count is 1 | It is 0 | The historical fixture has no passing coherent file-bound row. |
| Summary pending count is 3 | It is 8 | Five additional unbound historical contract/local claims cannot count as performed. |

No assertion/gate was removed, disabled or weakened. New positive and negative coverage includes real files, original coverage/mode/commit/exit/counts, tampering, missing artifacts, identity/key pins and accountable signature scope.

## Remaining and deviation

Actual integrated RC engine/live/rehearsal evidence, verifier recorder metadata/bindings, and owner sign-off/trust pins remain pending. The real file-acceptance gates require those inputs; Mac commands are in REL-02/03. Full Docker/PG/Temporal/kind/browser/cloud campaigns were not run (needs the Mac verifier/authorized owner accounts), and no production flag was enabled. No schema need. Only additional derived-file refresh was `REQUIREMENTS.md`, necessary for the mandated ledger check. Suggested commit: `feat(release): gate RC status with evidence and signed signoff`.
