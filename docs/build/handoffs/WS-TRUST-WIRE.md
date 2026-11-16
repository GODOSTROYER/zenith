# WS-TRUST-WIRE — cloud-side workload identity trust + non-AWS connection verification

Workstream: WS-TRUST-WIRE (orchestrator brief) — Branch ws/trust-wire — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-trust-wire
Base: platform/integration (WS-K8S-IDENTITY and WS-AZURE-MORE merged)

## Part A — workload identity trust (read src/lib/providers/kubernetes/IDENTITY.md first)
The Kubernetes identity renderer now annotates ServiceAccounts for EKS IRSA, GKE Workload Identity and
AKS Workload Identity, referencing the cloud identity by published attribute. The cloud side does not
yet trust those ServiceAccounts:
- AWS (src/lib/providers/aws/drivers/data/iam-role.ts ~185): when the workload runs on an EKS cluster
  in the graph, the role's trust policy allows `sts:AssumeRoleWithWebIdentity` from the cluster's OIDC
  provider with `sub = system:serviceaccount:<ns>:<sa>` and `aud = sts.amazonaws.com` exactly (no
  wildcards); the cluster's OIDC provider resource is created once (by the EKS driver or here — pick one
  owner, publish its ARN as a local).
- GCP (src/lib/providers/gcp/drivers/identity/service-account.ts ~48): `roles/iam.workloadIdentityUser`
  binding on the GSA for member `serviceAccount:<project>.svc.id.goog[<ns>/<sa>]` exactly.
- Azure (src/lib/providers/azure/drivers/identity/identity.ts ~103): `azurerm_federated_identity_credential`
  on the user-assigned identity with issuer = the AKS OIDC issuer URL, subject
  `system:serviceaccount:<ns>:<sa>`, audience `api://AzureADTokenExchange`.
The namespace/ServiceAccount names must come from the same derivation the Kubernetes renderer uses
(import it; do not re-implement). If the cluster is not in the graph (referenced/external), emit
nothing and a note.

## Part B — non-AWS connection verification at onboarding
src/lib/platform/credentials.ts (~104–110) verifies AWS connections only. Add verification for GCP
(exchange the Zenith OIDC token via STS and call a cheap read such as projects.get with the observe
identity), Azure (client-assertion token for ARM and a subscription read), Kubernetes (TokenReview or
a namespaced `get` on the allowlisted namespace) and OCI (runner-only: verify the runner is registered
with the OCI kind enabled for that connection; never hold OCI keys). Each returns the existing
verification result shape with precise, non-secret failure reasons; no credential ever stored or logged.

## Owned paths
src/lib/providers/aws/drivers/data/iam-role.ts (+ its tests) ; the EKS OIDC-provider ownership choice
in src/lib/providers/aws/drivers/eks/** only if it is already on integration (it is NOT — it is on a
staging branch; if you need it, put the OIDC provider in iam-role.ts keyed by cluster and note it) ;
src/lib/providers/gcp/drivers/identity/** ; src/lib/providers/azure/drivers/identity/** ;
src/lib/platform/credentials.ts ; tests/providers/{aws,gcp,azure}/**identity*/trust* (new) ;
tests/platform/credentials*.test.ts .

## Verification
- npx tsc --noEmit ; npx eslint <touched paths>
- npx vitest run --maxWorkers=2 tests/providers/aws tests/providers/gcp tests/providers/azure tests/providers/kubernetes tests/platform
- ZENITH_TEST_TOFU_NETWORK=1 for the touched providers' validate suites (say if tofu cannot run)
