# Kubernetes identity grant integration

`renderGraph` now renders namespaced Roles and RoleBindings for exact Kubernetes
object grants. Each rule has one API group, one resource, explicit resourceNames,
and explicit verbs. `read` maps to `get`; `get/list/watch/update/patch/delete` are
accepted verbatim. `create/deletecollection` cannot be restricted by name and
are rejected. Data-plane verbs (for example database `connect`) produce a note
and no API permissions. No ClusterRoles or wildcard permissions are rendered.

Managed targets use the renderer's actual primary object name (including Secret
names derived from references). Referenced/external targets require an explicit
`externalRef: "namespace/name"`. Referenced ConfigMaps can be granted access;
this workstream does not introduce a ConfigMap creation renderer. Cross-namespace
grants produce a Role/RoleBinding in the target namespace, binding the account
in its own namespace. Include all target namespaces in apply/prune scope.

API tokens remain off unless RBAC was actually rendered or the context explicitly
opts in. The ServiceAccount and its Deployment/CronJob agree on token mounting.
RBAC activates a bound API token so the workload can use its granted permissions.
Cloud-only identities keep the default Kubernetes API token off. AKS labels are
on Deployment and CronJob pod templates, never only on workload metadata.

## Cloud caller contract

Pass the entire graph (including cloud identities, targets and the cluster) to
`renderGraph`. Cloud counterpart matching uses `spec.workload`, provider/native
type, and coverage of all eligible target/verb grants. Missing or ambiguous
counterparts produce notes and no annotation. No counterpart names are guessed.

The additive `K8sRenderContext` inputs are:

```ts
{
  environmentId,
  workloadIdentity: { cluster: "cluster/main", mechanism: "eks-irsa" },
  resolveAttribute: (address, attribute) => publishedAttributes[address]?.[attribute],
}
```

`resolveAttribute` must return a concrete non-secret attribute published by the
cloud driver, after cloud apply/reference resolution; OpenTofu interpolations,
unknown values, invalid identifiers and resolver failures render no annotation.
It is a pure synchronous lookup, not a cloud credential/session callback.

| Mechanism | Cloud identity native type | Published key | Kubernetes output |
| --- | --- | --- | --- |
| `eks-irsa` | `aws:iam_role` | `arn` | `eks.amazonaws.com/role-arn` |
| `gke` | `gcp:service_account` | `email` | `iam.gke.io/gcp-service-account` |
| `aks` | `azure:user_assigned_identity` | `client_id` | `azure.workload.identity/client-id` plus pod label `azure.workload.identity/use=true` |
| `eks-pod-identity` | `aws:iam_role` | `arn` | prerequisite note; EKS uses a cloud association, no SA annotation |

No cloud trust or federation is created by Kubernetes server-side apply. The
rendered notes explicitly say that effective cloud access is unverified. The
ServiceAccount driver's verification also reports grants as unknown: observing
the account is insufficient to prove permissions are effective.

## Out-of-scope provider and caller work

These files were read but not edited because they are outside owned paths:

- `src/lib/providers/aws/drivers/data/iam-role.ts:126`, `:156`, `:185`: select
  IRSA trust with the cluster OIDC provider and exact namespace/SA subject, or
  Pod Identity trust for `pods.eks.amazonaws.com` (AssumeRole/TagSession) rather
  than the current ECS workload service principal. Pod Identity also needs an
  `aws_eks_pod_identity_association` owned by the cloud/cluster workstream.
- `src/lib/providers/gcp/drivers/identity/service-account.ts:48`, `:134`: add the
  exact Kubernetes principal's `roles/iam.workloadIdentityUser` binding to the
  published GCP service account for the annotation mechanism used here.
- `src/lib/providers/azure/drivers/identity/identity.ts:103`: add an
  `azurerm_federated_identity_credential` on the published user-assigned identity,
  scoped to the cluster issuer, namespace and SA subject, with the Azure token
  exchange audience.
- Caller wiring must supply the new context inputs after cloud attributes are
  resolved. If the Zenith wrapper exposes this for managed-cloud clusters,
  extend `src/lib/providers/zenith/k8s-port.ts:76` and forward the full graph and
  new options at `src/lib/providers/zenith/render.ts:218` and
  `src/lib/providers/zenith/export.ts:257`. Existing wrappers supply a Kubernetes
  subset and no cloud attribute resolver, so they cannot emit cloud annotations.

The cluster's IRSA webhook, GKE Workload Identity configuration, AKS workload
identity webhook/OIDC configuration, or EKS Pod Identity agent must exist.

## Apply and prune safety

Roles and bindings participate in normal apply order and reverse prune order.
Apply uses `zenith`, `force=false` and existing foreign-object refusal. RBAC
validation additionally refuses broad rules, ClusterRole references and foreign
subjects; a RoleBinding must include its exact Role and ServiceAccount in the
same batch, with matching resource/environment annotations. A failed Role apply
stops subsequent bindings from activating stale rules. Prune rechecks ownership
and uses UID preconditions, retaining foreign or replaced Roles/RoleBindings.

Tests use pure graph fixtures and the fake HTTP API, which does not enforce RBAC
or run cloud admission webhooks. Evidence remains contract-level. The gated kind
suite and live-cloud access were not run; WSL, Docker and cloud access are not
available in this worker environment.

## Decisions clarified

The handoff's Pod Identity annotation expectation was corrected: AWS documents
that Pod Identity uses an association rather than a ServiceAccount annotation.
The previous default-off API token remains for ungranted/cloud-only workloads;
rendered RBAC opts in so granted Kubernetes API access is usable.

Primary references: [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/),
[EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-association.html),
[GKE identity](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/workload-identity),
[AKS identity](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview).
