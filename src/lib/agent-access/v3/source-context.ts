/** Shared current authority for direct exports and indirect operation reads. */
import { authorizeReadOrThrow, requireEnvironment, requireProject, type ToolContext } from "./context";
import { assertInGrant } from "./principal";
import { McpToolError } from "./errors";
import type { GetSourceContextArgs } from "./source-schema";

export async function authorizedSourceContext(args: GetSourceContextArgs, ctx: ToolContext) {
  assertInGrant(ctx.principal, args.target);
  await authorizeReadOrThrow(ctx, "source.context.read", args.target);
  await requireProject(ctx, args.target.workspaceId, args.target.projectId);
  await requireEnvironment(ctx, args.target.workspaceId, args.target.projectId, args.target.environmentId);
  if (!ctx.ports.sourceContext) throw new McpToolError("source_unavailable", "Repository context export is unavailable on this deployment.", 503);
  const handoff = await ctx.ports.sourceContext.get({ workspaceId: args.target.workspaceId, target: args.target, runId: args.runId,
    ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}), ...(args.expectedDigest !== undefined ? { expectedDigest: args.expectedDigest } : {}), now: ctx.ports.now() });
  if (handoff.id !== args.runId || handoff.context.target?.workspaceId !== args.target.workspaceId || handoff.context.target?.projectId !== args.target.projectId || handoff.context.target?.environmentId !== args.target.environmentId) {
    throw new McpToolError("not_found", "The requested source context was not found.", 404);
  }
  if ((args.expectedVersion !== undefined && handoff.runVersion !== args.expectedVersion) || (args.expectedDigest !== undefined && handoff.digest !== args.expectedDigest)) {
    throw new McpToolError("source_mismatch", "The source context changed. Prepare a new handoff.", 409);
  }
  // GitHub/provider verification may wait on network I/O. Recheck the live
  // client grant and membership before exporting the protected projection.
  await authorizeReadOrThrow(ctx, "source.context.read", args.target);
  return handoff;
}
