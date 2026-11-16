# WS-FIX-EPHEMERAL-REAL — make the real-OpenTofu ephemeral test agree with OpenTofu 1.12.5

Workstream: WS-FIX-EPHEMERAL-REAL (orchestrator brief) — Branch ws/fix-ephemeral-real — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-fix-ephemeral-real
Base: ws/integrate-w6 (WS-EPHEMERAL merged: TofuFragment `ephemeral` blocks, write-only `*_wo`, expression allowlist extended)

## Failure (orchestrator ran it outside the sandbox with real tofu 1.12.5, ZENITH_TEST_TOFU_NETWORK=1)
tests/tofu (the ephemeral network suite): "real ephemeral resources (network) > evaluates a password-dependent
condition and keeps generated values out of plan views and state" fails with
`expected { …(4) } to match object { input: 'checked', output: 'checked' }`.
Your sandbox cannot run tofu, so the test was never run against the real binary.

## Do
Find out what real OpenTofu 1.12.5 actually does with an ephemeral value in that condition (read the
OpenTofu 1.12 docs/changelog on ephemeral resources, write-only attributes and where ephemeral values may
flow — e.g. they cannot reach non-ephemeral outputs or resource inputs except write-only ones). Then fix the
implementation (src/lib/tofu/** ephemeral rendering) if Zenith generates something tofu does not accept or
evaluates differently, or fix the test if its expectation is wrong. The safety property stays: generated
values never appear in plan views, normalized plans, state or evidence (keep the canary checks).
The orchestrator will re-run the real-tofu test outside your sandbox; make the test's real-tofu path
precise and its assertions about tofu's behavior documented with the source you relied on.

## Owned paths
src/lib/tofu/** (ephemeral rendering only), tests/tofu/ephemeral*.

## Verification
- npx vitest run --maxWorkers=2 tests/tofu ; npx tsc --noEmit ; npx eslint src/lib/tofu tests/tofu
