/**
 * LocalStack provider — AWS emulated on your own machine.
 *
 * The point of this adapter is the migration story: it shares the AWS
 * provider's plan shapes and Terraform generator, so "switch to real AWS
 * later" means deleting one override file and supplying real credentials —
 * nothing else in Zenith changes.
 *
 * Honesty contract:
 *  - S3 buckets and SQS queues are created FOR REAL against LocalStack's
 *    edge endpoint (http://localhost:4566) with the AWS SDK.
 *  - Kinds LocalStack Community cannot emulate (RDS, ElastiCache, ECS, ALB)
 *    are locally simulated, and every such step's title says so.
 *  - Removing a bucket or queue from your system DELETES it in LocalStack, in
 *    the same deployment, or the deployment fails. It never reports a
 *    convergence it did not reach (see `teardownSteps`).
 *  - Preflight talks to the real health endpoint and names the fix when
 *    Docker or LocalStack isn't running.
 *
 * The adapter object only; its parts live in the sibling modules.
 */
import type { ProviderAdapter } from "@/lib/providers/types";
import { PERMISSIONS, REGION } from "./clients";
import { preflight, probe } from "./health";
import { planSteps } from "./plan";
import { executeStep } from "./execute";
import { discover, observe, verify } from "./observe";
import { exportBundle } from "./export";


/* --------------------------------- adapter ---------------------------------- */

export const localstackProvider: ProviderAdapter = {
  id: "localstack",
  displayName: "LocalStack",
  availability: "available",
  tagline:
    "Real S3 buckets and SQS queues against a reachable LocalStack endpoint. Application services, routes and other emulated behavior remain labeled simulations. Requires Docker + LocalStack running.",
  regions: [{ id: REGION, label: `${REGION} (emulated locally)` }],

  accessExplanation: () => ({
    summary:
      "Zenith uses throwaway test credentials against the configured LocalStack endpoint for supported S3 and SQS operations. This does not verify an AWS identity. Data persistence depends on how you configured LocalStack.",
    permissions: PERMISSIONS,
  }),

  preflight,
  probe,
  planSteps,
  executeStep,
  observe,
  verify,
  discover,
  exportBundle,
};
