data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.tenancy_ocid
}

# ---- the compartment Zenith is confined to ------------------------------------

resource "oci_identity_compartment" "zenith" {
  compartment_id = coalesce(var.parent_compartment_ocid, var.tenancy_ocid)
  name           = var.compartment_name
  description    = "Everything Zenith creates lives here. Policies below grant the runner access to THIS compartment only."
  enable_delete  = false
}

locals {
  c = oci_identity_compartment.zenith.id

  tags = {
    zenith_managed = "true"
    zenith_role    = "bootstrap"
  }
}

# ---- vault and key for secret containers and generated database passwords ----------
# Drivers find these BY NAME (src/lib/providers/oci/vault-lookup.ts): keep the names.

resource "oci_kms_vault" "zenith" {
  count          = var.create_vault ? 1 : 0
  compartment_id = local.c
  display_name   = "zenith-vault"
  vault_type     = "DEFAULT"
  freeform_tags  = local.tags
}

resource "oci_kms_key" "secrets" {
  count               = var.create_vault ? 1 : 0
  compartment_id      = local.c
  display_name        = "zenith-secrets-key"
  management_endpoint = oci_kms_vault.zenith[0].management_endpoint
  protection_mode     = "SOFTWARE"
  freeform_tags       = local.tags

  key_shape {
    algorithm = "AES"
    length    = 32
  }
}

# ---- OpenTofu state -------------------------------------------------------------------
# Private, versioned, Oracle-managed encryption. See README.md for how the runner
# reaches it (S3-compatible API) and what that needs.

resource "oci_objectstorage_bucket" "state" {
  compartment_id = local.c
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = var.state_bucket_name
  access_type    = "NoPublicAccess"
  versioning     = "Enabled"
  storage_tier   = "Standard"
  freeform_tags  = local.tags
}

# ---- who the runners are ---------------------------------------------------------------

locals {
  deploy_terms  = concat([for id in var.deploy_runner_instance_ocids : "instance.id = '${id}'"], [for id in var.deploy_runner_container_instance_ocids : "resource.id = '${id}'"])
  observe_terms = concat([for id in var.observe_runner_instance_ocids : "instance.id = '${id}'"], [for id in var.observe_runner_container_instance_ocids : "resource.id = '${id}'"])
}

resource "oci_identity_dynamic_group" "deploy" {
  count          = length(local.deploy_terms) > 0 ? 1 : 0
  compartment_id = var.tenancy_ocid
  name           = "${var.name_prefix}-runner-deploy"
  description    = "Zenith DEPLOY runner: exactly the instances named in deploy_runner_*_ocids."
  matching_rule  = "ANY {${join(", ", local.deploy_terms)}}"
  freeform_tags  = local.tags
}

resource "oci_identity_dynamic_group" "observe" {
  count          = length(local.observe_terms) > 0 ? 1 : 0
  compartment_id = var.tenancy_ocid
  name           = "${var.name_prefix}-runner-observe"
  description    = "Zenith OBSERVE runner: read-only, exactly the instances named in observe_runner_*_ocids."
  matching_rule  = "ANY {${join(", ", local.observe_terms)}}"
  freeform_tags  = local.tags
}

locals {
  dg_pattern_term = var.dynamic_group_name_pattern == "" ? "" : "target.group.name like '${var.dynamic_group_name_pattern}'"

  deploy_oke_terms  = var.deploy_runner_oke == null ? "" : "request.principal.type = 'workload', request.principal.namespace = '${var.deploy_runner_oke.namespace}', request.principal.service_account = '${var.deploy_runner_oke.service_account}', request.principal.cluster_id = '${var.deploy_runner_oke.cluster_ocid}'"
  observe_oke_terms = var.observe_runner_oke == null ? "" : "request.principal.type = 'workload', request.principal.namespace = '${var.observe_runner_oke.namespace}', request.principal.service_account = '${var.observe_runner_oke.service_account}', request.principal.cluster_id = '${var.observe_runner_oke.cluster_ocid}'"

  # one entry per way a runner can authenticate; `cond` is appended to every statement,
  # `cond_dg` additionally carries the optional dynamic-group name pattern
  deploy_principals = concat(
    length(local.deploy_terms) > 0 ? [{
      subject = "dynamic-group ${oci_identity_dynamic_group.deploy[0].name}"
      cond    = ""
      cond_dg = local.dg_pattern_term == "" ? "" : " where ${local.dg_pattern_term}"
    }] : [],
    var.deploy_runner_oke == null ? [] : [{
      subject = "any-user"
      cond    = " where all {${local.deploy_oke_terms}}"
      cond_dg = " where all {${local.deploy_oke_terms}${local.dg_pattern_term == "" ? "" : ", ${local.dg_pattern_term}"}}"
    }]
  )

  observe_principals = concat(
    length(local.observe_terms) > 0 ? [{
      subject = "dynamic-group ${oci_identity_dynamic_group.observe[0].name}"
      cond    = ""
    }] : [],
    var.observe_runner_oke == null ? [] : [{
      subject = "any-user"
      cond    = " where all {${local.observe_oke_terms}}"
    }]
  )

  # What the DEPLOY runner needs in the Zenith compartment — exactly the resource types the
  # drivers create (see README.md for the mapping). Note what is ABSENT: no
  # "all-resources", no secret-bundles (the runner can never read a secret value), no
  # object-level Object Storage access, no compartment or user management.
  deploy_grants = [
    "manage virtual-network-family",
    "manage load-balancers",
    "manage compute-container-family",
    "manage repos",
    "manage postgres-db-systems",
    "manage postgres-backups",
    "manage redis-family",
    "manage buckets",
    "manage queues",
    "manage log-groups",
    "manage secrets",
    "manage volumes",
    "use vaults",
    "use keys",
    "manage dns-records",
    "read dns-zones",
    "read leaf-certificate-family",
    "manage policies",
  ]

  # What an OBSERVE-only runner may do: read configuration, never change it, never read a secret value.
  observe_grants = [
    "read virtual-network-family",
    "read load-balancers",
    "read compute-container-family",
    "read repos",
    "read postgres-db-systems",
    "read redis-family",
    "read buckets",
    "read queues",
    "read secrets",
    "read vaults",
    "inspect keys",
    "read log-groups",
    "read dns-zones",
    "read dns-records",
    "read leaf-certificate-family",
    "read policies",
    "read volumes",
  ]
}

resource "oci_identity_policy" "deploy" {
  count          = length(local.deploy_principals) > 0 ? 1 : 0
  compartment_id = local.c
  name           = "${var.name_prefix}-runner-deploy"
  description    = "Least privilege for the Zenith DEPLOY runner, scoped to the Zenith compartment."
  freeform_tags  = local.tags

  statements = flatten([
    for p in local.deploy_principals : [
      for g in local.deploy_grants : "Allow ${p.subject} to ${g} in compartment id ${local.c}${p.cond}"
    ]
  ])
}

resource "oci_identity_policy" "observe" {
  count          = length(local.observe_principals) > 0 ? 1 : 0
  compartment_id = local.c
  name           = "${var.name_prefix}-runner-observe"
  description    = "Read-only access for the Zenith OBSERVE runner, scoped to the Zenith compartment."
  freeform_tags  = local.tags

  statements = flatten([
    for p in local.observe_principals : [
      for g in local.observe_grants : "Allow ${p.subject} to ${g} in compartment id ${local.c}${p.cond}"
    ]
  ])
}

# Tenancy-level statements: the Object Storage namespace lookup, and (optionally) the dynamic
# groups Zenith creates per workload. A dynamic group is only ever powerful through a policy, and
# the runner can write policies in the Zenith compartment only, so the blast radius of identity
# management is that compartment — except that an EXISTING group named in some other policy could
# be edited: use dynamic_group_name_pattern to fence it.
resource "oci_identity_policy" "tenancy" {
  count          = length(local.deploy_principals) + length(local.observe_principals) > 0 ? 1 : 0
  compartment_id = var.tenancy_ocid
  name           = "${var.name_prefix}-runner-tenancy"
  description    = "Tenancy-level access for Zenith runners: namespace lookup and workload dynamic groups."
  freeform_tags  = local.tags

  statements = concat(
    [for p in local.deploy_principals : "Allow ${p.subject} to read objectstorage-namespaces in tenancy${p.cond}"],
    [for p in local.observe_principals : "Allow ${p.subject} to read objectstorage-namespaces in tenancy${p.cond}"],
    var.allow_identity_management ? [for p in local.deploy_principals : "Allow ${p.subject} to manage dynamic-groups in tenancy${p.cond_dg}"] : [],
    [for p in local.observe_principals : "Allow ${p.subject} to read dynamic-groups in tenancy${p.cond}"],
  )
}

# The load balancer SERVICE must be allowed to read the certificate a listener uses.
resource "oci_identity_policy" "lb_certificates" {
  compartment_id = local.c
  name           = "${var.name_prefix}-lb-certificates"
  description    = "Lets the load balancer service read certificates imported into OCI Certificates in the Zenith compartment."
  freeform_tags  = local.tags

  statements = ["Allow service loadbalancer to read leaf-certificate-family in compartment id ${local.c}"]
}
