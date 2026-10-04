"use client";
/** Read-only routing metadata; the platform page and broker own every decision. */
import { useJson } from "@/lib/client/api";
import type { OperationDetail } from "@/lib/capabilities/operations";
import type { Deployment } from "@/lib/domain/types";

interface ReviewScope {
  workspaceId?: string;
  projectId?: string;
  environmentId?: string;
}
type ApprovalRoute =
  | { kind: "legacy" | "initial" }
  | { kind: "plan"; href: string }
  | { kind: "unavailable"; loading: boolean; refresh: () => void };

const validId = (value: string | undefined, max = 100): value is string => typeof value === "string" && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

/** A missing, stale or foreign native read never falls back to product approval. */
export function useOperationApprovalRoute(deployment: Deployment | undefined, scope: ReviewScope): ApprovalRoute {
  const native = Boolean(deployment && (deployment.executor === "workflow" || deployment.operationId !== undefined));
  const scoped = deployment && validId(scope.workspaceId) && validId(scope.projectId) && validId(scope.environmentId)
    && deployment.projectId === scope.projectId && deployment.environmentId === scope.environmentId;
  const operationId = deployment?.operationId;
  const url = native && scoped && deployment?.status === "awaiting_approval" && !deployment.error && validId(operationId, 200)
    ? `/api/platform/v1/operations/${encodeURIComponent(operationId)}?workspace=${encodeURIComponent(scope.workspaceId!)}`
    : null;
  const { data, error, loading, refresh } = useJson<Pick<OperationDetail, "operation">>(url, 1500);
  if (deployment && !native) return { kind: "legacy" };
  const unavailable: ApprovalRoute = { kind: "unavailable", loading: Boolean(url && loading), refresh };
  if (!url || loading || error) return unavailable;
  const op = data?.operation;
  const input = op?.proposal?.input;
  const proposalScope = op?.proposal?.scope;
  const round = op?.approvalRound;
  if (!op || op.id !== operationId || op.workspaceId !== scope.workspaceId || op.projectId !== scope.projectId || op.environmentId !== scope.environmentId
    || proposalScope?.workspaceId !== scope.workspaceId || proposalScope?.projectId !== scope.projectId || proposalScope?.environmentId !== scope.environmentId
    || !["deployment.deploy", "deployment.rollback"].includes(op.capability)
    || typeof input !== "object" || input === null || Array.isArray(input)
    || !("deploymentId" in input) || input.deploymentId !== deployment?.id
    || !("revisionId" in input) || input.revisionId !== deployment?.revisionId
    || typeof round !== "number" || !Number.isSafeInteger(round) || round < 0) return unavailable;
  // Only a confirmed, unbound round-zero proposal keeps the product startup action.
  if (round === 0 && op.planDigest === undefined && op.proposal.planDigest === undefined
    && ["awaiting_approval", "approved", "queued"].includes(op.status)) return { kind: "initial" };
  if (round > 0 || op.planDigest !== undefined || op.proposal.planDigest !== undefined) {
    return { kind: "plan", href: `/platform/operations/${encodeURIComponent(op.id)}` };
  }
  return unavailable;
}
