/**
 * Deterministic placement solver (ADR-0013, spec §29/§30/§38).
 *
 * The model turns natural language into `PlacementConstraints`; this code
 * chooses. It enumerates candidates, rejects the ones that break a hard
 * constraint (with the reason and the numbers), scores the rest and picks the
 * lowest score. Same inputs give the same result, including the seed:
 * candidates are enumerated in sorted order, all arithmetic is plain
 * floating point on catalog numbers, ties break on the candidate id, and
 * nothing reads a clock, the environment or a random source.
 *
 * Candidate rules
 * - Single provider, single region: every provider/region pair that can host
 *   every component kind.
 * - Multi-region (one provider, two regions) is considered only when the
 *   availability target is >= 99.99 (then single-region candidates are
 *   rejected), or the user regions are far apart (max pairwise RTT above
 *   `FAR_APART_RTT_MS`), or a latency target is set that no single region
 *   meets for every user region.
 * - Cross-cloud (mixed provider) candidates exist only when component pins
 *   name two or more different providers (then they are forced), or the
 *   provider preference list names two or more providers (then they are
 *   optional and must clear the savings margin below).
 *
 * Hard filters, each reported with its numbers: denylist, capability gap,
 * residency, availability (zones, multi-region), pin conflict, missing price,
 * budget. `tolerateSingleFailure` and availability targets are applied by
 * construction (replicas, zones, HA) and reported in `specOverrides`; a region
 * with too few zones is rejected.
 *
 * Score (LOWER IS BETTER), weights in `SCORE_WEIGHTS`:
 *   cost         (monthly - cheapest feasible) / max(cheapest, 1)
 *   latency      max over user regions of p95 / reference (target or 100 ms)
 *   overshoot    max over regions of (p95 - target) / target, when a target is set
 *   complexity   2 points per extra provider (identity federation, second
 *                control plane) + 1 per extra region
 *   preference   minus the mean rank bonus of the candidate's providers
 *
 * Cross-cloud margin: an optional cross-cloud candidate is rejected unless
 *   cheapestSingleProvider - candidate - complexityUsd >= 15% of cheapestSingleProvider
 * where the candidate's cost already includes its cross-cloud egress and
 * `complexityUsd` is `COMPLEXITY_USD_PER_EXTRA_PROVIDER` per extra provider.
 * Forced cross-cloud (pins) skips the margin: there is nothing cheaper to
 * compare against, but the egress, latency and complexity are still costed.
 *
 * Honest limits: prices come from the catalog (see `pricebook.ts` for what is
 * verified); latency is approximate (`latency.ts`); the zenith managed tier is
 * excluded unless asked for because its prices are internal assumptions;
 * placement checks price and capability, not whether a driver exists yet.
 */
import { digest } from "@/lib/controlplane/digest";
import type { CostEstimate, PlacementCandidate, PlacementConstraints, PlacementResult, PriceCatalog } from "@/lib/placement/types";
import { estimateGraphCost, listCrossBoundaryTransfers, resolveExtendedUsage, resolveUsage, toPriceBook } from "@/lib/placement/cost";
import { budgetReason } from "@/lib/placement/reasons";
import { MissingPriceError, verificationSummary, type PriceBook } from "@/lib/placement/pricebook";
import { nativeTypeFor, placementProviders } from "@/lib/placement/capabilities";
import {
  COMPUTE_KINDS,
  deriveEdges,
  isFixed,
  resolvePins,
  tierOf,
  type PlacementComponent,
  type PlacementEdge,
} from "@/lib/placement/components";
import {
  buildPlacedGraph,
  deriveRequirements,
  enumerateMixed,
  enumerateMulti,
  singleSpec,
  siteOf,
  type CandidateSpec,
  type PlacedGraph,
  type Requirements,
  type Site,
} from "@/lib/placement/candidates";
import {
  LATENCY_TABLE_SOURCE,
  P95_FACTOR,
  estimateP95Ms,
  geoRttMs,
  normalizeResidencyToken,
  normalizeUserRegion,
  regionInfo,
  regionSatisfiesResidency,
  regionToRegionRttMs,
  userRegionGeo,
  userToRegionRttMs,
  type UserRegion,
} from "@/lib/placement/latency";
import type { PortableKind } from "@/lib/resources/types";

/* --------------------------------- constants ------------------------------- */

export const SCORE_WEIGHTS = { cost: 1.0, latency: 0.35, latencyOvershoot: 1.0, complexity: 0.05, preference: 0.1 } as const;
/** An optional cross-cloud candidate must save at least this share of the cheapest single-provider cost, after costs. */
export const CROSS_CLOUD_SAVINGS_MARGIN = 0.15;
/** Monthly USD-equivalent of the operational cost of each extra provider (identity federation, a second control plane, on-call surface). An assumption, not a price. */
export const COMPLEXITY_USD_PER_EXTRA_PROVIDER = 75;
export const COMPLEXITY_POINTS_PER_EXTRA_PROVIDER = 2;
export const COMPLEXITY_POINTS_PER_EXTRA_REGION = 1;
/** User regions further apart than this (approximate RTT, ms) make multi-region worth considering. */
export const FAR_APART_RTT_MS = 100;
/** p95 latency in ms the latency term is normalized against when no target is given. */
export const LATENCY_REFERENCE_MS = 100;
export const DEFAULT_MAX_ALTERNATIVES = 4;
/** Share of an estimate resting on weak price evidence above which a candidate carries a warning. */
const WEAK_EVIDENCE_WARN_SHARE = 0.25;

export class PlacementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementInputError";
  }
}

export interface SolveOptions {
  /** Minimum AZs from manifest placement or expansion's provider requirements. */
  minimumAvailabilityZones?: number;
  /** consider the zenith managed tier (prices are internal assumptions); it is also considered when pinned or preferred */
  includeZenithManagedTier?: boolean;
  /** ISO timestamp for `computedAt`; defaults to the catalog snapshot time */
  now?: string;
  /** database backup retention policy default, days */
  backupRetentionDays?: number;
  /** alternatives returned besides the chosen candidate (default 4) */
  maxAlternatives?: number;
}

export interface SolveInput {
  components: readonly PlacementComponent[];
  /** data-plane edges; derived (load balancer -> compute -> data) when omitted */
  edges?: readonly PlacementEdge[];
  constraints: PlacementConstraints;
  catalog: PriceCatalog | PriceBook;
  options?: SolveOptions;
}

/* -------------------------------- helpers --------------------------------- */

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const money = (x: number) => `${x < 0 ? "-" : ""}${Math.abs(x).toFixed(2)}`;
/** 6-decimal rounding that never yields -0 (keeps serialized results stable). */
const q6 = (x: number) => Math.round(x * 1e6) / 1e6 || 0;
const pct = (x: number) => `${(Math.round(x * 1000) / 10).toString()}%`;

function validateConstraints(c: PlacementConstraints): void {
  const finite = (v: unknown, name: string, ok: (n: number) => boolean, what: string) => {
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v) || !ok(v)) throw new PlacementInputError(`constraints.${name} must be ${what}.`);
  };
  finite(c.budgetUsdMonthly, "budgetUsdMonthly", (n) => n >= 0, "a finite number >= 0");
  finite(c.latencyTargetMs, "latencyTargetMs", (n) => n > 0, "a finite number > 0");
  finite(c.availabilityTarget, "availabilityTarget", (n) => n > 0 && n <= 100, "a number in (0, 100]");
  if (!Array.isArray(c.userRegions)) throw new PlacementInputError("constraints.userRegions must be an array.");
}

interface Normalized {
  userRegions: UserRegion[];
  residency: string[] | undefined;
  denylist: Set<string>;
  preference: string[];
  pins: Record<string, string>;
  issues: string[];
}

function normalizeConstraints(c: PlacementConstraints, providersInCatalog: readonly string[]): Normalized {
  const issues: string[] = [];
  const userRegions: UserRegion[] = [];
  for (const raw of c.userRegions) {
    const n = normalizeUserRegion(raw);
    if (!n) issues.push(`unknown user region "${raw}" (known: india, singapore, us-east, us-west, europe, japan, australia, brazil)`);
    else if (!userRegions.includes(n)) userRegions.push(n);
  }
  if (c.userRegions.length === 0) issues.push("constraints.userRegions is empty: at least one user region is needed to estimate latency");
  userRegions.sort(cmp);
  const residency = c.residency && c.residency.length > 0 ? [...new Set(c.residency.map(normalizeResidencyToken))].sort(cmp) : undefined;
  const denylist = new Set((c.providerDenylist ?? []).map((p) => p.trim().toLowerCase()));
  const preference = [...new Set((c.providerPreference ?? []).map((p) => p.trim().toLowerCase()))];
  const pins: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.componentProviders ?? {})) pins[k] = v.trim().toLowerCase();
  for (const p of preference) if (!providersInCatalog.includes(p)) issues.push(`preferred provider "${p}" has no price catalog`);
  return { userRegions, residency, denylist, preference, pins, issues };
}

function inputFailure(seed: string, version: string, issues: string[], assumptions: string[]): PlacementResult {
  return { alternatives: [], rejected: [{ id: "input", reasons: issues }], assumptions, catalogVersion: version, deterministicSeed: seed };
}

/* ---------------------------------- solve ---------------------------------- */

interface Evaluated {
  spec: CandidateSpec;
  reasons: string[];
  candidate?: PlacementCandidate;
  placed?: PlacedGraph;
  cost?: CostEstimate;
  forced: boolean;
}

export function solvePlacement(input: SolveInput): PlacementResult {
  const book = toPriceBook(input.catalog);
  const catalogVersion = book.catalog.version;
  const options = input.options ?? {};
  if (options.minimumAvailabilityZones !== undefined && (!Number.isInteger(options.minimumAvailabilityZones) || options.minimumAvailabilityZones < 1 || options.minimumAvailabilityZones > 3)) {
    throw new PlacementInputError("options.minimumAvailabilityZones must be an integer from 1 to 3.");
  }
  const constraints = input.constraints;
  validateConstraints(constraints);
  const usage = resolveUsage(constraints.usage);
  const extendedUsage = resolveExtendedUsage(constraints.usage);

  const components = [...input.components].sort((a, b) => cmp(a.address, b.address));
  const addresses = new Set<string>();
  for (const c of components) {
    if (addresses.has(c.address)) throw new PlacementInputError(`Duplicate component address ${c.address}.`);
    addresses.add(c.address);
  }
  const edges: PlacementEdge[] = [...(input.edges ?? deriveEdges(components))].sort((a, b) => cmp(`${a.from}>${a.to}>${a.relation ?? ""}`, `${b.from}>${b.to}>${b.relation ?? ""}`));

  const knownProviders = placementProviders().filter((p) => book.providers().includes(p));
  const norm = normalizeConstraints(constraints, knownProviders);

  const seed = digest({
    v: 1,
    catalogVersion,
    components: components.map((c) => ({ address: c.address, name: c.name ?? null, kind: c.kind, size: c.size ?? null, spec: c.spec ?? {}, ownership: c.ownership ?? "managed", pin: c.pin ?? null })),
    edges,
    constraints: {
      budgetUsdMonthly: constraints.budgetUsdMonthly ?? null,
      userRegions: norm.userRegions,
      residency: norm.residency ?? null,
      latencyTargetMs: constraints.latencyTargetMs ?? null,
      availabilityTarget: constraints.availabilityTarget ?? null,
      providerPreference: norm.preference,
      providerDenylist: [...norm.denylist].sort(cmp),
      componentProviders: norm.pins,
      tolerateSingleFailure: constraints.tolerateSingleFailure ?? false,
      managedDatabaseRequired: constraints.managedDatabaseRequired ?? false,
      usage,
      ...(Object.keys(extendedUsage).length > 0 ? { extendedUsage } : {}),
    },
    options: {
      includeZenithManagedTier: options.includeZenithManagedTier ?? false,
      backupRetentionDays: options.backupRetentionDays ?? null,
      maxAlternatives: options.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES,
      now: options.now ?? null,
      ...(options.minimumAvailabilityZones !== undefined ? { minimumAvailabilityZones: options.minimumAvailabilityZones } : {}),
    },
  });

  const req = deriveRequirements(constraints);
  if (options.minimumAvailabilityZones !== undefined) {
    req.azCount = Math.max(req.azCount, options.minimumAvailabilityZones);
    req.reasons.push(`minimumAvailabilityZones: at least ${options.minimumAvailabilityZones} availability zone(s) from manifest placement or provider requirements`);
  }
  const assumptions: string[] = [];
  const weak = weakSummary(book);
  assumptions.push(
    `Prices come from catalog ${catalogVersion}, a static list-price snapshot; ${weak} Estimates are not invoices.`,
    LATENCY_TABLE_SOURCE,
    `Usage modeled: ${usage.egressGb} GB internet egress, ${usage.requestsMillions} M requests, ${usage.storageGb} GB per object store, ${usage.dbStorageGb} GB per database, ${usage.logGbPerService} GB logs per service per month; ${pct(usage.interComponentFraction)} of egress assumed to flow between components across a boundary.`,
    `Score is a weighted penalty (lower is better): cost x${SCORE_WEIGHTS.cost}, latency x${SCORE_WEIGHTS.latency}, target overshoot x${SCORE_WEIGHTS.latencyOvershoot}, complexity x${SCORE_WEIGHTS.complexity}, preference bonus x${SCORE_WEIGHTS.preference}; ties break on candidate id.`,
    ...req.reasons.map((r) => `Availability rule: ${r}.`),
  );

  // Semantic input problems come back as a result, not an exception.
  const pins = resolvePins(components, norm.pins);
  const issues = [...norm.issues];
  for (const k of pins.unresolved) issues.push(`componentProviders key "${k}" matches no component (components: ${components.map((c) => c.address).join(", ") || "none"})`);
  issues.push(...pins.conflicts);
  const allowedProviders = new Set<string>();
  for (const p of knownProviders) {
    if (norm.denylist.has(p)) continue;
    if (p === "zenith" && !(options.includeZenithManagedTier || norm.preference.includes("zenith") || [...pins.byAddress.values()].includes("zenith"))) continue;
    allowedProviders.add(p);
  }
  if (!allowedProviders.has("zenith") && knownProviders.includes("zenith") && !norm.denylist.has("zenith")) {
    assumptions.push("The zenith managed tier was not considered: its catalog prices are internal assumptions. Set options.includeZenithManagedTier, prefer or pin it to include it.");
  }
  const pinnedProviders = new Set<string>();
  for (const [addr, p] of pins.byAddress) {
    const c = components.find((x) => x.address === addr)!;
    if (isFixed(c)) continue;
    pinnedProviders.add(p);
    if (norm.denylist.has(p)) issues.push(`component ${addr} is pinned to ${p}, which is on the provider denylist`);
    else if (!knownProviders.includes(p)) issues.push(`component ${addr} is pinned to provider "${p}", which has no price catalog`);
  }
  if (constraints.managedDatabaseRequired && !components.some((c) => c.kind === "postgres" || c.kind === "mysql")) {
    issues.push("managedDatabaseRequired is set but the graph has no managed database component to place");
  }
  if (issues.length > 0) return inputFailure(seed, catalogVersion, issues, assumptions);

  // Region pools per provider after the residency filter (residency and zones rejections are reported per single candidate).
  const regionsOf = (p: string): string[] => book.regions(p).filter((r) => regionInfo(p, r) !== undefined);
  const residencyOk = (p: string, r: string) => {
    const ri = regionInfo(p, r);
    return ri !== undefined && regionSatisfiesResidency(ri, norm.residency);
  };
  const userRttSum = (p: string, r: string) => norm.userRegions.reduce((s, u) => s + userToRegionRttMs(u, p, r), 0);
  const maxUserP95 = (p: string, r: string) => Math.max(...norm.userRegions.map((u) => estimateP95Ms(userToRegionRttMs(u, p, r))));

  const providerList = [...allowedProviders].sort(cmp);
  const rejected: { id: string; reasons: string[] }[] = [];
  for (const p of knownProviders) {
    if (norm.denylist.has(p)) rejected.push({ id: `provider:${p}`, reasons: [`denylist: provider ${p} is on the provider denylist`] });
  }

  const specs: CandidateSpec[] = [];
  for (const p of providerList) for (const r of regionsOf(p)) specs.push(singleSpec(p, r));

  // Multi-region trigger.
  const multiReasons: string[] = [];
  if (req.multiRegionRequired) multiReasons.push(`availability target ${constraints.availabilityTarget}% needs a second region`);
  const farApart = maxPairwiseUserRtt(norm.userRegions);
  if (farApart > FAR_APART_RTT_MS) multiReasons.push(`user regions are far apart (${farApart} ms approximate RTT between the furthest pair, above ${FAR_APART_RTT_MS} ms)`);
  if (constraints.latencyTargetMs !== undefined) {
    const target = constraints.latencyTargetMs;
    const anySingleMeets = providerList.some((p) => regionsOf(p).some((r) => residencyOk(p, r) && maxUserP95(p, r) <= target));
    if (!anySingleMeets) multiReasons.push(`no single region keeps estimated p95 at or under ${target} ms for every user region`);
  }
  if (multiReasons.length > 0) {
    assumptions.push(`Multi-region candidates were considered because ${multiReasons.join("; ")}.`);
    for (const p of providerList) specs.push(...enumerateMulti(p, regionsOf(p).filter((r) => residencyOk(p, r)), userRttSum));
  } else {
    assumptions.push("Multi-region candidates were not considered: availability target below 99.99%, user regions close together, and every latency target is met by a single region.");
  }

  // Cross-cloud trigger.
  const forcedMix = pinnedProviders.size >= 2;
  const preferMix = norm.preference.filter((p) => allowedProviders.has(p)).length >= 2;
  if (forcedMix || preferMix) {
    const mixSet = [...new Set([...pinnedProviders, ...norm.preference.filter((p) => allowedProviders.has(p))])].filter((p) => allowedProviders.has(p)).sort(cmp);
    const movable = components.filter((c) => !isFixed(c) && (c.ownership ?? "managed") === "managed");
    const groups: { name: string; provider?: string }[] = [];
    if (movable.some((c) => !pins.byAddress.has(c.address) && tierOf(c.kind) === "app")) groups.push({ name: "app" });
    if (movable.some((c) => !pins.byAddress.has(c.address) && tierOf(c.kind) === "data")) groups.push({ name: "data" });
    for (const p of [...new Set(movable.map((c) => pins.byAddress.get(c.address)).filter((x): x is string => x !== undefined))].sort(cmp)) groups.push({ name: `pin:${p}`, provider: p });
    const mixed = enumerateMixed({ groups, mixSet, regionsOf: (p) => regionsOf(p).filter((r) => residencyOk(p, r)) });
    specs.push(...mixed);
    assumptions.push(
      forcedMix
        ? `Cross-cloud candidates are forced: component pins name ${[...pinnedProviders].sort(cmp).join(" and ")}. Their cross-cloud egress, latency and complexity are costed.`
        : `Cross-cloud candidates were considered because the provider preference lists ${norm.preference.join(", ")}; each must save at least ${pct(CROSS_CLOUD_SAVINGS_MARGIN)} of the cheapest single-provider cost after egress and ${COMPLEXITY_USD_PER_EXTRA_PROVIDER} USD per extra provider of complexity.`,
    );
  } else {
    assumptions.push("Cross-cloud candidates were not considered: no pins name different providers and the provider preference does not list two.");
  }

  const evaluate = (spec: CandidateSpec): Evaluated => {
    const reasons = staticReasons(spec, components, pins.byAddress, req, norm.residency, constraints);
    const forced = spec.topology === "cross_cloud" && forcedMix;
    if (reasons.length > 0) return { spec, reasons, forced };
    const placed = buildPlacedGraph({ components, edges, spec, req, pins: pins.byAddress });
    let cost: CostEstimate;
    try {
      cost = estimateGraphCost({ nodes: placed.nodes, edges: placed.edges }, { catalog: book, usage: constraints.usage, backupRetentionDays: options.backupRetentionDays, now: options.now });
    } catch (e) {
      if (e instanceof MissingPriceError) return { spec, reasons: [`price: ${e.message}`], forced };
      throw e;
    }
    const budget = constraints.budgetUsdMonthly;
    if (budget !== undefined && cost.monthlyUsd > budget) {
      reasons.push(budgetReason(cost.monthlyUsd, budget));
    }
    const assessment = assess(placed, norm.userRegions, book, constraints, options);
    const candidate: PlacementCandidate = {
      id: spec.id,
      assignments: placed.assignments,
      cost,
      latencyMs: assessment.latencyMs,
      crossBoundary: assessment.crossBoundary,
      score: 0,
      scoreBreakdown: {},
      warnings: candidateWarnings(spec, cost, assessment.latencyMs, constraints, placed),
      topology: spec.topology,
      availabilityZones: placed.availabilityZones,
      specOverrides: placed.specOverrides,
    };
    return { spec, reasons, candidate, placed, cost, forced };
  };

  const evaluated = specs.map(evaluate);

  // Cross-cloud savings margin against the cheapest surviving single-provider candidate.
  const singleProvider = evaluated.filter((e) => e.candidate && e.reasons.length === 0 && e.spec.topology !== "cross_cloud");
  const bestSingle = singleProvider.reduce<Evaluated | undefined>((best, e) => (!best || e.cost!.monthlyUsd < best.cost!.monthlyUsd || (e.cost!.monthlyUsd === best.cost!.monthlyUsd && e.spec.id < best.spec.id) ? e : best), undefined);
  for (const e of evaluated) {
    if (!e.candidate || e.reasons.length > 0 || e.spec.topology !== "cross_cloud" || e.forced || !bestSingle) continue;
    const complexityUsd = COMPLEXITY_USD_PER_EXTRA_PROVIDER * (e.spec.providers.length - 1);
    const egressUsd = e.candidate.crossBoundary.reduce((s, x) => s + x.egressUsdMonthly, 0);
    const baseline = bestSingle.cost!.monthlyUsd;
    const net = baseline - e.cost!.monthlyUsd - complexityUsd;
    if (net < CROSS_CLOUD_SAVINGS_MARGIN * baseline) {
      const diff = baseline - e.cost!.monthlyUsd;
      e.reasons.push(
        `cross-cloud margin: costs $${money(e.cost!.monthlyUsd)}/month including $${money(egressUsd)} cross-cloud transfer, against $${money(baseline)} for ${bestSingle.spec.id}; that is ${diff >= 0 ? `$${money(diff)} cheaper` : `$${money(-diff)} dearer`}, and after $${money(complexityUsd)} of complexity the net saving is ${net >= 0 ? `$${money(net)}` : `-$${money(-net)}`}, below the required ${pct(CROSS_CLOUD_SAVINGS_MARGIN)} margin of $${money(CROSS_CLOUD_SAVINGS_MARGIN * baseline)}`,
      );
    }
  }

  for (const e of evaluated) if (e.reasons.length > 0) rejected.push({ id: e.spec.id, reasons: e.reasons });
  const feasible = evaluated.filter((e) => e.candidate && e.reasons.length === 0);

  // Score.
  const minCost = feasible.length > 0 ? Math.min(...feasible.map((e) => e.cost!.monthlyUsd)) : 0;
  const target = constraints.latencyTargetMs;
  for (const e of feasible) {
    const cand = e.candidate!;
    const maxLat = Math.max(...Object.values(cand.latencyMs));
    const costTerm = SCORE_WEIGHTS.cost * ((e.cost!.monthlyUsd - minCost) / Math.max(minCost, 1));
    const latencyTerm = SCORE_WEIGHTS.latency * (maxLat / (target ?? LATENCY_REFERENCE_MS));
    const overshoot = target !== undefined ? Math.max(0, (maxLat - target) / target) : 0;
    const overshootTerm = SCORE_WEIGHTS.latencyOvershoot * overshoot;
    const extraProviders = e.spec.providers.length - 1;
    const distinctSites = new Set(Object.values(e.spec.sites).map(siteKey)).size;
    const extraRegions = e.spec.topology === "multi_region" ? 1 : e.spec.topology === "cross_cloud" ? Math.max(0, distinctSites - e.spec.providers.length) : 0;
    const complexityTerm = SCORE_WEIGHTS.complexity * (COMPLEXITY_POINTS_PER_EXTRA_PROVIDER * extraProviders + COMPLEXITY_POINTS_PER_EXTRA_REGION * extraRegions);
    const prefTerm = -SCORE_WEIGHTS.preference * preferenceRank(e.spec.providers, norm.preference);
    cand.scoreBreakdown = {
      monthlyUsd: e.cost!.monthlyUsd,
      maxLatencyMs: maxLat,
      costPenalty: q6(costTerm),
      latencyPenalty: q6(latencyTerm),
      overshootPenalty: q6(overshootTerm),
      complexityPenalty: q6(complexityTerm),
      preferenceBonus: q6(prefTerm),
    };
    cand.score = q6(costTerm + latencyTerm + overshootTerm + complexityTerm + prefTerm);
  }
  const ranked = feasible.map((e) => e.candidate!).sort((a, b) => a.score - b.score || cmp(a.id, b.id));
  const maxAlt = Math.max(0, options.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES);
  rejected.sort((a, b) => cmp(a.id, b.id));

  return {
    ...(ranked[0] ? { chosen: ranked[0] } : {}),
    alternatives: ranked.slice(1, 1 + maxAlt),
    rejected,
    assumptions,
    catalogVersion,
    deterministicSeed: seed,
  };
}

/* -------------------------------- internals -------------------------------- */

function weakSummary(book: PriceBook): string {
  const v = verificationSummary(book.catalog);
  const strong = v.official_api + v.official_page;
  const weak = v.model_knowledge + v.derived + v.internal_assumption;
  return `${strong} of ${book.catalog.entries.length} catalog entries were read from a provider price feed or page, ${v.third_party_mirror} from a third-party mirror of one, and ${weak} are remembered, derived or internal assumptions (see the catalog sources).`;
}

function maxPairwiseUserRtt(users: readonly UserRegion[]): number {
  let max = 0;
  for (let i = 0; i < users.length; i++) for (let j = i + 1; j < users.length; j++) max = Math.max(max, geoRttMs(userRegionGeo(users[i]!), userRegionGeo(users[j]!)));
  return max;
}

function preferenceRank(providers: readonly string[], preference: readonly string[]): number {
  if (preference.length === 0 || providers.length === 0) return 0;
  const n = preference.length;
  const sum = providers.reduce((s, p) => {
    const i = preference.indexOf(p);
    return s + (i < 0 ? 0 : (n - i) / n);
  }, 0);
  return sum / providers.length;
}

function siteKey(s: Site): string {
  return `${s.provider}/${s.region}`;
}

/** Hard filters that need no price: capability, residency, zones, pins, multi-region requirement. All reasons are collected. */
function staticReasons(
  spec: CandidateSpec,
  components: readonly PlacementComponent[],
  pins: ReadonlyMap<string, string>,
  req: Requirements,
  residency: readonly string[] | undefined,
  constraints: PlacementConstraints,
): string[] {
  const reasons = new Set<string>();
  const movable = components.filter((c) => !isFixed(c) && (c.ownership ?? "managed") === "managed");
  const sitesUsed = new Map<string, Site>();
  const gaps = new Map<string, Set<string>>();
  for (const c of movable) {
    const site = siteOf(c, spec, pins);
    sitesUsed.set(siteKey(site), site);
    if (!nativeTypeFor(site.provider, c.kind as PortableKind)) {
      const set = gaps.get(site.provider) ?? new Set<string>();
      set.add(c.kind);
      gaps.set(site.provider, set);
    }
    const pin = pins.get(c.address);
    if (spec.topology !== "cross_cloud" && pin && pin !== site.provider) {
      reasons.add(`pin: component ${c.address} is pinned to ${pin} but this candidate places it on ${site.provider}`);
    }
  }
  if (spec.secondary) sitesUsed.set(siteKey(spec.secondary), spec.secondary);
  for (const [provider, kinds] of [...gaps].sort(([a], [b]) => cmp(a, b))) {
    reasons.add(`capability: ${provider} has no native type for ${[...kinds].sort(cmp).map((k) => `"${k}"`).join(", ")}`);
  }
  for (const site of [...sitesUsed.values()].sort((a, b) => cmp(siteKey(a), siteKey(b)))) {
    const ri = regionInfo(site.provider, site.region);
    if (!ri) {
      reasons.add(`region: ${siteKey(site)} is not in the latency and residency table`);
      continue;
    }
    if (!regionSatisfiesResidency(ri, residency)) {
      reasons.add(`residency: ${siteKey(site)} (${ri.city}, ${ri.country}) is outside the allowed jurisdictions [${(residency ?? []).join(", ")}]`);
    }
    const az = Math.max(req.azCount, site.provider === "aws" && components.some((c) => c.kind === "load_balancer") ? 2 : 1);
    if (ri.zones < az) {
      reasons.add(`availability: ${siteKey(site)} offers ${ri.zones} availability zone(s) but ${az} are required (${req.reasons[0] ?? "load balancer requirement"})`);
    }
  }
  if (req.multiRegionRequired && spec.topology === "single_region") {
    reasons.add(`availability: target ${constraints.availabilityTarget}% needs at least two regions; a single region is one failure domain`);
  }
  if (req.multiRegionRequired && spec.topology === "cross_cloud") {
    reasons.add(`availability: target ${constraints.availabilityTarget}% needs a second region; cross-cloud candidates here use one region per group`);
  }
  return [...reasons].sort(cmp);
}

interface Assessment {
  latencyMs: Record<string, number>;
  crossBoundary: PlacementCandidate["crossBoundary"];
}

const SERVING_KINDS: ReadonlySet<string> = new Set([...COMPUTE_KINDS, "load_balancer", "static_site"]);
const TRAFFIC = new Set(["routes_to", "connects_to", "publishes_to", "consumes_from"]);

function assess(placed: PlacedGraph, users: readonly UserRegion[], book: PriceBook, constraints: PlacementConstraints, options: SolveOptions): Assessment {
  const site = new Map<string, Site>();
  for (const n of placed.nodes) site.set(n.address, { provider: n.provider, region: n.region });
  const serving = new Map<string, Site>();
  for (const n of placed.nodes) if (SERVING_KINDS.has(n.kind) && (n.ownership ?? "managed") === "managed") serving.set(siteKey(site.get(n.address)!), site.get(n.address)!);
  if (serving.size === 0) for (const s of site.values()) serving.set(siteKey(s), s);
  const servingSites = [...serving.values()].sort((a, b) => cmp(siteKey(a), siteKey(b)));

  const transfers = listCrossBoundaryTransfers({ nodes: placed.nodes, edges: placed.edges }, { catalog: book, usage: constraints.usage, backupRetentionDays: options.backupRetentionDays, now: options.now });
  const usdByPair = new Map(transfers.map((t) => [`${t.from}>${t.to}`, t.usd]));

  const crossBoundary: PlacementCandidate["crossBoundary"] = [];
  const seen = new Set<string>();
  for (const e of [...placed.edges].sort((a, b) => cmp(`${a.from}>${a.to}`, `${b.from}>${b.to}`))) {
    if (!TRAFFIC.has(e.relation)) continue;
    const a = site.get(e.from);
    const b = site.get(e.to);
    if (!a || !b || siteKey(a) === siteKey(b)) continue;
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // the sender is the callee for request/response edges and the caller for publishes
    const senderIsFrom = e.relation === "publishes_to";
    const sender = senderIsFrom ? e.from : e.to;
    const receiver = senderIsFrom ? e.to : e.from;
    crossBoundary.push({
      from: e.from,
      to: e.to,
      kind: a.provider === b.provider ? "cross_region" : "cross_cloud",
      egressUsdMonthly: Math.round((usdByPair.get(`${sender}>${receiver}`) ?? 0) * 100) / 100,
      addedLatencyMs: regionToRegionRttMs(a, b),
    });
  }

  const latencyMs: Record<string, number> = {};
  for (const u of users) {
    let best: Site | undefined;
    let bestRtt = Infinity;
    for (const s of servingSites) {
      const rtt = userToRegionRttMs(u, s.provider, s.region);
      if (rtt < bestRtt) {
        bestRtt = rtt;
        best = s;
      }
    }
    let added = 0;
    if (best) {
      for (const e of placed.edges) {
        if (!TRAFFIC.has(e.relation) || e.relation === "publishes_to") continue;
        const a = site.get(e.from);
        const b = site.get(e.to);
        const from = placed.nodes.find((n) => n.address === e.from);
        if (!a || !b || !from || !SERVING_KINDS.has(from.kind) || siteKey(a) !== siteKey(best) || siteKey(b) === siteKey(best)) continue;
        added = Math.max(added, regionToRegionRttMs(a, b));
      }
    }
    latencyMs[u] = estimateP95Ms(bestRtt + added);
  }
  return { latencyMs, crossBoundary };
}

function candidateWarnings(spec: CandidateSpec, cost: CostEstimate, latencyMs: Record<string, number>, constraints: PlacementConstraints, placed: PlacedGraph): string[] {
  const w: string[] = [...placed.warnings];
  for (const p of spec.providers) {
    if (p !== "aws" && p !== "zenith") w.push(`${p}: placement checks price and native-type capability only; Zenith's ${p} resource drivers may not exist yet (AWS is the first complete provider), so this candidate may not be applicable today.`);
  }
  if (spec.providers.includes("zenith")) w.push("zenith: managed-tier prices are internal assumptions, not published rates.");
  const azureLb = cost.lines.filter((l) => l.sku === "azure.app_gateway.hour").reduce((s, l) => s + l.monthlyUsd, 0);
  if (azureLb >= 50) {
    w.push(`azure: the load balancer is priced as Application Gateway Standard v2 ($${money(azureLb)}/month fixed fee); Container Apps built-in ingress or Standard Load Balancer would cost far less if the design allows it.`);
  }
  if (spec.topology === "cross_cloud") {
    w.push("Cross-cloud: adds identity federation between the providers, two control planes and a public-internet hop between components; its transfer cost and latency are included in the estimate.");
  }
  const weakUsd = Number(cost.assumptions.priceEvidenceWeakUsd ?? 0);
  if (cost.monthlyUsd > 0 && weakUsd / cost.monthlyUsd > WEAK_EVIDENCE_WARN_SHARE) {
    w.push(`${pct(weakUsd / cost.monthlyUsd)} ($${money(weakUsd)}) of this estimate rests on remembered, derived or internal prices that were not read from a provider price feed.`);
  }
  const target = constraints.latencyTargetMs;
  if (target !== undefined) {
    for (const [u, ms] of Object.entries(latencyMs).sort(([a], [b]) => cmp(a, b))) {
      if (ms > target) w.push(`latency: estimated p95 for ${u} users is ${ms} ms, above the ${target} ms target (approximate; p95 = ${P95_FACTOR} x table RTT).`);
    }
  }
  return w;
}
