# J15 harness completion build report

Worktree: Z:/Projects/Spawned.ai/zenith-wt/prod6-j15-harness-completion  
Branch: prod/j15-harness-completion  
Base: 443bfeaf537dd5d5324d33c84fc544ede0baa632  
All edits remain in the working tree. No commit, history operation, dependency installation, migration/aggregate edit or real cloud API call.

## Files

Modified:
- docs/build/production/ledger.json (only MIX-05/06/07 and REL-01 statuses/notes)
- scripts/release/acceptance-orchestrator.ts
- scripts/release/scenarios.ts
- fixtures/mixed-app/README.md
- fixtures/mixed-app/enricher/server.mjs
- fixtures/mixed-app/web/stores.mjs

Added:
- scripts/release/local-targets.ts
- scripts/release/local-target-runner.ts
- scripts/release/local-environment.ts
- scripts/release/local-kubernetes.ts
- scripts/release/local-mixed.ts
- scripts/release/local-pebble.ts
- deploy/acceptance/local-targets/scenarios.json
- deploy/acceptance/local-targets/compose.yml
- deploy/acceptance/local-targets/kind.yml
- deploy/acceptance/local-targets/Corefile
- deploy/acceptance/local-targets/pebble.json
- deploy/acceptance/local-targets/README.md
- fixtures/mixed-app/Dockerfile
- fixtures/mixed-app/enricher/lambda.mjs
- fixtures/mixed-app/enricher/local-lambda.mjs
- fixtures/mixed-app/acme/challenge.mjs
- tests/release/local-targets.test.ts
- tests/acceptance/local-targets.engine.test.ts
- docs/build/production/verify/MIX-05.md
- docs/build/production/verify/MIX-06.md
- docs/build/production/verify/MIX-07.md
- docs/build/production/verify/REL-01.md
- docs/build/production/verify/J15-HARNESS-COMPLETION.md (this report)

Total: 29 files. Tests, verify docs and the four ledger rows are the explicit supporting scope alongside the three owned trees.

## Exact verification commands and every attempt

Every PowerShell command prepended:
```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
```

```powershell
npx vitest run tests/release/local-targets.test.ts tests/release/orchestrator.test.ts tests/release/acceptance-scenarios.test.ts tests/acceptance/mixed-traffic.test.ts --no-file-parallelism --maxWorkers=2
```

| Attempt | Passed | Failed | Skipped | Files |
| --- | ---: | ---: | ---: | --- |
| 1 | 65 | 0 | 0 | 4 passed |
| 2, after TLS/ownership updates | 65 | 0 | 0 | 4 passed |
| 3, after strict counts/ownership tests | 69 | 0 | 0 | 4 passed |
| 4, after skip-exit and remote-Docker guards | 69 | 1 | 0 | 3 passed, 1 failed |
| 5, corrected fake command's exit code | 70 | 0 | 0 | 4 passed |
| 6, final code and live-Vitest receipt guard | 74 | 0 | 0 | 4 passed |

Attempt 4 failed because the NEW fake executor incorrectly gave exit 3 to both its component Vitest process and its skipped local target. The assertion remained unchanged; the fake now gives exit 3 only to the local receipt process. No existing expectation/assertion/gate was changed, skipped or removed.

```powershell
npx eslint scripts/release/acceptance-orchestrator.ts scripts/release/scenarios.ts scripts/release/local-targets.ts scripts/release/local-environment.ts scripts/release/local-kubernetes.ts scripts/release/local-mixed.ts scripts/release/local-pebble.ts scripts/release/local-target-runner.ts fixtures/mixed-app/enricher/server.mjs fixtures/mixed-app/enricher/lambda.mjs fixtures/mixed-app/enricher/local-lambda.mjs fixtures/mixed-app/acme/challenge.mjs fixtures/mixed-app/web/stores.mjs tests/release/local-targets.test.ts tests/acceptance/local-targets.engine.test.ts
npx eslint tests/release/local-targets.test.ts
```

Full 15-file lint: 5 invocations. First failed with 1 prefer-const error, 0 warnings; fixed without changing behavior. Subsequent 4 passed with 0 errors/0 warnings, including the final code. The additional single-file lint passed with 0 errors/0 warnings. No files skipped.

```powershell
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
```

Two serialized attempts, never concurrent. First: exit 1, 4 errors (two stale AST/module errors from an in-progress guard edit; two test environment objects missing NODE_ENV). Those are fixed. Second: exit 0, 0 errors, passed on final code. No further TypeScript changes after this check. Test counts do not apply to typecheck.

```powershell
npx tsx scripts/release/acceptance-orchestrator.ts check
npx tsx scripts/acceptance/mixed/cost-report.ts --egress-gb 10 --fraction 0.5 --residency us --latency-ms 120 --json
node --version
git diff --check
```

Scenario check: exit 0; 19 scenarios, 78 mapped component/live files present, 0 missing. The local-target map is independently covered by the unit test. Cost report: exit 0, priced true, positive transfers and latency entries, US residency satisfied; dated estimates only. Runtime: v22.23.3. Diff check initially found 1 trailing blank-line error; subsequent checks passed (0 whitespace errors). Git's CRLF normalization notice for the README is not a failure.

Read-only inspection included git status/log/branch/rev-parse/diff/ls-files, rg/Get-Content for the handoff's files, the supplied PREAMBLE and PLAN-100, and a lightweight memory search with no relevant context used. Initial verify docs were absent and were created; exploratory searches for absent cilium.env, billing files and Windows wildcard paths returned errors, then the actual existing interfaces were inspected. An optional Get-CimInstance Win32_Process diagnostic was denied; no escalation. File authoring used Set-Content/Add-Content/WriteAllText; an initial Bash here-document was truncated and was repaired before all checks. No such inspection/write was counted as a test pass.

## Remaining work and joins

- Mac-only engine checks: **not run (needs Docker, kind, actual PostgreSQL, LocalStack Lambda, Pebble/CoreDNS and stripe-mock)**. The real gated suite and exact sequential commands/counts/cleanup are in [local target README](../../../../deploy/acceptance/local-targets/README.md) and the four requirement verify docs.
- J1/J2/J4: confirm/adapt the proposed default-stack verify, default-journey and maintenance driver paths/CLI/receipt protocol. Those files are absent at this base. Local scenario lanes decline until their driver and ZENITH_LOCAL_JOINED_DRIVERS=1 exist. These joins do not establish full end-to-end acceptance yet.
- J1 default-stack 4-GiB feasibility, J2 browser/approval/revocation/two-tenant journeys, J4 Temporal schedules and billing persistence are separate owner runs.
- J11: policy-capable CNI for packet isolation and actual emulator/PG/CA digest pins. Default kindnet does not enforce the emitted NetworkPolicy; certificate authentication and private Service exposure are independently checked.
- J8: join current catalog pricing. Economics remains approximate/dated and models the existing cloud container equivalent.
- Live accounts/regions/budgets, real cross-cloud traffic/VPN/DNS/identity, operational live rehearsals and production approval remain deferred. The new local mode cannot invoke live lanes and sanitizes child environments.
- No schema, migration, store-function or sensitive-data inventory need. Orchestrator registers the new unit/engine-gated files in its gate manifest.
- Scope deviation: no unrelated production code edited. The runner also strengthens stale-artifact and live-Vitest skip handling because skipped or missing evidence must never become verification.

Suggested commit: `feat(release): add gated local acceptance targets`

