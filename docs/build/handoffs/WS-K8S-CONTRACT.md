# WS-K8S-CONTRACT — close the Kubernetes / managed-hosting contract gaps

Workstream: WS-K8S-CONTRACT (new; orchestrator brief) — Branch ws/k8s-contract — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-k8s-contract
Base: platform/integration @ e92a3df (tsc clean; WS-K8S and WS-ZM merged)

## Gaps reported by the merged workers (verify each in the code first)
1. WS-ZM needs the real Kubernetes apply to accept `ResourceQuota` (v1), `LimitRange` (v1) and
   `HTTPRoute` (`gateway.networking.k8s.io/v1`), all namespaced: today `KIND_INFO` / `APPLY_ORDER`
   in src/lib/providers/kubernetes/** refuse them, so the managed tenancy baseline cannot apply.
   ZM lists them in `ZENITH_EXTRA_KINDS` (src/lib/providers/zenith/k8s-port.ts).
2. ZM's follow-up test: `OWNERSHIP` strings in src/lib/providers/zenith/k8s-port.ts must equal the
   constants in src/lib/providers/kubernetes/types.ts, and every `ZENITH_EXTRA_KINDS` entry must be
   accepted by the real `KIND_INFO`. Replace ZM's structural `FakeToolkit` reliance with at least
   one test that drives `renderZenithEnvironment`/`applyZenithEnvironment` through the REAL
   kubernetes renderer and server-side apply against the kubernetes provider's fake API server
   (tests/providers/kubernetes/fake-api.ts).
3. WS-K8S: add an additive `namespace?: string` to `WorkloadCommon`, `FirewallSpec`,
   `LoadBalancerSpec`, `DnsRecordSpec`, `TlsCertificateSpec`, `SecretSpec`, `IdentitySpec` and the
   data-store specs in src/lib/resources/specs.ts, and have expansion write the network node's
   namespace onto every Kubernetes-bound node, so observe/operations look where render wrote.
4. native-types.ts: give `zenith` its own row instead of aliasing Kubernetes:
   `postgres: "zenith:managed_postgres"`, `object_store: "zenith:object_store"`, no mysql/redis row;
   ZM drivers follow via `nativeTypeFor`. Keep the kubernetes row unchanged.
5. Optionally pin `VolumeSpec { sizeGb, storageClass?, accessModes? }` (K8S and OCI read volumes
   defensively today) — only if it stays additive.

## Owned paths
src/lib/providers/kubernetes/** ; src/lib/providers/zenith/** ; src/lib/resources/specs.ts and
src/lib/resources/native-types.ts (ADDITIVE changes only) ; src/lib/resources/expand*.ts (namespace
propagation only) ; tests/providers/kubernetes/** ; tests/providers/zenith/** ; tests/resources/**
(new files, plus fixing existing expectations that the namespace field legitimately changes).
Do NOT touch src/lib/platform/** (WS-COMPOSE registers drivers there; if the zenith native-type
change affects its "one driver per (provider, nativeType)" assumption, say so in the report).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/providers/kubernetes src/lib/providers/zenith src/lib/resources tests/providers/kubernetes tests/providers/zenith tests/resources
- npx vitest run --maxWorkers=2 tests/providers/kubernetes tests/providers/zenith tests/resources tests/providers/aws/drivers/e2e-compile.test.ts
