/**
 * The vocabulary the Deploys screen and its list share: what a status is
 * called, which dot it gets, and which of them are still running. Pure — the
 * list, the detail header and the filter all read the same tables.
 */
import type { DotStatus } from "@/components/ui/status-dot";
import type { Deployment, DeploymentStatus } from "@/lib/domain/types";

export const STREAM_EVENTS = ["status", "step", "log", "output"];

export const PAGE_SIZE = 50;

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "rolled_back", "cancelled"];

export const STATUS_DOT: Record<DeploymentStatus, DotStatus> = {
  planning: "running",
  awaiting_approval: "warn",
  applying: "running",
  verifying: "running",
  succeeded: "ok",
  failed: "err",
  rolling_back: "running",
  rolled_back: "warn",
  cancelled: "idle",
};

export const STATUS_LABEL: Record<DeploymentStatus, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting approval",
  applying: "Applying",
  verifying: "Verifying",
  succeeded: "Succeeded",
  failed: "Failed",
  rolling_back: "Rolling back",
  rolled_back: "Rolled back",
  cancelled: "Cancelled",
};

export const isLive = (s: DeploymentStatus) => !TERMINAL.includes(s);

/** One page of `GET /api/environments/:id/deployments`. */
export interface DeploymentPage {
  deployments: Deployment[];
  /** how many match the filter in total — so the count on screen is honest */
  total: number;
  nextCursor?: string;
}

/** The endpoint's own vocabulary, so the filter needs no translation table. */
export type StatusFilter = "all" | "live" | "terminal";

export const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "deployment",
  live: "deployment in flight",
  terminal: "finished deployment",
};
