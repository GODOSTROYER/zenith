output "workload_identity_provider" {
  description = "Paste into the Zenith connection: projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>."
  value       = local.provider_path
}

output "observe_service_account" {
  description = "Paste into the Zenith connection (read-only account)."
  value       = google_service_account.observe.email
}

output "deploy_service_account" {
  description = "Paste into the Zenith connection (mutating account)."
  value       = google_service_account.deploy.email
}

output "state_bucket" {
  description = "Bucket for OpenTofu state."
  value       = google_storage_bucket.state.name
}

output "zenith_subject" {
  description = "The only token subject that can use this trust."
  value       = local.zenith_subject
}

output "connection" {
  description = "The non-secret fields of the Zenith GCP connection (no key, token or secret exists in this configuration)."
  value = {
    provider                 = "gcp"
    mode                     = "oidc_web_identity"
    projectId                = var.project_id
    region                   = var.region
    workloadIdentityProvider = local.provider_path
    observeServiceAccount    = google_service_account.observe.email
    deployServiceAccount     = google_service_account.deploy.email
    stateBucket              = google_storage_bucket.state.name
  }
}
