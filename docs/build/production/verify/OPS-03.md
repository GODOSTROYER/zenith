# OPS-03: J11 image and workflow-history replay seams

Existing worker/API upgrade/schema/protocol/rollback implementations are mapped in `PROD-OPS-03.md`; none is rebuilt
here. J11 inventories the three Kubernetes placeholder images and supplies real digest rewriting, plus a named manifest
lane `workflow-history-replay`. It is emitted as `required:false` while no recorded JSON/manifest exists. Any JSON fixture
or manifest activates `required:true`, including malformed or partial sets, which then fail integrity/coverage checks.
Read-only Git HEAD inventory retains the requirement if committed fixtures are later deleted; an unavailable Git inventory
cannot silently disable it. No Git writes occur.
Explicit lane invocation always sets `ZENITH_REPLAY_LANE=1`, so absence cannot be counted as successful replay.

Ten strict groups retain all six literal inventory/coverage/patch checks, actual replay, both nondeterminism negative
controls, and the versioning audit. `tests/ci/workflow-history-replay-manifest.test.ts` checks activation and missing/skipped/
failed report refusal with synthetic reports only. No real histories were recorded or fabricated by this builder.

## Exact Mac commands: replay

Prerequisites: Node 22, installed locked dependencies, pinned Temporal CLI 1.9.1, and the existing local workflow harness.
It starts and tears down its own local Temporal server. Keep one worker/process and no parallel heavy Docker workload.

```bash
export ZENITH_TEST_TEMPORAL_CLI="$(command -v temporal)"
"$ZENITH_TEST_TEMPORAL_CLI" --version
# Same record mode as replay:record, with the lean verifier worker limits explicit:
ZENITH_TEST_TEMPORAL=1 ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts --no-file-parallelism --maxWorkers=1
# Orchestrator reviews and commits recorded histories; this worker never writes .git.
node scripts/ci/gate-manifest.mjs workflow-history-replay
node scripts/ci/run-gate.mjs workflow-history-replay --run
node scripts/ci/run-gate.mjs workflow-history-replay --validate .data-ci-lane/workflow-history-replay-lane.json --require-execution
ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/upgrade-rehearsal.test.ts --no-file-parallelism --maxWorkers=1
```

Expected: the current scenario inventory is recorded (do not trust historical 19-scenario counts), MANIFEST.json freezes
every hash, the lane becomes required, every integrity/coverage/negative control and every history replay passes. The
existing unconditional opt-in notice is an explicit skipped informational test, never a passed scenario; all ten required
groups and all actual fixture cases must pass. Strict execution receipt validation must succeed separately. Preexisting
upgrade-rehearsal failures in the verifier's WIP handoff require fixes by their owner, not weakening this new gate.

Assembler join: schedule the named gate from the shared local/CI launcher once `required:true`; the existing workflows
lane continues excluding recorder/replay files because the dedicated gate owns them. This job is not authorized to edit
`.github/workflows` or the shared launcher. The manifest is already callable via `run-gate.mjs` without launcher changes.

## Exact Mac commands: real Kubernetes image references

First resolve bases as in `OPS-09.md`. Build native ARM64 images serially; use an exclusively owned loopback registry,
never a real cloud registry or real credentials. These commands require crane and a free local port 5007.

```bash
J11_REGISTRY="zenith-j11-registry-$(date +%s)"
REGISTRY_IMAGE="registry:2@$(crane digest registry:2)"
docker run --detach --name "$J11_REGISTRY" --label io.zenith.j11=true --memory 128m --publish 127.0.0.1:5007:5000 "$REGISTRY_IMAGE"
docker build --platform linux/arm64 -f Dockerfile -t localhost:5007/zenith/api:j11 .
docker build --platform linux/arm64 -f docker/worker.Dockerfile --target production -t localhost:5007/zenith/worker:j11 .
docker build --platform linux/arm64 -f deploy/self-hosted/migrations.Dockerfile -t localhost:5007/zenith/migrate:j11 .
docker push localhost:5007/zenith/api:j11
docker push localhost:5007/zenith/worker:j11
docker push localhost:5007/zenith/migrate:j11
crane digest --insecure localhost:5007/zenith/api:j11
crane digest --insecure localhost:5007/zenith/worker:j11
crane digest --insecure localhost:5007/zenith/migrate:j11
ZENITH_RESOLVE_DEPLOY_PINS=1 node scripts/deploy/pin-digests.mjs --resolve --scope release --resolver crane --image api=localhost:5007/zenith/api:j11 --image worker=localhost:5007/zenith/worker:j11 --image migrate=localhost:5007/zenith/migrate:j11
# After Cilium resolution too, this must exit 0 with pending:[]:
node scripts/deploy/pin-digests.mjs --check
```

Keep the owned registry until the kind pull/load/rollout rehearsal finishes; kind nodes need the existing verifier local-
registry mirror wiring (node localhost is not host localhost). Use the pinned images and existing rolling-upgrade script
with positively owned cluster/secrets and real in-flight histories, following `docs/platform/operations/ROLLING-UPGRADES.md`.
Cleanup only the recorded owned registry name with `docker rm --force "$J11_REGISTRY"`; no global pruning. A native image
build or pin does not prove Kubernetes rollout, N-1 upgrade or rollback. This base's API manifest probes `/api/me` on port
3400. J11 additionally fixes the owned worker Deployment's Pod-IP probe mismatch: startup/readiness execute the packaged
Node runtime against the existing loopback listener, with the same periods/failure thresholds and 660-second drain. The
probe accepts only HTTP 200, rejects malformed ports, and aborts within the existing one-second probe timeout. The local
Node/HTTP contract is in `tests/ops/k8s-worker-probe.test.ts`; actual packaged worker dependencies and Kubernetes startup
still require the Mac rollout rehearsal.

**Not run here (needs registry/Docker, Temporal and kind on Mac).** The placeholders intentionally remain until real
artifacts exist. No migration/schema/protocol/deployment-guard assertions changed. Ledger status stays verification pending.
