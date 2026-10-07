variable "subscription_id" {
  description = "The Azure subscription Zenith will observe and deploy into."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a GUID."
  }
}

variable "cloud" {
  description = "Azure cloud the subscription lives in: public, usgov (Azure Government) or china (Azure operated by 21Vianet). It selects the federated-credential audience. Sovereign clouds are contract-level in Zenith: configure the azurerm provider with the matching environment (usgovernment or china)."
  type        = string
  default     = "public"

  validation {
    condition     = contains(["public", "usgov", "china"], var.cloud)
    error_message = "cloud must be public, usgov or china."
  }
}

variable "location" {
  description = "Region for the bootstrap resource group, the identities and the state storage account."
  type        = string
  default     = "westeurope"
}

variable "name_prefix" {
  description = "Prefix for bootstrap resource names (lowercase letters and digits, at most 8 characters)."
  type        = string
  default     = "zenith"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.name_prefix))
    error_message = "name_prefix must be 2-8 lowercase letters/digits, starting with a letter."
  }
}

variable "zenith_issuer" {
  description = "Zenith's OIDC issuer URL, shown in the Zenith connection wizard, e.g. https://app.example.com/api/oidc. It must serve /.well-known/openid-configuration and its JWKS over https."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+(/[^?#]*)?$", var.zenith_issuer))
    error_message = "zenith_issuer must be an https URL without a query or fragment."
  }
}

variable "workspace_id" {
  description = "Your Zenith workspace id; it is part of the token subject the identities trust."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.workspace_id))
    error_message = "workspace_id may contain only letters, digits, '_' and '-'."
  }
}

variable "observe_connection_id" {
  description = "Id of the Zenith connection that may only OBSERVE (read-only)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.observe_connection_id))
    error_message = "observe_connection_id may contain only letters, digits, '_' and '-'."
  }
}

variable "deploy_connection_id" {
  description = "Id of the Zenith connection that may DEPLOY. Leave empty to create only the read-only identity. It must differ from observe_connection_id: the two identities trust different token subjects, which is how a read-only connection can never mint a deploy token."
  type        = string
  default     = ""

  validation {
    condition     = var.deploy_connection_id == "" || can(regex("^[A-Za-z0-9_-]{1,64}$", var.deploy_connection_id))
    error_message = "deploy_connection_id may contain only letters, digits, '_' and '-'."
  }

  validation {
    condition     = var.deploy_connection_id == "" || var.deploy_connection_id != var.observe_connection_id
    error_message = "deploy_connection_id must differ from observe_connection_id."
  }
}

variable "register_resource_providers" {
  description = "Register the resource providers Zenith's environments use. Zenith runs the azurerm provider with resource_provider_registrations = \"none\" (its identity cannot register providers), so they must be registered here, once."
  type        = bool
  default     = true
}

variable "state_allowed_ip_ranges" {
  description = "CIDR ranges allowed to reach the OpenTofu state storage account (the egress addresses of your Zenith runner / worker). Empty leaves the endpoint reachable from anywhere; access is still Entra ID only (shared keys are disabled), but restricting it is better."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Extra tags for the bootstrap resources."
  type        = map(string)
  default     = {}
}
