# Destroy workflow planning admission correction

This four-path source packet fixes a destroy workflow startup regression exposed by the root platform PostgreSQL run on tree `810678f5b44dc67893d5bb1279b99110db248b05`. The run recorded 2755 passed, 27 failed and eight declared skips. Two failures reached `beginExecution`, which signed an early `infrastructure.destroy` grant before any authenticated original-plan hold existed. Migration 15 correctly refused that grant. The root failure report remains unchanged.

`beginExecution` still evaluates the exact current destroy requirement and checks its unconsumed browser human approval. It then separately evaluates `infrastructure.plan` against the current requester, scope and policy before the existing claim can consume approvals. Only an allowed planning decision can produce a signed, persisted planning grant. This follows the existing repair startup admission. The worker's destructive grant still requires the private active original-plan hold and exact owner attempt; no provider write authority is minted at startup.

The existing current-round approval test now denies only planning policy after a valid destructive approval and verifies that signing, claim and grant insertion never occur, while the approval and operation remain unchanged. It then restores the allowed policy, verifies the real signed grant as `infrastructure.plan`, and preserves the original next-round approval assertions. The browser destroy review test checks that the workflow starts with a running claim, a consumed exact human approval and only planning authority, with zero provider apply calls. The two supersession race fixtures retain an explicit planning grant rather than an unheld destructive bearer, preserving operation, approval, event and single-use grant assertions. All eleven destroy proposal cases and twenty-one destroy review cases retain their original names and order.

The fixtures use the existing real PGlite/PostgreSQL ledger and broker, committed policy or explicitly scripted policy, and modeled product, cloud and workflow transport. They do not prove hosted composition, actual provider execution or workflow settlement. Author checks are source-only; no compiler, lint, project imports, tests, services, database, Docker, install or commit ran. Independent review and root execution remain required.

Root verification commands after source review:

```sh
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/typescript/bin/tsc --noEmit
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/eslint/bin/eslint.js src/lib/capabilities/execution.ts tests/capabilities/destroy-propose.test.ts tests/execution/destroy-review.test.ts
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/vitest/vitest.mjs run tests/capabilities/destroy-propose.test.ts tests/execution/destroy-review.test.ts --maxWorkers=1
```

The last command needs the root's owned PostgreSQL prerequisite for the existing real PostgreSQL cases and the repository's canonical policy runtime. Source receipts do not establish those prerequisites or passing results.

Outside this packet, associated destroy fixtures need genuine default paired callback admission and exact saved bytes. The historical delivery inventory intentionally does not treat a succeeded use, revoked grant, expired credential or terminal operation as provider settlement. Safe same-scope apply-then-destroy continuation needs an authenticated completion protocol and remains open. The existing saved-plan fixture that changes logical tenant/environment while sharing physical state needs an owning-scope correction. The other migration, grant error, retention and raw-grant fixtures are separate bounded work. Accepted migration 15 and all its checksums are unchanged. This packet closes neither cleanup success nor the full production requirements.
