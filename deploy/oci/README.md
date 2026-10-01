# Zenith on Oracle Cloud Infrastructure — customer bootstrap

This OpenTofu module prepares **your** tenancy so Zenith can deploy into it
without ever holding an OCI credential. Run it once, as a tenancy administrator,
with your own credentials. It is pinned to OpenTofu `>= 1.6` (tested with
1.12.5) and `oracle/oci` **9.7.1** (the exact version Zenith's own workspaces
use; `.terraform.lock.hcl` is included).

Zenith's OCI connection has one mode, **`runner`**: a small `zenith-runner`
process that you run inside your tenancy authenticates to OCI with its *own
instance / resource / workload principal*. Zenith sends it signed jobs over an
outbound-only connection; OCI requests are signed on the runner, and no key,
fingerprint or token ever leaves your network
([RUNNER-PROTOCOL-OCI.md](../../docs/platform/RUNNER-PROTOCOL-OCI.md)).

## What it creates

| Resource | Why |
|---|---|
| Compartment `zenith` | Everything Zenith creates lives here; every policy below is scoped to it |
| Vault `zenith-vault` + AES key `zenith-secrets-key` | Secret containers and generated database passwords. **Names are a contract**: the drivers look them up by name |
| Private, versioned bucket `zenith-tfstate` | OpenTofu state (see "State backend") |
| Dynamic group `zenith-runner-deploy` | Matches exactly the runner instances you list |
| Dynamic group `zenith-runner-observe` (optional) | A second, read-only runner |
| Policies `*-runner-deploy`, `*-runner-observe`, `*-runner-tenancy` | Exactly what the drivers need (next section) |
| Policy `*-lb-certificates` | Lets the load balancer *service* read the certificate a listener uses |

It creates **no user, no API key, no customer secret key and no auth token.**

## Apply

```sh
export TF_VAR_tenancy_ocid=ocid1.tenancy.oc1..…
export TF_VAR_region=us-ashburn-1
tofu init
tofu apply \
  -var 'deploy_runner_instance_ocids=["ocid1.instance.oc1.iad.…"]'
```

Then give Zenith the outputs `tenancy_ocid`, `compartment_ocid` and `region` as
the connection's `tenancyOcid`, `compartmentOcid` and `region`, plus the id of
the runner you register. Dynamic-group and policy changes can take minutes to
propagate; allow up to an hour before a brand-new runner is authorized.

## What the runner is allowed to do (and what it is not)

`manage` here is always `in compartment id <the Zenith compartment>`; nothing
is granted tenancy-wide except the two lines at the end of the table.

| Statement | Used by |
|---|---|
| `manage virtual-network-family` | `oci:vcn`, `oci:subnet`, NSG rules, public IPs, gateways, route tables |
| `manage load-balancers` | `oci:load_balancer` |
| `manage compute-container-family` | `oci:container_instance` |
| `manage repos` | `oci:container_repository` (OCIR) |
| `manage postgres-db-systems`, `manage postgres-backups` | `oci:postgresql_db_system`, `database.snapshot` |
| `manage redis-family` | `oci:redis_cluster` |
| `manage buckets` | `oci:object_storage_bucket` |
| `manage queues` | `oci:queue` |
| `manage log-groups` | `oci:log_group` |
| `manage secrets`, `use vaults`, `use keys` | `oci:vault_secret`, generated DB passwords, `secret.write` |
| `manage volumes` | `oci:block_volume` |
| `manage dns-records`, `read dns-zones` | `oci:dns_rrset`, zone lookup |
| `read leaf-certificate-family` | `oci:certificate` lookup |
| `manage policies` | per-workload policies (`oci:dynamic_group`) |
| tenancy: `read objectstorage-namespaces` | bucket and registry namespace lookups |
| tenancy: `manage dynamic-groups` (optional, `allow_identity_management`) | per-workload dynamic groups |

**Deliberately absent:** `manage all-resources` (nothing in this module or in
Zenith's drivers ever writes it); `secret-bundles` (the runner can write a
secret value but can **never read one back**); object-level Object Storage
access (your data); user, group, compartment or tenancy management; any
`delete`-only verb the drivers do not need.

The read-only observe runner gets `read`/`inspect` on the same families and
nothing that changes anything.

### Identity management has a blast radius

Zenith creates one dynamic group per workload and one policy granting it
least-privilege access to *its own* database password, bucket, queue and log
group. A dynamic group only matters through a policy, and the runner can write
policies in the **Zenith compartment only**, so what it can grant is bounded to
that compartment. The remaining exposure is editing an *existing* dynamic group
that some other policy already references. Fence it with
`dynamic_group_name_pattern` (for example `zn-%`), or set
`allow_identity_management = false` and create workload identities yourself.
The workload dynamic groups Zenith creates match container instances by **tag**
(`zenith_environment`, `zenith_resource`) inside the compartment, so restrict who
may create or tag container instances there.

## Deploying the runner

The runner makes **outbound HTTPS only**: to your Zenith control plane and to
`*.oraclecloud.com`. It needs no inbound port. Give it the registration token
from Zenith (single use, shown once) and a local config enabling the OCI kinds
(`tofu.run`, `oci.http`) with `oci.allowedCompartments` set to the compartment
OCID above.

**A. Compute instance (instance principal)** — the simplest.
1. Create a small VM in a private subnet with a NAT gateway (egress only).
2. Pass its OCID in `deploy_runner_instance_ocids`, apply.
3. Install the runner as a service (`systemd`) or container. No credentials are
   configured: it uses the instance's identity through the metadata endpoint.
   Zenith passes `auth = "InstancePrincipal"` to the OCI provider.

**B. OKE (workload identity)** — for clusters you already run.
1. Create a namespace and service account for the runner.
2. Set `deploy_runner_oke = { cluster_ocid, namespace, service_account }`.
   The module emits `any-user` statements fenced by
   `request.principal.type/namespace/service_account/cluster_id`.
3. Deploy the runner with that service account. Enhanced clusters are required
   for workload identity.

**C. Container instance (resource principal)** — no VM to patch.
1. Create the runner as a container instance; note its OCID.
2. Set `deploy_runner_container_instance_ocids`, apply.
3. The platform injects the `OCI_RESOURCE_PRINCIPAL_*` variables into the
   container; the runner must pass exactly those to OpenTofu and nothing else.

Register the runner's labels `oci.auth`, `oci.region`, `oci.tenancy`; the
control plane checks the tenancy against the connection.

## State backend — read this before first use

The state bucket is created, but how a **runner** reaches it is the least-settled
part of the OCI story:

- **S3-compatible API** (`state_s3_compatible_endpoint`). OpenTofu's `s3`
  backend can talk to it with `endpoints.s3`, `use_path_style`, and the
  `skip_*_validation` flags. It authenticates with an **S3 access key pair
  ("customer secret key")** that belongs to an IAM *user* — a static credential
  that instance principals cannot replace and that this module deliberately does
  **not** create. You would create a dedicated service user, issue one secret
  key, and give it to the runner's environment (a secret that stays in your
  tenancy; Zenith never receives it). Whether the compatibility layer supports
  the conditional writes `use_lockfile` relies on is **unverified**, so state
  locking is not guaranteed. The workspace assembler's `s3` backend block
  (`src/lib/tofu/workspace.ts`) does not emit the endpoint flags yet: that is a
  contract change for the orchestrator, described in the WS-OCI handoff.
- **HTTP backend** (`kind: "http"`), served by a state endpoint you trust.
- **Local state on the runner** is possible for a trial and is not durable.

Nothing in this module or the drivers depends on the choice; it only decides
where `terraform.tfstate` lives.

## Secrets, certificates and the things OCI cannot do

- **Secrets.** Zenith's secret nodes become empty-ish Vault *containers*
  (seeded with a random placeholder); the value is written later with
  `secret.write` by the control plane, through the runner, without touching
  OpenTofu state. **Container Instances cannot inject Vault secrets into the
  container as environment variables or files** (the provider has no such
  argument). The driver therefore sets `ZENITH_SECRET_OCID_<KEY>` to the
  secret's OCID and grants the workload `read secret-bundles` on that one
  secret; the application fetches the value with its resource principal. Until it
  does, `<KEY>` is simply unset. Database passwords are generated *inside* Vault
  and handed to PostgreSQL by reference (`VAULT_SECRET`); no password exists in
  configuration or state.
- **Certificates.** OCI cannot issue a publicly trusted certificate for your
  domain. Obtain one yourself (for example with an ACME client), **import it into
  OCI Certificates under the exact route hostname**, and Zenith's load balancer
  listener will use it (one certificate per HTTPS listener; use a SAN certificate
  for several hosts). Renewal is yours; Zenith's `verify` fails when fewer than
  14 days remain.
- **DNS.** Zenith never creates your zone. The public zone must exist in the
  Zenith compartment; Zenith manages only the record sets it derives (A records
  to the load balancer's reserved public IP — note an `oci_dns_rrset` replaces
  every record at that name and type).

## Honest status

This module passes `tofu validate` against the locked provider. It has **not**
been applied to a tenancy, and the policy statements follow the public OCI IAM
reference without having been exercised against one; a missing permission shows
up as a `404 NotAuthorizedOrNotFound` from the first call that needs it (OCI
reports unauthorized reads as not-found by design). Treat the first apply as an
acceptance run.
