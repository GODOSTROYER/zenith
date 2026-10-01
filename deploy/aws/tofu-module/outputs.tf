output "observe_role_arn" {
  description = "Give this to Zenith as the observe role ARN."
  value       = aws_iam_role.observe.arn
}

output "deploy_role_arn" {
  description = "Give this to Zenith as the deploy role ARN."
  value       = aws_iam_role.deploy.arn
}

output "secret_writer_role_arn" {
  description = "Give this to Zenith as secretWriterRoleArn, separate from deployRoleArn."
  value       = aws_iam_role.secret_writer.arn
}

output "state_bucket_name" {
  description = "Bucket for OpenTofu state and build artifacts."
  value       = aws_s3_bucket.state.bucket
}

output "codebuild_role_arn" {
  description = "Service role for Zenith CodeBuild projects."
  value       = aws_iam_role.codebuild.arn
}

output "workload_boundary_arn" {
  description = "Permission boundary every Zenith-created role must carry."
  value       = aws_iam_policy.workload_boundary.arn
}

output "oidc_provider_arn" {
  description = "The IAM OIDC provider the trust policies reference (empty when only AssumeRole mode is used)."
  value       = local.has_oidc ? local.oidc_provider_arn : ""
}

output "account_id" {
  description = "The AWS account id this module was applied to."
  value       = local.account_id
}

output "region" {
  description = "The region of the state bucket."
  value       = local.region
}
