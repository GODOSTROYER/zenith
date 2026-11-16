# J8 COST production joins report

Worktree: `Z:/Projects/Spawned.ai/zenith-wt/prod6-j8-cost`. Baseline: orchestrator commit `2eb09bc2`. This report supersedes the integration gaps in the [committed base packet](J8-COST-REPORT.md). COST-01/02 code and MCP digests remain as committed; the six owner-authorized COST-03 joins are now built. Ledger status remains `implementation_complete_verification_pending`, never verified. No commit, dependency install/change, migration/snapshot edit or real cloud call occurred.

## Files changed/added

Within original ownership:

- `src/lib/cost/optimizer-settings-endpoint.ts`: registered-route documentation.
- `src/lib/cost/optimizer/measurement-ports.ts`: cost-purpose broker/session reads and authoritative V1 policies; retain the stricter environment/manifest budget.
- `src/lib/cost/optimizer/sweep-step.ts` (new): compose measured optimization into the existing sweep with its canonical broker and credential broker inside the worker product-store scope.
- `src/lib/cost/usage-exporter.ts` (new): strict current tenant/resource reports, bounded process-local projection, actual counters and DB/object occupancy gauges; missing/stale data remains absent.
- `tests/cost/pglite-startup-diagnostic.ts` (new): engine/migration wall time, process CPU time and event-loop delay, without prewarming tests or changing budgets.
- `tests/cost/usage-exporter.test.ts`, `usage-route.test.ts` (new): actual PGlite resource scoping and explicit HTTP gate contracts.
- `tests/placement/cost-sources.test.ts` (new): local HTTP contracts for five provider graphs, tenant selectors, DB/object coverage and missing binding/configuration.
- `tests/placement/measurement-ports.test.ts`: authoritative legacy budget read and malformed-policy refusal.
- `tests/placement/measurement-collector.local.test.ts`: use the production cost source, including its producer heartbeat.
- `tests/placement/optimizer-sweep.local.test.ts` (new): gated actual default worker/schedule, human HTTP consent, native store and retained real metrics, including default-off and proposal-only/cooldown assertions.
- `tests/placement/optimizer-pass.test.ts`: complete the positive memory-store ownership fixture with exact modeled approved size/replica transfers. All existing assertions, initialization and timeouts remain unchanged.

Minimal edits outside original ownership, authorized by the follow-up:

| File | Join |
|---|---|
| `src/app/api/platform/v1/environments/[id]/optimizer/route.ts` (new) | Node/dynamic GET/POST registration with existing browser guards |
| `src/app/api/platform/v1/_lib/bearer-paths.ts` | Explicit browser-only GET/POST classification |
| `src/app/api/internal/metrics/route.ts` | Existing internal authentication for bounded usage ingress and scrape exposition |
| `src/lib/workflows/reconcile-schedule.ts` | Invoke measured step inside the existing activity/lease; no new scheduler |
| `src/lib/platform/agent-ports.ts` | Carry internal cost-purpose source selection through the verified observe session |
| `src/lib/platform/optimizer.ts` | Correct base-port documentation; independent callers remain conservative |
| `src/lib/agent-access/v3/ports.ts` | Optional authoritative environment policies and internal fabric purpose |
| `src/lib/agent-access/v3/adapters.ts` | Scoped, cloned validated environment policies; duplicate environment/project/revision refusal; carry fabric purpose |
| `src/lib/observability/sources/factory.ts` | Select boundary usage source for optimizer, including DB/object nodes |
| `src/lib/observability/sources/prometheus.ts` | Fixed tenant/resource selectors, units, unique fresh producer requirement; ordinary workload coverage preserved |
| `src/lib/ownership/conflicts.ts` | Check exactly changed size/replica input fields |
| `src/lib/capabilities/broker.ts` | Enforce size at proposal/check; no missing-guard or legacy IaC-warning authorization |
| `src/lib/controlplane/db/repos/ownership-transfers.ts` | Check stored input at dispatch/grant admission; require exact live size-transfer dependencies |
| `tests/capabilities/field-ownership-broker.test.ts` | Size-only and combined-field authorization contracts |
| `tests/controlplane/ownership-transfers.test.ts` | Native final-grant size-transfer expiry race, gated by PostgreSQL |
| `tests/middleware/platform-bearer.test.ts` | Cookie gate coverage and exact route inventory |
| `tests/security/controlplane-sql-scoping.test.ts` | Register four direct cost SQL modules; existing adversarial audit unchanged |
| `docs/build/production/ledger.json` | Update COST-03 implementation note, retain pending verification |
| `docs/build/production/verify/COST-03.md`, `PROD-COST-03.md`, this report | Current mapping, exact Mac commands and honest evidence |

## Executed commands and counts

Every PowerShell invocation starts with:

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH;
```

Counts below are test assertions, not native-production claims. Skipped cases are retained. Successor checks validate specific fixes; duplicate reruns are not added into a fabricated aggregate pass count.

| Exact command after the PATH prefix | Result |
|---|---|
| `node -v` | Exit 0: **v22.23.3**, **0 tests**. |
| `npx tsx tests/cost/pglite-startup-diagnostic.ts` | Exit 0; **0 tests**. Two genuine engine opens/full migrations; phase timings below. |
| `npx vitest run tests/placement/optimizer-pass.test.ts --no-file-parallelism --maxWorkers=2` (before fixture change) | Exit 0: **9 passed / 0 failed / 0 skipped**. Unmodified timeout case included. |
| `npx vitest run tests/cost/usage-exporter.test.ts tests/placement/cost-sources.test.ts tests/placement/measurement-ports.test.ts tests/capabilities/field-ownership-broker.test.ts tests/security/controlplane-sql-scoping.test.ts --no-file-parallelism --maxWorkers=2` | Exit 1: **26 passed / 2 failed / 0 skipped**. Both failures were existing 20-second SQL security audit timeouts; the added contracts passed. |
| `npx vitest run tests/cost tests/placement tests/agent-v3/catalog.test.ts tests/agent-v3/placement.test.ts tests/agent-v3/placement-transport.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=C:/Users/user/AppData/Local/Temp/j8-joins-main.json` | Exit 1: **433 passed / 1 failed / 11 skipped**. Positive memory-store size proposal fixture lacked the newly required broker size transfer. Fixed fixture without changing its expected behavior/assertions. |
| `npx vitest run tests/capabilities/field-ownership-broker.test.ts tests/ownership/field-ownership.test.ts tests/controlplane/ownership-transfers.test.ts tests/middleware/platform-bearer.test.ts tests/observability/prometheus.test.ts tests/agent-v3/adapters.test.ts tests/workflows/reconcile-schedule.test.ts tests/workers/reconcile-composition.test.ts tests/security/controlplane-sql-scoping.test.ts tests/ops/admin-routes.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=C:/Users/user/AppData/Local/Temp/j8-joins-external.json` | Exit 1: **203 passed / 3 failed / 34 skipped**. Corrected ordinary Prometheus node coverage and stale 97-method inventory. Third failure: existing SQL audit timeout (`STACK_TRACE_ERROR` in JSON). |
| `npx vitest run tests/placement/optimizer-pass.test.ts --no-file-parallelism --maxWorkers=2` (after complete ownership fixture) | Exit 0: **9 passed / 0 failed / 0 skipped**. Assertions/timeouts unchanged. |
| `npx vitest run tests/security/controlplane-sql-scoping.test.ts --no-file-parallelism --maxWorkers=2` | Exit 1: **5 passed / 1 failed / 0 skipped**. Existing adversarial SQL interpolation case took 29.1 seconds against unchanged 20-second limit. New direct-query inventory passed. |
| `npx vitest run tests/middleware/platform-bearer.test.ts tests/observability/prometheus.test.ts tests/placement/cost-sources.test.ts tests/security/controlplane-sql-scoping.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=C:/Users/user/AppData/Local/Temp/j8-joins-repairs.json` | Exit 1: **142 passed / 1 failed / 0 skipped**. Middleware, ordinary Prometheus and cost-source successors passed. Existing adversarial SQL audit still timed out (35.6 seconds). A bounded AST-parsing cache experiment did not resolve the wall timeout and was removed; its original audit implementation/assertions are preserved. |
| `& 'C:\Program Files\Git\bin\bash.exe' 'Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh'` (two invocations) | Both exit 0, **0 diagnostics**, including the final source fixes. Both serialized through the owner-supplied lock; the final invocation waited over an hour under shared load. |
| `$costChangedTs = @(git diff --name-only; git ls-files --others --exclude-standard) \| Where-Object { $_ -match '\.ts$' }; npx eslint $costChangedTs` (two invocations) | Both exit 0: **0 errors / 0 warnings**, including all added TypeScript files. |
| `git diff --check` (five invocations) | Each exit 0, **0 whitespace errors**. |

Read-only inspection used `git status --short`, `git log --oneline -10`, `git diff --stat`, `git diff --numstat`, `git diff 3a9de905 2eb09bc2 -- src/lib/controlplane/db tests/capabilities/support.ts vitest.config.ts`, `git ls-files --others --exclude-standard`, `Get-Content`, `rg`, `rg --files`, `Get-Process node`, `Get-Item C:/Users/user/AppData/Local/Temp/zenith-tsc.lock`, `Get-Date -Format o` and `ConvertFrom-Json` report summaries. These run zero tests. Some discovery reads reported missing paths/unsupported PowerShell glob paths and were corrected; no verification result depends on those misses. No git mutation command ran.

## PGlite startup finding

The diagnostic opens fresh databases without altering test setup. Milliseconds:

| Phase | Wall | Process CPU |
|---|---:|---:|
| import open | 916 | 563 |
| import migrator | 13 | 0 |
| first engine | 4660 | 7172 |
| first migrations | 8349 | 1594 |
| first query | 1 | 0 |
| second engine | 34269 | 3438 |
| second migrations | 1823 | 1578 |
| second query | 1 | 0 |

Second engine event-loop maximum delay: 2498 ms; free RAM stayed around 6.5 GiB; 22 available processors and 98 concurrent Node processes were observed. The second engine consumed about 3.4 CPU seconds across 34.3 wall seconds, while the same first engine completed in 4.7 wall seconds. Startup/migration/support/config files have no changes between `3a9de905` and `2eb09bc2`. The unchanged optimizer-pass rerun took 4.45 seconds of test time (imports 65.4 seconds) and passed all nine cases. Its corrected-fixture successor took 5.52 seconds of test time and again passed all nine cases.

This evidence supports shared scheduling/I/O load, not an introduced PGlite cold-start regression. No engine, migrator, initialization assertion, prewarm or timeout change is justified or included. The SQL audit timeout is separately retained as unresolved local verification, not converted into a pass.

## Remaining verification and limits

- **Not run (needs native PostgreSQL):** three consent cases and eight ownership custody/race cases, including the new size-transfer final-grant expiry case.
- **Not run (needs actual local Temporal/native stack):** fourteen reconcile schedule cases and twelve worker composition cases. The five/seven scalar boundary cases passed; they are not Temporal evidence.
- **Not run (needs local verified human auth/browser session):** actual HTTP consent lane.
- **Not run (needs real Prometheus, actual workload meters and seven days of retained observations):** actual measurement and default sweep lanes. The exporter consumes trusted actual observations; contract fixtures do not supply operating data. Deployment must use a stable scrape/ingress instance and real scope IDs. Missing data refuses proposals.
- **Not run (owner deferred live):** five live billing/refresh tests, owner-key catalog adoption and actual cloud billing. No real cloud API or real credential was used.
- **Unresolved local verification:** the existing adversarial SQL interpolation audit repeatedly exceeded 20 seconds under shared load. Its assertions, setup and timeout remain intact. Exact Mac commands and lean profiles are in [COST-03.md](COST-03.md); run that full security file again there with zero failures required.
- J13's existing new-owner/resource-fact insertion serialization work remains separate. This change enforces current size ownership and its live enabling receipt at dispatch/grant admission without a migration.

## Expectation changes and deviations

Exactly one existing expectation changed: the exhaustive platform route inventory **97 -> 99**, because the newly required optimizer GET and POST add two classified methods. The assertion remains exact. The positive memory-store pass fixture now supplies the exact approved ownership it already declared via `staticFieldOwnership`; no assertion or expected count changed. The gated collector harness selects the actual default cost source; its assertions/gate remain intact. No timeout/gate was increased, weakened, deleted or skipped to obtain a pass.

Scope expansion follows the owner's six explicit joins. No deviation from that expanded handoff. Startup code remains unchanged because the regression hypothesis was not supported. Suggested commit: `feat(cost): wire measured optimizer into durable production sweep`.
