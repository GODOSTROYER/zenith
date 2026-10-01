/**
 * The tool dispatcher: one place where a tool call becomes a broker call.
 *
 *   name ─▶ catalog lookup ─▶ scope check ─▶ strict input parse
 *        ─▶ product-store scope ─▶ handler ─▶ envelope (scrubbed, bounded, labelled)
 *
 * `runTool` never throws: every failure becomes an error envelope with a stable
 * code, so a client sees one shape whatever went wrong. `invokeTool` is the
 * throwing variant for callers that want the exception.
 *
 * There is no handler that is not in `HANDLERS`, no tool that is not in the
 * catalog, and no code path from here to a cloud, a shell or an OpenTofu process
 * except through the broker (and, for reads, a credential-broker session opened
 * with the broker's own grant).
 */
import { TOOL_NAMES, type ToolName } from "../contract";
import { TOOL_SCHEMAS, toolDescriptor } from "../catalog";
import type { ToolContext } from "../context";
import { buildEnvelope, buildErrorEnvelope, type Envelope, type ToolOutput } from "../envelope";
import { mapError, McpToolError } from "../errors";
import type { McpPrincipal } from "../principal";
import { assertInGrant, requireScope, type TargetLike } from "../principal";
import type { McpPorts } from "../ports";
import { executeApprovedOperation } from "./execute";
import { getOperation, getOperationEvents } from "./operations";
import { investigateIncident, queryLogs, queryMetrics } from "./observe";
import { compareRevisions, estimateCost, getCapabilities, getTopology } from "./project";
import { planChange, prepareDeploy, restartService, scaleService } from "./propose";
import { recommendPlacementTool } from "./placement";
import { reviewTeardown } from "./teardown-review";

type Handler = (args: never, ctx: ToolContext) => Promise<ToolOutput>;

const HANDLERS: Record<ToolName, Handler> = {
  zenith_get_topology: getTopology as Handler,
  zenith_get_capabilities: getCapabilities as Handler,
  zenith_plan_change: planChange as Handler,
  zenith_review_teardown: reviewTeardown as Handler,
  zenith_prepare_deploy: prepareDeploy as Handler,
  zenith_execute_approved_operation: executeApprovedOperation as Handler,
  zenith_query_logs: queryLogs as Handler,
  zenith_query_metrics: queryMetrics as Handler,
  zenith_investigate_incident: investigateIncident as Handler,
  zenith_restart_service: restartService as Handler,
  zenith_scale_service: scaleService as Handler,
  zenith_compare_revisions: compareRevisions as Handler,
  zenith_estimate_cost: estimateCost as Handler,
  zenith_recommend_placement: recommendPlacementTool as Handler,
  zenith_get_operation: getOperation as Handler,
  zenith_get_operation_events: getOperationEvents as Handler,
};

export interface InvokeOptions {
  principal: McpPrincipal;
  ports: McpPorts;
  signal?: AbortSignal;
}

/** Run a tool and return its envelope; throws on any refusal. */
export async function invokeTool(name: string, rawArgs: unknown, options: InvokeOptions): Promise<Envelope> {
  const tool = toolDescriptor(name);
  if (!tool || !(TOOL_NAMES as readonly string[]).includes(name)) throw new McpToolError("unknown_tool", "There is no such tool.", 404);
  requireScope(options.principal, tool.name, tool.requiredScope);

  // All fifteen strict schemas have one of these two explicit scope shapes.
  const args = TOOL_SCHEMAS[tool.name].parse(rawArgs ?? {}) as { target: TargetLike } | { workspaceId: string };
  // Check the explicit target before even resolving the broker or entering a
  // product-store snapshot. Grant-restricted ids must never touch tenant data.
  const target = "target" in args ? args.target : { workspaceId: args.workspaceId };
  assertInGrant(options.principal, target);
  return options.ports.scope(options.principal.identity, async () => {
    const broker = await options.ports.broker();
    const output = await HANDLERS[tool.name](args as never, { principal: options.principal, ports: options.ports, broker, tool, signal: options.signal });
    return buildEnvelope(tool, output);
  });
}

/** Run a tool and never throw: a refusal is an `ok: false` envelope with a stable code. */
export async function runTool(name: string, rawArgs: unknown, options: InvokeOptions): Promise<Envelope> {
  try {
    return await invokeTool(name, rawArgs, options);
  } catch (error) {
    const tool = toolDescriptor(name) ?? { name: name.slice(0, 64), schemaVersion: 0 };
    return buildErrorEnvelope(tool, mapError(error).body);
  }
}

export { HANDLERS };
