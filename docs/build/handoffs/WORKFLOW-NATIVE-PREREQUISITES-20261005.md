# Workflow native prerequisites, 2026-10-05

The workflow job includes eight platform files with actual PostgreSQL cases. Its previous Temporal-only setup left 82 cases skipped and failed the strict gate. The fresh native successor ran 1190 passing cases and two failing absent-config cases: those fixtures cleared the explicit platform configuration but retained the genuine `SUPABASE_DB_URL` fallback.

The job now owns the pinned PostgreSQL16.15 service and two distinct disposable databases. `ZENITH_TEST_PLATFORM_PG_URL` names `zenith_platform_ci`; `SUPABASE_DB_URL` names `zenith_ci`. The fixed database creation step precedes canonical agent initialization and verification, then canonical platform migration and current-ledger verification. The existing Supabase bootstrap applies and verifies the current committed migration list separately. None of those steps is optional. Existing Node22.23.3, Temporal1.9.1, serial commands, immutable public GitHub source, report checks and execution binding stay in place.

Five exact required native flags enable the eight files' existing prerequisite refusals. The canonical manifest declares actual PostgreSQL and the schema order. Its same 58 identities remain required; the eight existing whole-file identities also survive source deletion. Source/report models challenge missing or substituted prerequisites, source deletion, failed/skipped/missing/zero/malformed/duplicate reports and absent execution binding. The report validator is unchanged. Platform1059, canonical PostgreSQL80, Linux123 and packaged worker22 obligations are preserved.

Only the two intended absent-config cases now clear all three production configuration sources: `ZENITH_PLATFORM_DB`, `ZENITH_PLATFORM_DB_URL` and `SUPABASE_DB_URL`. Their original assertions, titles and existing `vi.unstubAllEnvs()` restoration remain. The native harness URL is preserved and the production opener is unchanged.

This is source-only work. No imports, compiler, tests, database, Temporal, Docker, service, installation, staging or commit ran in this lane. Both failed runtime receipts remain historical failures. Source/report models cannot prove PostgreSQL or Temporal execution, hosted deployment, product/browser authority, provider effects or cleanup completion.

Root verification, still unrun for this packet:

```sh
node node_modules/vitest/vitest.mjs run tests/ci/gate-manifest.test.ts tests/ci/platform-coverage.test.ts tests/ci/release-gates.test.ts --maxWorkers=1 --no-file-parallelism
node node_modules/vitest/vitest.mjs run tests/platform/agent-ports.test.ts tests/platform/composition.test.ts --maxWorkers=1 --no-file-parallelism
node scripts/ci/run-gate.mjs workflows --run
node scripts/ci/lane-report.mjs workflows .data-ci-lane/workflows-lane.json
node scripts/ci/run-gate.mjs workflows --validate .data-ci-lane/workflows-lane.json --require-execution
```

The last three commands require both positively owned databases initialized through the exact canonical scripts, the pinned Temporal CLI and existing permitted time-skipping/public-source prerequisites. Root also owns compiler/lint and coherent full-gate execution. Stand-in CI roles and modeled cloud/hosted responses supply no live acceptance. Stale comments in the existing platform migration shell script remain a separate documentation follow-up.
