/** Placement is explicit: recommendation is a read, application delegates to
 * project.updateManifest's reviewed edit path. Neither changes connections.
 * V2 placement is saved through that same editor and concurrency check. */
import { z } from "zod";
import { defineAction, getAction, type ActionContext, type ActionPlan } from "@/lib/actions/core";
import { platformBroker } from "@/lib/capabilities/platform";
import { BrokerError } from "@/lib/capabilities/errors";
import { contentHash } from "@/lib/domain/types";
import { parseManifest, ManifestV2, ConcreteProvider } from "@/lib/resources/manifest-v2";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { RecommendOptions, recommendPlacement, type PlacementRecommendation, type RecommendedCandidate } from "@/lib/placement/recommend";
import { requireProject } from "./_shared";
import "./project-manifest";

const Input = RecommendOptions.extend({ projectId: z.string().min(1).optional(), environmentId: z.string().min(1).optional() }).strict();
type Input = z.infer<typeof Input>;
const Apply = Input.extend({ candidateId: z.string().min(1).max(500), expectedHash: z.string().min(1), expectedSeed: z.string().min(1) }).strict();
type Apply = z.infer<typeof Apply>;

async function recommend(ctx: ActionContext, input: Input): Promise<PlacementRecommendation> {
  const project = requireProject(ctx, input.projectId);
  const environmentId = input.environmentId ?? ctx.environmentId;
  const principal = ctx.integration
    ? { kind: "integration" as const, id: ctx.integration.clientId, name: ctx.actor.name, integrationId: ctx.integration.clientId, onBehalfOf: ctx.actor.id }
    : { kind: ctx.actor.type === "navigator" ? "navigator" as const : "user" as const, id: ctx.actor.id, name: ctx.actor.name };
  const authorization = await (await platformBroker()).authorizeRead({ capability: "placement.solve", scope: {
    workspaceId: ctx.workspaceId, projectId: project.id, ...(environmentId ? { environmentId } : {}),
  } }, principal);
  if (authorization.decision.outcome !== "allow" || !authorization.claims) throw new BrokerError("policy_denied", "Current policy does not authorize placement planning.", "Ask a workspace administrator to review placement policy.");
  return recommendPlacement({ ...input, workspaceId: ctx.workspaceId, projectId: project.id, environmentId });
}

defineAction<Input>({
  id: "placement.recommend", title: "Recommend placement", category: "project", risk: "low", requiredRole: "viewer", mutates: false, input: Input,
  async plan(ctx, input) {
    const recommendation = await recommend(ctx, input);
    return { summary: recommendation.result.chosen ? "Placement recommendation ready for review." : "No connected placement meets the constraints.",
      details: [recommendation.explanation], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false };
  },
  async execute(ctx, input) {
    const recommendation = await recommend(ctx, input);
    return { ok: true, summary: "Placement planning completed; costs and latency are estimates.", data: recommendation };
  },
});

/** Single-region application can be reproduced by expansion. Multi-region
 * solver topologies are planning models: expansion currently ignores secondary
 * regions, so they must not be saved as if the priced topology will deploy. */
export function manifestForPlacement(raw: unknown, candidate: RecommendedCandidate): ManifestV2 {
  if (candidate.requiresConnection) throw new Error(`Connect and verify ${candidate.missingProviders.join(", ")} in Settings → Connections before applying.`);
  if (candidate.topology === "multi_region") throw new Error("This topology requires multi-region deployment wiring. Choose a single-region or cross-cloud manifest placement.");
  const places = [...new Map(Object.values(candidate.assignments).map((a) => [`${a.provider}/${a.region}`, a])).values()];
  const parsed = parseManifest(raw);
  if (!parsed.ok) throw new Error("Fix the working manifest before applying placement.");
  const manifest = parsed.manifest.version === 2 ? structuredClone(parsed.manifest) : upgradeManifest(parsed.manifest, { provider: "auto" });
  const compute = Object.entries(candidate.assignments).find(([address]) => /^(container_service|scheduled_job|static_site)\//.test(address));
  const site = compute?.[1] ?? places[0];
  if (!site) throw new Error("This candidate has no component assignments.");
  // Expansion gives the environment's existing connection precedence over
  // global placement. Explicit primary-node pins preserve the user's choice
  // without switching that connection. Derived nodes follow these primaries.
  const nodePlacement = { ...manifest.nodePlacement };
  for (const node of [...manifest.services, ...manifest.resources]) {
    const entry = Object.entries(candidate.assignments).find(([address]) => address.endsWith(`/${node.name}`) && /^(container_service|scheduled_job|static_site|postgres|redis|object_store|queue)\//.test(address));
    if (entry && node.ownership === "managed") nodePlacement[node.id] = { provider: ConcreteProvider.parse(entry[1].provider), region: entry[1].region };
  }
  for (const [address, overrides] of Object.entries(candidate.specOverrides ?? {})) {
    const name = address.slice(address.lastIndexOf("/") + 1);
    const service = manifest.services.find((s) => s.name === name);
    if (service && typeof overrides.replicas === "number") service.replicas = overrides.replicas;
  }
  const haDatabase = Object.entries(candidate.specOverrides ?? {}).some(([addr, spec]) => /^(postgres|mysql|redis)\//.test(addr) && (spec.ha === true || spec.multiAz === true));
  if (haDatabase) manifest.constraints = { ...manifest.constraints, availabilityTarget: Math.max(manifest.constraints?.availabilityTarget ?? 0, 99.9) };
  return ManifestV2.parse({ ...manifest, nodePlacement, placement: { ...manifest.placement, provider: site.provider, regions: [site.region], zones: candidate.availabilityZones } });
}

async function application(ctx: ActionContext, input: Apply) {
  if (ctx.actor.type !== "user" || ctx.integration) throw new Error("A person must review and apply placement in the browser.");
  const project = requireProject(ctx, input.projectId);
  if (contentHash(project.workingManifest) !== input.expectedHash) throw new Error("The working copy changed. Request placement again before applying.");
  const recommendation = await recommend(ctx, Input.parse({ projectId: input.projectId, environmentId: input.environmentId, constraints: input.constraints, includeUnconnected: input.includeUnconnected }));
  const candidates = [...(recommendation.result.chosen ? [recommendation.result.chosen] : []), ...recommendation.result.alternatives, ...recommendation.unconnectedCandidates];
  const candidate = candidates.find((c) => c.id === input.candidateId);
  if (!candidate) throw new Error("This placement is no longer eligible. Connect and verify the chosen provider in Settings → Connections, then request placement again.");
  if (candidate.requiresConnection) throw new Error(`Connect and verify ${candidate.missingProviders.join(", ")} in Settings → Connections before applying.`);
  if (recommendation.result.deterministicSeed !== input.expectedSeed) throw new Error("The placement inputs or verified connections changed. Request placement again before applying.");
  const manifest = manifestForPlacement(project.workingManifest, candidate);
  const edit = getAction("project.updateManifest");
  const editInput = { projectId: project.id, manifest, expectedHash: input.expectedHash };
  const editPlan = await edit.plan(ctx, editInput);
  // The editor owns validation, concurrency and saving for both versions.
  const plan: ActionPlan = { ...editPlan, summary: `Stage ${candidate.id} in the working manifest.`,
    details: [`Provider ${manifest.placement?.provider}; regions ${manifest.placement?.regions.join(", ")}; ${candidate.availabilityZones ?? 1} zones.`,
      `Candidate estimate $${candidate.cost.monthlyUsd.toFixed(2)}/month; catalog ${candidate.cost.catalogVersion}.`,
      "The environment keeps its current connection. Review and change that separately before any deployment.", ...editPlan.details] };
  return { plan, edit, editInput };
}

defineAction<Apply>({
  id: "placement.apply", title: "Apply placement to working manifest", category: "system", risk: "medium", requiredRole: "editor", mutates: true, input: Apply,
  async plan(ctx, input) { return (await application(ctx, input)).plan; },
  async execute(ctx, input) {
    const { plan, edit, editInput } = await application(ctx, input);
    if (plan.blocked) return { ok: false, summary: "Placement was not applied.", error: plan.blocked };
    return edit.execute(ctx, editInput);
  },
});
