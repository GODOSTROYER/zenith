/**
 * Product placement planning. Reads the working copy and stored verification
 * metadata only; never opens a cloud session, saves, or changes a connection.
 * Verification is the last recorded check, not proof of current permissions.
 * Prices and latency are estimates from the solver's static catalogs.
 */
import { z } from "zod";
import { db } from "@/lib/db/store";
import { platformDb, repos } from "@/lib/controlplane/db";
import { contentHash, type Environment } from "@/lib/domain/types";
import { digest } from "@/lib/controlplane/digest";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { expandManifest, ManifestExpansionError } from "@/lib/resources/expand";
import { parseManifest, type ManifestV2 } from "@/lib/resources/manifest-v2";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { componentsFromGraph } from "./components";
import { solvePlacement } from "./solver";
import { explainPlacement } from "./explain";
import { loadDefaultCatalog } from "./pricebook";
import { assessFeasibility, type FeasibilityReport } from "./feasibility";
import { costDisclosure, type CostDisclosure } from "@/lib/cost/wording";
import { regionInfo, regionSatisfiesResidency } from "./latency";
import type { PlacementCandidate, PlacementConstraints, PlacementResult } from "./types";
import type { ProviderKey, ResourceGraph } from "@/lib/resources/types";

const token = z.string().min(1).max(64).regex(/^[A-Za-z0-9 _./-]+$/);
export const RecommendConstraints = z.object({
  userRegions: z.array(token).max(32).optional(),
  budgetUsdMonthly: z.number().finite().positive().optional(),
  residency: z.array(token).max(16).optional(),
  latencyTargetMs: z.number().finite().positive().optional(),
  availabilityTarget: z.number().finite().positive().max(100).optional(),
  tolerateSingleFailure: z.boolean().optional(),
  managedDatabaseRequired: z.boolean().optional(),
  providerPreference: z.array(token).max(8).optional(),
  providerDenylist: z.array(token).max(8).optional(),
  componentProviders: z.record(token, token).optional(),
  usage: z.object({
    egressGb: z.number().finite().nonnegative().optional(),
    requestsMillions: z.number().finite().nonnegative().optional(),
    storageGb: z.number().finite().nonnegative().optional(),
    logGbPerService: z.number().finite().nonnegative().optional(),
    dbStorageGb: z.number().finite().nonnegative().optional(),
    interComponentFraction: z.number().finite().min(0).max(1).optional(),
    interAzGb: z.number().finite().nonnegative().optional(),
    storageIoMillions: z.number().finite().nonnegative().optional(),
    crossRegionBackupCopyGb: z.number().finite().nonnegative().optional(),
  }).strict().optional(),
}).strict();
export const RecommendOptions = z.object({
  constraints: RecommendConstraints.optional(),
  includeUnconnected: z.boolean().optional(),
}).strict();
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const RecommendInput = RecommendOptions.extend({
  workspaceId: Id, projectId: Id, environmentId: Id.optional(),
}).strict();
export type RecommendInput = z.infer<typeof RecommendInput>;

export interface PlacementConnection {
  workspaceId: string;
  provider: string;
  verified: boolean;
}
export interface RecommendReads {
  project(workspaceId: string, projectId: string): Promise<{ id: string; workspaceId: string; workingManifest: unknown } | null>;
  environment(workspaceId: string, projectId: string, environmentId: string): Promise<(Environment & { provider?: ProviderKey }) | null>;
  connections(workspaceId: string): Promise<PlacementConnection[]>;
}

/** SQL reads are workspace-scoped. Config, role ARNs and verification text stay here. */
export const placementReads: RecommendReads = {
  async project(workspaceId, projectId) {
    return db().projects.find((p) => p.workspaceId === workspaceId && p.id === projectId) ?? null;
  },
  async environment(workspaceId, projectId, environmentId) {
    const data = db();
    if (!data.projects.some((p) => p.id === projectId && p.workspaceId === workspaceId)) return null;
    const env = data.environments.find((e) => e.projectId === projectId && e.id === environmentId);
    if (!env) return null;
    const connection = data.connections.find((c) => c.id === env.connectionId && c.workspaceId === workspaceId);
    return { ...env, ...(connection ? { provider: connection.provider } : {}) };
  },
  async connections(workspaceId) {
    try {
      const rows = await repos.connections.list(await platformDb(), workspaceId);
      return rows.map((c) => ({ workspaceId: c.workspaceId, provider: c.config.provider, verified: c.status === "verified" && !c.revokedAt }));
    } catch {
      throw new BrokerError("platform_store_unavailable", "Connection verification metadata could not be read.", "Restore the platform store, then retry placement.");
    }
  },
};

export type RecommendedCandidate = PlacementCandidate & {
  requiresConnection: boolean;
  missingProviders: string[];
};
export interface PlacementRecommendation {
  workspaceId: string;
  projectId: string;
  environmentId?: string;
  manifestHash: string;
  graphDigest: string;
  constraints: PlacementConstraints;
  connectedProviders: string[];
  result: Omit<PlacementResult, "chosen" | "alternatives"> & { chosen?: RecommendedCandidate; alternatives: RecommendedCandidate[] };
  explanation: string;
  /** Typed answer to "can the constraints be met at all"; when not, the binding blockers and nearest miss. */
  feasibility: FeasibilityReport;
  /** Costs here are estimates; a budget is a planning limit, never a billing cap. */
  disclosure: CostDisclosure;
  /** Discovery is separate: an unconnected option never displaces a recommendation. */
  unconnectedCandidates: RecommendedCandidate[];
}

const invalid = () => new BrokerError("invalid_request", "The placement request or working manifest is invalid.", "Fix the manifest or constraints, then request placement again.");

function constraintsFor(m: ManifestV2, input: RecommendInput, env?: Environment): PlacementConstraints {
  const overrides = input.constraints ?? {};
  const constraints: PlacementConstraints = { ...m.constraints, ...overrides, userRegions: overrides.userRegions ?? m.constraints?.userRegions ?? [] };
  // Request refinements may tighten, but cannot discard manifest/environment safety limits.
  const budgets = [m.constraints?.budgetUsdMonthly, env?.policies.budgetUsdMonthly, overrides.budgetUsdMonthly].filter((x): x is number => x !== undefined);
  if (budgets.length) constraints.budgetUsdMonthly = Math.min(...budgets);
  const availability = [m.constraints?.availabilityTarget, overrides.availabilityTarget].filter((x): x is number => x !== undefined);
  if (availability.length) constraints.availabilityTarget = Math.max(...availability);
  constraints.tolerateSingleFailure = !!(m.constraints?.tolerateSingleFailure || overrides.tolerateSingleFailure || (m.placement?.zones ?? 1) > 1);
  if (m.placement?.residency?.length && overrides.residency !== undefined) {
    // Intersections of jurisdiction aliases are checked per site below, not as literal strings.
    constraints.residency = m.placement.residency;
  } else constraints.residency = m.placement?.residency ?? overrides.residency;
  return constraints;
}

/** Read-only recommendation. An injectable read seam keeps tests cloud-free. */
export async function recommendPlacement(raw: RecommendInput, reads: RecommendReads = placementReads): Promise<PlacementRecommendation> {
  const parsedInput = RecommendInput.safeParse(raw);
  if (!parsedInput.success) throw invalid();
  const input = parsedInput.data;
  const project = await reads.project(input.workspaceId, input.projectId);
  if (!project || project.workspaceId !== input.workspaceId || project.id !== input.projectId) throw notFound();
  const env = input.environmentId ? await reads.environment(input.workspaceId, input.projectId, input.environmentId) : undefined;
  if (input.environmentId && (!env || env.id !== input.environmentId || env.projectId !== project.id)) throw notFound();
  const parsed = parseManifest(project.workingManifest);
  if (!parsed.ok) throw invalid();
  const manifest = parsed.manifest.version === 2 ? parsed.manifest : upgradeManifest(parsed.manifest, { provider: "auto", policies: env?.policies });
  const connectedProviders = [...new Set((await reads.connections(input.workspaceId)).filter((c) => c.workspaceId === input.workspaceId && c.verified).map((c) => c.provider))].sort();
  // Expansion needs a concrete baseline. This does not select or connect a cloud.
  const baseline: ProviderKey = env?.provider ?? "aws";
  let graph: ResourceGraph;
  try {
    graph = expandManifest(manifest, { id: env?.id ?? "placement-preview", name: env?.name ?? "placement", class: env?.class ?? "staging", provider: baseline,
      region: env?.region ?? "ap-south-1", baseDomain: env?.baseDomain ?? "placement.invalid" });
  } catch (error) {
    if (error instanceof ManifestExpansionError) throw invalid();
    throw error;
  }
  const constraints = constraintsFor(manifest, input, env ?? undefined);
  const catalog = loadDefaultCatalog();
  const { components, edges } = componentsFromGraph(graph);
  // Explicit node placements are real pins, including those on managed nodes.
  for (const node of graph.nodes) {
    const component = components.find((c) => c.address === node.address)!;
    const key = node.origin.find((o) => manifest.nodePlacement?.[o]);
    const byName = manifest.nodePlacement?.[component.name ?? ""];
    const pin = key ? manifest.nodePlacement?.[key] : byName;
    if (pin) component.pin = { provider: pin.provider, ...(pin.region ? { region: pin.region } : {}) };
  }
  const providers = [...new Set(catalog.entries.map((e) => e.provider))].sort();
  const minimumAvailabilityZones = Math.max(manifest.placement?.zones ?? 1, ...graph.nodes.filter((n) => n.kind === "network" && n.ownership === "managed")
    .map((n) => typeof n.spec.azCount === "number" ? n.spec.azCount : 1));
  const solve = (connectedOnly: boolean) => solvePlacement({ components, edges, catalog, constraints: {
    ...constraints, providerDenylist: [...new Set([...(constraints.providerDenylist ?? []), ...(connectedOnly ? providers.filter((p) => !connectedProviders.includes(p)) : [])])].sort(),
  }, options: { maxAlternatives: 256, minimumAvailabilityZones } });
  const connected = solve(true);
  const discovery = input.includeUnconnected ? solve(false) : undefined;
  const candidates = (result: PlacementResult) => [ ...(result.chosen ? [result.chosen] : []), ...result.alternatives ];
  const rejected = [...connected.rejected];
  const annotate = (c: PlacementCandidate): RecommendedCandidate => {
    const missingProviders = [...new Set(Object.values(c.assignments).map((a) => a.provider))].filter((p) => !connectedProviders.includes(p)).sort();
    return { ...c, requiresConnection: missingProviders.length > 0, missingProviders,
      warnings: [...c.warnings, ...(missingProviders.length ? [`Connect and verify ${missingProviders.join(", ")} before applying. This discovery option is not ranked above connected placements.`] : [])] };
  };
  const meetsExtraLimits = (c: PlacementCandidate): boolean => {
    const reasons: string[] = [];
    const minimumZones = manifest.placement?.zones ?? 1;
    for (const a of Object.values(c.assignments)) {
      const info = regionInfo(a.provider, a.region);
      if (info && info.zones < minimumZones) reasons.push(`availability: ${a.provider}/${a.region} has ${info.zones} zones; placement.zones requires ${minimumZones}`);
      if (info && constraints.residency?.length && !regionSatisfiesResidency(info, constraints.residency)) reasons.push(`residency: ${a.provider}/${a.region} does not satisfy manifest residency`);
      if (input.constraints?.residency?.length && manifest.placement?.residency?.length && info && !regionSatisfiesResidency(info, input.constraints.residency)) reasons.push(`residency: ${a.provider}/${a.region} does not satisfy the additional requested residency`);
    }
    if (reasons.length) rejected.push({ id: c.id, reasons: [...new Set(reasons)].sort() });
    return reasons.length === 0;
  };
  const ranked = candidates(connected).filter(meetsExtraLimits).map(annotate).filter((c) => {
    if (!c.requiresConnection) return true;
    rejected.push({ id: c.id, reasons: [`connection: no verified connection for ${c.missingProviders.join(", ")}`] });
    return false;
  });
  const unconnectedCandidates = discovery ? candidates(discovery).filter(meetsExtraLimits).map(annotate).filter((c) => c.requiresConnection).slice(0, 5) : [];
  if (discovery) for (const r of discovery.rejected) if (!rejected.some((x) => x.id === r.id)) rejected.push(r);
  for (const r of rejected) if (r.id.startsWith("provider:") && !connectedProviders.includes(r.id.slice(9))) {
    const provider = r.id.slice(9);
    const explicitlyDenied = constraints.providerDenylist?.some((p) => p.trim().toLowerCase() === provider);
    // The automatic provider exclusion is an eligibility rule, not a denylist
    // the user authored. Name the actionable reason in product responses.
    r.reasons = [`connection: ${provider} has no verified workspace connection`, ...r.reasons.filter((reason) => explicitlyDenied || !reason.startsWith("denylist:"))];
  }
  const rejectionReasons = new Map<string, Set<string>>();
  for (const r of rejected) {
    const reasons = rejectionReasons.get(r.id) ?? new Set<string>();
    for (const reason of r.reasons) reasons.add(reason);
    rejectionReasons.set(r.id, reasons);
  }
  const result: PlacementRecommendation["result"] = { ...connected, chosen: ranked[0], alternatives: ranked.slice(1, 5),
    rejected: [...rejectionReasons].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, reasons]) => ({ id, reasons: [...reasons].sort() })),
    deterministicSeed: digest({ seed: connected.deterministicSeed, discovery: discovery?.deterministicSeed, connectedProviders, graph: graph.graphDigest, input }),
    assumptions: [...connected.assumptions, "Candidates require a stored verified workspace connection; simulated and legacy preview connections do not qualify.",
      "The working copy is planned. Applying edits only the manifest; environment connections and deployments require separate explicit actions.",
      ...(discovery ? ["Unconnected discovery options are listed separately after connected placements; connect and verify them before applying."] : [])] };
  return { workspaceId: input.workspaceId, projectId: input.projectId, ...(env ? { environmentId: env.id } : {}), manifestHash: contentHash(project.workingManifest),
    graphDigest: graph.graphDigest, constraints, connectedProviders, result, unconnectedCandidates,
    feasibility: assessFeasibility(result, constraints), disclosure: costDisclosure(),
    explanation: explainPlacement(result) + (connectedProviders.length === 0 ? "\nConnect and verify a cloud account in Settings → Connections, then request placement again." : "") };
}
