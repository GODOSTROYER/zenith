# Cloud workload trust wiring

The AWS, GCP and Azure identity compilers reuse the Kubernetes renderer's
`namespaceOf` and `objectName`. They grant trust to an exact ServiceAccount,
never a namespace wildcard. This is contract evidence only; no live cloud
permissions or admission webhooks were tested.

The fixed `CompileContext` supplies address lookup, without node enumeration.
The cloud identity must name its Kubernetes workload with `spec.workload`.
Link the workload to its Kubernetes identity and cluster in `dependsOn`, or
set cloud identity `spec.serviceAccount` and `spec.cluster` to their graph
addresses. These fields are addresses, not names or credential values.
Use explicit `spec.cluster` on AWS identities so node-only drift comparison
does not expect ECS trust from a `container_service/...` address. Kubernetes
namespace overrides must agree with these graph specs; the renderer's optional
context override is not available in the fixed cloud compile context.

Missing, ambiguous, mismatched, referenced or external prerequisites produce a
non-secret OpenTofu output note and no federation. GCP and Azure can still
create the cloud identity and its resource grants. AWS omits the role when
Kubernetes trust cannot be selected, so it cannot silently use ECS trust.

EKS clusters must set `spec.oidcProviderOwner` to one managed AWS IAM identity
address for that cluster. Only that fragment owns
`aws_iam_openid_connect_provider.<cluster_label>_workload_oidc`, and publishes
the cluster's `oidc_provider_arn` local. Every workload role uses the same local.
The issuer is read via the cluster's `identity[0].oidc[0].issuer` reference.
The owner must be included in the compiled graph. No EKS driver was changed;
it is still staged outside this worktree. When the cluster driver eventually
owns OIDC itself, move this single resource and local together, without
creating a second owner. The AWS provider retrieves the thumbprint when the
optional thumbprint list is omitted.

GKE trust binds `roles/iam.workloadIdentityUser` on the GSA to
`serviceAccount:<cluster-project>.svc.id.goog[<namespace>/<account>]`. The
cluster project reference allows the cluster and GSA to be in different
projects. Existing resource-scoped workload grants remain independent.

AKS is an ARM-template-managed cluster on integration. The identity fragment
creates an incremental, outputs-only ARM deployment with no resources, using
`reference(clusterId, '2024-10-01').oidcIssuerProfile.issuerURL`. It reads the
public issuer without the dedicated AzureRM AKS data source's kubeconfig LIST
calls and without adding an unpinned provider. Its output supplies one
`azurerm_federated_identity_credential`, scoped to the UAI and exact subject,
with audience `api://AzureADTokenExchange`.

The existing Zenith wrappers still need the caller wiring recorded in
`src/lib/providers/kubernetes/IDENTITY.md`: forward the complete graph and
resolved published cloud attributes to `renderGraph`, including the explicit
cluster/mechanism. Those wrappers are outside this workstream's owned paths.
The EKS and GKE cluster drivers and cloud admission prerequisites must exist
before live deployment. Identity observation does not prove federation or
effective grants; the existing readers do not compare all trust conditions.

Primary references: [EKS role trust](https://docs.aws.amazon.com/eks/latest/userguide/associate-service-account-role.html),
[GKE IAM identity](https://cloud.google.com/blog/products/containers-kubernetes/introducing-workload-identity-better-authentication-for-your-gke-applications),
[AzureRM AKS data source](https://registry.terraform.io/providers/hashicorp/azurerm/4.55.0/docs/data-sources/kubernetes_cluster).
