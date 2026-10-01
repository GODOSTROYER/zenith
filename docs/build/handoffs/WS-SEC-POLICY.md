# WS-SEC-POLICY — fix SEC-F8, SEC-F10 and SEC-F1

Workstream: WS-SEC-POLICY (new; orchestrator brief) — Branch ws/sec-policy — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-sec-policy
Base: platform/integration @ e92a3df (tsc clean; WS-SEC merged with pinned findings)

Read docs/platform/THREAT-MODEL.md (findings table) and the pinned tests first.

## Findings
- SEC-F8 (MEDIUM): policy rule `agent_high_risk_requires_approval` keys on `context.origin` only
  (policy/rego/approval.rego:~137). An integration principal labelled `human` runs
  `infrastructure.apply` unattended; a navigator principal labelled `human` does so in production
  at autonomy 5. Pinned: two `it.fails("SEC-F8 …")` in tests/security/policy-invariants.test.ts.
  Fix: derive agent-ness from the authenticated principal kind (input.principal.kind or the
  equivalent field the broker sets from the verified principal), not from a caller-controllable
  origin label; keep human behaviour unchanged. Check how src/lib/capabilities builds PolicyInput
  so origin cannot be claimed (only add a minimal change there if strictly needed and say so).
- SEC-F10 (MEDIUM): an external STS error's `Error.name` can leak credential material into errors
  or events. Pinned: `it.fails("SEC-F10 …")` in tests/security/credential-boundaries.test.ts.
  Fix in src/lib/credentials/** error classification/scrubbing.
- SEC-F1 (LOW): v2 journal operation lookups tell a foreign id (403) from a nonexistent one (404):
  lookup by id alone, tenant check afterwards (src/lib/agent-access/control/journal.ts:~152,~202,
  journal-pg.ts:~281,~371). Fix: scope the lookup by workspace so foreign == nonexistent (same
  code, message, status). Find its pin in tests/security (grep SEC-F1) and flip it.

## Owned paths
policy/rego/** ; policy/dist/** (rebuild with `npm run policy:build`, then `npm run policy:check`;
if `opa` cannot run in your sandbox, change the Rego + tests and SAY the bundle was not rebuilt —
the orchestrator rebuilds) ; src/lib/policy/** ; src/lib/credentials/** (F10 only) ;
src/lib/agent-access/control/journal*.ts ; tests/policy/** ; tests/credentials/** (new files) ;
tests/agent-access/** (new files) ; tests/security/{policy-invariants,credential-boundaries}.test.ts
and the F1 pin file (ONLY flip the pins for F8/F10/F1 from `it.fails` to `it`).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/policy src/lib/credentials src/lib/agent-access/control tests/policy tests/credentials tests/agent-access tests/security
- npm run policy:build ; npm run policy:check
- npx vitest run --maxWorkers=2 tests/policy tests/credentials tests/agent-access tests/security tests/capabilities
