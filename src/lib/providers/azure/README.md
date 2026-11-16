# Additional Azure drivers (WS-AZURE-MORE)

All six previously absent native types are registered. Evidence is **contract**
only: pure compilation, fake ARM HTTP tests and static security checks. None of
this work has been applied to a real subscription. Schema validation is gated
by `ZENITH_TEST_TOFU_NETWORK=1`; OpenTofu execution is denied in this sandbox.
The orchestrator must run that check outside the sandbox before integration.

These specs are explicit `ResourceNode` graphs, not new manifest fields. Current
manifest expansion does not produce VM, Function, MySQL, AKS or volume nodes.
A static-only manifest also does not create an Azure landing zone or workload
identity. An Azure network node continues to own the environment RG/VNet.

| Native type | Declaration and limits |
| --- | --- |
| `azure:mysql_flexible_server` | Private MySQL 8.0/8.4 with Entra-only authentication and required TLS. Supports `PointInTimeRestore` or `Replica` from an existing server; **fresh creation is refused**, since AzureRM requires a bootstrap password and `TofuFragment` has no ephemeral resources. |
| `azure:virtual_machine` | Private Ubuntu 24.04 VM, UAI, encrypted managed OS disk, NIC NSG denies SSH and inbound traffic, cloud-init masks SSH. AzureRM requires a caller-provided **public** RSA key even with SSH off. No guest command capability is declared. |
| `azure:managed_disk` | Empty platform-key-encrypted disk; no public export/download; deletion protection by default. `ReadWriteOnce` only. Does not attach volumes to a VM. |
| `azure:static_web_app` | Standard SWA infrastructure, UAI, private endpoint by default (`publicAccess: true` explicitly enables public hosting). Custom subdomains use CNAME validation. **Artifact upload is not implemented**; an ACR build pipeline cannot deploy SWA assets. |
| `azure:function_app` | Linux Functions custom container on a Dedicated Linux plan (B1 by default), UAI for Key Vault/ACR and Blob/Queue host storage, VNet egress integration and private ingress. No storage key or Azure Files connection string. Flex does not support container artifacts. |
| `azure:aks_cluster` | Private API, Azure CNI overlay, managed identity, managed Entra RBAC, local accounts off, OIDC/workload identity on. System pool from spec plus individually managed user pools. No kubeconfig or Kubernetes readiness is read. |
| `azure:application_gateway` | Existing Container Apps ingress mapping is retained. Declares no gateway; rejects WAF, private frontend, non-root path routing and unsupported targets. |

## Required graph inputs

- Delegated subnet nodes use `spec.role: "mysql"` or `"functions"`, with private
  CIDRs inside the VNet, outside the reserved landing-zone subnets. MySQL uses
  `Microsoft.DBforMySQL/flexibleServers`; Linux Functions uses
  `Microsoft.Web/serverFarms`. Functions need at least /26; MySQL at least /28.
  Do not overlap other explicit subnet nodes. The Function host's private Blob
  and Queue endpoints use the landing-zone DNS zones; private Function ingress
  uses its shared `privatelink.azurewebsites.net` zone.
- VM/Function/AKS `spec.subnet` selects a private Azure subnet in the same region.
  VM and AKS subnets are undelegated. VM, Function and SWA each require exactly
  one managed `identity` dependency whose `spec.workload` equals the workload
  address. The identity driver grants access to managed Key Vault secret vaults
  and registries from `grants`, as it does for Container Apps.
- VM: `adminSshPublicKey` (RSA >=2048 bits), optional `instanceClass` or
  `size` (nano/small/standard/performance), and `osDiskSizeGb` (default 32).
  The image and cloud-init are fixed; arbitrary scripts/credentials are refused.
  Azure Run Command is an operator-side access path requiring a separate
  operator permission; Zenith's deploy role does not gain arbitrary guest exec.
  ARM cannot attest that SSH stopped inside the guest: verification says unknown.
- Volume: `sizeGb`, optional `storageClass` (Standard/StandardSSD/Premium LRS,
  StandardSSD/Premium ZRS), optional `deletionPolicy` (deny by default).
- MySQL: `createMode`, `sourceServerId`, `restoreTime` (for PITR), `subnet`,
  `entraIdentityId`, `entraAdministratorId`, `entraAdministratorLogin`, and
  optional `size`, `instanceClass`, `storageGb`, `version`, `highAvailability`,
  `backup`, `config.geoRedundantBackup`, `deletionPolicy`. The server UAI must
  already have Microsoft's required Graph directory-read permissions. These
  tenant-wide permissions are never granted by the bootstrap deployer. Replicas
  refuse HA; burstable SKUs refuse HA. Azure backups cannot be disabled: none,
  daily and hourly map to 7, 14 and 35 retention days; hourly defaults to geo
  redundancy. Restore/source/region compatibility is unverified live. Entra
  workload database roles remain an operator SQL step.
- Function: `artifact` is a tagged MCR or ACR image, or a built ACR artifact;
  `env` values are literals or `secretRef`s. Sensitive env keys require references.
  Private non-ACR registries and Flex/Consumption plan SKUs are refused. Optional
  `instanceClass`: B1/B2/B3/P1v3/P2v3/P3v3. Dedicated plans have a fixed cost.
  This implements the Function host and ordinary Blob/Queue host permissions;
  Durable Functions/Table storage and arbitrary trigger/binding permissions are
  not automatically inferred. Workload-specific grants are still explicit.
- SWA: an existing, VNet-linked `privateDnsZoneId` for the site's actual default
  hostname partition is required for private hosting. Its name is typically
  `privatelink.<partition>.azurestaticapps.net`; match the assigned site hostname
  and arrange private resolution of custom domains as well. Public DNS nodes
  targeting `static_site/<name>` create CNAME plus validated custom-domain
  binding. Apex domains are explicitly refused: they need TXT validation and
  an ALIAS solution. SWA does support private endpoints and managed identity,
  so a storage/Front Door substitution is unnecessary for this infrastructure
  scope. Deployment tokens are never read or exported by these drivers.
- AKS: customer-prepared `controlPlaneIdentityId` plus `privateDnsZoneId` linked
  to the VNet (the AKS regional private zone). The customer assigns narrowly
  scoped subnet/network and DNS permissions to that UAI before creation; no
  subscription Network Contributor role is compiled. `nodePools` consists of
  unique lowercase alphanumeric names (<=12), `vmSize`, `count`, `osDiskSizeGb`.
  First pool is System, others User. Defaults: two Standard_D2s_v5 nodes with
  128 GiB OS disks. Optional `version`, `serviceCidr`, `podCidr`; CIDRs must be
  private and disjoint from each other and the VNet. Azure-managed outbound
  load balancer egress may use a public IP; the API remains private.

## Why ARM templates for three resources

Function, SWA and AKS primary objects use incremental
`azurerm_resource_group_template_deployment`. Dedicated AzureRM refresh paths
read publishing credentials, SWA API keys or cluster user credentials. These
templates output only ID and hostname and do not need those listing actions.
Lifecycle is still OpenTofu-managed, never native driver CRUD. ARM parameter
objects keep external strings as data. AzureRM's default template deletion
removes its nested resource; do not set
`features.template_deployment.delete_nested_items_during_deletion = false`.
Template plans display configuration changes at deployment granularity; native
observation/verification compares the service properties. ARM template contents
are **not** validated by `tofu validate`, which checks AzureRM schema only;
real Azure validation/apply remains required.

The bootstrap adds explicit CRUD/read actions for these providers and ARM
deployments. It never adds publishing-key, SWA-secret or cluster-credential
listing. Two additional conditioned data roles support Function host storage:
Storage Blob Data Owner and Storage Queue Data Contributor, scoped to that
Function's host account. The existing custom deployer/conditioned assignment
trade-off at subscription scope remains documented in `deploy/azure/README.md`.

## Shared-contract follow-up for the orchestrator

Fresh MySQL needs an additive `ephemeral` fragment field in
`src/lib/drivers/types.ts:TofuFragment`, support/validation/merging in
`src/lib/tofu/workspace.ts`, and integration tests for ephemeral
`random_password` -> MySQL `administrator_password_wo` with nonsecret rotation
version. Random 3.9.1 and OpenTofu 1.12.5 are already pinned. Only then can this
driver add Default creation without storing a password in configuration/plan.
Those shared paths were not edited. SWA asset deployment separately needs a
broker-confined customer build/deploy path; do not claim it is present here.

Run `npx tsc --noEmit`, `npx eslint src/lib/providers/azure tests/providers/azure`,
and `npx vitest run --maxWorkers=2 tests/providers/azure`. For provider schema
proof outside this sandbox, set `ZENITH_TEST_TOFU_NETWORK=1` and run the gated
`validate.test.ts` and `deploy.test.ts` suites (azurerm 5.7.0).
