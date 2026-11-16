# WS-TEMPORAL-MTLS - Temporal client/worker mTLS configuration

Workstream: WS-TEMPORAL-MTLS (orchestrator brief, wave 8) - Branch ws/temporal-mtls - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-temporal-mtls
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
src/lib/workflows/config.ts supports API key or TLS-with-defaults only; there is no custom CA or client certificate (docs/platform/operations/DEPLOYING.md says mTLS is not wired).

## Do
1. Env: ZENITH_TEMPORAL_TLS_CA_FILE, ZENITH_TEMPORAL_TLS_CERT_FILE, ZENITH_TEMPORAL_TLS_KEY_FILE (optional ZENITH_TEMPORAL_TLS_SERVER_NAME); cert and key only together;
   files read once at startup with size bounds; never logged (describeTemporalConfig reports set/unset only).
2. Both the web client and the worker use it (connectionOptionsFor).
3. Tests: validation matrix, describe output has no PEM, wiring into the connection options (mocked).
4. DEPLOYING.md table rows; remove the "mTLS is not wired" claim; docs guard env list.

## Owned paths
src/lib/workflows/config.ts , src/lib/workflows/client.ts (connection options only) , workers/execution/** (connection options only) , tests/workflows/** , tests/workers/** , docs/platform/operations/DEPLOYING.md , docs/LIMITATIONS.md , tests/docs/operator-docs.test.ts
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
