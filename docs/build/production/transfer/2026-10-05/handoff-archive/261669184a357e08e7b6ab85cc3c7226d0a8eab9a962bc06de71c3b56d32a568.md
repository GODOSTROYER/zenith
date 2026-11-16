# WS-MACHINE-PORT - default composition supplies the machine port

Workstream: WS-MACHINE-PORT (orchestrator brief, wave 8) - Branch ws/machine-port - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-machine-port
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
src/lib/execution/capability.ts calls executeMachineOperation but default composition (src/lib/platform/execution.ts) supplies no `machines` port; Azure Run Command, AWS SSM and read-only GCP OS Inventory transports exist (src/lib/machines/**).

## Do
1. Compose a provider-dispatched machine port in default composition: AWS SSM Run Command, Azure Run Command, GCP read-only inventory (mutations refuse: they need zenithd),
   and zenithd for registered machines; each over the broker session for the grant, behind the existing policy/approval gates (machine.exec stays an escape hatch that needs admin approval).
2. Bounded output, redaction, idempotency per operation; no new privilege.
3. Tests per provider with mocked SDKs; update the operator-docs guard that asserts "no machines port in default composition" so it asserts the new wiring.
NOTE: WS-AWS-BOUNDARY-MORE is concurrently adding the EC2 SSM agent permissions to the AWS boundary; do not touch deploy/aws/**.

## Owned paths
src/lib/platform/execution.ts (composition lines only) , src/lib/machines/** , src/lib/execution/capability.ts (port typing only) , tests/machines/** , tests/execution/** (machine tests) , tests/platform/** (composition tests) , docs/platform/operations/DEPLOYING.md (machine section) , docs/LIMITATIONS.md , tests/docs/operator-docs.test.ts (machine-port assertion only)
Anything outside: list it in your final report as an orchestrator follow-up instead of editing it.

## Rules that always apply
Deterministic code owns credentials, policy, approvals, state and execution; models only propose. Approvals are human, browser-only,
bound to an immutable plan digest. No secret value in logs, state, evidence, errors, URLs or test output. Nothing is labelled live-verified.
Update docs/LIMITATIONS.md: remove or narrow the gap line you closed, and keep any remainder honest.

## Verification
- `npx tsc --noEmit` (at most twice) ; `npx eslint <touched paths>`
- `npx vitest run --maxWorkers=1 <the suites you touched or that cover the code you changed>`
- `npx vitest run --maxWorkers=1 tests/docs` if you changed any doc or a claim a docs guard checks
- Anything your sandbox cannot run (tofu, opa, go, temporal, Docker, live cloud): write the test anyway, gate it the way the repo
  already gates such tests, and SAY it was not run; the orchestrator runs it outside the sandbox.
