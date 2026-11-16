# J4 local command report

All PowerShell commands prepend `C:\Users\user\.local\sdk\node22` to PATH. No installs, commits, Git history operations, Docker, real PG/Temporal/browser tests or cloud calls were run.

## Original build on base 443bfeaf: commands and observed counts

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

Counts overlap. Do not sum them. Initial SQL-backed delivery fixture was split into an explicitly labelled memory/signing/broker contract after the unmodified base schema refused admission. Billing's genuine schema admission was blocked at that base; assembly fixed the collision, and step 2 reruns below supersede the blocker. No production migration/checksum/assertion was bypassed. Original existing tests only gained a broker-settlement-outage assertion.

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
- Assembly repaired the original migration collision before step 2. No migration 55, inventory, aggregate or dependency change was needed in J4.
- Reuse two existing Temporal Schedules for seven core jobs, plus billing. No independent schedule subsystem.
- Billing HTTP fallback wrapper was an original outside-owned-files join; completed in step 2 under the explicit scope extension. Central gate manifest integration remains for the orchestrator after review.
- Original build changed no existing test expectation. Step 2's one stale billing-health expectation change is justified below. Native pending-approval cancellation is the real cancellation harness; remote OS process termination is not claimed.
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

## Step 2: assembled build on 65b71e39

Assembly `257b9ebe` is merged by the orchestrator. Migrations 44-52 and aggregate 0026 are unmodified by J4. The earlier schema-collision failures remain historical evidence; admission is no longer blocked.

| Run | Passed / failed / skipped or diagnostics |
|---|---|
| Previously blocked billing/store/critical-job SQL rerun | 24 / 0 / 0; 3 files passed. |
| Expanded SQL delivery + HTTP fallback regression run | 60 / 1 / 0; 3 files passed, 1 failed. The first PGlite delivery case charged cold schema admission to its 20-second operation timeout. |
| Delivery after moving genuine schema admission into suite setup | 28 / 0 / 0; 1 file passed, both memory and PGlite. Case timeout and assertions unchanged. |
| Pure runbook/workflow/admission regressions | 58 / 0 / 4; 4 files passed, 1 skipped. Two existing Temporal and two default-stack/registered-agent gates explicitly skipped. |
| Changed-file eslint | Exit 0, 0 errors/warnings. |
| Delivery-only eslint after setup fix | Exit 0, 0 errors/warnings. |
| Initial serial typecheck | Exit 0, 1 check passed, 0 failed/skipped; compiler snapshot predates the SQL setup fix. |
| Final serial typecheck after setup fix | Exit 0, 1 check passed, 0 failed/skipped. Final delivery SHA-256 matches the compiler snapshot. |
| Production ledger check | Exit 0, 1 check passed, 0 failed/skipped. |
| Diff/marker and final scope checks | Exit 0; no conflict markers, clean diff check, 10 changed files. |

Counts overlap; do not sum runs. The expanded run's HTTP routes (20), billing scheduling (4) and critical jobs (9) passed. The only failed delivery case is covered by the successful full 28-case rerun. Real PostgreSQL, Temporal, browser and installed-agent acceptance remain NOT RUN here; use the exact Mac commands in J4-SCHEDULES-RUNBOOKS.md.

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
npx vitest run tests/platform/billing-schedule.test.ts tests/controlplane/machine-runbooks.test.ts tests/platform/critical-jobs.test.ts --no-file-parallelism --maxWorkers=2
$env:ZENITH_TEST_PLATFORM_PG_URL = ''
npx vitest run tests/machines/runbook-delivery.test.ts tests/platform/billing-schedule.test.ts tests/billing/billing-routes.test.ts tests/platform/critical-jobs.test.ts --no-file-parallelism --maxWorkers=2
npx eslint src/app/api/internal/tick/billing/route.ts src/lib/platform/critical-jobs.ts scripts/acceptance/maintenance/default.ts tests/billing/billing-routes.test.ts tests/platform/billing-schedule.test.ts tests/machines/runbook-delivery.test.ts tests/acceptance/maintenance-default.test.ts
$env:ZENITH_TEST_TEMPORAL = ''
$env:ZENITH_TEST_MAINTENANCE = ''
$env:ZENITH_TEST_RUNBOOK_DELIVERY = ''
npx vitest run tests/machines/runbook-step-executor.test.ts tests/machines/runbooks.test.ts tests/workflows/critical-schedule.test.ts tests/acceptance/maintenance-default.test.ts tests/acceptance/maintenance-preconditions.test.ts --no-file-parallelism --maxWorkers=2
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
npx vitest run tests/machines/runbook-delivery.test.ts --no-file-parallelism --maxWorkers=2
npx eslint tests/machines/runbook-delivery.test.ts
node scripts/build/production-ledger.mjs --check
git diff --check
# Repeat required serial check only because the SQL suite setup was fixed after the first compiler snapshot:
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
```

A read-only Node probe compared the final delivery file's SHA-256 with its `tsconfig.tsbuildinfo` version. The first comparison returned false/exit 1 (old compiler snapshot), prompting the final serialized rerun; the final comparison returned true/exit 0. The shared lock was never modified. Non-test inspections use the same git/rg/Get-Content/Get-Date/Get-Item families as the original report; one guessed config glob was corrected, and the released typecheck lock's absence is normal after compiler exit. One report-writing PowerShell command was rejected at parse time because of nested here-string quoting; no file changes occurred, and the report was updated using apply_patch.

One expectation was provably stale: billing's `durableOnly: true` health exemption predated assembly's authenticated HTTP fallback. It now asserts cadence, lease TTL, kind and the absence of that exemption; a new SQL regression requires missing billing health to make the overall view unhealthy when its peers have run. No assertion or gate was removed. Schema admission uses the existing 60-second setup budget, with the original 20-second step case budget retained.

Registration inspection: exactly one billing property in CRITICAL_JOBS, one billing function in MAINTENANCE_JOBS, and one provision-mode call each to ensureCriticalMaintenanceSchedule and ensureReconcileSchedule. No separate billing schedule was added; all J4 jobs use the existing fixed schedule identities.

Step 2 files changed:

- docs/build/production/ledger.json (notes only; verification-pending status retained)
- docs/build/production/verify/J4-CHECKS.md
- docs/build/production/verify/J4-SCHEDULES-RUNBOOKS.md
- scripts/acceptance/maintenance/default.ts
- src/app/api/internal/tick/billing/route.ts
- src/lib/platform/critical-jobs.ts
- tests/acceptance/maintenance-default.test.ts
- tests/billing/billing-routes.test.ts
- tests/machines/runbook-delivery.test.ts
- tests/platform/billing-schedule.test.ts

Outside the original owned paths: only the billing HTTP route and its existing billing route test file. This is the explicitly authorized wrapper join and its SQL/authentication regression coverage. The route's boot/session ports are controlled in contract tests; actual default API acceptance is still the Mac gate. No new storage, package changes, aggregate changes, Git writes, cloud calls or extra migration required.

Suggested step 2 commit: `fix: complete durable billing fallback and SQL runbook verification`.

Exact compiler snapshot probe (run twice, as described above):

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
$snapshotProbe = @'
import fs from "node:fs";
import crypto from "node:crypto";
const snapshot = JSON.parse(fs.readFileSync("tsconfig.tsbuildinfo", "utf8"));
const data = snapshot.program ?? snapshot;
const target = "./tests/machines/runbook-delivery.test.ts";
const index = data.fileNames.findIndex(name => name.replaceAll("\\", "/") === target);
if (index < 0) throw new Error("Final delivery source is absent from compiler snapshot.");
const info = data.fileInfos[index];
const version = typeof info === "string" ? info : info.version;
const current = crypto.createHash("sha256").update(fs.readFileSync(target, "utf8")).digest("hex");
console.log(JSON.stringify({ finalDeliverySourceInCompilerSnapshot: version === current }));
if (version !== current) process.exitCode = 1;
'@;
node --input-type=module -e $snapshotProbe
```
