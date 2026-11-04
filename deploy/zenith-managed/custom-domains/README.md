# Custom domains add-on

Optional, PROD-MAN-03. Never applied to a real cluster; both files are placeholders (`REPLACE`).

| File | What it is |
| --- | --- |
| `10-gateway-acme-http01.yaml` | one platform Gateway whose port-80 listener accepts only same-namespace routes (cert-manager's temporary HTTP-01 solver routes) |
| `20-clusterissuer-http01.yaml` | cert-manager `ClusterIssuer` (ACME staging) whose HTTP-01 solver attaches to that Gateway; its name is `ZENITH_MANAGED_HTTP_CLUSTER_ISSUER` (default suggestion `zenith-letsencrypt-http01`) |

Without `ZENITH_MANAGED_HTTP_CLUSTER_ISSUER` the platform serves no custom domain: a verified hostname is rendered to its
managed hostname with a note, never half-served. Operator requirements this repository cannot prove: cert-manager runs with
Gateway API support enabled; this Gateway and each environment Gateway are reachable at the address custom hostnames CNAME to
(controller-specific); DNS for the customer's hostname points there. See `docs/platform/MANAGED-PLATFORM.md`, "Managed serving".
