# deploy/zenith-managed

Baseline manifests for the cluster that backs `provider = zenith`.

**Status: nobody operates this cluster.** These files have never been applied
to a real cluster. They are a starting point and a checklist, not a
tested installer. Everything marked `REPLACE` or `example.com` is a placeholder.
The architecture, the isolation model and what is and is not implemented are in
[docs/platform/MANAGED-PLATFORM.md](../../docs/platform/MANAGED-PLATFORM.md).

| File | What it is |
| --- | --- |
| `00-namespaces.yaml` | `zenith-gateway`, `cert-manager`, `zenith-system`, with Pod Security labels |
| `10-gateway.yaml` | `GatewayClass` placeholder (controller name is yours to set); environment Gateways are created by apply |
| `20-clusterissuer.yaml` | cert-manager `ClusterIssuer` placeholder (DNS-01, ACME staging) |
| `30-networkpolicy-baseline.yaml` | default-deny and minimal allows for the platform namespaces |
| `40-operator-rbac.yaml` | tenant ServiceAccount/ClusterRole plus a gateway-namespace Role for TLS Certificates and Gateways |
| `apiserver/podsecurity-admission.example.yaml` | API-server admission config making `restricted` the cluster default. **Not** a cluster object: do not `kubectl apply` it |
| `kustomization.yaml` | applies the first five files |

Tenant namespaces (`zt-<workspace>-<env>-<hash>`) and everything in them are
created by Zenith through server-side apply. Nothing tenant-specific lives here.

## Order

1. A cluster whose CNI **enforces NetworkPolicy** (Calico, Cilium, ...). If it
   does not, every policy is a no-op and tenants are not isolated on the network.
2. Pod Security Admission available (built in from Kubernetes 1.25). Optionally
   set the cluster default with `apiserver/podsecurity-admission.example.yaml`.
3. The Gateway API CRDs and one Gateway API implementation.
4. cert-manager, with its CRDs, in the `cert-manager` namespace.
5. `kubectl apply -k deploy/zenith-managed`, after replacing every placeholder.
6. Provision wildcard DNS for the managed environment zones to their Gateway
   addresses. A base-domain wildcard can be used only when your DNS zone layout
   and Gateway implementation serve all of them through the same address.
7. Create the credential for `zenith-operator` (a token or kubeconfig) and store
   it in the Zenith vault; configure `ZENITH_MANAGED_KUBECONFIG_REF` with the
   `vault:` reference. Never put the credential in an environment variable or a
   file in this repository.
8. Configure the `ZENITH_MANAGED_*` variables (docs/platform/MANAGED-PLATFORM.md).

## Verify the cluster before putting a tenant on it

Zenith renders isolation; it cannot prove the cluster enforces it. Check each,
with throwaway namespaces, and record the result somewhere reviewers can see:

- **NetworkPolicy is enforced.** In a test namespace apply a default-deny policy,
  start two pods, and confirm one cannot reach the other. Confirm a pod in a
  tenant-style namespace cannot reach `169.254.169.254` or a private address on
  443 and cannot reach a pod in another tenant-style namespace.
- **Pod Security is enforced.** Label a test namespace `enforce: restricted` and
  confirm a privileged pod and a `hostPath` pod are rejected by the API server.
- **Quotas count.** Apply a small `ResourceQuota` and confirm a pod over it is
  rejected.
- **Each environment gateway only accepts its tenant routes.** Apply an
  environment, then try attaching an `HTTPRoute` from an unlabeled namespace
  and from another labeled tenant namespace. Neither should be accepted.
- **TLS is actually ready.** Configure the ClusterIssuer's DNS-01 solver, check
  `Certificate` Ready, Gateway Programmed and listener ResolvedRefs, then probe
  a managed hostname over HTTPS. Apply acceptance alone does not prove issuance.
- **The operator role is no wider than 40-operator-rbac.yaml.**
  `kubectl auth can-i --as=system:serviceaccount:zenith-system:zenith-operator ...`
  for `pods/exec`, `clusterroles`, `nodes` (all should be `no`).

## Known gaps in these files

- Per-environment Certificate/Gateway automation has contract tests only.
  `teardownZenithTls` removes that environment's Gateway, Certificate and labeled
  TLS Secret; call it under the same environment lease as apply on destruction.
  Gateways may cost one load balancer each, depending on your controller; shared
  data planes and DNS routing need live verification. Ingress mode still requires
  operator-provisioned certificates and is outside this automation.
- The gateway namespace policy is generic; your implementation may need other
  ports and peers.
- No monitoring, logging, backup, autoscaling or node-pool isolation is
  installed. Tenants share nodes and the node kernel; there is no sandboxed
  runtime (gVisor, Kata) in this baseline.
