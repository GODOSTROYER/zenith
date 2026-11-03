/** Generic operation tools cannot bypass source export consent or current GitHub authority. */
import type { OperationView } from "@/lib/capabilities/types";
import { isSourceOperation, sourceOperationInput, sourceOperationMatches } from "@/lib/coding-agent/source-operation";
import type { ToolContext } from "./context";
import { GetSourceContextInput } from "./source-schema";
import { authorizedSourceContext } from "./source-context";

export const SOURCE_DETAILS_OMITTED = "Source-derived details are omitted. They require export consent and current authorization for this exact analysis.";

export async function sourceOperationDetailsAllowed(operation: OperationView, ctx: ToolContext): Promise<boolean> {
  if (!isSourceOperation(operation)) return true;
  if (!ctx.principal.scopes.includes("export")) return false;
  const input = sourceOperationInput(operation);
  const request = GetSourceContextInput.safeParse({
    target: { workspaceId: operation.workspaceId, projectId: operation.projectId, environmentId: operation.environmentId }, runId: input.runId,
    ...(input.stage === "coding_agent_source_return" ? { expectedVersion: input.runVersion, expectedDigest: input.handoffDigest } : {}),
  });
  if (!request.success) return false;
  try {
    return sourceOperationMatches(operation, await authorizedSourceContext(request.data, ctx));
  } catch {
    // The operation's ledger metadata remains readable. Denial, expiry and
    // provider outages must never fall back to a cached private projection.
    return false;
  }
}
