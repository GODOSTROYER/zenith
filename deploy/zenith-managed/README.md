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
| `10-gateway.yaml` | `GatewayClass` and `Gateway` placeholders (controller name, hostname, certificate are yours to set) |
| `20-clusterissuer.yaml` | cert-manager `ClusterIssuer` placeholder (DNS-01, ACME staging) |
| `30-networkpolicy-baseline.yaml` | default-deny and minimal allows for the platform namespaces |
| `40-operator-rbac.yaml` | the ServiceAccount and ClusterRole Zenith operates tenants with (review it; it is cluster-wide) |
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
6. A wildcard DNS record for the base domain pointing at the gateway's address.
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
- **The gateway only accepts tenant routes.** Create an `HTTPRoute` from an
  unlabeled namespace and confirm it is not accepted by the Gateway.
- **The operator role is no wider than 40-operator-rbac.yaml.**
  `kubectl auth can-i --as=system:serviceaccount:zenith-system:zenith-operator ...`
  for `pods/exec`, `clusterroles`, `nodes` (all should be `no`).

## Known gaps in these files

- The Gateway listener is for one example environment zone. The managed hostname
  scheme needs a certificate per environment zone; nobody has built the
  automation (see "Hostnames and TLS" in the design document).
- The gateway namespace policy is generic; your implementation may need other
  ports and peers.
- No monitoring, logging, backup, autoscaling or node-pool isolation is
  installed. Tenants share nodes and the node kernel; there is no sandboxed
  runtime (gVisor, Kata) in this baseline.
