data "azurerm_client_config" "current" {}

locals {
  subscription_scope = "/subscriptions/${var.subscription_id}"
  token_audience     = "api://AzureADTokenExchange"
  # Sovereign clouds exchange against their own audience (src/lib/providers/azure/cloud.ts); the federated credentials
  # below trust exactly the audience of the cloud the subscription lives in.
  federation_audiences = {
    public = local.token_audience
    usgov  = "api://AzureADTokenExchangeUSGov"
    china  = "api://AzureADTokenExchangeChina"
  }
  federation_audience = local.federation_audiences[var.cloud]
  has_deployer       = var.deploy_connection_id != ""

  # Zenith's token subject: zenith:ws:<workspace>:conn:<connection> (ADR-0006). The federated
  # credential trusts exactly this subject, this issuer and this audience, and nothing else.
  observe_subject = "zenith:ws:${var.workspace_id}:conn:${var.observe_connection_id}"
  deploy_subject  = "zenith:ws:${var.workspace_id}:conn:${var.deploy_connection_id}"

  # Short, stable, globally unique-ish suffix for the state account name.
  suffix     = substr(md5(var.subscription_id), 0, 6)
  state_name = "${var.name_prefix}state${local.suffix}"

  tags = merge({ "zenith:bootstrap" = "true" }, var.tags)

  # The resource providers Zenith's Azure drivers use.
  resource_providers = var.register_resource_providers ? toset([
    "Microsoft.App",
    "Microsoft.Authorization",
    "Microsoft.Cache",
    "Microsoft.ContainerRegistry",
    "Microsoft.DBforPostgreSQL",
    "Microsoft.DBforMySQL",
    "Microsoft.Compute",
    "Microsoft.ContainerService",
    "Microsoft.Insights",
    "Microsoft.KeyVault",
    "Microsoft.ManagedIdentity",
    "Microsoft.Network",
    "Microsoft.OperationalInsights",
    "Microsoft.Resources",
    "Microsoft.ServiceBus",
    "Microsoft.Storage",
    "Microsoft.Web",
  ]) : toset([])

  # The ONLY roles the deploy identity may hand out (see the conditioned role-assignment administrator below).
  # These are the built-in data roles src/lib/providers/azure/drivers/identity/identity.ts can produce.
  assignable_role_guids = [
    "7f951dda-4ed3-4680-a7ca-43fe172d538d", # AcrPull
    "8311e382-0749-4cb8-b61a-304f252e45ec", # AcrPush (a builder identity, data plane, one registry)
    "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1", # Storage Blob Data Reader
    "ba92f5b4-2d11-453d-a403-e96b0029c9fe", # Storage Blob Data Contributor
    "b7e6dc6d-f1e8-4753-8033-0f276bb0955b", # Storage Blob Data Owner (Function host account only)
    "974c5e8b-45b9-4653-ba55-5f855dd0fb88", # Storage Queue Data Contributor (Function host account only)
    "69a216fc-b8fb-44d8-bc22-1f3c2cd27a39", # Azure Service Bus Data Sender
    "4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0", # Azure Service Bus Data Receiver
    "4633458b-17de-408a-b874-0445c86b69e6", # Key Vault Secrets User
    "b86a8fe4-44ce-4948-aee5-eccb2c155cd7", # Key Vault Secrets Officer
  ]
  assignable_guid_list = join(", ", local.assignable_role_guids)

  # ABAC condition (condition version 2.0): role assignments written or deleted by the deploy identity must be one of
  # the roles above, for service principals only.
  deployer_assignment_condition = <<-EOT
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
     )
     OR
     (
      @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable_guid_list}}
      AND
      @Request[Microsoft.Authorization/roleAssignments:PrincipalType] StringEqualsIgnoreCase 'ServicePrincipal'
     )
    )
    AND
    (
     (
      !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
     )
     OR
     (
      @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${local.assignable_guid_list}}
     )
    )
  EOT
}

resource "azurerm_resource_provider_registration" "required" {
  for_each = local.resource_providers
  name     = each.value
}

resource "azurerm_resource_group" "bootstrap" {
  name     = "${var.name_prefix}-bootstrap-rg"
  location = var.location
  tags     = local.tags
}

/* --------------------------------- identities -------------------------------- */

# Two user-assigned managed identities with federated credentials: no app registration, no client secret, no
# certificate, nothing to rotate. Zenith exchanges its short-lived signed token for an Entra token for one of them.

resource "azurerm_user_assigned_identity" "observe" {
  name                = "${var.name_prefix}-observe"
  location            = azurerm_resource_group.bootstrap.location
  resource_group_name = azurerm_resource_group.bootstrap.name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "observe" {
  name                      = "zenith-observe"
  user_assigned_identity_id = azurerm_user_assigned_identity.observe.id
  issuer                    = var.zenith_issuer
  subject                   = local.observe_subject
  audience                  = [local.federation_audience]
}

resource "azurerm_user_assigned_identity" "deploy" {
  count               = local.has_deployer ? 1 : 0
  name                = "${var.name_prefix}-deploy"
  location            = azurerm_resource_group.bootstrap.location
  resource_group_name = azurerm_resource_group.bootstrap.name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "deploy" {
  count                     = local.has_deployer ? 1 : 0
  name                      = "zenith-deploy"
  user_assigned_identity_id = azurerm_user_assigned_identity.deploy[0].id
  issuer                    = var.zenith_issuer
  subject                   = local.deploy_subject
  audience                  = [local.federation_audience]
}

/* ------------------------------- observe (read-only) ------------------------------ */

# Reader sees configuration of everything in the subscription (needed to find Zenith-tagged resources and to
# discover candidates for import) but can change nothing and cannot read secret values or keys. The data readers are
# the specific read-only roles for logs, metrics and Key Vault METADATA (never secret contents).
resource "azurerm_role_assignment" "observe" {
  for_each             = toset(["Reader", "Monitoring Reader", "Log Analytics Reader", "Key Vault Reader"])
  scope                = local.subscription_scope
  role_definition_name = each.value
  principal_id         = azurerm_user_assigned_identity.observe.principal_id
  principal_type       = "ServicePrincipal"
  description          = "Zenith read-only observation"
}

/* ----------------------------------- deploy ------------------------------------- */

# NOT Owner, NOT Contributor. A custom role limited to the resource providers Zenith's drivers compile to, with the
# key/secret-listing actions removed. It is assigned at SUBSCRIPTION scope because Zenith creates one resource group
# per environment (a resource group does not exist yet to scope a role to); that is the one trade-off of this design.
resource "azurerm_role_definition" "deployer" {
  count       = local.has_deployer ? 1 : 0
  name        = "${var.name_prefix}-deployer"
  scope       = local.subscription_scope
  description = "Create and manage the Azure resources Zenith environments are made of. No Owner/Contributor, no key listing, no role administration except the conditioned assignment below."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/read",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/subscriptions/resourceGroups/write",
      "Microsoft.Resources/subscriptions/resourceGroups/delete",
      "Microsoft.Resources/subscriptions/resources/read",
      "Microsoft.Resources/deployments/read",
      "Microsoft.Resources/deployments/write",
      "Microsoft.Resources/deployments/delete",
      "Microsoft.Resources/deployments/validate/action",
      "Microsoft.Resources/deployments/operations/read",
      "Microsoft.Authorization/*/read",
      "Microsoft.Authorization/locks/*",
      "Microsoft.Network/virtualNetworks/*",
      "Microsoft.Network/networkSecurityGroups/*",
      "Microsoft.Network/networkInterfaces/*",
      "Microsoft.Network/privateEndpoints/*",
      "Microsoft.Network/privateDnsZones/*",
      "Microsoft.Network/dnszones/*",
      "Microsoft.Network/locations/*/read",
      "Microsoft.App/*",
      "Microsoft.DBforPostgreSQL/flexibleServers/*",
      "Microsoft.DBforPostgreSQL/locations/*/read",
      "Microsoft.DBforMySQL/flexibleServers/read",
      "Microsoft.DBforMySQL/flexibleServers/write",
      "Microsoft.DBforMySQL/flexibleServers/delete",
      "Microsoft.DBforMySQL/flexibleServers/administrators/read",
      "Microsoft.DBforMySQL/flexibleServers/administrators/write",
      "Microsoft.DBforMySQL/flexibleServers/administrators/delete",
      "Microsoft.DBforMySQL/flexibleServers/configurations/read",
      "Microsoft.DBforMySQL/flexibleServers/configurations/write",
      "Microsoft.DBforMySQL/flexibleServers/configurations/delete",
      "Microsoft.DBforMySQL/locations/*/read",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/disks/read",
      "Microsoft.Compute/disks/write",
      "Microsoft.Compute/disks/delete",
      "Microsoft.Compute/locations/*/read",
      "Microsoft.ContainerService/managedClusters/read",
      "Microsoft.ContainerService/managedClusters/write",
      "Microsoft.ContainerService/managedClusters/delete",
      "Microsoft.ContainerService/managedClusters/agentPools/read",
      "Microsoft.ContainerService/managedClusters/agentPools/write",
      "Microsoft.ContainerService/managedClusters/agentPools/delete",
      "Microsoft.ContainerService/locations/*/read",
      "Microsoft.Web/serverFarms/read",
      "Microsoft.Web/serverFarms/write",
      "Microsoft.Web/serverFarms/delete",
      "Microsoft.Web/serverFarms/join/action",
      "Microsoft.Web/sites/read",
      "Microsoft.Web/sites/write",
      "Microsoft.Web/sites/delete",
      "Microsoft.Web/sites/config/read",
      "Microsoft.Web/sites/config/write",
      "Microsoft.Web/sites/basicPublishingCredentialsPolicies/read",
      "Microsoft.Web/sites/basicPublishingCredentialsPolicies/write",
      "Microsoft.Web/staticSites/read",
      "Microsoft.Web/staticSites/write",
      "Microsoft.Web/staticSites/delete",
      "Microsoft.Web/staticSites/customDomains/read",
      "Microsoft.Web/staticSites/customDomains/write",
      "Microsoft.Web/staticSites/customDomains/delete",
      "Microsoft.Web/staticSites/privateEndpointConnections/read",
      "Microsoft.Web/staticSites/privateEndpointConnections/write",
      "Microsoft.Web/staticSites/privateEndpointConnections/delete",
      "Microsoft.Cache/redis/*",
      "Microsoft.Storage/storageAccounts/*",
      "Microsoft.ServiceBus/namespaces/*",
      "Microsoft.KeyVault/vaults/*",
      "Microsoft.KeyVault/locations/*/read",
      "Microsoft.ContainerRegistry/registries/*",
      "Microsoft.ManagedIdentity/userAssignedIdentities/*",
      # Container Apps environments read the workspace key when they are wired to Log Analytics.
      "Microsoft.OperationalInsights/workspaces/*",
    ]
    not_actions = [
      "Microsoft.Cache/redis/listKeys/action",
      "Microsoft.Cache/redis/regenerateKey/action",
      "Microsoft.Storage/storageAccounts/listKeys/action",
      "Microsoft.Storage/storageAccounts/regenerateKey/action",
      "Microsoft.Storage/storageAccounts/listAccountSas/action",
      "Microsoft.Storage/storageAccounts/listServiceSas/action",
      "Microsoft.ServiceBus/namespaces/authorizationRules/listkeys/action",
      "Microsoft.ServiceBus/namespaces/authorizationRules/regenerateKeys/action",
      "Microsoft.ContainerRegistry/registries/listCredentials/action",
      "Microsoft.ContainerRegistry/registries/generateCredentials/action",
    ]
    # Writing secret VALUES into the Key Vaults Zenith created (syncSecretValue). Reading them back is needed only to
    # skip an unchanged write; the value never leaves Zenith's worker.
    data_actions = [
      "Microsoft.KeyVault/vaults/secrets/getSecret/action",
      "Microsoft.KeyVault/vaults/secrets/setSecret/action",
      "Microsoft.KeyVault/vaults/secrets/readMetadata/action",
    ]
  }

  assignable_scopes = [local.subscription_scope]
}

resource "azurerm_role_assignment" "deployer" {
  count              = local.has_deployer ? 1 : 0
  scope              = local.subscription_scope
  role_definition_id = azurerm_role_definition.deployer[0].role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.deploy[0].principal_id
  principal_type     = "ServicePrincipal"
  description        = "Zenith deployments"
}

# Zenith grants each workload identity its data roles (AcrPull, Key Vault Secrets User, ...). Writing role
# assignments is how privilege escalates, so this is the built-in administrator role CONSTRAINED by a condition to the
# data roles above and to service principals. The deploy identity cannot assign Owner, Contributor, itself
# a broader role, or anything to a user.
resource "azurerm_role_assignment" "deployer_assigns_data_roles" {
  count                = local.has_deployer ? 1 : 0
  scope                = local.subscription_scope
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.deploy[0].principal_id
  principal_type       = "ServicePrincipal"
  description          = "Zenith: assign only workload data roles"
  condition_version    = "2.0"
  condition            = local.deployer_assignment_condition
}

/* ------------------------------- OpenTofu state storage ---------------------------- */

resource "azurerm_storage_account" "state" {
  name                             = local.state_name
  location                         = azurerm_resource_group.bootstrap.location
  resource_group_name              = azurerm_resource_group.bootstrap.name
  account_kind                     = "StorageV2"
  account_tier                     = "Standard"
  account_replication_type         = "ZRS"
  https_traffic_only_enabled       = true
  min_tls_version                  = "TLS1_2"
  allow_nested_items_to_be_public  = false
  shared_access_key_enabled        = false
  default_to_oauth_authentication  = true
  cross_tenant_replication_enabled = false
  local_user_enabled               = false
  tags                             = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }

  network_rules {
    default_action = length(var.state_allowed_ip_ranges) > 0 ? "Deny" : "Allow"
    ip_rules       = var.state_allowed_ip_ranges
    bypass         = ["AzureServices"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "state" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

resource "azurerm_management_lock" "state" {
  name       = "zenith-protect-state"
  scope      = azurerm_storage_account.state.id
  lock_level = "CanNotDelete"
  notes      = "Holds OpenTofu state; deleting it loses track of every Zenith-managed resource."
}

# The deploy identity reads and writes state (and takes the lease lock) on THIS container only.
resource "azurerm_role_assignment" "deployer_state" {
  count                = local.has_deployer ? 1 : 0
  scope                = azurerm_storage_container.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.deploy[0].principal_id
  principal_type       = "ServicePrincipal"
  description          = "Zenith OpenTofu state"
}
