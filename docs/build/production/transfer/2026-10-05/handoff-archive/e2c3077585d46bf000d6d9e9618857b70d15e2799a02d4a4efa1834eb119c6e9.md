# Worker codec fixture correction, 2026-10-04

This source-only packet updates `tests/workflows/codec-wiring.test.ts` for the current execution worker composition. It changes no production code and provides no native worker, Temporal, PostgreSQL or package acceptance evidence.

The root's full unit run on the prepared dependency tree reported four failures in this file: mTLS worker success exited with failure, the private transport case never reached the intercepted connection, the decrypt-compatible worker success exited with failure, and one invalid production key escaped during static module loading. The retained evidence is `/Users/saivedanthava/.codex/zenith-production/logs/operations-integrated-full-r2-20261004-unit.json`. The codec fixture worktree starts at `2fcc3cd163cfb525e5890dc2e1461a6bf47ed2e1`.

The worker now imports the default reconciliation composition and Azure source-storage resolver, validates reconciliation configuration, opens its own reconciliation client, observes pollers, prepares the schedule, starts a monitor, and shuts down a created worker before closing resources. The old fixture omitted these composition boundaries and methods. Its worker `run()` also returned no Promise. Loading the real default composition reached product store environment validation before the worker's handled startup path.

The fixture now intercepts the default composition modules themselves. It supplies explicitly modeled sweep activities, a client identity, poller observation, schedule preparation, monitor and owned close methods. Its monitor returns `missing`, with `observationCurrent: false`, rather than claiming native reconciliation readiness. The modeled worker returns a settled Promise and supplies shutdown with a local state transition. These SDK and startup replies are test fixtures; none establish native readiness or authorization.

All original suite names, case declarations and assertions remain. The client and codec suites are unchanged. The process fixture still uses production `NODE_ENV`, the real worker configuration parser, real TLS file parsing, real worker option mapping and real payload codec. It explicitly selects the ordinary reconciliation `observe` configuration with the existing bounded defaults. No production environment validator, broker guard or runtime code is relaxed.

Additional assertions bind the composed store, Azure resolver, sweep activity, parsed reconciliation configuration and same converter to the worker and reconciliation client. They retain startup-before-effects, mTLS byte identity, current-key refusal, retained-key decryption, unchanged worker options and private-error assertions. Cleanup keeps the original health, janitor, native connection and store ordering, and checks worker shutdown, monitor stop and reconciliation client closure in their current positions. Failed prerequisite and invalid key cases still refuse before composition; a transport refusal closes the opened store without inventing a worker or reconciliation client.

The exact patch, prepared preimages, after-images and SHA256 inventory live under `/Users/saivedanthava/.codex/zenith-production/logs/codec-fixture-20261004/revision1`. Static review compares all original assertion lines in order, all suite/case declaration groups, every outside-owned tracked path and critical production source hashes. `git diff --check` is the only executable repository check performed by the author. No compiler, lint, test, candidate import, dependency install, service, Docker, database, cloud call or commit was run.

Root verification remains required after independent source review. Run from the integrated candidate with the existing locked dependencies and pinned Node 22. These commands are proposed and unrun:

```sh
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/typescript/bin/tsc --noEmit
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/eslint/bin/eslint.js tests/workflows/codec-wiring.test.ts
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/vitest/vitest.mjs run tests/workflows/codec-wiring.test.ts --maxWorkers=1 --no-file-parallelism
```

All production composition, configuration, startup, lifecycle and codec paths remain outside ownership and unchanged. Actual worker package startup, authenticated Temporal transport, native poller/schedule behavior, PostgreSQL readiness and full regression acceptance remain separate root-owned verification. The previously frozen MCP packet remains unchanged, including its disclosed final cross-store dispatch window and required native evidence. This fixture packet closes no production requirement by itself.
