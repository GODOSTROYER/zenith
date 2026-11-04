# WS-DESTROY-WIRE — environment teardown reachable from the product, end to end

Workstream: WS-DESTROY-WIRE (orchestrator brief) — Branch ws/destroy-wire — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-destroy-wire
Base: platform/integration (wave 6 merged: destroy engine/workflow from WS-DESTROY, plan-level approval
rounds from WS-APPROVAL-FLOW, secret sync, Manifest V2 in the product store)

## Situation (read src/lib/execution/destroy.ts, src/lib/workflows/definitions/destroy.ts,
src/lib/tofu/engine.ts destroy functions, and the WS-DESTROY notes in its commit/tests first)
The destroy engine and workflow exist and are tested, but nothing in the product starts them:
1. No product action proposes `infrastructure.destroy` (src/lib/actions/defs/env.ts has `env.delete`
   for the record only).
2. The broker's `ProposeContext` requires a `NormalizedPlan`; destroy activities produce summaries. The
   broker needs a TRUSTED, evidence-backed proposal input: load the reviewed destroy-plan facts and
   digest server-side from the recorded `tofu_plan` evidence, validate workspace/environment and
   `destroy: true`, and bind them into the immutable proposal. Destroy approval status must return a
   real human approval id.
3. Manifest-removal (a deploy that drops resources) must pass trusted `deletionNodes` and the DNS
   ownership guard (`assessRecordDeletion` for AWS; equivalent fail-closed guard elsewhere) into the
   engine options from src/lib/execution/plan.ts / apply.ts.
4. Providers that do not use OpenTofu: Kubernetes and Zenith-managed environments tear down by
   pruning every Zenith-owned object (stateful objects retained unless deletionPolicy allows), and
   Zenith-managed teardown calls `teardownZenithTls` under the environment lease.

## Objective
`env.teardown` (product action, human-only, browser session) → destroy plan → policy (destructive:
approval required in every class) → digest-bound human approval → fenced destroy apply/prune → verify
absence (missing = done; inaccessible/unknown = uncertain) → environment marked torn down. Stateful
resources are retained unless the node's deletionPolicy allows deletion AND the approval covered it.

## Owned paths
src/lib/actions/defs/env.ts (+ a new defs file if cleaner, registered in defs/index.ts) ;
src/lib/capabilities/** (trusted destroy proposal input; keep Broker facade signatures) ;
src/lib/platform/broker.ts ; src/lib/execution/{destroy,plan,apply}.ts ; src/lib/bridge/** (start the
destroy workflow like deploys) ; src/lib/providers/kubernetes/** and src/lib/providers/zenith/** (teardown
paths only) ; src/app/(product)/platform/** (a teardown control on the environment view, optional) ;
tests for all of it (new files + necessary updates); docs/platform/operations/RECOVERY.md (teardown section).

## Tests
Product action → workflow → approval → destroy (fake tofu + Temporal test env as tests/platform does);
stateful retention without deletionPolicy; approval reject → nothing destroyed; plan changed after
approval → refused; DNS dangling refusal; Kubernetes/Zenith prune teardown incl. TLS teardown; agents
cannot propose or approve teardown (refused for integration/navigator).

## Verification
- npx tsc --noEmit ; npx eslint <touched paths>
- npx vitest run --maxWorkers=4 tests/platform tests/workflows tests/execution tests/capabilities tests/actions tests/bridge tests/providers/kubernetes tests/providers/zenith
