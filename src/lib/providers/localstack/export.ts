/**
 * The export bundle: the AWS provider's Terraform plus the one
 * LocalStack-specific override file that makes it apply locally. Split out of
 * the single-file adapter; the code is unchanged.
 */
import { LOCALSTACK_ENDPOINT, REGION } from "./clients";
import type { Environment, Manifest } from "@/lib/domain/types";
import type { ExportBundle } from "@/lib/providers/types";
import { terraformFiles, terraformReadme } from "@/lib/providers/aws/terraform";


/* --------------------------------- export ---------------------------------- */

export const OVERRIDE_FILE = `# providers_override.tf — the ONLY LocalStack-specific file.
#
# Terraform merges *_override.tf into the aws provider from providers.tf,
# pointing every service at LocalStack with throwaway credentials.
#
# >>> Moving to real AWS: DELETE THIS FILE and supply real credentials.
# >>> Nothing else in this bundle changes.
provider "aws" {
  access_key                  = "test"
  secret_key                  = "test"
  region                      = "${REGION}"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    s3             = "${LOCALSTACK_ENDPOINT}"
    sqs            = "${LOCALSTACK_ENDPOINT}"
    ses            = "${LOCALSTACK_ENDPOINT}"
    rds            = "${LOCALSTACK_ENDPOINT}"
    elasticache    = "${LOCALSTACK_ENDPOINT}"
    ecs            = "${LOCALSTACK_ENDPOINT}"
    ec2            = "${LOCALSTACK_ENDPOINT}"
    ecr            = "${LOCALSTACK_ENDPOINT}"
    iam            = "${LOCALSTACK_ENDPOINT}"
    logs           = "${LOCALSTACK_ENDPOINT}"
    route53        = "${LOCALSTACK_ENDPOINT}"
    acm            = "${LOCALSTACK_ENDPOINT}"
    elbv2          = "${LOCALSTACK_ENDPOINT}"
    sts            = "${LOCALSTACK_ENDPOINT}"
    cloudwatch     = "${LOCALSTACK_ENDPOINT}"
    events         = "${LOCALSTACK_ENDPOINT}"
  }
}
`;

export function exportBundle(env: Environment, manifest: Manifest): ExportBundle {
  const files = terraformFiles(env, manifest);
  files.unshift({ path: "providers_override.tf", content: OVERRIDE_FILE });
  const readme =
    terraformReadme(env, manifest) +
    `\n\n## LocalStack mode\n\nThis bundle was exported from a LocalStack environment. \`providers_override.tf\` points the AWS provider at ${LOCALSTACK_ENDPOINT}; with LocalStack running, \`terraform init && terraform apply\` provisions against your machine (Community edition applies the S3/SQS subset; Pro covers more).\n\n**Switching to real AWS is one step: delete \`providers_override.tf\` and run with real AWS credentials.** Every resource definition is identical between the two targets — that is Zenith's migration guarantee.\n`;
  return { files, readme };
}
