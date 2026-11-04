terraform {
  required_version = ">= 1.6.0"
  required_providers {
    oci = { source = "oracle/oci", version = "= 9.7.1" }
  }
}
# Owner bootstrap identity, never the GitHub observer. No users or API keys are created.
provider "oci" { region = var.region }
variable "tenancy_id" {
  type = string
  validation {
    condition     = can(regex("^ocid1\\.tenancy\\.[a-z0-9.-]+$", var.tenancy_id))
    error_message = "An exact tenancy OCID is required."
  }
}
variable "compartment_id" {
  type = string
  validation {
    condition     = can(regex("^ocid1\\.compartment\\.[a-z0-9.-]+$", var.compartment_id))
    error_message = "An exact compartment OCID is required; no policy text."
  }
}
variable "identity_domain_id" {
  type = string
  validation {
    condition     = can(regex("^ocid1\\.domain\\.[a-z0-9.-]+$", var.identity_domain_id))
    error_message = "An exact trusted domain OCID is required; no policy text."
  }
}
variable "region" { type = string }
variable "name" { type = string }
variable "budget_usd" {
  type = number
  validation {
    condition     = var.budget_usd > 0 && var.budget_usd <= 100
    error_message = "Positive sandbox monthly alert budget, at most USD 100."
  }
}
variable "alert_email" { type = string }
resource "oci_identity_policy" "observer" {
  compartment_id = var.compartment_id
  name           = "${var.name}-readback"
  description    = "Compartment-scoped GitHub resource-principal readback, no mutation or IAM management"
  freeform_tags  = { zenith_sandbox = "true", zenith_owner = "arnav.bule05" }
  statements = [for family in ["instances", "virtual-network-family", "container-instances", "load-balancers", "dns", "buckets", "objects", "repos", "secrets"] :
    "Allow any-user to read ${family} in compartment id ${var.compartment_id} where all {request.principal.type='githubactions', request.principal.domain_id='${var.identity_domain_id}'}"
  ]
}
resource "oci_budget_budget" "sandbox" {
  compartment_id = var.tenancy_id
  amount         = var.budget_usd
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.compartment_id]
  display_name   = "${var.name}-budget"
  freeform_tags  = { zenith_sandbox = "true" }
}
resource "oci_budget_alert_rule" "actual" {
  budget_id      = oci_budget_budget.sandbox.id
  type           = "ACTUAL"
  threshold      = 50
  threshold_type = "PERCENTAGE"
  recipients     = var.alert_email
  display_name   = "Half of approved sandbox budget"
}
resource "oci_budget_alert_rule" "forecast" {
  budget_id      = oci_budget_budget.sandbox.id
  type           = "FORECAST"
  threshold      = 80
  threshold_type = "PERCENTAGE"
  recipients     = var.alert_email
  display_name   = "Forecast sandbox budget alert"
}
