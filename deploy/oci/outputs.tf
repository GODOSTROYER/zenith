output "compartment_ocid" {
  description = "Give this to Zenith as the connection's compartmentOcid."
  value       = oci_identity_compartment.zenith.id
}

output "tenancy_ocid" {
  description = "Give this to Zenith as the connection's tenancyOcid."
  value       = var.tenancy_ocid
}

output "region" {
  description = "Give this to Zenith as the connection's region."
  value       = var.region
}

output "object_storage_namespace" {
  value = data.oci_objectstorage_namespace.ns.namespace
}

output "state_bucket" {
  description = "Bucket for OpenTofu state (private, versioned)."
  value       = oci_objectstorage_bucket.state.name
}

output "state_s3_compatible_endpoint" {
  description = "S3-compatible endpoint of the state bucket; see README.md before using it as a backend."
  value       = "https://${data.oci_objectstorage_namespace.ns.namespace}.compat.objectstorage.${var.region}.oraclecloud.com"
}

output "vault_id" {
  value = var.create_vault ? oci_kms_vault.zenith[0].id : null
}

output "secrets_key_id" {
  value = var.create_vault ? oci_kms_key.secrets[0].id : null
}

output "deploy_dynamic_group" {
  value = length(oci_identity_dynamic_group.deploy) > 0 ? oci_identity_dynamic_group.deploy[0].name : null
}

output "observe_dynamic_group" {
  value = length(oci_identity_dynamic_group.observe) > 0 ? oci_identity_dynamic_group.observe[0].name : null
}
