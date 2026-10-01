# WS-DOCS-SYNC — bring the operator docs back in line with what is now wired

Workstream: WS-DOCS-SYNC (new; orchestrator brief) — Branch ws/docs-sync — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-docs-sync
Base: platform/integration (COMPOSE, REF, APPWIRE, UI-WIRE, CLI, PLACE-WIRE, MACH-ALIGN, DB-LEDGER,
TOFU-2, GO-OCI, SEC-* all merged)

## Situation
WS-DOCS wrote operator guides (docs/platform/operations/*.md, docs/LIMITATIONS.md, README.md
"Platform control plane" section) plus drift tests (tests/docs/operator-docs.test.ts — an
"in progress claims" table, env-var coverage, link checks — and tests/docs/capability-matrix.test.ts).
Since then the platform got composed and many "not wired / not merged" statements became false.
`npx vitest run tests/docs` currently fails, for example:
- worker/workflows now open the platform store and policy engine (src/lib/platform, workers/execution);
- the application now registers every provider's drivers (src/lib/platform/drivers.ts registerAllDrivers);
- reconciliation is wired (wireReconcilePorts in src/lib/platform/app.ts) and scheduled (tick.yml);
- the job reaper runs from the cron passes; real activities are in the worker (createActivities delegates);
- new env vars (ZENITH_SECRET_KEY, ZENITH_WORKER_PLAN_DIR, and any other ZENITH_* the platform
  modules now read) are undocumented in DEPLOYING.md;
- platform pages now render the components (src/app/(product)/platform/**);
- placement (provider:auto) recommendation, the CLI (docs/platform/CLI.md), MCP v3 (15 tools),
  oci.http, state backends for GCS/azurerm/OCI, and the SEC fixes all landed.

## Objective
Every operator-facing statement is TRUE for the current code, and the drift tests encode the new
truth (so the next change that falsifies a claim fails a test again). Honesty rules stay: nothing is
`real`/live-verified; unknown stays unknown; claims cite the file that proves them.

## Owned paths
docs/** (except docs/build/** — the ledger is the orchestrator's — and except
docs/platform/CAPABILITY-MATRIX.md and docs/platform/DRIVER-CONVENTIONS.md, which WS-DRIVER-FIX owns) ;
README.md (the platform section) ; tests/docs/** EXCEPT tests/docs/capability-matrix.test.ts
(WS-DRIVER-FIX owns it).
No source code changes. If a guide needs a fact you cannot verify from code, say "not verified".

## Do
1. Run `npx vitest run tests/docs` and fix every failure by updating the GUIDES to the truth and then
   the tests' claims table to the new truth (do not just delete assertions — replace "not wired"
   assertions with "wired here" assertions that would fail if the wiring were removed).
2. Sweep the guides for remaining stale statements (search for "not wired", "stub", "not merged",
   "nothing calls", "in progress", "pending", "gap") and correct them against the code.
3. Add short sections where an operator now needs instructions: running the worker with real
   activities (required env, startup validation), the reconcile tick, the CLI, placement, the new
   state backends per provider, MCP v3 tool list, oci.http runner config.
4. Keep the generated-matrix rule: do not hand-edit CAPABILITY-MATRIX.md.

## Verification
- npx vitest run --maxWorkers=2 tests/docs   (0 failures)
- npx eslint tests/docs
- npx tsc --noEmit
