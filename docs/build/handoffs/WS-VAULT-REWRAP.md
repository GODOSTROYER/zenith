# WS-VAULT-REWRAP - product-vault key rotation: re-wrap tooling and runbook

Workstream: WS-VAULT-REWRAP (orchestrator brief, wave 8) - Branch ws/vault-rewrap - worktree Z:/Projects/Spawned.ai/zenith-wt/ws-vault-rewrap
Base: ws/integrate-w6 (staging: all of wave 7 merged)

## Situation
docs/LIMITATIONS.md ("Still-open gaps at source snapshot 3c1fa66") lists this as an open code gap. Read that line, the linked operator guide, and the code it names before designing anything.
ZENITH_SECRET_KEY protects product vault secrets (src/lib/secrets/**); Temporal payloads have decrypt-only previous keys, but there is no tool to re-encrypt vault data under a new key.

## Do
1. A re-wrap command (`npm run vault:rewrap`, scripts/vault-rewrap.ts) that reads ZENITH_SECRET_KEY (new) and ZENITH_VAULT_PREVIOUS_SECRET_KEYS (JSON array),
   decrypts each vault row with whichever key wrote it, re-encrypts under the new key in bounded batches inside transactions, idempotent and resumable,
   with --dry-run, counts only (never values) in output, and an audit event.
2. The vault read path accepts previous keys during rotation (decrypt-only) and never writes with them.
3. Tests on PGlite/the file store: mixed-key rows, an interrupted run resumes, a wrong key fails closed without partial writes, output has no secret.
4. A runbook section in docs/platform/operations/DEPLOYING.md or RECOVERY.md; the env var documented (a docs guard requires it).

## Owned paths
src/lib/secrets/** , src/lib/db/** (vault row access only) , scripts/vault-rewrap.ts , package.json (one script line) , tests/secrets/** , docs/platform/operations/{DEPLOYING,RECOVERY}.md , docs/LIMITATIONS.md , tests/docs/operator-docs.test.ts (env-var list only)
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
