# J4 local command report

All PowerShell commands prepend `C:\Users\user\.local\sdk\node22` to PATH. No installs, commits, Git history operations, Docker, real PG/Temporal/browser tests or cloud calls were run.

## Validation commands and observed counts

| Run | Result |
|---|---|
| Initial delivery + billing PGlite | 1 passed, 13 failed, 3 skipped; 2 failed suites. Base duplicate migration 42 checksum admission, retained as failure. |
| Focused runbook/workflow/harness contracts | 62 passed, 0 failed, 4 gated skips; 4 passed files, 1 skipped file. |
| Serial whole-repo typecheck | Exit 0: 1 check passed, 0 failed, 0 skipped. Completed after waiting through the shared serial queue. |
| First changed-file eslint | Exit 0, 0 errors, 0 warnings. |
| Executor/authority regression rerun | 20 passed, 0 failed, 0 skipped; 2 passed files. |
| Harness admission contracts | 9 passed, 0 failed, 0 skipped; 1 passed file. |
| Final changed-file eslint + signed-step rerun | eslint exit 0, 0 errors/warnings; 14 passed, 0 failed, 0 skipped. |
| git diff --check | First found 9 extra EOF blank lines; normalization fixed them; rerun exit 0. |

Counts overlap. Do not sum them. Initial SQL-backed delivery fixture was split into an explicitly labelled memory/signing/broker contract after the unmodified base schema refused admission. The billing PGlite tests retain genuine schema admission and remain blocked; no production migration/checksum/assertion was bypassed. Existing tests only gained a broker-settlement-outage assertion.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
npx vitest run tests/machines/runbook-delivery.test.ts tests/platform/billing-schedule.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/machines/runbook-delivery.test.ts tests/machines/runbooks.test.ts tests/machines/runbook-step-executor.test.ts tests/workflows/critical-schedule.test.ts tests/acceptance/maintenance-default.test.ts --no-file-parallelism --maxWorkers=2
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
npx eslint src/lib/platform/critical-jobs.ts src/lib/platform/runbooks.ts src/lib/workflows/definitions/criticalMaintenance.ts src/lib/machines/runbooks/runner.ts src/lib/runbooks/semantics.ts src/lib/runbooks/delivery.ts 'scripts/acceptance/maintenance/*.ts' tests/machines/runbook-delivery.test.ts tests/machines/runbook-step-executor.test.ts tests/platform/billing-schedule.test.ts tests/acceptance/maintenance-default.test.ts
npx vitest run tests/machines/runbook-delivery.test.ts tests/machines/runbook-step-executor.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/acceptance/maintenance-preconditions.test.ts --no-file-parallelism --maxWorkers=2
npx eslint src/lib/platform/critical-jobs.ts src/lib/platform/runbooks.ts src/lib/workflows/definitions/criticalMaintenance.ts src/lib/machines/runbooks/runner.ts src/lib/runbooks/semantics.ts src/lib/runbooks/delivery.ts 'scripts/acceptance/maintenance/*.ts' tests/machines/runbook-delivery.test.ts tests/machines/runbook-step-executor.test.ts tests/platform/billing-schedule.test.ts tests/acceptance/maintenance-default.test.ts tests/acceptance/maintenance-preconditions.test.ts
npx vitest run tests/machines/runbook-delivery.test.ts --no-file-parallelism --maxWorkers=2
git diff --check
```

Non-test inspection used git status/log/diff/ls-files, rg, Get-Content, Get-Date, Get-Item and Get-Process. The serial check was polled to completion; the shared lock was never modified. Missing unprefixed verify paths and a few exploratory guessed paths were corrected to actual repository paths. A read-only Get-CimInstance Win32_Process diagnostic returned Access denied; it was not retried with privilege. These are not test passes/skips.

## Unexecuted acceptance and deviations

- Docker, actual PostgreSQL, Temporal, browser/default-stack and actual registered zenithd: not run, needs Mac fixtures. Two newly authored gates and two existing Temporal cases were explicitly skipped in the local focused run.
- Migration collision repair belongs to assembly. No migration 55, inventory, aggregate or dependency change was needed.
- Reuse two existing Temporal Schedules for seven core jobs, plus billing. No independent schedule subsystem.
- Billing HTTP fallback wrapper and central gate manifest are outside owned files; joins are documented in J4-SCHEDULES-RUNBOOKS.md.
- No existing test expectation was changed or assertion removed. Native pending-approval cancellation is the new real cancellation harness; remote OS process termination is not claimed.
- Suggested commit: `feat: bind signed runbook delivery and schedule durable billing`.

## Files changed/added

- docs/build/production/ledger.json
- docs/build/production/verify/J4-CHECKS.md
- docs/build/production/verify/J4-SCHEDULES-RUNBOOKS.md
- docs/build/production/verify/PROD-DUR-03-04.md
- docs/build/production/verify/PROD-MACH-03.md
- docs/build/production/verify/PROD-OBS-04.md
- scripts/acceptance/maintenance/default.ts
- scripts/acceptance/maintenance/preconditions.ts
- scripts/acceptance/maintenance/run-runbooks.ts
- scripts/acceptance/maintenance/run.ts
- scripts/acceptance/maintenance/runbooks.ts
- src/lib/machines/runbooks/runner.ts
- src/lib/platform/critical-jobs.ts
- src/lib/platform/runbooks.ts
- src/lib/runbooks/delivery.ts
- src/lib/runbooks/semantics.ts
- src/lib/workflows/definitions/criticalMaintenance.ts
- tests/acceptance/maintenance-default.test.ts
- tests/acceptance/maintenance-preconditions.test.ts
- tests/machines/runbook-delivery.test.ts
- tests/machines/runbook-step-executor.test.ts
- tests/platform/billing-schedule.test.ts
