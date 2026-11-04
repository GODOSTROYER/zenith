/**
 * `aws:ecs_service` — a long-running container workload on ECS Fargate.
 *
 * Kind `container_service`. See `ecs-task.ts` (task plumbing and its
 * decisions), `ecs-service-compile.ts` (the service), `ecs-read.ts`
 * (observe / runtime / verify / discover) and `ecs-operations.ts`
 * (restart / scale / deployImage).
 *
 * Evidence: `contract` for everything. `compile` is additionally checked with
 * a real `tofu validate` against hashicorp/aws 6.66.0 (argument names and
 * types), which proves the JSON is a valid configuration, not that an apply
 * would succeed; no AWS account was used.
 */
import type { AwsSession } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import { compileEcsService, expectedEcsService } from "./ecs-service-compile";
import { ecsDiscover, ecsObserve, ecsRuntime, ecsVerify } from "./ecs-read";
import { ecsOperations } from "./ecs-operations";
import { DRIVER_IDS } from "./types";

export const ecsServiceDriver: ResourceDriver<AwsSession> = {
  id: DRIVER_IDS.ecsService,
  provider: "aws",
  kind: "container_service",
  nativeType: "aws:ecs_service",
  capabilities: {
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: true,
    operations: Object.keys(ecsOperations),
    evidence: {
      compile: "contract",
      observe: "contract",
      runtime: "contract",
      verify: "contract",
      discover: "contract",
      "service.restart": "contract",
      "service.scale": "contract",
      "deployment.deploy": "contract",
    },
  },
  compile: compileEcsService,
  observe: ecsObserve,
  runtime: ecsRuntime,
  verify: ecsVerify,
  discover: ecsDiscover,
  expectedAttributes: expectedEcsService,
  operations: ecsOperations,
};
