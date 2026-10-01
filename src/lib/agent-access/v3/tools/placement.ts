/** Read-only placement recommendation. The broker authorizes before any product
 * read; all explanation, price lines and manifest-derived text are untrusted
 * data. The static catalog owns its schema and transport registration. */
import { recommendPlacement } from "@/lib/placement/recommend";
import { BrokerError } from "@/lib/capabilities/errors";
import type { RecommendPlacementArgs } from "../schemas";
import { assertInGrant } from "../principal";
import type { ToolContext } from "../context";
import type { ToolOutput } from "../envelope";

export async function recommendPlacementTool(args: RecommendPlacementArgs, ctx: Pick<ToolContext, "broker" | "principal">): Promise<ToolOutput> {
  assertInGrant(ctx.principal, args.target);
  const authorization = await ctx.broker.authorizeRead({ capability: "placement.solve", scope: args.target }, ctx.principal.principal);
  if (authorization.decision.outcome !== "allow" || !authorization.claims) throw new BrokerError("policy_denied", "Current policy does not authorize placement planning.", "Use the plan scope and review workspace placement policy.");
  const recommendation = await recommendPlacement({ ...args.target, constraints: args.constraints, includeUnconnected: args.includeUnconnected });
  return {
    data: { workspaceId: recommendation.workspaceId, projectId: recommendation.projectId, environmentId: recommendation.environmentId,
      manifestHash: recommendation.manifestHash, graphDigest: recommendation.graphDigest, catalogVersion: recommendation.result.catalogVersion,
      deterministicSeed: recommendation.result.deterministicSeed, connectedProviders: recommendation.connectedProviders, isEstimate: true,
      chosenCandidateId: recommendation.result.chosen?.id ?? null },
    untrusted: { result: recommendation.result, explanation: recommendation.explanation, constraints: recommendation.constraints,
      unconnectedCandidates: recommendation.unconnectedCandidates },
    notes: ["Costs are static list-price estimates, not invoices; latency is approximate and not measured.",
      "Connection verification is stored metadata, not a fresh cloud permission check. Applying requires a person's reviewed manifest edit."],
  };
}
