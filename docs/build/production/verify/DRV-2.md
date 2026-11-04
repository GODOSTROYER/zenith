# DRV-2: operated drift-repair and crash-partition

Built from 7d52b372 in prod7-drivers-d2. All changes remain uncommitted. This PC builds and runs offline contracts only. Operated acceptance is **not run (needs native Mac ARM64, Docker, real PostgreSQL, Temporal, kind and Chromium)**. No live API, real account credentials, migrations, aggregate SQL or dependency changes.

## Implementation and acceptance

| Clause | Implementation | Proof |
| --- | --- | --- |
| Real operated preconditions | drivers/operated.ts reuses J1 private state, immutable source binding, readiness and labelled cleanup; J2 config/auth/Mailpit/MFA helpers. Refuses remote Docker and observer kubeconfigs with nonlocal servers, an alternate CA or exec plugins. The observer must exactly match kind's current owned kubeconfig. | tests/release/drivers-d2.test.ts; both operated tests |
| Human approval | Fresh independent operators log in and enroll actual TOTP factors. Browser deployment reviews include the saved-plan round. Day-two proposals use REST/MCP, self-approval is refused, and operator B clicks the real operation page's approval button. No approval row, grant or workflow signal is synthesized. | approved-workload and repair-browser-approved checks |
| Drift, repair and re-observation | drift-repair.ts changes owned witness replicas through independent kubectl, waits for the natural reconciliation schedule's nonsimulated persisted replica finding, proposes the supported service.scale repair through REST, approves in the UI, executes via MCP and verifies kind/application state. A newer full clean report is required. | drift-repair.operated.test.ts: 8 checks, 4 independent readback hashes |
| Crash, restart and partition | crash-partition.ts temporarily disables only the owned worker's restart policy, SIGKILLs it and observes exit137 before enqueueing approved work. The independent app serves during the actual outage. The original workflow survives restart. A real Docker network disconnect isolates the original worker; a canonical prepareJoin worker with separate identity/scratch recovers the retained workflow. Two approved same-environment writes run with both workers polling; independent read-only PostgreSQL checks require distinct native fence tokens. A duplicate completed execute call must return startedNow=false and leave kind generation unchanged. | crash-partition.operated.test.ts: 11 checks, 7 independent readback hashes |
| Owned cleanup after success, failure or interruption | Restoration is registered before mutation. Cleanup attempts continue after failures: restore original network/restart policy, stop/remove the positively labelled peer, drain original worker, remove only the exact recorded J2 kind node, revoke linked credentials, delete disposable Auth users, close browser, then J1's existing cleanup enumerates owned resources and independently proves absence. SIGINT/SIGTERM mark the active run interrupted and allow bounded work to enter cleanup. A failed cleanup prevents acceptance. | OwnedCleanup ordering/failure contract and mandatory cleanup check in both gated tests |
| Sanitized provenance | Closed check/limit/readback vocabulary, source commit and source-byte digest, dirty flag, and SHA256 readbacks only. Receipt label is local_operated_rehearsal. Generic J2, local_rehearsal or live receipts cannot satisfy these drivers. The strict validator also requires the exact non-skipped gated Vitest identity. | operated-contract.ts, verify.ts, offline receipt/report contracts |
| Complete joins | local-targets.ts overrides only these two catalog entries; local-target-runner.ts dispatches their dedicated drivers; scenarios.ts registers their offline contracts; acceptance-orchestrator.ts preserves and validates the operated label. gate-manifest.mjs adds drv2-drift-repair and drv2-crash-partition lanes and literal test identities. | runner provenance, manifest and existing registration regression tests |

Primary requirement: PROD-REL-01, two operated scenarios only. PROD-MIX-07 receives local control-plane outage/writer evidence, not mixed-provider outage or economics acceptance. PROD-OBS-01's automatic repair lifecycle remains in its existing component/provider lanes: Kubernetes has no drift.repair handler, so this driver repairs detected replicas through the supported, explicitly approved service.scale path. No ledger or production-state promotion is made. Suggested implementationStatus: implementation_complete_verification_pending for this driver slice.

## Exact lean-profile Mac plan

Run each scenario separately, with only one J1/kind profile active. Each driver **consumes and cleans the supplied disposable stack and kind fixture**. Do not reuse a stack or an existing cluster. Keep source bytes frozen from J1 build through strict verification; copy receipts into an evidence directory only afterward. Docker Desktop gets 4 GiB, kind uses J2's one-node 640 MiB cap, and the temporary joined worker is capped at 512 MiB/pool2. These caps are provisional until measured on the Mac; OOM is a failed run, not permission to weaken assertions.

The operator supplies the approved native digest pins (same J1/J2 prerequisites as PKG-05.md): GO_BUILDER_IMAGE, DISTROLESS_IMAGE, KIND_NODE_IMAGE, ZENITH_DEFAULT_STACK_REGISTRY_IMAGE. Chromium must already be installed. Only a local image is pushed to J1's loopback registry. Supabase/issuer hostnames must resolve to loopback. Trust the newly generated **public** J1 CA in the browser using the existing J1 local trust procedure; TLS bypasses remain forbidden. Node gets the same CA through NODE_EXTRA_CA_CERTS at startup. No private host environment is printed or sourced into a shell.

```bash
export PATH="$HOME/.local/sdk/node22:$PATH"
set -euo pipefail
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
test "$(uname -m)" = arm64
: "${GO_BUILDER_IMAGE:?approved ARM64 digest required}"
: "${DISTROLESS_IMAGE:?approved ARM64 digest required}"
: "${KIND_NODE_IMAGE:?approved ARM64 digest required}"
: "${ZENITH_DEFAULT_STACK_REGISTRY_IMAGE:?approved local registry image digest required}"

# Build while no heavy acceptance profile is running.
docker build -f tests/e2e/default/zenithd.Dockerfile \
  --build-arg GO_BUILDER_IMAGE="$GO_BUILDER_IMAGE" \
  --build-arg DISTROLESS_IMAGE="$DISTROLESS_IMAGE" \
  -t localhost:5000/zenith-j2-witness:drv2 .

# First run: drift-repair. Repeat the setup block later with crash-partition.
SCENARIO=drift-repair
export ZENITH_LOCAL_RUN_ID="d2-$(date -u +%m%d%H%M%S)"
DRV2_BASE="$(mktemp -d /private/tmp/zenith-drv2.XXXXXX)"
chmod 700 "$DRV2_BASE"
export ZENITH_LOCAL_ROOT="$DRV2_BASE/zenith-j15-$ZENITH_LOCAL_RUN_ID-receipts"
export ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR="$DRV2_BASE/stack"
DRV2_TARGETS="$DRV2_BASE/targets"
mkdir -m 700 "$ZENITH_LOCAL_ROOT"
export ZENITH_LOCAL_TARGETS=1 ZENITH_LOCAL_JOINED_DRIVERS=1
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1 ZENITH_DEFAULT_JOURNEY=1 ZENITH_TEST_DRV2_OPERATED=1
node scripts/acceptance/default-stack/up.mjs --directory "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR" --profile lean
node scripts/acceptance/default-stack/env.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR" "$DRV2_BASE/host.env"
export NODE_EXTRA_CA_CERTS="$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR/tls/ca.crt"
# Complete J1's browser public-CA trust step now, before the following test.
docker push localhost:5000/zenith-j2-witness:drv2
DRV2_WITNESS_IMAGE="$(docker image inspect localhost:5000/zenith-j2-witness:drv2 --format '{{index .RepoDigests 0}}')"
node tests/e2e/default/prepare.mjs --directory "$DRV2_TARGETS" \
  --stack "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR" --node-image "$KIND_NODE_IMAGE" \
  --witness-image "$DRV2_WITNESS_IMAGE" --mailpit-url http://127.0.0.1:8025
export ZENITH_LOCAL_JOURNEY_CONFIG_FILE="$DRV2_TARGETS/journey.json"

node scripts/ci/gate-manifest.mjs "drv2-$SCENARIO"
npx vitest run "tests/acceptance/$SCENARIO.operated.test.ts" \
  --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json \
  --outputFile.json="$ZENITH_LOCAL_ROOT/vitest.json"
unset NODE_EXTRA_CA_CERTS # The driver has now removed its owned stack's public CA file.
node --import tsx scripts/release/drivers/verify.ts --scenario "$SCENARIO" \
  --run-id "$ZENITH_LOCAL_RUN_ID" --receipt "$ZENITH_LOCAL_ROOT/$SCENARIO.json" \
  --report "$ZENITH_LOCAL_ROOT/vitest.json"

# Idempotent J1 absence recheck. Remove browser trust for this generated CA through
# the same J1 trust procedure; retain only sanitized receipts/public diagnostics.
node scripts/acceptance/default-stack/down.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
```

For the second run, set SCENARIO=crash-partition and repeat from the fresh ZENITH_LOCAL_RUN_ID assignment through cleanup. Do not start it before the previous stack and kind fixture are absent. Expected per invocation: **1 Vitest passed /0 failed /0 skipped**, followed by **8/0/0 operated checks** for drift-repair or **11/0/0** for crash-partition. Missing gates return2 at driver entry; failed checks return1; incomplete checks return3. These are never accepted as passes.

The same registration is reachable through `node --import tsx scripts/release/local-target-runner.ts run --scenario "$SCENARIO" --receipt "$ZENITH_LOCAL_ROOT/$SCENARIO.json"` after fresh setup, and through `node --import tsx scripts/release/acceptance-orchestrator.ts run --only "$SCENARIO" --local-targets --run-id "$ZENITH_LOCAL_RUN_ID" --out "$ZENITH_LOCAL_ROOT/orchestrator"`. Do not execute this as a second pass on an already consumed fixture. The operated Vitest invocation is the lean dedicated lane above; the full scenario command additionally runs existing component lanes and preserves deferred live acceptance.

If setup or the verifier process fails before driver ownership is established, retain the failure and run J1 down on that exact private directory. For J2, only delete zenith-j2 if the private targets.json is createdBy=J2-DEFAULT-JOURNEY, status=created, and its recorded containerId still equals the current zenith-j2-control-plane ID with the kind owner label. A missing/partial receipt does not authorize deleting a differently owned cluster. A hard host/process kill can require this owner recovery; it cannot produce passing evidence. Keep the private target directory protected until its inline kubeconfig credentials are removed after confirmed cluster absence.

## Scope and remaining verification

No changes to J1/J2/J4 implementations, migrations, package files, SQL inventories, CRITICAL_JOBS or scheduling composition are needed. The natural J1 reconciliation scheduler is reused. J4's separate natural-maintenance/billing harness remains registered and unchanged. These scenarios use kind; LocalStack, Pebble and stripe-mock are unnecessary for replica repair/control-plane writer faults and must remain down to preserve the lean footprint.

Mac-operated results, native memory fit, real browser approvals, actual worker recovery and independent PostgreSQL/kind assertions remain unverified here. This slice does not prove in-flight provider nondelivery, every crash window, live cloud repair, automatic Kubernetes drift.repair, mixed-provider outage, HA or production signoff. All original gates/assertions remain. One existing planner expectation changes because these two scenarios now have additional gates and an operated evidence label; the expectation still compares every exact gate and label.

See [command report](DRV-2-COMMANDS.md) for every build check and attempt. Suggested commit: `feat(release): add operated drift and crash scenario drivers`.
