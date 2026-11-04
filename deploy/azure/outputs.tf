output "tenant_id" {
  description = "The Entra tenant id (AzureConnectionConfig.tenantId)."
  value       = data.azurerm_client_config.current.tenant_id
}

output "subscription_id" {
  description = "AzureConnectionConfig.subscriptionId."
  value       = var.subscription_id
}

output "observe_client_id" {
  description = "Client id of the read-only identity: AzureConnectionConfig.clientId for the observe connection."
  value       = azurerm_user_assigned_identity.observe.client_id
}

output "deploy_client_id" {
  description = "Client id of the deploy identity: AzureConnectionConfig.clientId for the deploy connection (null when no deploy connection was configured)."
  value       = local.has_deployer ? azurerm_user_assigned_identity.deploy[0].client_id : null
}

output "state_storage_account" {
  description = "Storage account for OpenTofu state."
  value       = azurerm_storage_account.state.name
}

output "state_container" {
  description = "Blob container for OpenTofu state."
  value       = azurerm_storage_container.state.name
}

# Paste these into the Zenith connection wizard. Nothing here is a secret: identifiers only.
output "zenith_observe_connection" {
  description = "Non-secret connection settings for the read-only connection."
  value = {
    provider       = "azure"
    mode           = "oidc_web_identity"
    tenantId       = data.azurerm_client_config.current.tenant_id
    clientId       = azurerm_user_assigned_identity.observe.client_id
    subscriptionId = var.subscription_id
    region         = var.location
  }
}

output "zenith_deploy_connection" {
  description = "Non-secret connection settings for the deploy connection (null when no deploy connection was configured)."
  value = local.has_deployer ? {
    provider       = "azure"
    mode           = "oidc_web_identity"
    tenantId       = data.azurerm_client_config.current.tenant_id
    clientId       = azurerm_user_assigned_identity.deploy[0].client_id
    subscriptionId = var.subscription_id
    region         = var.location
  } : null
}
