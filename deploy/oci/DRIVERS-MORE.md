# OCI compute, OKE and MySQL driver contracts

These additions have `contract` evidence only. No tenancy was planned, applied
or inspected. Expansion does not yet produce VM, OKE or MySQL nodes; callers
provide explicit graph specs, documented in `drivers/compute/specs.ts`.

VM inputs: `imageOcid`, optional `shape`, `ocpus`, `memoryGb`, `bootVolumeGb`,
`cloudInit`, `deletionPolicy`. OKE inputs: explicit `version`, `nodeImageOcid`,
optional `nodeCount`, `nodeShape`, `nodeOcpus`, `nodeMemoryGb`,
`apiAccessCidrs`, `deletionPolicy`. Both depend on private OCI subnets in one
VCN/region. Image compatibility, regional shapes, quotas and Kubernetes version
availability need customer acceptance. The node pool uses AD 1; it does not
claim multi-AD availability. At-rest boot encryption uses Oracle-managed keys.

Cloud-init accepts non-secret `#cloud-config` YAML only and is base64 encoded
into metadata. Credential tripwires reject common mistakes; they cannot prove
arbitrary text secret-free. Specs must already obey the graph's no-secret
contract. No shell or file reads occur in compilation. The OS Management Hub
Agent plugin is enabled; an installed compatible Oracle Cloud Agent, profile,
network access, IAM and service registration are customer prerequisites.

An `identity` node whose workload is a VM uses the instance compartment and
exact instance OCID for its dynamic group. OCI IAM does not support free-form
tags in matching rules, so the new VM principal uses an explicit ID reference.
No permissions are granted
implicitly. Enhanced OKE supports workload identities, which still require
application SDK configuration and policies scoped to namespace, service account
and cluster. OIDC discovery is enabled; external-user OIDC authentication and
Kubernetes RBAC are not configured by this driver.

OKE publishes `local.<label>_endpoint`, `_ca_data`, `_oidc_issuer_url`, `_nsg_id`
(nodes/pods) and `_endpoint_nsg_id`. Endpoint/CA come from the version 2 private
kubeconfig data source, without publishing kubeconfig content or a token.
API clients must reach the VCN and be admitted by `apiAccessCidrs` or an
explicit endpoint NSG rule. The endpoint NSG's resource tag is
`<address>:endpoint`, keeping node NSG lookup unambiguous. Internal rules permit
node/pod communication, kubelet access and node-to-API/proxymux access only.

MySQL supports observe/runtime/verify/discover, with no compile method.
oracle/oci 9.7.1 exposes `admin_password`, not `VAULT_SECRET` password details.
Vault reads into that argument would put plaintext into plan/state, so creating
MySQL safely is blocked until the provider accepts a native secret reference.
HA and backup settings are read from the service; only a daily backup is
reported for an enabled scheduled policy. Hourly desired backup fails verification
instead of claiming an hourly schedule. No MySQL writes or backup operations are
authorized. The published resource contract is at
https://docs.oracle.com/en-us/iaas/tools/terraform-provider-oci/latest/docs/r/mysql_mysql_db_system.html.

Additive service entries for the shared runner protocol:

| Service | Host | Version |
| --- | --- | --- |
| `containerengine` | `containerengine.{region}.oraclecloud.com` | `20180222` |
| `mysql` | `mysql.{region}.ocp.oraclecloud.com` | `20190415` |

Additive rules for `infrastructure.observe`, `topology.read` and
`incident.investigate`; no other capability is widened:

```text
core GET /20160918/instances
core GET /20160918/instances/{}
containerengine GET /20180222/clusters
containerengine GET /20180222/clusters/{}
containerengine GET /20180222/nodePools
containerengine GET /20180222/nodePools/{}
mysql GET /20190415/dbSystems
mysql GET /20190415/dbSystems/{}
```

`secret.write` stays disabled by the Go runner. The existing shared contract's
Vault PUT entry is unchanged, and does not enable execution.

Integration follow-ups outside this workstream's owned paths:

- Regenerate `go/internal/oci/testdata/services.json`: add `mysql` with the
  host/version above. Until then the Go runner refuses MySQL reads; the exact
  service-contract test intentionally detects this mismatch.
- In `go/internal/oci/oci_test.go`, `TestGoldenAllowlistEveryRule` at line 88,
  update its expected service count from 15 to 16 and observe rule count from
  42 to 50. Keep the exhaustive matcher assertions.
- Fold this service/rule appendix into `docs/platform/RUNNER-PROTOCOL-OCI.md`.
- Expand the fixed portable specs/manifest compiler when VM and OKE graph
  creation becomes part of the product. No fixed contracts were changed here.
- Audit the pre-existing container identity compiler: its tag-based matching
  rule uses free-form tags, which OCI IAM does not support. This existing
  container behavior was retained; the new VM identity uses exact IDs.

The schema fixture under `tests/providers/oci/fixtures/schema-9.7.1.json` is a
subset of a cached `tofu providers schema -json` dump for the locked 9.7.1
provider, retaining attribute flags/types and nested blocks for eight types.
It proves argument/required-field structure only. OpenTofu validation and
provider semantics remain separate, gated checks.
