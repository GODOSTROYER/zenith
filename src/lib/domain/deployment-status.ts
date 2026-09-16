/**
 * Which deployment status may follow which. Pure, shared by the event stream
 * route and every screen that merges streamed events over a stored record.
 *
 * The event log is append-only and is not guarded by the deployment row's
 * version. When two instances advance the same deployment (the dispatching
 * request and a scheduler pass), the one that loses the row's version guard
 * has still appended its events, so a stale `verifying` can sit in the log
 * after `succeeded`. The row is the authority; a status that cannot follow the
 * current one is stale and is ignored.
 */
import type { DeploymentStatus } from "./types";

export const TERMINAL_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled",
];

export const isTerminalDeploymentStatus = (status: DeploymentStatus): boolean =>
  TERMINAL_DEPLOYMENT_STATUSES.includes(status);

/**
 * True when `next` is a transition the engine can make from `current`.
 *
 * - An in-flight phase can move to anything.
 * - `succeeded` and `failed` can only start a rollback.
 * - `rolling_back` can only end, as `rolled_back` or `failed`.
 * - `rolled_back` and `cancelled` are final.
 */
export function followsStatus(current: DeploymentStatus, next: DeploymentStatus): boolean {
  if (current === next) return true;
  switch (current) {
    case "succeeded":
    case "failed":
      return next === "rolling_back";
    case "rolling_back":
      return next === "rolled_back" || next === "failed";
    case "rolled_back":
    case "cancelled":
      return false;
    default:
      return true;
  }
}
