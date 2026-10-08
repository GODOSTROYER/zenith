terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = { source = "hashicorp/google", version = "= 8.5.0" }
  }
}
provider "google" { project = var.project_id }
variable "project_id" { type = string }
variable "billing_account_id" { type = string }
variable "pool_id" { type = string }
variable "github_repository" { type = string }
variable "github_owner_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "Numeric GitHub owner ID is mandatory to prevent name reuse."
  }
}
variable "github_repository_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "Numeric GitHub repository ID is mandatory."
  }
}
variable "github_environment" { type = string }
variable "github_ref" { type = string }
variable "budget_usd" {
  type = number
  validation {
    condition     = var.budget_usd > 0 && var.budget_usd <= 100 && floor(var.budget_usd) == var.budget_usd
    error_message = "Whole-dollar positive budget, at most USD 100."
  }
}
variable "notification_channel" { type = string }
data "google_project" "sandbox" { project_id = var.project_id }
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = var.pool_id
  display_name             = "Zenith acceptance observer"
}
resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
  }
  attribute_condition = "assertion.repository_owner_id == ${jsonencode(var.github_owner_id)} && assertion.repository_id == ${jsonencode(var.github_repository_id)} && assertion.ref == ${jsonencode(var.github_ref)} && assertion.sub == ${jsonencode("repo:${var.github_repository}:environment:${var.github_environment}")}"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account" "observer" {
  account_id   = "zenith-live-observer"
  display_name = "Read-only live acceptance, no deploy authority"
}
resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.observer.name
  role              = "roles/iam.workloadIdentityUser"
  member            = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/repo:${var.github_repository}:environment:${var.github_environment}"
}
resource "google_project_iam_custom_role" "observer" {
  role_id = "zenithLiveReadback"
  title   = "Zenith sandbox readback"
  permissions = [
    "resourcemanager.projects.get",
    "cloudasset.assets.searchAllResources",
    "compute.instances.get", "compute.instances.list",
    "compute.networks.get", "compute.networks.list",
    "compute.subnetworks.get", "compute.subnetworks.list",
    "compute.forwardingRules.get", "compute.forwardingRules.list",
    "dns.managedZones.get", "dns.managedZones.list", "dns.resourceRecordSets.list",
    "storage.buckets.get", "storage.buckets.list", "storage.objects.get", "storage.objects.list",
    "cloudbuild.builds.get", "cloudbuild.builds.list",
    "artifactregistry.repositories.get", "artifactregistry.repositories.list",
    "artifactregistry.dockerimages.get", "artifactregistry.dockerimages.list",
    "secretmanager.secrets.get", "secretmanager.secrets.list"
  ]
}
resource "google_project_iam_member" "observer" {
  project = var.project_id
  role    = google_project_iam_custom_role.observer.name
  member  = "serviceAccount:${google_service_account.observer.email}"
}
resource "google_billing_budget" "sandbox" {
  billing_account = var.billing_account_id
  display_name    = "Zenith disposable sandbox"
  budget_filter {
    projects = ["projects/${data.google_project.sandbox.number}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_usd)
    }
  }
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.8
    spend_basis       = "FORECASTED_SPEND"
  }
  all_updates_rule {
    monitoring_notification_channels = [var.notification_channel]
    disable_default_iam_recipients    = false
  }
}
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "observer_service_account" { value = google_service_account.observer.email }
