# MIX-07 local target verification

Built `scripts/release/local-mixed.ts` partition drill and the economics target in `local-target-runner.ts`. No Docker/PG/kind/live drill was run on this PC.

Acceptance mapping: stop the actual owned LocalStack container, send new orders, require zero acknowledgements, read PostgreSQL independently to prove pre-outage rows survive and outage rows are absent; restart LocalStack and restore the same stateless function ZIP if needed, then require recovered acknowledgements/readback. Existing deterministic economics engine reports dated transfer costs, approximate edge latency and residency; unpriced graphs fail rather than being recorded as free. Economics receipt checks pricing, positive transfers, latency entries and satisfied requested residency. Tests: `tests/release/local-targets.test.ts`, `tests/acceptance/local-targets.engine.test.ts`, `tests/execution/mixed/economics.test.ts`.

Exact Mac setup/commands: [mixed Lambda block](../../../../deploy/acceptance/local-targets/README.md). Engine expectation: 2 passed/2 skipped; recovery receipt has seven passed checks, including partition-unavailable, outage-readback and partition-recovered. Economics command:
```bash
npx tsx scripts/release/local-target-runner.ts run --scenario mixed-economics
```
Expected exit 0, four passed checks; economics.json is a dated estimate including transfer/latency/residency, never an invoice, SLO or cap. Missing prices fail.

Scope limits: a local emulator process outage, not a real provider outage; restoration reprovisions a stateless function, not durable cloud-state recovery. Economics models the existing live container-equivalent manifest rather than charging emulator resources. J8 catalog work must join; existing gated live recovery/traffic harnesses remain unchanged, deferred. No schema change. Suggested ledger status: implementation_complete_verification_pending.
