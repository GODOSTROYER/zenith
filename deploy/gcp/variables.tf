variable "project_id" {
  description = "The GCP project Zenith will manage. Everything Zenith creates lives in this project."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project id (6-30 characters, lowercase letters, digits, hyphens)."
  }
}

variable "region" {
  description = "Default region for Zenith-managed resources and the state bucket, e.g. asia-south1."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2,}-[a-z]+[0-9]{1,2}$", var.region))
    error_message = "region must look like asia-south1."
  }
}

variable "zenith_issuer_uri" {
  description = "Zenith's OIDC issuer URL, shown in the Zenith connection wizard (https://<zenith origin>/api/oidc). It must serve /.well-known/openid-configuration publicly."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$", var.zenith_issuer_uri)) && !endswith(var.zenith_issuer_uri, "/")
    error_message = "zenith_issuer_uri must be an https URL without a trailing slash."
  }
}

variable "zenith_workspace_id" {
  description = "Your Zenith workspace id, from the connection wizard. The trust is pinned to it."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.zenith_workspace_id))
    error_message = "zenith_workspace_id may contain only letters, digits, underscore and hyphen."
  }
}

variable "zenith_connection_id" {
  description = "The Zenith connection id, from the connection wizard. The trust is pinned to it: only tokens whose subject is zenith:ws:<workspace>:conn:<connection> can impersonate the Zenith service accounts."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,64}$", var.zenith_connection_id))
    error_message = "zenith_connection_id may contain only letters, digits, underscore and hyphen."
  }
}

variable "pool_id" {
  description = "Workload identity pool id to create."
  type        = string
  default     = "zenith"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,31}$", var.pool_id))
    error_message = "pool_id must be 4-32 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "provider_id" {
  description = "Workload identity pool provider id to create."
  type        = string
  default     = "zenith-oidc"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{3,31}$", var.provider_id))
    error_message = "provider_id must be 4-32 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "state_bucket_name" {
  description = "Name of the Cloud Storage bucket for OpenTofu state. Empty = <project_id>-zenith-state."
  type        = string
  default     = ""

  validation {
    condition     = var.state_bucket_name == "" || can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid bucket name, or empty."
  }
}

variable "enable_apis" {
  description = "Enable the Google APIs Zenith's drivers use. Set false if your organisation enables APIs centrally (then enable the list in the README yourself)."
  type        = bool
  default     = true
}

variable "service_account_name_prefix" {
  description = "Zenith names the service accounts it creates <prefix>-<name>. When set, the deploy account may act as (iam.serviceAccountUser) only service accounts whose id starts with this prefix. Empty = it may act as any service account in the project, which is broader; see the README."
  type        = string
  default     = ""

  validation {
    condition     = var.service_account_name_prefix == "" || can(regex("^[a-z][a-z0-9-]{1,20}$", var.service_account_name_prefix))
    error_message = "service_account_name_prefix must be 2-21 lowercase letters, digits or hyphens, or empty."
  }
}
