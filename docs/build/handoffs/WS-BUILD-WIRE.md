# WS-BUILD-WIRE — source builds deploy by digest on GCP and Azure; secret-sink composition

Workstream: WS-BUILD-WIRE (orchestrator brief) — Branch ws/build-wire — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-build-wire
Base: platform/integration (wave 6 merged: GCP/Azure release ports from WS-BUILD-MULTI, secret sync from
WS-SECRET-SYNC, Azure drivers incl. WS-AZURE-MORE)

## Situation
AWS solves "image is only known after the build" with an SSM parameter pointer: tofu creates the
workload with a bootstrap image and ignores later image changes; `deployImage` rolls the digest and
records it (src/lib/providers/aws/drivers/compute/ecs-task.ts emitImage + ecs-operations.ts deployImage).
GCP and Azure have release ports (src/lib/platform/release-{gcp,azure}.ts, providers/*/release/**) but:
- GCP compile needs built images resolved BEFORE compile, while the workflow builds after planning.
- Azure's compiler emits `<registry>/<service>:latest` for built artifacts
  (src/lib/providers/azure/drivers/compute/workload.ts ~118).
- Source acquisition needs an injected `SourceBundlePort` (execution ports) and Azure's `readSource`.
- SECRET-SYNC left: the Zenith-managed Neon adapter's ConnectionSecretSink composition and the
  infra → secret sync → rollout ordering for managed databases (src/lib/secrets/DELIVERY.md).

## Objective
Same contract on every provider: compile never needs the not-yet-built digest and never emits
`:latest`; built workloads start from a pinned bootstrap reference with image changes ignored by tofu;
the release port rolls the exact digest and records it so a later apply renders the deployed digest
(GCP: Cloud Run revision update; Azure: Container App revision; jobs likewise); source bundles flow
through `SourceBundlePort`; managed-database credentials flow through the ConnectionSecretSink before
workloads roll.

## Owned paths
src/lib/providers/gcp/drivers/compute/** and src/lib/providers/gcp/release/** ;
src/lib/providers/azure/drivers/compute/** and src/lib/providers/azure/release/** ;
src/lib/platform/release*.ts and src/lib/platform/execution.ts (port wiring) ; src/lib/execution/ports.ts
(additive SourceBundlePort if missing) and src/lib/execution/release.ts (ordering) ;
src/lib/providers/zenith/** (Neon sink composition only) ; src/lib/secrets/** (sink wiring only) ;
tests under tests/providers/{gcp,azure}, tests/platform, tests/execution, tests/secrets (new + necessary updates).
Do NOT edit src/lib/capabilities/**, src/lib/actions/**, src/lib/bridge/** (WS-DESTROY-WIRE).

## Verification
- npx tsc --noEmit ; npx eslint <touched paths>
- npx vitest run --maxWorkers=4 tests/providers/gcp tests/providers/azure tests/platform tests/execution tests/secrets tests/providers/zenith
- ZENITH_TEST_TOFU_NETWORK=1 for gcp/azure validate suites (say if tofu cannot run in your sandbox)
