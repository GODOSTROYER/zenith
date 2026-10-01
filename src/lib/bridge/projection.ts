/** Product projections before a workflow starts. The worker owns progress after start. */
import { appendEvent, isPostgres, q, readEvents, save } from "@/lib/db/store";
import { nextEventSeq } from "@/lib/db/pg/history";
import type { Deployment, DeploymentEvent, DeploymentStatus } from "@/lib/domain/types";

type EventBody = DeploymentEvent extends infer E ? E extends DeploymentEvent ? Omit<E, "ts" | "seq" | "deploymentId"> : never : never;
export function appendDeploymentEvent(deploymentId: string, body: EventBody): void {
  const seq = isPostgres() ? nextEventSeq(deploymentId) : readEvents(deploymentId).reduce((max, e) => Math.max(max, e.seq + 1), 0);
  appendEvent({ ...body, deploymentId, seq, ts: new Date().toISOString() } as DeploymentEvent);
}

export function setProjectedStatus(d: Deployment, status: DeploymentStatus, error?: string): void {
  d.status = status;
  if (error) d.error = error;
  if (["succeeded", "failed", "cancelled", "rolled_back"].includes(status)) d.endedAt = new Date().toISOString();
  appendDeploymentEvent(d.id, { type: "status", status });
  save(d.projectId);
}

export function finishUnstartedDeployment(d: Deployment, status: "failed" | "cancelled", error?: string): void {
  for (const step of d.steps) {
    if (step.status !== "pending") continue;
    step.status = "skipped";
    step.endedAt = new Date().toISOString();
    appendDeploymentEvent(d.id, { type: "step", stepId: step.id, status: "skipped" });
  }
  const env = q.environment(d.environmentId);
  if (env?.activeDeploymentId === d.id) env.activeDeploymentId = undefined;
  setProjectedStatus(d, status, error);
}
export const failDeployment = (d: Deployment, error: string): void => finishUnstartedDeployment(d, "failed", error);
