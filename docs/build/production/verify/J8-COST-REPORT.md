# J8 COST implementation report

Worktree: `Z:/Projects/Spawned.ai/zenith-wt/prod6-j8-cost`. Baseline: `3a9de905`. Node: `v22.23.3`. **38 changed/added files**, all uncommitted for the orchestrator. No `.git` mutation, dependency change, published migration/snapshot edit, cloud call or credential use occurred. Ledger rows retain `in_progress` and `implementation_complete_verification_pending`; none is verified.

## Changed and added files

Modified:

- `src/lib/cost/billing/aws.ts`: RFC3986 query escaping, repeated-value ordering and safe re-signing.
- `src/lib/cost/catalog-fetch.ts`: GCP Cloud SQL and Azure VM services in the existing gated downloader.
- `src/lib/placement/catalog-refresh/normalize-{gcp,azure,oci}.ts`: narrow compute/PostgreSQL SKU rules with component-derived shapes and ambiguity refusal.
- `src/lib/placement/catalog-refresh/refresh.ts`: verify every input before grouping same-day GCP/Azure pages; preserve original checksums and provenance.
- `src/lib/placement/recommend.ts`: initialize the existing platform repository dependency on module load, preserving scoped reads and failure behavior.
- `src/lib/agent-access/v3/{schemas,catalog}.ts`: three extended usage dimensions and placement schema v2.
- `tests/agent-v3/golden/catalog.json`, `tests/agent-v3/placement.test.ts`, `tests/agent-v3/placement-transport.test.ts`: matching digests and version pins.
- `docs/build/production/ledger.json`: short J8 notes on COST-01/02/03 only.
- `docs/build/production/verify/PROD-COST-01-02.md`, `PROD-COST-03.md`: links to this follow-up, preserving earlier evidence.

Added:

- `src/lib/cost/catalog-dry-run.ts`, `catalog-dry-run-cli.ts`.
- `src/lib/cost/optimizer-settings-service.ts`, `optimizer-settings-endpoint.ts`.
- `src/lib/cost/optimizer/measurement-collector.ts`, `measurement-ports.ts`, `optimizer-ownership.ts`, `optimizer-collector-pass.ts`.
- `src/lib/placement/catalog-refresh/derived.ts`.
- `tests/cost/aws-published-vector.test.ts`, `compute-refresh.test.ts`, `mcp-placement-usage.test.ts`, `optimizer-settings.test.ts`, `optimizer-settings.http.local.test.ts`.
- `tests/placement/measurement-collector.test.ts`, `measurement-collector.local.test.ts`, `measurement-ports.test.ts`, `optimizer-ownership.test.ts`, `optimizer-collector-pass.test.ts`.
- `docs/build/production/verify/COST-01.md`, `COST-02.md`, `COST-03.md`, `J8-COST-REPORT.md`.

## Executed commands and results

Every PowerShell command used this Node 22 prefix:

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH;
```

Counts below are individual test cases, not nested describe-suite counts. Diagnostic runs remain recorded even after their successors pass. No whole-repository test suite was run.

| Command | Result |
|---|---|
| `npx vitest run tests/cost/compute-refresh.test.ts tests/cost/aws-published-vector.test.ts tests/cost/optimizer-settings.test.ts tests/placement/measurement-collector.test.ts --no-file-parallelism --maxWorkers=2` | Exit 0: **22 passed / 0 failed / 3 skipped**. Initial new-contract run. |
| `npx vitest run tests/cost tests/placement tests/agent-v3/catalog.test.ts tests/agent-v3/placement.test.ts tests/agent-v3/placement-transport.test.ts --no-file-parallelism --maxWorkers=2` | Exit 1: **409 passed / 5 failed / 9 skipped**. Diagnostic run: three stale schema-version/digest pins, operational imports in the pure placement directory, and initial connection dependency timeout. Sources changed during this diagnostic run; it is not final evidence. |
| `npx vitest run tests/placement/recommend-connections.test.ts tests/placement/solver.test.ts tests/agent-v3/placement.test.ts tests/agent-v3/placement-transport.test.ts tests/placement/optimizer-ownership.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=C:/Users/user/AppData/Local/Temp/j8-repair-tests.json` | Exit 1: **69 passed / 3 failed / 0 skipped**. Two connection timeouts and an incomplete SQL count fixture. |
| `npx vitest run tests/placement/recommend-connections.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=C:/Users/user/AppData/Local/Temp/j8-connections-isolated.json` | Exit 1: **1 passed / 1 failed / 0 skipped**. First dependency load took 22.3 s against the unchanged 20 s test budget. |
| `npx vitest run tests/placement/recommend-connections.test.ts tests/placement/optimizer-ownership.test.ts tests/placement/optimizer-collector-pass.test.ts tests/cost/compute-refresh.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=C:/Users/user/AppData/Local/Temp/j8-new-fixes.json` | Exit 0: **13 passed / 0 failed / 0 skipped**. Successor after static dependency loading and complete count fixture. |
| `npx vitest run tests/cost tests/placement tests/agent-v3/catalog.test.ts tests/agent-v3/placement.test.ts tests/agent-v3/placement-transport.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=C:/Users/user/AppData/Local/Temp/j8-final-tests.json` | Exit 1: **423 passed / 1 failed / 9 skipped** across 32 files. All new J8 tests and MCP goldens passed. Only existing PGlite optimizer-settings initialization failed: 26.6 s against the 20 s test budget, with the JSON runner reporting `STACK_TRACE_ERROR`. Its unchanged isolated rerun is recorded below. |
| `npx vitest run tests/placement/optimizer-pass.test.ts --no-file-parallelism --maxWorkers=2` | Exit 1: **8 passed / 1 failed / 0 skipped**. Confirms the existing 20 s PGlite initialization timeout; elapsed failing-case duration 90.5 s under shared-machine load. Its assertions, setup and timeout remain unchanged. |
| `npx vitest run tests/cost/optimizer-settings.test.ts tests/cost/optimizer-settings.http.local.test.ts tests/placement/measurement-collector.test.ts tests/placement/measurement-ports.test.ts --no-file-parallelism --maxWorkers=2` | Exit 0: **22 passed / 0 failed / 4 skipped**. Final focused contracts; three native PostgreSQL consent cases and the actual HTTP lane are skipped. |
| `npx tsc --noEmit -p .` (five invocations) | In order: exit 1, **4 diagnostics**; exit 0, **0 diagnostics**; exit 1, **3 diagnostics** in the newly added adapter test; exit 0, **0 diagnostics**; final exit 0, **0 diagnostics** including the corrected GET guard and HTTP harness. Optional address access, applied-revision handling, full graph fixture typing, optional placement and untyped session-fixture access corrected. Repeats were after fixes. |
| `$files = @(git diff --name-only; git ls-files --others --exclude-standard) \| Where-Object { $_ -match '\.ts$' }; npx eslint $files` (four invocations) | All exit 0: **0 errors / 0 warnings** each. Final invocation includes all added TypeScript files and fixes. |
| `git diff --check` | All executed invocations exit 0: **0 whitespace errors**. |
| `node --version`; `(Get-Content -Raw docs/build/production/ledger.json \| ConvertFrom-Json)`; `@(git diff --name-only; git ls-files --others --exclude-standard)` | Exit 0: Node **v22.23.3**, valid ledger JSON, **38 changed/added files**. Read-only checks, 0 test cases. |

MCP golden regeneration (exit 0, one artifact, zero test cases):

```powershell
npx tsx -e 'import { writeFileSync } from "node:fs"; import { TOOL_CATALOG, catalogDigest } from "./src/lib/agent-access/v3/catalog"; writeFileSync("tests/agent-v3/golden/catalog.json", JSON.stringify({catalogDigest:catalogDigest(),tools:TOOL_CATALOG.map(({name,schemaVersion,schemaDigest})=>({name,schemaVersion,schemaDigest}))},null,2)+"\n");'
```

Offline CLI checks, zero test cases each:

1. `npx tsx src/lib/cost/catalog-dry-run-cli.ts tests/cost/fixtures/price-snapshots 2026-10-08.1`: tool shell reported exit 1 for the nonzero child; the candidate was printed without writes, with 13 updates, 14 unchanged, 1 addition, 1 flagged/unapplied increase, 1 rejected target and 37 unmatched targets.
2. The following early-output pipeline check failed (shell exit 1, observed 0). Early pipeline termination does not establish the child's completed exit status; this attempt is not used as CLI evidence:

```powershell
npx tsx src/lib/cost/catalog-dry-run-cli.ts tests/cost/fixtures/price-snapshots 2026-10-08.1 | Select-Object -First 5
$cliExit = $LASTEXITCODE
Write-Output "Native CLI exit: $cliExit (expected 2)"
if ($cliExit -ne 2) { exit 1 }
```

3. Full native-output capture verified the real CLI exit without terminating its pipeline:

```powershell
$dryRunOutput = & npx.cmd tsx src/lib/cost/catalog-dry-run-cli.ts tests/cost/fixtures/price-snapshots 2026-10-08.1
$dryRunExit = $LASTEXITCODE
$dryRunOutput | Select-Object -First 5
Write-Output "Native CLI exit: $dryRunExit (expected 2)"
if ($dryRunExit -ne 2) { exit 1 }
```

Result: shell exit 0, **native CLI exit 2**, as required for the deliberately flagged 147% fixture increase. Nothing was adopted or written. The fixture set does not establish current provider prices.

Read-only inspection used `git status --short`, `git log --oneline -10`, `git diff --stat`, `git diff --numstat`, `git diff --name-only`, `git ls-files --others --exclude-standard`, `rg`, `Get-Content`, `Select-Object`, `Select-String` and JSON report parsing for the instructed program files, baseline and owned code. These are not acceptance tests (0 cases). Some discovery probes found missing paths/no matches; one `Get-CimInstance Win32_Process` inspection was denied. No retry with elevation, process termination or state change followed that denial.

## Skips, joins and limits

The nine full-run skips are **five live billing cases**, **three native PostgreSQL consent cases**, and **one actual seven-day measurement case**. The subsequently added real HTTP consent lane is separately gated and not run here. Skips are not passes. Real PostgreSQL, Docker, Temporal, kind and browser journeys were **not run (needs the Mac verifier and actual services)**. Live price refresh and provider billing were **not run (needs explicit owner authorization and provider credentials)**.

Exact lean Mac startup, environment variables and commands are in [COST-01](COST-01.md), [COST-02](COST-02.md), and [COST-03](COST-03.md). The actual collector harness requires seven days of real data and approved current ownership; no backdated synthetic sample lane exists.

One existing local PGlite initialization timeout remains reproducible. Its support implementation is outside J8 ownership. It is reported as a failure, not dismissed as a pass; no timeout increase or gate relaxation was made. The Mac should run the unchanged `tests/placement/optimizer-pass.test.ts` in isolation and retain the result.

Required joins outside owned paths: browser-only route registration; the existing durable sweep's adapter composition; tenant-scoped usage exporter/source coverage (including DB/object sources); dispatch-time size-field ownership authorization; SQL-scoping inventory registration; authoritative legacy V1 environment policies. Until those land, the default sweep still has no measurements and no optimizer opt-in HTTP route is registered. Endpoint handlers and adapters are implemented and tested as integration seams, not deployed production acceptance. No new scheduler or automatic execution was added.

MySQL retains the pre-existing disclosed PostgreSQL price approximation. OCI optional additional PostgreSQL memory/VPU charges remain explicitly excluded. Unfamiliar provider meter names, unavailable/ambiguous components, unsupported compute and incomplete telemetry refuse coverage; genuine official downloads/adoption remain deferred. The bundled catalog is unchanged.

## Handoff deviations and expectation changes

- Production route/sweep/exporter/legacy-policy joins are described rather than editing their unowned files. This packet therefore does not claim default-stack completion.
- The existing connection adapter dependency was moved to module initialization after reproducing its cold-import timeout. SQL scoping, failure behavior and test timeout/assertions are unchanged.
- The settings GET uses the browser guard's explicit read-only mode, because same-origin browser GETs normally omit Origin. POST still requires exact Origin and both methods refuse agent Authorization headers. The gated actual HTTP test covers these boundaries after registration.
- Operational collector modules live under `src/lib/cost/optimizer` so the existing pure placement import gate remains intact. No gate was changed.
- Exactly three stale MCP assertions were updated: handler schema version and its exact digest; transport metadata version; transport result version. Each changes placement v1 to required v2. The placement-only golden digest and aggregate catalog digest changed accordingly. No other existing expectation was weakened, skipped or removed.

Suggested orchestrator commit message: `feat(cost): add refresh rules and measured optimizer adapters`.
