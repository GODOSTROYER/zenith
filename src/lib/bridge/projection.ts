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

/** An unconfirmed start must not end steps, release the writer or replace worker progress. */
export function noteUnconfirmedDeployment(d: Deployment, error: string): void {
  if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return;
  d.error = error;
  save(d.projectId);
}

/**
 * Derive the product's "workflow started" fact from the platform authority.
 * A crash between an accepted Temporal start and the product save leaves the
 * deployment without `workflowStartedAt` while the retained start intent is
 * acknowledged; this repairs the projection, never the authority. It never
 * touches steps, status or the active writer (the worker owns those).
 */
export function projectAcknowledgedStart(deploymentId: string, observedStartAt: string): boolean {
  const d = q.deployment(deploymentId);
  if (!d || d.workflowStartedAt || ["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return false;
  d.workflowStartedAt = observedStartAt;
  save(d.projectId);
  return true;
}
