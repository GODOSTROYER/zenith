data "google_project" "this" {
  project_id = var.project_id
}

locals {
  project_number = data.google_project.this.number

  # The exact subject Zenith's OIDC token carries for this connection (ADR-0006).
  zenith_subject = "zenith:ws:${var.zenith_workspace_id}:conn:${var.zenith_connection_id}"

  # Full resource path of the provider, and the audience the Zenith token must carry.
  provider_path    = "projects/${local.project_number}/locations/global/workloadIdentityPools/${var.pool_id}/providers/${var.provider_id}"
  allowed_audience = "https://iam.googleapis.com/${local.provider_path}"

  state_bucket = var.state_bucket_name != "" ? var.state_bucket_name : "${var.project_id}-zenith-state"

  apis = [
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "compute.googleapis.com",
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "servicenetworking.googleapis.com",
    "storage.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "containerscanning.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudscheduler.googleapis.com",
    "dns.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]

  # Read-only: what `observe`, `runtime`, `verify`, `discover` and the observability
  # source need. None of these can read a secret value, a database row or an object.
  observe_roles = [
    "roles/run.viewer",
    "roles/cloudsql.viewer",
    "roles/redis.viewer",
    "roles/pubsub.viewer",
    "roles/secretmanager.viewer",
    "roles/compute.viewer",
    "roles/dns.reader",
    "roles/cloudscheduler.viewer",
    "roles/logging.viewer",
    "roles/monitoring.viewer",
    "roles/cloudbuild.builds.viewer",
    "roles/serviceusage.serviceUsageConsumer",
  ]

  # Create/update/delete the resource families Zenith's drivers compile to.
  # No primitive role (owner/editor/viewer) appears anywhere in this module.
  deploy_roles = [
    "roles/compute.networkAdmin",
    "roles/compute.securityAdmin",
    "roles/compute.loadBalancerAdmin",
    "roles/servicenetworking.networksAdmin",
    "roles/run.admin",
    "roles/cloudsql.admin",
    "roles/redis.admin",
    "roles/storage.admin",
    "roles/pubsub.admin",
    "roles/artifactregistry.admin",
    "roles/cloudbuild.builds.editor",
    "roles/cloudscheduler.admin",
    "roles/dns.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/serviceusage.serviceUsageConsumer",
  ]

  # The only project-level IAM roles Zenith's drivers ever bind to the service accounts they create.
  grantable_roles = [
    "roles/logging.logWriter",
    "roles/cloudsql.client",
    "roles/cloudsql.instanceUser",
  ]
}

# --------------------------------------------------------------------------
# APIs
# --------------------------------------------------------------------------

resource "google_project_service" "api" {
  for_each = var.enable_apis ? toset(local.apis) : toset([])

  project = var.project_id
  service = each.value

  # Zenith must not turn off an API the rest of the project may rely on.
  disable_on_destroy = false
}

# --------------------------------------------------------------------------
# Keyless trust: Zenith's OIDC issuer -> workload identity pool -> service accounts
# --------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "zenith" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = "Zenith"
  description               = "Federates Zenith's OIDC tokens; no long-lived key exists."

  depends_on = [google_project_service.api]
}

resource "google_iam_workload_identity_pool_provider" "zenith" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.zenith.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "Zenith OIDC"

  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }

  # Only a token whose subject is exactly this workspace + connection is accepted at all.
  # Everything else the issuer signs (other workspaces, other connections) is rejected here.
  attribute_condition = "assertion.sub == \"${local.zenith_subject}\""

  oidc {
    issuer_uri        = var.zenith_issuer_uri
    allowed_audiences = [local.allowed_audience]
  }
}

resource "google_service_account" "observe" {
  project      = var.project_id
  account_id   = "zenith-observe"
  display_name = "Zenith observe (read-only)"
  description  = "Impersonated by Zenith for read-only calls: observe, verify, discover, logs, metrics."

  depends_on = [google_project_service.api]
}

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "zenith-deploy"
  display_name = "Zenith deploy"
  description  = "Impersonated by Zenith for mutating calls: OpenTofu apply, restarts, scaling, builds."

  depends_on = [google_project_service.api]
}

locals {
  # principal:// matches exactly one federated subject, not the pool.
  federated_principal = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.zenith.name}/subject/${local.zenith_subject}"
}

resource "google_service_account_iam_member" "observe_impersonation" {
  service_account_id = google_service_account.observe.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.federated_principal
}

resource "google_service_account_iam_member" "deploy_impersonation" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.federated_principal
}

# --------------------------------------------------------------------------
# Observe: read-only predefined roles plus one small custom role for the reads
# no predefined read-only role covers
# --------------------------------------------------------------------------

resource "google_project_iam_custom_role" "observe_extras" {
  project     = var.project_id
  role_id     = "zenithObserveExtras"
  title       = "Zenith observe extras"
  description = "Metadata reads for Artifact Registry, Cloud Storage buckets, service accounts and log buckets."
  permissions = [
    "artifactregistry.repositories.get",
    "artifactregistry.repositories.list",
    "storage.buckets.get",
    "storage.buckets.list",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.list",
    "logging.buckets.get",
    "logging.buckets.list",
    "resourcemanager.projects.get",
  ]
}

resource "google_project_iam_member" "observe" {
  for_each = toset(local.observe_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.observe.email}"
}

resource "google_project_iam_member" "observe_extras" {
  project = var.project_id
  role    = google_project_iam_custom_role.observe_extras.id
  member  = "serviceAccount:${google_service_account.observe.email}"
}

# --------------------------------------------------------------------------
# Deploy: per-service admin roles, a custom role for secrets that cannot read values,
# and a grant-limited IAM admin binding
# --------------------------------------------------------------------------

resource "google_project_iam_custom_role" "secrets_manage" {
  project     = var.project_id
  role_id     = "zenithSecretsManage"
  title       = "Zenith secrets manage (no value access)"
  description = "Create and manage Secret Manager secrets and add versions. Deliberately lacks secretmanager.versions.access: the deploy account can write a secret but never read it."
  permissions = [
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.list",
    "secretmanager.secrets.update",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.setIamPolicy",
    "secretmanager.versions.add",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
    "secretmanager.versions.enable",
    "secretmanager.versions.disable",
    "secretmanager.versions.destroy",
  ]
}

resource "google_project_iam_member" "deploy" {
  for_each = toset(local.deploy_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_project_iam_member" "deploy_secrets" {
  project = var.project_id
  role    = google_project_iam_custom_role.secrets_manage.id
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

# Zenith binds roles to the service accounts it creates (logging, Cloud SQL login). The
# project IAM admin role could grant ANY role, so the binding carries a condition: the
# account may only ever grant or revoke the three roles in local.grantable_roles. It cannot
# grant itself, or anyone, owner, editor, or an admin role.
resource "google_project_iam_member" "deploy_iam_grants" {
  project = var.project_id
  role    = "roles/resourcemanager.projectIamAdmin"
  member  = "serviceAccount:${google_service_account.deploy.email}"

  condition {
    title       = "zenith-grantable-roles-only"
    description = "Limits role grants and revocations to the roles Zenith's drivers bind."
    expression  = "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([${join(", ", formatlist("'%s'", local.grantable_roles))}])"
  }
}

# Deploying a Cloud Run service or a scheduler job "as" a service account needs actAs on it.
# Unconditional unless service_account_name_prefix is set (see the README).
resource "google_project_iam_member" "deploy_act_as" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.deploy.email}"

  dynamic "condition" {
    for_each = var.service_account_name_prefix == "" ? [] : [1]
    content {
      title       = "zenith-service-accounts-only"
      description = "Act-as limited to service accounts whose id starts with the Zenith prefix."
      expression  = "resource.name.startsWith(\"projects/${var.project_id}/serviceAccounts/${var.service_account_name_prefix}-\")"
    }
  }
}

# --------------------------------------------------------------------------
# OpenTofu state bucket
# --------------------------------------------------------------------------

resource "google_storage_bucket" "state" {
  project  = var.project_id
  name     = local.state_bucket
  location = upper(var.region)

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  # State history is kept for 90 days after a version stops being current.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 90
      with_state                 = "ARCHIVED"
    }
  }

  # State is the record of everything Zenith built; deleting it must be deliberate.
  force_destroy = false

  depends_on = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "state_deploy" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_storage_bucket_iam_member" "state_observe" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.observe.email}"
}
