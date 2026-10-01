# Zenith customer bootstrap for Azure

An OpenTofu module you run ONCE, as an administrator of your Azure subscription, to let Zenith observe and
deploy there **without any stored credential**. It creates:

| What | Why |
|---|---|
| `zenith-observe` user-assigned managed identity + federated credential | what a read-only Zenith connection exchanges its token for |
| `zenith-deploy` user-assigned managed identity + federated credential (optional) | what a deploying Zenith connection exchanges its token for |
| Roles for the observe identity | `Reader`, `Monitoring Reader`, `Log Analytics Reader`, `Key Vault Reader` (metadata only) on the subscription |
| Roles for the deploy identity | the custom role `<prefix>-deployer`, a **conditioned** `Role Based Access Control Administrator`, and `Storage Blob Data Contributor` on the state container |
| Resource provider registrations | Zenith runs azurerm with `resource_provider_registrations = "none"` |
| A state storage account + `tfstate` container | OpenTofu state for your environments, in YOUR subscription |

No app registration, no client secret, no certificate, nothing to rotate.

## How the trust works (ADR-0006)

Zenith is an OIDC issuer (`<origin>/api/oidc`). For one operation it signs a JWT (at most five minutes) whose
`sub` is `zenith:ws:<workspace>:conn:<connection>` and `aud` is `api://AzureADTokenExchange`, and presents it to
Microsoft Entra as a client assertion for the identity's client id. The identity's federated credential accepts a
token only if **issuer, audience and the exact subject** match. Therefore:

* stealing Zenith's database yields no Azure credential; the signing key is the crown jewel;
* the read-only connection cannot become a deploying one: its token's subject is different, and the deploy identity
  trusts a different subject. This is why `deploy_connection_id` must differ from `observe_connection_id`, and why
  you create **two Zenith connections** (the Azure connection record has one `clientId`; the split is by connection).

## Use

```hcl
provider "azurerm" {
  features {}
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"   # this module registers the providers it needs
  storage_use_azuread             = true     # the state account has shared keys disabled
}

module "zenith" {
  source                = "./deploy/azure"
  subscription_id       = "00000000-0000-0000-0000-000000000000"
  zenith_issuer         = "https://app.example.com/api/oidc"   # from the Zenith connection wizard
  workspace_id          = "ws_abc123"
  observe_connection_id = "conn_observe"
  deploy_connection_id  = "conn_deploy"                         # "" for read-only only
  location              = "westeurope"
  # state_allowed_ip_ranges = ["203.0.113.10/32"]               # your runner's egress, recommended
}

output "zenith" {
  value = {
    observe = module.zenith.zenith_observe_connection
    deploy  = module.zenith.zenith_deploy_connection
  }
}
```

Run it as an identity that can create role definitions and role assignments at the subscription (Owner, or
User Access Administrator + Contributor). Then paste the two connection objects into Zenith. Every value in the
outputs is an identifier, not a secret.

## What the deploy identity can and cannot do

`<prefix>-deployer` is a custom role, **not Owner and not Contributor**:

* only the resource providers Zenith's drivers use: Network (VNets, NSGs, private endpoints, private DNS, DNS),
  App (Container Apps), DBforPostgreSQL, DBforMySQL, Compute (VMs/disks), ContainerService (AKS),
  Web (Linux Functions/Static Web Apps), ARM deployments, Cache, Storage, ServiceBus, KeyVault, ContainerRegistry, ManagedIdentity,
  OperationalInsights, resource groups, resource locks;
* the actions that list or regenerate keys, SAS tokens and registry credentials are removed (`not_actions`);
  Zenith's storage accounts and Service Bus namespaces have key/SAS access disabled anyway;
* Key Vault **data** actions limited to get/set/readMetadata of secrets (it writes the secret values Zenith syncs);
* it can write role assignments **only** through the built-in `Role Based Access Control Administrator` role
  restricted by an ABAC condition to nine roles (AcrPull, Storage Blob Data Reader/Contributor/Owner,
  Storage Queue Data Contributor, Service Bus Data Sender/Receiver, Key Vault Secrets User/Officer)
  and to service principals. The added Blob Owner/Queue Contributor assignments are scoped only to
  a Function's private host account. It cannot assign Owner, Contributor or
  anything to a user, and cannot delete other assignments.

The added provider actions are explicit read/write/delete operations rather than whole-provider
wildcards. The deploy role does not list SWA deployment keys, Function publishing credentials,
cluster user/admin credentials or execute arbitrary VM commands. The three service primaries use
incremental ARM template deployments to avoid AzureRM refresh paths that fetch those credentials;
leave AzureRM's default nested-resource deletion enabled. See
`src/lib/providers/azure/README.md` for graph inputs, customer-prepared AKS/MySQL identities,
private DNS prerequisites, and the fresh-MySQL/SWA-artifact limitations.

### The one trade-off: subscription scope

The deploy role is assigned at **subscription** scope. Zenith creates one resource group per environment, and a
role cannot be scoped to a resource group that does not exist yet. To confine Zenith to one group you would pre-create
it and give the network driver an "existing resource group" input; the driver does not have one yet (it owns the
resource group). Until then, the blast radius is "the listed resource providers in this subscription". If that is too
broad, dedicate a subscription to Zenith.

## State

`<prefix>state<hash>` is a ZRS StorageV2 account: HTTPS only, TLS 1.2, **shared keys disabled** (Entra ID only),
no anonymous access, blob versioning and 30-day soft delete, a `CanNotDelete` lock, `prevent_destroy`. Only the
deploy identity can read or write the `tfstate` container (role scoped to that container). The endpoint is public
unless you set `state_allowed_ip_ranges`.

Record the bootstrap outputs as `stateStorageAccount` and `stateContainer` on the Azure connection.
`src/lib/tofu/backends.ts` derives an `azurerm` backend with `storage_account_name`, `container_name`, and
key `zenith/<workspace>/<environment>/terraform.tfstate`. It forces `use_azuread_auth = true` and
`use_cli = false`; federated connections also emit `use_oidc = true`. Runner connections let the scoped
`ARM_USE_OIDC` environment select OIDC. `ARM_OIDC_TOKEN`, `ARM_CLIENT_ID`, `ARM_TENANT_ID`, and
`ARM_SUBSCRIPTION_ID` come from the session only. No access key, SAS, client secret or credential file is accepted.
Keep separate observe/deploy connection identities as described above; there is no `deployClientId` override.
Backend assembly/refusals have unit coverage and gated real `tofu init -backend=false` / `tofu validate`
checks. Actual state access and lease locking remain unverified against Azure. The orchestrator still needs
to wire the execution compiler to this helper.

## Honest limits

* Validated with `tofu validate` against azurerm 5.7.0 (`tests/providers/azure/deploy.test.ts`). **Not applied to a real
  subscription.** The ABAC condition text follows Microsoft's published "constrain delegated role assignments"
  template; whether Azure accepts it exactly as written has not been verified live.
* An application using the azurerm provider with an OIDC client assertion exchanges it once at start. The assertion
  expires in minutes, so an apply that outlives the first access token (about an hour) cannot refresh it.
* The identities live in the `<prefix>-bootstrap-rg` resource group; deleting it revokes Zenith's access.
* Registering resource providers needs the operator to have that right; set `register_resource_providers = false`
  if your organisation registers them centrally, and make sure the list in `main.tf` is registered.

## Revoking access

Delete the federated credentials (or the whole module): Zenith's next token exchange fails immediately. Nothing
Zenith holds can be used against your subscription without a fresh token from Zenith's issuer.
