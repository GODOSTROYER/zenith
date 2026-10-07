# Zenith connection - OpenTofu equivalent of deploy/aws/zenith-connection.cfn.yaml.
#
# Creates keyless (OIDC) trust for one Zenith workspace + connection, a
# read-only observe role, a tag- and name-scoped deploy role whose IAM reach is
# limited to roles carrying a permission boundary, a private versioned state
# bucket, and a CodeBuild role. No access keys, no secrets, no passwords.
#
# Permissions live in policies/*.json.tftpl. Those files are GENERATED from the
# CloudFormation template (deploy/aws/tools/generate-tofu-policies.ts) so the
# two artifacts cannot drift; do not edit them by hand.
#
# Revoke Zenith: `tofu destroy` (the state bucket is only removed if it is
# empty - your state is not deleted implicitly), or delete the IAM OIDC
# provider / the two roles by hand. See deploy/aws/README.md.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  has_oidc         = var.zenith_issuer_host != ""
  has_assume_role  = var.zenith_principal_arn != ""
  has_kms_key      = var.state_bucket_kms_key_arn != ""
  has_hosted_zones = length(var.route53_hosted_zone_arns) > 0

  # IAM caps a managed policy at 6,144 characters and a role at 10 managed
  # policies. The first 20 zones live in ZenithDeployEdge; any further zones are
  # split into overflow policies of 40, attached to the deploy role (8 + 2 = 10).
  # The literals mirror src/lib/credentials/aws/limits.ts (a test pins them).
  dns_zones_inline   = slice(var.route53_hosted_zone_arns, 0, min(length(var.route53_hosted_zone_arns), 20))
  dns_zones_overflow = length(var.route53_hosted_zone_arns) > 20 ? chunklist(slice(var.route53_hosted_zone_arns, 20, length(var.route53_hosted_zone_arns)), 40) : []

  bootstrap_tags = merge(var.tags, { "zenith:bootstrap" = "true" })

  # Names are deterministic so policy documents can reference them without
  # depending on the resources they protect (no dependency cycles).
  state_bucket_name = "zenith-state-${local.account_id}-${local.region}${var.name_suffix}"
  state_bucket_arn  = "arn:${local.partition}:s3:::${local.state_bucket_name}"
  boundary_name     = "ZenithWorkloadBoundary${var.name_suffix}"
  boundary_arn      = "arn:${local.partition}:iam::${local.account_id}:policy/${local.boundary_name}"
  oidc_provider_arn = "arn:${local.partition}:iam::${local.account_id}:oidc-provider/${var.zenith_issuer_host}"

  family_boundaries = {
    app        = { name = "ZenithAppBoundary", file = "app-boundary" }
    build      = { name = "ZenithBuildBoundary", file = "build-boundary" }
    machine    = { name = "ZenithMachineBoundary", file = "machine-boundary" }
    scheduler  = { name = "ZenithSchedulerBoundary", file = "scheduler-boundary" }
    eksCluster = { name = "ZenithEksClusterBoundary", file = "eks-cluster-boundary" }
    eksNode    = { name = "ZenithEksNodeBoundary", file = "eks-node-boundary" }
  }
  family_boundary_arns = { for key, spec in local.family_boundaries : key => "arn:${local.partition}:iam::${local.account_id}:policy/${spec.name}${var.name_suffix}" }

  policy_vars = merge({
    partition                = local.partition
    dns_suffix               = data.aws_partition.current.dns_suffix
    account_id               = local.account_id
    region                   = local.region
    state_bucket             = local.state_bucket_name
    state_bucket_arn         = local.state_bucket_arn
    boundary_arn             = local.boundary_arn
    environment_tag_value    = var.environment_tag_value
    kms_key_arn              = var.state_bucket_kms_key_arn
    route53_hosted_zone_arns = local.dns_zones_inline
  }, { for key, arn in local.family_boundary_arns : "${key}_boundary_arn" => arn })

  optional = jsondecode(templatefile("${path.module}/policies/optional-statements.json.tftpl", local.policy_vars))

  policy_docs = {
    observe          = { name = "ZenithObservePolicy${var.name_suffix}", desc = "Read-only access for Zenith (describe, list, get). No secret values." }
    deploy-network   = { name = "ZenithDeployNetwork${var.name_suffix}", desc = "Zenith deploy role - VPC and EC2 resources tagged zenith:managed." }
    deploy-balancing = { name = "ZenithDeployBalancing${var.name_suffix}", desc = "Zenith deploy role - load balancers, target groups, auto scaling groups, EC2 instance profiles, ElastiCache users and image pointer parameters named zenith-*." }
    deploy-compute   = { name = "ZenithDeployCompute${var.name_suffix}", desc = "Zenith deploy role - ECS, ECR, Lambda, EventBridge rules and CodeBuild projects named zenith-*." }
    deploy-data      = { name = "ZenithDeployData${var.name_suffix}", desc = "Zenith deploy role - RDS, ElastiCache, S3 buckets, SQS and secret containers named zenith-*." }
    deploy-edge      = { name = "ZenithDeployEdge${var.name_suffix}", desc = "Zenith deploy role - log groups and alarms named zenith-*, certificates, keys and CloudFront distributions tagged zenith:managed, DNS records in listed zones." }
    deploy-state     = { name = "ZenithDeployState${var.name_suffix}", desc = "Zenith deploy role - OpenTofu state and artifacts in the state bucket; cannot reconfigure or empty it." }
    deploy-iam       = { name = "ZenithDeployIam${var.name_suffix}", desc = "Zenith deploy role - bounded IAM for zenith-* roles, PassRole, and self-protection denies." }
  }

  # Statements that exist only when an optional feature is on (KMS key, DNS zones).
  policy_extras = {
    observe          = [for s in local.optional.observe_kms : s if local.has_kms_key]
    deploy-network   = []
    deploy-balancing = []
    deploy-compute   = []
    deploy-data      = []
    deploy-edge      = [for s in local.optional.route53 : s if local.has_hosted_zones]
    deploy-state     = [for s in local.optional.state_kms : s if local.has_kms_key]
    deploy-iam       = []
  }

  policy_documents = {
    for key, spec in local.policy_docs : key => jsonencode({
      Version = "2012-10-17"
      Statement = concat(
        jsondecode(templatefile("${path.module}/policies/${key}.json.tftpl", local.policy_vars)).Statement,
        local.policy_extras[key]
      )
    })
  }

  # Shared by both roles. `for ... if` (rather than `cond ? [...] : []`) because
  # the two branches would otherwise have different tuple types.
  trust_statements = concat(
    [for s in [{
      Sid       = "ZenithOidc"
      Effect    = "Allow"
      Principal = { Federated = local.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${var.zenith_issuer_host}:aud" = "sts.amazonaws.com"
          "${var.zenith_issuer_host}:sub" = var.zenith_oidc_subject
        }
        StringLike = { "sts:RoleSessionName" = "zenith-*" }
      }
      },
      {
        Sid       = "ZenithOidcTagSession"
        Effect    = "Allow"
        Principal = { Federated = local.oidc_provider_arn }
        Action    = "sts:TagSession"
        Condition = {
          StringEquals = {
            "${var.zenith_issuer_host}:aud" = "sts.amazonaws.com"
            "${var.zenith_issuer_host}:sub" = var.zenith_oidc_subject
          }
        }
    }] : s if local.has_oidc],
    [for s in [
      {
        Sid       = "ZenithAssumeRole"
        Effect    = "Allow"
        Principal = { AWS = var.zenith_principal_arn }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "sts:ExternalId" = var.external_id }
          StringLike   = { "sts:RoleSessionName" = "zenith-*" }
        }
      },
      {
        Sid       = "ZenithTagSession"
        Effect    = "Allow"
        Principal = { AWS = var.zenith_principal_arn }
        Action    = "sts:TagSession"
      },
    ] : s if local.has_assume_role],
  )

  trust_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.trust_statements
  })
}

# ------------------------------------------------------------------ OIDC
# IAM fetches <issuer>/.well-known/openid-configuration and the JWKS itself;
# the issuer must be reachable over public HTTPS. thumbprint_list is omitted:
# IAM validates providers on public CAs with its own trusted CA library.
resource "aws_iam_openid_connect_provider" "zenith" {
  count = local.has_oidc && var.create_oidc_provider ? 1 : 0

  url            = "https://${var.zenith_issuer_host}"
  client_id_list = ["sts.amazonaws.com"]
  tags           = local.bootstrap_tags
}

# ---------------------------------------------------------- state bucket
# OpenTofu state and build artifacts. Versioned, private, encrypted, TLS only.
# NOT tagged zenith:managed, so the deploy role cannot reconfigure or delete it
# (and is explicitly denied in the deploy-state policy as well).
resource "aws_s3_bucket" "state" {
  bucket        = local.state_bucket_name
  force_destroy = false
  tags          = local.bootstrap_tags
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    bucket_key_enabled = local.has_kms_key ? true : null

    apply_server_side_encryption_by_default {
      sse_algorithm     = local.has_kms_key ? "aws:kms" : "AES256"
      kms_master_key_id = local.has_kms_key ? var.state_bucket_kms_key_arn : null
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 180
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyTlsBelow12"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        Condition = { NumericLessThan = { "s3:TlsVersion" = "1.2" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}

# ------------------------------------------------- permission boundaries
# Family policies intersect driver role policies and enforce reserved principals.
# naming.ts centralizes selection; the generator verifies principal patterns.
resource "aws_iam_policy" "family_boundary" {
  for_each    = local.family_boundaries
  name        = "${each.value.name}${var.name_suffix}"
  description = "Permission boundary for Zenith ${each.key} roles. Do not edit; Zenith cannot."
  policy      = templatefile("${path.module}/policies/${each.value.file}.json.tftpl", local.policy_vars)
}

# Retain the legacy policy during migration; the deploy role cannot select it.
resource "aws_iam_policy" "workload_boundary" {
  name        = local.boundary_name
  description = "Permission boundary for roles created by Zenith. Do not edit; Zenith cannot."
  policy      = templatefile("${path.module}/policies/workload-boundary.json.tftpl", local.policy_vars)
  tags        = local.bootstrap_tags
}

# ------------------------------------------------------------ policies
resource "aws_iam_policy" "zenith" {
  for_each = local.policy_docs

  name        = each.value.name
  description = each.value.desc
  policy      = local.policy_documents[each.key]
  tags        = local.bootstrap_tags
}

# ---------------------------------------------------------------- roles
resource "aws_iam_role" "observe" {
  name                 = "ZenithObserveRole${var.name_suffix}"
  description          = "Read-only role assumed by Zenith to inspect this account."
  max_session_duration = 3600
  assume_role_policy   = local.trust_policy
  tags                 = local.bootstrap_tags

  lifecycle {
    precondition {
      condition     = local.has_oidc || local.has_assume_role
      error_message = "Set zenith_issuer_host (OIDC) or zenith_principal_arn (AssumeRole); otherwise nobody can assume the roles."
    }
    precondition {
      condition     = !local.has_oidc || var.zenith_oidc_subject != ""
      error_message = "zenith_oidc_subject is required with zenith_issuer_host."
    }
    precondition {
      condition     = !local.has_assume_role || var.external_id != ""
      error_message = "external_id is required with zenith_principal_arn."
    }
  }

  depends_on = [aws_iam_openid_connect_provider.zenith]
}

resource "aws_iam_role" "deploy" {
  name                 = "ZenithDeployRole${var.name_suffix}"
  description          = "Role assumed by Zenith to change resources tagged zenith:managed. Bounded; cannot modify itself."
  max_session_duration = 3600
  assume_role_policy   = local.trust_policy
  tags                 = local.bootstrap_tags

  depends_on = [aws_iam_openid_connect_provider.zenith]
}

resource "aws_iam_role" "secret_writer" {
  name                 = "ZenithSecretWriterRole${var.name_suffix}"
  description          = "Brokered secret.write only; exact per-node session policy required by Zenith."
  max_session_duration = 3600
  assume_role_policy   = local.trust_policy
  tags                 = local.bootstrap_tags

  depends_on = [aws_iam_openid_connect_provider.zenith]
}

resource "aws_iam_role_policy" "secret_writer" {
  name   = "ZenithSecretWriter"
  role   = aws_iam_role.secret_writer.id
  policy = templatefile("${path.module}/policies/secret-writer.json.tftpl", local.policy_vars)
}

# Hosted zones beyond the inline 20 get their own managed policies, each with only
# the same Route53 record-change statement over its own chunk of zones.
resource "aws_iam_policy" "dns_overflow" {
  count = length(local.dns_zones_overflow)

  name        = "ZenithDeployEdgeDns${count.index + 1}${var.name_suffix}"
  description = "Zenith deploy role - DNS records in additional listed zones (overflow ${count.index + 1})."
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [merge(local.optional.route53[0], { Resource = local.dns_zones_overflow[count.index] })]
  })
  tags = local.bootstrap_tags
}

resource "aws_iam_role_policy_attachment" "dns_overflow" {
  count = length(local.dns_zones_overflow)

  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.dns_overflow[count.index].arn
}

resource "aws_iam_role_policy_attachment" "observe" {
  role       = aws_iam_role.observe.name
  policy_arn = aws_iam_policy.zenith["observe"].arn
}

resource "aws_iam_role_policy_attachment" "deploy" {
  # The deploy role also reads: OpenTofu refreshes before it plans.
  for_each = toset(["observe", "deploy-network", "deploy-balancing", "deploy-compute", "deploy-data", "deploy-edge", "deploy-state", "deploy-iam"])

  role       = aws_iam_role.deploy.name
  policy_arn = aws_iam_policy.zenith[each.key].arn
}

# ---------------------------------------------------- CodeBuild service role
# Builds run in YOUR account. Lower-case name so the deploy role may pass it to
# zenith-* CodeBuild projects; the deploy role is explicitly denied any change
# to it.
resource "aws_iam_role" "codebuild" {
  name                 = "zenith-codebuild${var.name_suffix}"
  description          = "Service role for Zenith CodeBuild projects (image builds)."
  max_session_duration = 3600
  tags                 = local.bootstrap_tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "codebuild" {
  name = "zenith-codebuild-build"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      jsondecode(templatefile("${path.module}/policies/codebuild.json.tftpl", local.policy_vars)).Statement,
      [for s in local.optional.codebuild_kms : s if local.has_kms_key]
    )
  })
}
