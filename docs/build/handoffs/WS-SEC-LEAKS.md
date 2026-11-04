# WS-SEC-LEAKS — fix SEC-R1, SEC-F11, SEC-F12 and SEC-F13

Workstream: WS-SEC-LEAKS (new; orchestrator brief) — Branch ws/sec-leaks — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-sec-leaks
Base: platform/integration @ e92a3df (tsc clean; WS-SEC merged with pinned findings)

Read docs/platform/THREAT-MODEL.md (findings table) and each pinned test first.

## Findings (each pinned as `it.fails` — flip ONLY these pins to `it` once fixed)
- SEC-R1 (MEDIUM): `project.importCompose` writes the pasted compose text, plaintext secrets
  included, into the audit row, and audit `error` text is never redacted
  (src/lib/actions/core.ts:~685-725). Pin: tests/security/audit-secret-leakage.test.ts.
  Fix: audit records a bounded, redacted summary (never the raw compose text); redact audit error text.
- SEC-F11 (LOW): equivalent IPv4-mapped metadata literals (e.g. ::ffff:169.254.169.254 and other
  spellings) are not refused by the observability operator-URL guard. Pin:
  tests/security/signal-boundaries.test.ts. Fix in src/lib/observability/** host classification.
- SEC-F12 (MEDIUM): runtime node specs can reach Temporal workflow payloads/history via the
  workflow client surfaces. Pin: tests/security/workflow-history.test.ts (parameterised per
  surface). Fix: the client (src/lib/workflows/client.ts) refuses or strips anything but ids and
  the allowed scalar fields before serialization; workflows stay ids-only.
- SEC-F13 (LOW): credential-shaped expected attributes / desired drift values can reach driver
  contract outputs and reconcile events. Pin: tests/security/reconcile-value-boundaries.test.ts.
  Fix in src/lib/reconcile/** (scrub before persisting/emitting; attribute names only).

## Owned paths
src/lib/actions/core.ts (audit path only) ; src/lib/audit/** if it exists ; src/lib/observability/** ;
src/lib/workflows/client.ts and ADDITIVE src/lib/workflows/types.ts ; src/lib/reconcile/** ;
NEW tests under tests/actions, tests/observability, tests/workflows, tests/reconcile ;
the four pinned files above (flip pins only).
Do NOT edit src/lib/workflows/activities/index.ts or src/lib/platform/** (WS-COMPOSE).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/actions/core.ts src/lib/observability src/lib/workflows/client.ts src/lib/workflows/types.ts src/lib/reconcile tests/security
- npx vitest run --maxWorkers=2 tests/security tests/actions tests/observability tests/workflows/client.test.ts tests/reconcile
