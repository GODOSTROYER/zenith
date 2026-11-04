# W5 assembly: managed tenant readiness boundary

Implementation: `src/lib/platform/zenith-onboarding.ts` refuses sessions before credentials when the per-tenant operator prefix is absent. For configured tenants it resolves the tenant identity first, reads the complete expected isolation bundle under an internal bootstrap session, and probes the tenant identity through Kubernetes SelfSubjectAccessReview. It performs no apply, token mint or credential write. Bootstrap authority never reaches a workload caller. The default managed composition supplies this guard. `execution/tenant-isolation.ts` exports its existing readback and access-probe checks for this reuse.

Local contract test: `tests/platform/zenith-onboarding.test.ts` uses a localhost fake Kubernetes API and mock authorization reviews. It proves readiness/refusal behavior, credential selection, no writes, and error redaction. It does not prove real RBAC, CNI enforcement, sandbox isolation or live cloud behavior.

Mac verification (Node 22, Docker, kind and kubectl required):

```bash
export ZENITH_KIND_CLUSTER_NAME=zenith-life07-onboarding
export ZENITH_K8S_WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/zenith-life07.XXXXXX")"
bash scripts/k8s/kind-calico-up.sh
export KUBECONFIG="$ZENITH_K8S_WORKDIR/kubeconfig"
ZENITH_TEST_MANAGED_ONBOARDING=1 npx vitest run tests/isolation/managed-onboarding-readiness.test.ts --no-file-parallelism --maxWorkers=2
bash scripts/k8s/kind-calico-down.sh
```

Expected: 2 real-cluster tests pass. The harness requires the disposable `kind-zenith-life07*` context, creates unique tenant namespaces/RBAC/ServiceAccounts, uses real TokenRequest tokens and authorization reviews, and cleans up its own named resources. The cluster teardown removes any created `zenith-system` namespace. It verifies an absent tenant stays absent and a complete bundle is accepted only under its least-authority tenant identity. The Windows builder does not run this lane; without its explicit environment gate both tests are skipped.

Local commands:

```bash
npx vitest run tests/platform/zenith-onboarding.test.ts tests/execution/tenant-isolation.test.ts --no-file-parallelism --maxWorkers=2
npx eslint src/lib/platform/zenith-onboarding.ts src/lib/execution/tenant-isolation.ts tests/platform/zenith-onboarding.test.ts tests/isolation/managed-onboarding-readiness.test.ts
```

Known limitation: automatic first-time onboarding cannot call the existing isolation provisioner under a managed deployment approval. The provisioner binds a separate isolation plan digest; the managed deploy binds a composite digest, and the dedicated onboarding path does not yet carry the executable-semantics and custody records required by DUR-B/DUR-C. The production boundary therefore accepts only separately pre-provisioned and verified tenants and refuses missing/incomplete onboarding. First-deploy bootstrap remains implementation incomplete rather than being presented as verified. Complete policy readback uses the managed-database flag derived from persisted desired resources; custom tenant egress must likewise come from persisted desired inputs, never from live cluster policy.

Managed source builds also require separately reviewed per-tenant namespace, credential and node-pool provisioning. The shared-namespace build configuration alone is insufficient for that claim. Live cloud acceptance remains deferred. Suggested status: `implementation_complete_verification_pending` for the readiness guard only; full automatic onboarding remains `in_progress`.
