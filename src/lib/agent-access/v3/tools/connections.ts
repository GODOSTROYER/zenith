/** A read-only action draft, not a broker operation, approval or execution grant. */
import { z } from "zod/v4";
import { ConnectionRequest } from "@/lib/connections/handoff";
import { registerAllActions } from "@/lib/actions/defs";
import { getAction } from "@/lib/actions/core";
import { authorizeReadOrThrow, requireProject, type ToolContext } from "../context";
import { PlanRunnerConnectionInput } from "../connection-schema";
import { McpToolError } from "../errors";
import type { ToolOutput } from "../envelope";

export async function planRunnerConnection(args: z.infer<typeof PlanRunnerConnectionInput>, ctx: ToolContext): Promise<ToolOutput> {
  await authorizeReadOrThrow(ctx, "connection.plan", args.target);
  await requireProject(ctx, args.target.workspaceId, args.target.projectId);
  const request = ConnectionRequest.safeParse({ action: args.action, input: args.input });
  if (!request.success) throw new McpToolError("invalid_input", "Use the registered connection action's identifier-only contract. Secrets, actor overrides and approval fields are refused.", 400);
  registerAllActions();
  // The broker above owns current membership, plan scope and policy for this
  // read. Invoke only the fixed, non-mutating registry draft definition; no
  // model-supplied action id is dispatched. Its target action stays human-only.
  const draftAction = getAction("connection.proposeRunner");
  if (draftAction.mutates || draftAction.requiredRole !== "viewer") throw new McpToolError("plan_unavailable", "The connection review action is unavailable.", 409);
  const preview = await draftAction.execute({ workspaceId: args.target.workspaceId, projectId: args.target.projectId,
    actor: { type: "user", id: ctx.principal.identity.subject, name: "Agent-linked member" },
    integration: { clientId: ctx.principal.identity.integrationId, operationId: "connection-review-draft", proposalDigest: "unapproved" } }, request.data);
  if (!preview.ok) throw new McpToolError("plan_unavailable", "The shared connection action could not produce this review draft.", 409);
  const data = preview.data as { browserPath: string; requiredRole: string };
  return { data: { action: request.data.action, requiredRole: data.requiredRole, browserUrl: new URL(data.browserPath, ctx.ports.origin()).href,
    requiresBrowserConfirmation: true, approved: false, executed: false },
    untrusted: { request: request.data }, notes: ["This is a read-only review draft, not a stored operation or approval. A person reviews the exact identifiers in the signed-in browser. No agent execute tool can apply it."] };
}
