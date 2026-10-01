variable "tenancy_ocid" {
  description = "OCID of your tenancy (the root compartment). Dynamic groups and the object storage namespace live here."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.tenancy\\.[a-z0-9]+\\.[a-z0-9-]*\\.[A-Za-z0-9]+$", var.tenancy_ocid))
    error_message = "tenancy_ocid must be a tenancy OCID (ocid1.tenancy.…)."
  }
}

variable "region" {
  description = "Home region for the Zenith compartment's resources, e.g. us-ashburn-1."
  type        = string
}

variable "parent_compartment_ocid" {
  description = "Compartment to create the Zenith compartment in. Defaults to the tenancy root."
  type        = string
  default     = null
}

variable "compartment_name" {
  description = "Name of the compartment Zenith is allowed to manage. Everything Zenith creates lives here."
  type        = string
  default     = "zenith"
}

variable "name_prefix" {
  description = "Prefix for the dynamic groups and policies this module creates."
  type        = string
  default     = "zenith"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name_prefix))
    error_message = "name_prefix must be 2-20 lowercase letters, digits or dashes, starting with a letter."
  }
}

# ---- who the runner is -------------------------------------------------------
# A runner authenticates with its own OCI principal. Name the instances here; the
# module turns them into a dynamic group matching EXACTLY those OCIDs. Leave a list
# empty to skip that kind. An OKE runner uses workload identity instead (no dynamic
# group): give the cluster, namespace and service account.

variable "deploy_runner_instance_ocids" {
  description = "Compute instances running the DEPLOY runner (instance principal)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.deploy_runner_instance_ocids : can(regex("^ocid1\\.instance\\.[a-z0-9]+\\.[a-z0-9-]*\\.[A-Za-z0-9]+$", id))])
    error_message = "Every entry must be a compute instance OCID (ocid1.instance.…)."
  }
}

variable "deploy_runner_container_instance_ocids" {
  description = "Container instances running the DEPLOY runner (resource principal)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.deploy_runner_container_instance_ocids : can(regex("^ocid1\\.computecontainerinstance\\.[a-z0-9]+\\.[a-z0-9-]*\\.[A-Za-z0-9]+$", id))])
    error_message = "Every entry must be a container instance OCID (ocid1.computecontainerinstance.…)."
  }
}

variable "deploy_runner_oke" {
  description = "OKE workload identity of the DEPLOY runner: { cluster_ocid, namespace, service_account }."
  type = object({
    cluster_ocid    = string
    namespace       = string
    service_account = string
  })
  default = null
}

variable "observe_runner_instance_ocids" {
  description = "Compute instances running a READ-ONLY (observe) runner."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.observe_runner_instance_ocids : can(regex("^ocid1\\.instance\\.[a-z0-9]+\\.[a-z0-9-]*\\.[A-Za-z0-9]+$", id))])
    error_message = "Every entry must be a compute instance OCID (ocid1.instance.…)."
  }
}

variable "observe_runner_container_instance_ocids" {
  description = "Container instances running a READ-ONLY (observe) runner."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.observe_runner_container_instance_ocids : can(regex("^ocid1\\.computecontainerinstance\\.[a-z0-9]+\\.[a-z0-9-]*\\.[A-Za-z0-9]+$", id))])
    error_message = "Every entry must be a container instance OCID (ocid1.computecontainerinstance.…)."
  }
}

variable "observe_runner_oke" {
  description = "OKE workload identity of the READ-ONLY runner: { cluster_ocid, namespace, service_account }."
  type = object({
    cluster_ocid    = string
    namespace       = string
    service_account = string
  })
  default = null
}

# ---- what Zenith may do ------------------------------------------------------

variable "allow_identity_management" {
  description = <<-EOT
    Let the deploy runner create per-workload dynamic groups (tenancy level) and
    policies (in the Zenith compartment only). Zenith's `identity/*` nodes need this.
    With false, applying any workload identity fails: use it only if you create
    workload dynamic groups and policies yourself.
  EOT
  type        = bool
  default     = true
}

variable "dynamic_group_name_pattern" {
  description = <<-EOT
    Optional SQL-like pattern (for example "zn-%") limiting which dynamic groups the
    deploy runner may manage, added as `where target.group.name like '<pattern>'`.
    Empty = no restriction. The policy variable name follows the IAM reference and is
    unverified; a wrong one fails at apply, never silently.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[A-Za-z0-9_%-]*$", var.dynamic_group_name_pattern))
    error_message = "The pattern may contain only letters, digits, '_', '-' and '%'."
  }
}

variable "state_bucket_name" {
  description = "Name of the Object Storage bucket for OpenTofu state (unique in your tenancy's namespace)."
  type        = string
  default     = "zenith-tfstate"
}

variable "create_vault" {
  description = "Create the Vault and master key Zenith's secret containers and database passwords use. Set false only if you already have a vault named zenith-vault with a key named zenith-secrets-key in the Zenith compartment."
  type        = bool
  default     = true
}
