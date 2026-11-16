# W5-ASSEMBLY verification hand-off

Source: working-tree assembly on `prod/compose` after `443bfeaf`. The orchestrator commits and integrates. No git mutation, package installation, credential access or cloud call was authorized or performed. Implementation and all release states remain verification pending.

## Included changes and joins

Unpublished schemas renumbered 44â€“52; immutable verifier schemas 42/43 retained. Aggregate 0026 contains the union of new tables and narrow grants; every table is in the sensitive inventory. Contract widenings 49/51 need exact reviewed SQL plus drained-writer admission. Additive privilege blocks are bound to exact SQL hashes; edited blocks refuse. `retention_restores` gains its required tenant-leading index.

Restore measurements feed OPS-01 through a registered local recorder using incident/snapshot/finish instants. Archive encryption has purpose `enc:archive`. Audit signatures require independent `signing:audit-export`. Billing is a leased durable critical job, with the same guarded fallback route; quota admission precedes suspension admission. Managed session/composition, domain routes, reconciliation and drift are joined. First-deploy plans refuse before server validation unless separately approved tenant isolation is ready. Direct Kubernetes retains the verifier's reviewed-semantics implementation. SLO navigation, release actionlint and action pins are retained.

Gate inventory: 74 contract test files (10 adversarial), 9 external files; 1,144 platform PostgreSQL requirements, 76 workflow requirements and 29 OpenTofu suites. New contract/adversarial/recovery CI jobs validate their actual reports and upload only sanitized receipts. New native SLO/billing/mixed requirements are literal so deleting source cannot remove them. No historical identity or required assertion was removed.

## Deferred Mac commands

Run serially with Node22 and owned disposable services. Never point these commands at production. Set `ZENITH_TEST_PLATFORM_PG_URL` to a positively owned PostgreSQL16 database with CREATEDB; set separate `SUPABASE_DB_URL` to the owned agent/member database. The verifier owns setup, CLI version/hash verification and teardown. Empty prerequisites are failures in required lanes; a skipped test is never acceptance.

```bash
# 1. Canonical schema, tenancy and actual PG transactions; PostgreSQL16 required.
export ZENITH_ALLOW_CONTRACT_MIGRATIONS=42,49,51
bash scripts/ci/apply-platform-migrations.sh
npx vitest run tests/controlplane/migrations.test.ts tests/controlplane/migration-compat.test.ts tests/controlplane/tenancy.test.ts tests/controlplane/mixed-parent-plans.test.ts tests/controlplane/mixed-follow-up.test.ts tests/controlplane/recovery-epoch.test.ts tests/slo/slo.engine.test.ts tests/billing/billing.engine.test.ts tests/managed-serving/domain-store.test.ts tests/managed-serving/domain-routes.test.ts --no-file-parallelism --maxWorkers=2
# Complete native cohorts additionally need pinned OpenTofu, OPA and agent/product schemas.
node scripts/ci/run-gate.mjs platform-postgres --run
node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution

# 2. Matching pg_dump/pg_restore, owned PG CREATEDB and pinned Temporal CLI/dev server.
export ZENITH_TEST_PG_DUMP_BIN="$(command -v pg_dump)"
export ZENITH_TEST_PG_RESTORE_BIN="$(command -v pg_restore)"
export ZENITH_TEST_TEMPORAL_CLI="$(command -v temporal)"
node scripts/ci/run-gate.mjs recovery --run
node scripts/ci/run-gate.mjs recovery --validate .data-ci-lane/recovery.json --require-execution
# Workflow union, actual local Temporal and real PG, canonical agent/product/platform schemas.
node scripts/ci/run-gate.mjs workflows --run
node scripts/ci/run-gate.mjs workflows --validate .data-ci-lane/workflows-lane.json --require-execution

# 3. OpenTofu1.12.5, pinned plugins and writable local cache; no cloud credential.
ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/tofu/typed-inputs.test.ts tests/tofu/typed-substitution.test.ts --no-file-parallelism --maxWorkers=2
# Require the pinned local Go toolchain for the SBOM build-info case.
export GOTOOLCHAIN=local
export ZENITH_TEST_GO="$(command -v go)"
test "$(go env GOVERSION)" = "go1.27.1"
node scripts/ci/run-gate.mjs wave5-contract --run
node scripts/ci/run-gate.mjs wave5-contract --validate .data-ci-lane/wave5-contract.json --require-execution
node scripts/ci/run-gate.mjs adversarial --run
node scripts/ci/run-gate.mjs adversarial --validate .data-ci-lane/adversarial.json --require-execution

# 4. Docker/kind/kubectl, Gateway API, two verified digest-pinned images.
# The first harness creates/removes its disposable cluster; supply the image variables first.
: "${ZENITH_MAN_REGISTRY_IMAGE:?verified registry image@sha256 required}"
: "${ZENITH_MAN_BUILDER_IMAGE:?verified builder image@sha256 required}"
bash scripts/k8s/managed-substrate-acceptance.sh
# For a separately owned prepared kind cluster and digest-pinned probe image:
ZENITH_TEST_MANAGED_SERVING_KIND=1 npx vitest run tests/managed-serving/serving-kind.test.ts --no-file-parallelism --maxWorkers=2
ZENITH_TEST_MANAGED_ONBOARDING=1 npx vitest run tests/isolation/managed-onboarding-readiness.test.ts --no-file-parallelism --maxWorkers=2
# Complete setup/cleanup and absent/prepared namespace cases: W5-ASSEMBLY-ONBOARDING.md.
bash scripts/isolation/tenant-isolation-acceptance.sh kind-calico
# Supply publisher-verified ZENITH_CILIUM_CHART_VERSION and ZENITH_CILIUM_CHART_SHA256 first.
bash scripts/isolation/tenant-isolation-acceptance.sh kind-cilium

# 5. Local IAM-enforcing S3 emulator; runtime-generated fake admin values only.
: "${ZENITH_TEST_IAM_ENDPOINT:?local emulator endpoint required}"
: "${ZENITH_TEST_IAM_ADMIN_KEY_ID:?emulator fixture identity required}"
: "${ZENITH_TEST_IAM_ADMIN_SECRET:?runtime fake secret required}"
ZENITH_TEST_IAM_ENFORCED=1 npx vitest run tests/managed-serving/storage-emulator.test.ts --no-file-parallelism --maxWorkers=2

# 6. DOM contract tests; these do not prove a real browser journey.
npx vitest run tests/platform-ui --no-file-parallelism --maxWorkers=2
# Real Chrome/Edge/Chromium required; each harness owns its loopback server and fake credentials.
npx tsx scripts/hosted-browser.ts
npx tsx scripts/agent-browser.ts
```

Kind probe variables `KUBECONFIG` and `ZENITH_TEST_K8S_IMAGE` are private inputs. Follow PROD-MAN-01, PROD-MAN-02-03, PROD-MAN-04-05 and W5-ASSEMBLY-ONBOARDING for the exact existing bootstrap prerequisites. Runtime/FQDN probes remain unverified without their enforcing implementations.

Live clouds remain deferred by the user. `tests/live/mixed-connectivity.live.test.ts` and the release harness must remain gated; do not enable `ZENITH_LIVE_MIXED`, approve `docs/build/production/permissions.json`, create a release key or run real APIs as part of this verification. A later person must explicitly approve budgets and supply protected credentials. The experimental Lambda driver is not a runnable manifest service: native configuration, artifact custody and authenticated invocation/endpoint need implementation before the mixed fixture can become functions. Container substitution remains labelled.

## Builder command receipts

All shell invocations prepend the required Node22 PATH. Read-only git status/log/diff, rg and file inspection commands have no tests; their exits diagnose source discovery only. Validation counts and initial failed runs are retained below. No counts overlap claim is made between runs. Raw temporary Vitest reports contain only local diagnostics and are summarized here before cleanup.

Builder validation receipts are in [W5-ASSEMBLY-RESULTS.md](W5-ASSEMBLY-RESULTS.md). Failed attempts remain in that record with separate successor results. The branch command used 82 files from the inventory below, excluding `wave5-compat.test.ts`, which ran in the schema group; the full acceptance inventory has 83 files. Real engines and clouds remain pending.

The report validator now resolves each evidence filename once instead of scanning and resolving all files for every required scenario. Duplicate/malformed evidence, suite ancestry, every assertion status and report totals still refuse exactly as before. Complete gate-model regression covers the optimization.

## Test files in the branch acceptance command

```text
tests/acceptance/mixed-connectivity-probe.test.ts
tests/acceptance/mixed-failure-scenarios.test.ts
tests/acceptance/mixed-live-recovery.test.ts
tests/acceptance/mixed-live-run.test.ts
tests/acceptance/mixed-traffic.test.ts
tests/adversarial/approvals-forgery.test.ts
tests/adversarial/build-exfiltration.test.ts
tests/adversarial/cross-tenant.test.ts
tests/adversarial/integration-compromise.test.ts
tests/adversarial/malicious-archives.test.ts
tests/adversarial/prompt-injection.test.ts
tests/adversarial/residual-hardening.test.ts
tests/adversarial/role-escalation.test.ts
tests/adversarial/ssrf-rebinding.test.ts
tests/adversarial/token-forgery.test.ts
tests/audit-export/audit-export.test.ts
tests/audit-export/purpose.test.ts
tests/billing/billing-routes.test.ts
tests/billing/billing-unit.test.ts
tests/billing/billing.engine.test.ts
tests/ci/release-workflow.test.ts
tests/ci/vulnerability-triage.test.ts
tests/connections/zenith-connection.test.ts
tests/controlplane/mixed-follow-up.test.ts
tests/controlplane/recovery-epoch.test.ts
tests/controlplane/wave5-compat.test.ts
tests/execution/mixed-orchestration-signals.test.ts
tests/execution/mixed/connectivity.test.ts
tests/execution/mixed/economics.test.ts
tests/execution/mixed/output-reader.test.ts
tests/execution/mixed/typed-delivery.test.ts
tests/execution/mixed/typed-inputs-activities.test.ts
tests/execution/mixed/typed-substitution.test.ts
tests/execution/tenant-isolation.test.ts
tests/execution/zenith-destroy-databases.test.ts
tests/execution/zenith-graph-problems.test.ts
tests/execution/zenith-managed-journey.test.ts
tests/execution/zenith-semantics.test.ts
tests/isolation/isolation-profile.test.ts
tests/isolation/managed-onboarding-readiness.test.ts
tests/isolation/tenant-isolation-acceptance.test.ts
tests/live/mixed-connectivity.live.test.ts
tests/managed-serving/catalog.test.ts
tests/managed-serving/domain-routes.test.ts
tests/managed-serving/domain-store.test.ts
tests/managed-serving/domains.test.ts
tests/managed-serving/integration-readiness.test.ts
tests/managed-serving/services-route.test.ts
tests/managed-serving/serving-contract.test.ts
tests/managed-serving/serving-kind.test.ts
tests/managed-serving/serving-render.test.ts
tests/managed-serving/storage-emulator.test.ts
tests/managed-serving/storage.test.ts
tests/ops/recovery-manifest.test.ts
tests/ops/recovery-rehearsal.test.ts
tests/platform/managed-reconcile.test.ts
tests/platform/recovery-service.test.ts
tests/platform/zenith-build.test.ts
tests/platform/zenith-managed-composition.test.ts
tests/platform/zenith-onboarding.test.ts
tests/providers/zenith/isolation-bundle.test.ts
tests/providers/zenith/managed-kind.test.ts
tests/providers/zenith/managed-profile.test.ts
tests/providers/zenith/managed-substrate.test.ts
tests/release/acceptance-scenarios.test.ts
tests/release/checkpoint.test.ts
tests/release/dossier.test.ts
tests/release/live-scope-coverage.test.ts
tests/release/orchestrator.test.ts
tests/release/scope.test.ts
tests/retention/admin-routes.test.ts
tests/retention/key-purpose.test.ts
tests/retention/restore-destination.test.ts
tests/retention/retention.test.ts
tests/slo/definitions.test.ts
tests/slo/restore-sink.test.ts
tests/slo/sli-budget.test.ts
tests/slo/slo-artifacts.test.ts
tests/slo/slo.engine.test.ts
tests/supply-chain/release.test.ts
tests/supply-chain/sbom.test.ts
tests/tofu/typed-inputs.test.ts
tests/tofu/typed-substitution.test.ts
```
