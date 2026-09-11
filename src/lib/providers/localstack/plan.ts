/**
 * Manifest → the ordered steps a LocalStack deployment runs. Split out of the
 * single-file adapter; the code is unchanged.
 */
import { LOCALSTACK_ENDPOINT, SIMULATED_NOTE, bucketName, queueName } from "./clients";
import { teardownSteps } from "./teardown";
import type { Environment, Manifest } from "@/lib/domain/types";
import type { ProviderPlanStep } from "@/lib/providers/types";


/* ---------------------------------- plan ----------------------------------- */

export function planSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[] {
  const steps: ProviderPlanStep[] = [];
  const managed = <T extends { ownership: string }>(xs: T[]) =>
    xs.filter((x) => x.ownership === "managed");
  const had = (nodeId: string) =>
    !!previous && [...previous.services, ...previous.resources].some((n) => n.id === nodeId);

  steps.push({
    phase: "prepare",
    title: "Check LocalStack health and enabled services",
    targetId: "",
    estMs: 1500,
    detail: `GET ${LOCALSTACK_ENDPOINT}/_localstack/health`,
  });

  for (const r of managed(next.resources)) {
    if (r.kind === "object_store") {
      steps.push({
        phase: "provision",
        title: `${had(r.id) ? "Reconcile" : "Create"} S3 bucket "${bucketName(r.name, env)}" in LocalStack`,
        targetId: r.id,
        estMs: 2500,
        detail: `s3:CreateBucket via ${LOCALSTACK_ENDPOINT}`,
      });
    } else if (r.kind === "queue") {
      steps.push({
        phase: "provision",
        title: `${had(r.id) ? "Reconcile" : "Create"} SQS queue "${queueName(r.name, env)}" in LocalStack`,
        targetId: r.id,
        estMs: 2000,
        detail: `sqs:CreateQueue via ${LOCALSTACK_ENDPOINT}`,
      });
    } else {
      steps.push({
        phase: "provision",
        title: `Simulate ${r.kind} "${r.name}" locally`,
        targetId: r.id,
        estMs: 3000,
        detail: SIMULATED_NOTE[r.kind] ?? "simulated locally",
      });
    }
  }

  for (const s of managed(next.services)) {
    steps.push({
      phase: "release",
      title: `Simulate ${s.kind === "cron" ? "schedule" : "rollout"} of ${s.name} locally`,
      targetId: s.id,
      estMs: s.kind === "web" ? 5000 : 3000,
      detail: "ECS is not in LocalStack Community — simulated locally, real on AWS",
    });
  }

  for (const route of next.routes) {
    steps.push({
      phase: "release",
      title: `Simulate routing ${route.host} locally`,
      targetId: route.id,
      estMs: 2000,
      detail: "ALB/Route 53 are not in LocalStack Community — simulated locally, real on AWS",
    });
  }

  // Everything the previous revision managed and this one drops — last of the
  // mutating work, so a removal never races a create that still needs it.
  steps.push(...teardownSteps(env, next, previous));

  steps.push({
    phase: "verify",
    title: "Verify LocalStack resources and record outputs",
    targetId: "",
    estMs: 2000,
    detail: "HeadBucket / GetQueueUrl round-trips",
  });

  return steps;
}
