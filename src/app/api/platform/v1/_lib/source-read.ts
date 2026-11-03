/** Machine REST reads expose source-operation metadata; source content uses scoped MCP export. */
import type { OperationView } from "@/lib/capabilities/types";
import { isSourceOperation } from "@/lib/coding-agent/source-operation";
import type { CallerContext } from "./principal";

export const restrictedSourceRead = (operation: OperationView, caller: CallerContext): boolean =>
  (caller.via === "bearer" || caller.via === "navigator") && isSourceOperation(operation);

export function operationForRest(operation: OperationView, caller: CallerContext): OperationView {
  if (!restrictedSourceRead(operation, caller)) return operation;
  return {
    id: operation.id, workspaceId: operation.workspaceId, projectId: operation.projectId,
    environmentId: operation.environmentId, resourceId: operation.resourceId,
    capability: operation.capability, status: operation.status, principal: operation.principal,
    proposalDigest: operation.proposalDigest, planDigest: operation.planDigest,
    policyDecisionId: operation.policyDecisionId, approvalRequired: operation.approvalRequired,
    correlationId: operation.correlationId, createdAt: operation.createdAt, updatedAt: operation.updatedAt,
    startedAt: operation.startedAt, finishedAt: operation.finishedAt, expiresAt: operation.expiresAt,
    proposal: {
      summary: "Source analysis proposal. Use the scoped MCP source tools to request source context.",
      details: [], risk: operation.proposal.risk, scope: operation.proposal.scope,
      input: { sourceContextOmitted: true },
    },
  };
}
