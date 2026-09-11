/**
 * The endpoint, the throwaway credentials, the two SDK clients Zenith really
 * calls, and the names it derives for what they create. Split out of the
 * single-file adapter; the code is unchanged.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { env } from "@/lib/env";
import type { Environment } from "@/lib/domain/types";

export const LOCALSTACK_ENDPOINT = env().ORRERY_LOCALSTACK_ENDPOINT;

export const REGION = "us-east-1";
export const FAST = () => env().ORRERY_FAST;

export const PERMISSIONS = [
  `Talks only to LocalStack on this machine (${LOCALSTACK_ENDPOINT})`,
  'Uses the throwaway credentials "test"/"test" that LocalStack accepts',
  "Creates and reads S3 buckets and SQS queues for the environments you deploy",
  "Deletes a bucket or queue it created once you remove it from your system — and refuses, rather than destroying data, when the bucket still holds objects or the queue still holds messages, unless the environment allows stateful deletion",
  "Never contacts a real AWS account or the internet",
];

/* -------------------------------- clients --------------------------------- */

/**
 * LocalStack is on loopback, so a call that has not answered in a few seconds
 * is not slow — it is a container that died mid-deploy. Without these the SDK
 * defaults apply (no request timeout, 3 attempts with backoff) and a step can
 * hang the deployment indefinitely.
 */
export const clientConfig = {
  region: REGION,
  endpoint: LOCALSTACK_ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 2_000, requestTimeout: 8_000 },
};

export const s3 = () => new S3Client({ ...clientConfig, forcePathStyle: true });
export const sqs = () => new SQSClient(clientConfig);

/** Kinds this adapter provisions for real on LocalStack Community. */
export const REAL_KINDS = new Set(["object_store", "queue"]);

export const SIMULATED_NOTE: Record<string, string> = {
  postgres: "RDS is not in LocalStack Community — simulated locally, real on AWS",
  redis: "ElastiCache is not in LocalStack Community — simulated locally, real on AWS",
  email: "SES sending is limited in LocalStack Community — simulated locally, real on AWS",
};

export const bucketName = (name: string, env: Environment) =>
  `${name}-${env.id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60);
export const queueName = (name: string, env: Environment) =>
  `${name}-${env.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 75);
