/**
 * `k8s:Deployment` — container_service and (prebuilt-image) static_site.
 *
 * Operations: service.restart, service.scale, deployment.rollback,
 * container.logs, events.read. Evidence is `contract` for all of it.
 */
import type { VerificationCheck } from "@/lib/drivers/types";
import type { Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { readEvents, readLogs, restartWorkload, rollbackWorkload, scaleWorkload } from "../../ops";
import { workloadExpectations } from "../../renderers/workload";
import { dig } from "../../util";
import { compact, containerAttributes, safeExpected } from "../attrs";
import { podBasedRuntime } from "../runtime";
import { makeKubernetesDriver, type KindDef } from "../shared";

/** Shared by Deployment and StatefulSet: did the rollout finish and are the replicas serving? */
export function rolloutChecks(_node: ResourceNode, _observation: Observation, runtime?: RuntimeState): VerificationCheck[] {
  const c = runtime?.counts;
  const have = runtime !== undefined && c !== undefined && typeof c.desired === "number";
  const inProgress = runtime?.signals.some((s) => s === "rollout_in_progress" || s === "rollout_deadline_exceeded" || s === "rollout_failed");
  return [
    {
      id: "rollout_complete",
      description: "the rollout has finished",
      passed: !have ? "unknown" : !inProgress && (c.updated ?? 0) >= c.desired,
      detail: have && inProgress ? "rollout is still in progress or failed" : undefined,
    },
    {
      id: "ready",
      description: "all desired replicas are ready",
      passed: !have ? "unknown" : c.desired > 0 && (c.ready ?? 0) >= c.desired,
      detail: have ? `${c.ready ?? 0} of ${c.desired} ready` : undefined,
    },
  ];
}

export const deploymentDef: KindDef = {
  suffix: "deployment",
  nativeType: "k8s:Deployment",
  kind: "Deployment",
  portable: ["container_service", "static_site"],
  attributes: (live) => {
    const replicas = dig(live, "spec", "replicas");
    return { replicas: typeof replicas === "number" ? replicas : undefined, ...containerAttributes(dig(live, "spec", "template", "spec", "containers", 0)) };
  },
  expected: safeExpected(workloadExpectations),
  summary: (live) => {
    const c = containerAttributes(dig(live, "spec", "template", "spec", "containers", 0));
    return compact({ image: c.image, replicas: dig(live, "spec", "replicas"), port: c.port });
  },
  runtime: podBasedRuntime,
  extraChecks: rolloutChecks,
  operations: {
    "service.restart": (ctx, node) => restartWorkload(ctx, node),
    "service.scale": (ctx, node, input) => scaleWorkload(ctx, node, input),
    "deployment.rollback": (ctx, node, input) => rollbackWorkload(ctx, node, input),
    "container.logs": (ctx, node, input) => readLogs(ctx, node, input),
    "events.read": (ctx, node, input) => readEvents(ctx, node, input),
  },
};

export const deploymentDriver = makeKubernetesDriver(deploymentDef);
