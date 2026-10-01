# Offline tests: the AWS provider is mocked, so nothing here talks to AWS.
# They prove the module plans, that every policy template renders to valid JSON
# with all substitutions resolved, and the shape of the trust policies.
#
#   cd deploy/aws/tofu-module && tofu init -backend=false && tofu test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "ap-south-1" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
}

variables {
  zenith_issuer_host  = "app.example.com/api/oidc"
  zenith_oidc_subject = "zenith:ws:ws_1:conn:conn_1"
}

run "oidc_only_defaults" {
  command = plan

  assert {
    condition     = length(aws_iam_openid_connect_provider.zenith) == 1
    error_message = "the OIDC provider should be created by default"
  }

  assert {
    condition = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["app.example.com/api/oidc:sub"] == "zenith:ws:ws_1:conn:conn_1"
    error_message = "the trust policy must pin the exact subject"
  }

  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["app.example.com/api/oidc:aud"] == "sts.amazonaws.com"
    error_message = "the trust policy must pin the audience"
  }

  assert {
    condition     = [for s in jsondecode(aws_iam_role.deploy.assume_role_policy).Statement : s.Sid] == ["ZenithOidc", "ZenithOidcTagSession"]
    error_message = "only the OIDC statements should exist without a principal ARN"
  }

  assert {
    condition     = aws_s3_bucket.state.bucket == "zenith-state-123456789012-ap-south-1"
    error_message = "unexpected state bucket name"
  }

  assert {
    condition     = alltrue([for p in concat([aws_iam_policy.workload_boundary.policy], [for k, v in aws_iam_policy.zenith : v.policy]) : !strcontains(p, "$${")])
    error_message = "unresolved template variables in a policy"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_policy.zenith["deploy-state"].policy).Statement : s if s.Sid == "StateKmsKey"]) == 0
    error_message = "no KMS statement without a key"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_policy.zenith["deploy-edge"].policy).Statement : s if s.Sid == "Route53ChangeRecordsInListedZones"]) == 0
    error_message = "no Route53 write access without listed zones"
  }
}

run "assume_role_kms_and_dns" {
  command = plan

  variables {
    create_oidc_provider     = false
    zenith_principal_arn     = "arn:aws:iam::210987654321:role/zenith-control"
    external_id              = "zx-0123456789abcdef"
    state_bucket_kms_key_arn = "arn:aws:kms:ap-south-1:123456789012:key/11111111-2222-3333-4444-555555555555"
    route53_hosted_zone_arns = ["arn:aws:route53:::hostedzone/Z0123456789ABC"]
    name_suffix              = "-team-a"
    environment_tag_value    = "env_prod1"
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.zenith) == 0
    error_message = "create_oidc_provider=false must not create a provider"
  }

  assert {
    condition     = [for s in jsondecode(aws_iam_role.observe.assume_role_policy).Statement : s.Sid] == ["ZenithOidc", "ZenithOidcTagSession", "ZenithAssumeRole", "ZenithTagSession"]
    error_message = "OIDC (2) + AssumeRole + TagSession statements expected"
  }

  assert {
    condition     = jsondecode(aws_iam_role.observe.assume_role_policy).Statement[2].Condition.StringEquals["sts:ExternalId"] == "zx-0123456789abcdef"
    error_message = "AssumeRole must require the ExternalId"
  }

  assert {
    condition     = aws_iam_role.deploy.name == "ZenithDeployRole-team-a" && aws_s3_bucket.state.bucket == "zenith-state-123456789012-ap-south-1-team-a"
    error_message = "the suffix must apply to role and bucket names"
  }

  assert {
    condition     = length([for s in jsondecode(aws_iam_policy.zenith["deploy-state"].policy).Statement : s if s.Sid == "StateKmsKey"]) == 1
    error_message = "KMS statement expected with a key"
  }

  assert {
    condition     = one([for s in jsondecode(aws_iam_policy.zenith["deploy-edge"].policy).Statement : s.Resource if s.Sid == "Route53ChangeRecordsInListedZones"]) == ["arn:aws:route53:::hostedzone/Z0123456789ABC"]
    error_message = "Route53 writes must be limited to the listed zones"
  }

  assert {
    condition     = length(regexall("env_prod1", aws_iam_policy.zenith["deploy-network"].policy)) > 0
    error_message = "the environment tag scope must appear in the deploy policy"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_server_side_encryption_configuration.state.rule : one(r.apply_server_side_encryption_by_default).sse_algorithm]) == "aws:kms"
    error_message = "SSE-KMS expected with a key"
  }
}

run "requires_some_trust" {
  command = plan

  variables {
    zenith_issuer_host  = ""
    zenith_oidc_subject = ""
  }

  expect_failures = [aws_iam_role.observe]
}

run "rejects_wildcard_subject" {
  command = plan

  variables {
    zenith_oidc_subject = "zenith:ws:*:conn:*"
  }

  expect_failures = [var.zenith_oidc_subject]
}
