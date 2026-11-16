# DUR-03: J2 default journey join

Implementation complete, verification pending. The default worker's saved-plan/semantics gate, rejected stale digest and B's real UI approval are exercised by J2. Full component mutations and dispatch-time changed-semantics tests remain in PROD-DUR-03-04.md.

The real harness is `tests/e2e/default/journey.spec.mjs`, with gated fixture preparation,
customer witness and sanitized receipts under `tests/e2e/default/**`.
See [PKG-05](PKG-05.md) for the exact Mac start, image pins, TLS/Auth/Mailpit,
private configuration, invocation, cleanup, expected counts and assembly joins.
Run those commands on the same coherent RC as the existing requirement's tests.

Windows contract check:
```bash
npx --offline --no-install vitest run tests/e2e/default/receipt.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: 17 passed /0 failed /0 skipped; contract evidence only.
Default Playwright/PG/Temporal/kind/Docker checks: **not run (needs Mac engines,
Chromium, pinned test runner and J1/other joins)**. No live cloud call, migration,
production signoff or verified ledger state is implied. Suggested ledger
`implementationStatus`: `implementation_complete_verification_pending`.
