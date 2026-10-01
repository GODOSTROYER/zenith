/**
 * The AWS data group: data stores, secret containers, workload identities and
 * log groups. `awsDataDrivers` is what the provider-level
 * `drivers/index.ts` (owned by the orchestrator) concatenates and registers;
 * nothing here registers itself.
 *
 *   aws:rds_instance                   postgres, mysql (by `spec.engine`)
 *   aws:elasticache_replication_group  redis (IAM-authenticated; see its header)
 *   aws:s3_bucket                      object_store
 *   aws:sqs_queue                      queue (+ dead-letter queue)
 *   aws:secretsmanager_secret          secret container; values via `syncSecretValue`
 *   aws:iam_role                       identity (least-privilege grants, permissions boundary)
 *   aws:cloudwatch_log_group           log_group
 *
 * Every driver declares `contract` evidence only: compiled JSON is checked by
 * `tofu validate` against the pinned provider and every read is exercised
 * against a mocked SDK. None has been run against a real AWS account.
 */
import type { AwsSession } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import { cloudwatchLogGroupDriver } from "./cloudwatch-log-group";
import { elasticacheReplicationGroupDriver } from "./elasticache-replication-group";
import { iamRoleDriver } from "./iam-role";
import { rdsInstanceDriver } from "./rds-instance";
import { s3BucketDriver } from "./s3-bucket";
import { secretsManagerSecretDriver } from "./secretsmanager-secret";
import { sqsQueueDriver } from "./sqs-queue";

export const awsDataDrivers: ResourceDriver<AwsSession>[] = [
  rdsInstanceDriver,
  elasticacheReplicationGroupDriver,
  s3BucketDriver,
  sqsQueueDriver,
  secretsManagerSecretDriver,
  iamRoleDriver,
  cloudwatchLogGroupDriver,
];

export {
  cloudwatchLogGroupDriver,
  elasticacheReplicationGroupDriver,
  iamRoleDriver,
  rdsInstanceDriver,
  s3BucketDriver,
  secretsManagerSecretDriver,
  sqsQueueDriver,
};
export { syncSecretValue, secretSyncToken, type SecretSyncResult } from "./secretsmanager-sync";
export { GRANT_RULES } from "./iam-grants";
