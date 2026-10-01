/**
 * Demo J — multi-cloud planning. Plan only: it needs no cloud, no credentials
 * and no network, and it runs end to end on this machine.
 *
 * The chain, every link a merged module:
 *
 *   sample app files ─▶ repository analysis ─▶ proposed V1 manifest
 *     ─▶ V2 upgrade ─▶ resource graph (expandManifest) ─▶ placement components
 *     ─▶ placement solver under several constraint sets ─▶ cost + latency +
 *        cross-cloud egress ─▶ plain-text explanation
 *     ─▶ the chosen cross-cloud placement written back into the manifest
 *        (`nodePlacement`) and expanded and priced again
 *
 * What it can show: that the deterministic code, given an application and a set
 * of constraints, chooses a placement, prices it, costs the cross-cloud traffic
 * and explains itself, identically every time. What it cannot: that any of the
 * chosen providers has a driver that can build it today, that the catalog prices
 * are current (they are a static, partly remembered snapshot), or that the
 * latency table matches a real network. See `cannotProve`.
 */
import { createHash } from "node:crypto";
import { analyzeRepository, proposeArchitecture, snapshotFromFiles } from "@/lib/analysis";
import { digest } from "@/lib/controlplane/digest";
import { Manifest as ManifestV1Schema, type Manifest } from "@/lib/domain/types";
import { componentsFromGraph, estimateGraphCost, explainPlacement, loadDefaultCatalog, regionInfo, regionSatisfiesResidency, solvePlacement, type PlacementResult } from "@/lib/placement";
import { expandManifest, upgradeManifest, type ExpandEnv, type ManifestV2, type ResourceGraph } from "@/lib/resources";
import type { PassCriterion, ScenarioContext, ScenarioDefinition } from "../types";
import { checker, loadFixtureFiles } from "./_shared";

const CRITERIA: readonly PassCriterion[] = [
  { id: "analysis", text: "Analysing the sample app yields a web service on a port with a health path and a Postgres datastore, and a valid V1 manifest." },
  { id: "expansion", text: "The manifest expands to a resource graph with a network, load balancer and database, and expanding it twice gives byte-identical digests." },
  { id: "single-provider", text: "Under the spec's example constraints the solver picks a single-provider placement within budget, with at least two zones and a latency estimate for every user region." },
  { id: "cross-cloud", text: "Pinning the web tier and the database to different clouds yields a cross-cloud placement whose cross-boundary edges all carry a positive egress cost and a positive added latency, and the cost estimate contains a cross-cloud transfer line." },
  { id: "explanation", text: "The plain-text explanation of the cross-cloud placement states the cross-cloud egress per month and the added latency in milliseconds, says the number is an estimate and not an invoice, and warns about identity federation." },
  { id: "determinism", text: "Solving the same input again returns the same deterministic seed, the same chosen candidate id and the same monthly cost." },
  { id: "honest-refusal", text: "An impossible constraint (a $10/month budget) returns no placement with a reason per rejected candidate that quotes the numbers, rather than a made-up recommendation." },
  { id: "residency", text: "An EU residency constraint puts every component in an EU region." },
  { id: "written-back", text: "Writing the chosen cross-cloud placement back into the manifest and expanding it again produces a graph with cross-cloud notes, and that graph prices without error." },
  { id: "no-cloud", text: "The scenario ran without a cloud session, a control plane client or AWS credentials." },
];

const C = checker("J", CRITERIA);

const ENV: ExpandEnv = { id: "env-live-j", name: "sandbox", class: "sandbox", provider: "aws", region: "ap-south-1", baseDomain: "example.test" };
const NOW = "2026-09-30T00:00:00.000Z";

/** Everything the planning chain produced; also what the tests inspect. */
export interface PlanningResult {
  manifest: Manifest;
  v2: ManifestV2;
  graph: ResourceGraph;
  graphDigestAgain: string;
  analysis: { services: number; port?: number; healthPath?: string; datastores: string[] };
  example: PlacementResult;
  crossCloud: PlacementResult;
  crossCloudRepeat: PlacementResult;
  tooTight: PlacementResult;
  residency: PlacementResult;
  /** the V2 manifest with the chosen cross-cloud placement written into `nodePlacement` */
  placedManifest?: ManifestV2;
  placedGraph?: ResourceGraph;
  placedEstimateUsd?: number;
  placedError?: string;
  explanations: { example: string; crossCloud: string; tooTight: string };
}

/** Run the whole planning chain. Pure and deterministic; reads only the sample app's files. */
export function runPlanningChain(files: Record<string, string> = loadFixtureFiles()): PlanningResult {
  const requirements = analyzeRepository(snapshotFromFiles(files));
  const proposal = proposeArchitecture(requirements, { environmentClass: "sandbox", provider: "aws", regions: [ENV.region] });
  const manifest = ManifestV1Schema.parse(proposal.manifest);
  const web = requirements.services.find((s) => s.value.kind === "web");
  const v2 = upgradeManifest(manifest, { provider: "aws", region: ENV.region });
  const graph = expandManifest(v2, ENV);
  const graphAgain = expandManifest(v2, ENV);
  const { components, edges } = componentsFromGraph(graph);
  const catalog = loadDefaultCatalog();
  const solve = (constraints: Parameters<typeof solvePlacement>[0]["constraints"]) => solvePlacement({ components, edges, constraints, catalog, options: { now: NOW, maxAlternatives: 4 } });

  const example = solve({ userRegions: ["india", "singapore"], budgetUsdMonthly: 500, tolerateSingleFailure: true, managedDatabaseRequired: true });
  const crossConstraints = { userRegions: ["india"], componentProviders: { web: "aws", database: "gcp" } };
  const crossCloud = solve(crossConstraints);
  const crossCloudRepeat = solve(crossConstraints);
  const tooTight = solve({ userRegions: ["india", "singapore"], budgetUsdMonthly: 10 });
  const residency = solve({ userRegions: ["europe"], residency: ["eu"] });

  const result: PlanningResult = {
    manifest,
    v2,
    graph,
    graphDigestAgain: graphAgain.graphDigest,
    analysis: {
      services: requirements.services.length,
      port: web?.value.port?.value,
      healthPath: web?.value.healthPath?.value,
      datastores: requirements.datastores.map((d) => d.value.kind),
    },
    example,
    crossCloud,
    crossCloudRepeat,
    tooTight,
    residency,
    explanations: { example: explainPlacement(example), crossCloud: explainPlacement(crossCloud), tooTight: explainPlacement(tooTight) },
  };

  // Write the chosen cross-cloud placement back into the manifest and look at the consequences.
  const chosen = crossCloud.chosen;
  if (chosen) {
    try {
      const nodePlacement: NonNullable<ManifestV2["nodePlacement"]> = {};
      // Only manifest-level nodes (services and data resources) have a placement of their own; the
      // load balancer, firewalls, certificates and the like are derived from where those land.
      for (const node of graph.nodes) {
        if (!PRIMARY_KINDS.has(node.kind)) continue;
        const a = chosen.assignments[node.address];
        const key = node.origin[0];
        if (!a || !key || (a.provider === node.provider && a.region === node.region)) continue;
        if (a.provider === "aws" || a.provider === "gcp" || a.provider === "azure" || a.provider === "oci") nodePlacement[key] = { provider: a.provider, region: a.region };
      }
      const placedManifest: ManifestV2 = { ...v2, nodePlacement };
      const placedGraph = expandManifest(placedManifest, ENV);
      result.placedManifest = placedManifest;
      result.placedGraph = placedGraph;
      result.placedEstimateUsd = estimateGraphCost(placedGraph, { catalog, now: NOW }).monthlyUsd;
    } catch (err) {
      result.placedError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }
  return result;
}

/** Graph node kinds that come straight from a manifest service or resource (the only ones `nodePlacement` can move). */
const PRIMARY_KINDS: ReadonlySet<string> = new Set(["container_service", "scheduled_job", "static_site", "postgres", "mysql", "redis", "object_store", "queue"]);

const money = (n: number) => `$${n.toFixed(2)}`;

function recordChecks(ctx: ScenarioContext, r: PlanningResult): void {
  // analysis
  const a = r.analysis;
  C.expect(ctx, "analysis", a.services >= 1 && a.port !== undefined && a.healthPath !== undefined && a.datastores.includes("postgres"), `${a.services} service(s), port ${a.port ?? "none"}, health ${a.healthPath ?? "none"}, datastores [${a.datastores.join(", ")}]; manifest has ${r.manifest.services.length} service(s) and ${r.manifest.resources.length} resource(s).`);

  // expansion
  const kinds = new Set(r.graph.nodes.map((n) => n.kind));
  C.expect(ctx, "expansion", kinds.has("network") && kinds.has("load_balancer") && kinds.has("postgres") && r.graph.graphDigest === r.graphDigestAgain, `${r.graph.nodes.length} nodes; graph digest ${r.graph.graphDigest.slice(0, 12)}, re-expanded ${r.graphDigestAgain.slice(0, 12)}.`);

  // single provider
  const ex = r.example.chosen;
  C.expect(ctx, "single-provider", !!ex && ex.topology === "single_region" && ex.cost.monthlyUsd <= 500 && (ex.availabilityZones ?? 0) >= 2 && ["india", "singapore"].every((u) => (ex.latencyMs[u] ?? 0) > 0), ex ? `${ex.id} at ${money(ex.cost.monthlyUsd)}/month, ${ex.availabilityZones} zones, latency ${JSON.stringify(ex.latencyMs)}.` : "no placement was chosen");

  // cross-cloud
  const cc = r.crossCloud.chosen;
  const edges = cc?.crossBoundary.filter((e) => e.kind === "cross_cloud") ?? [];
  const transferLine = cc?.cost.lines.find((l) => l.description.startsWith("Cross-cloud transfer"));
  C.expect(ctx, "cross-cloud", !!cc && cc.topology === "cross_cloud" && edges.length > 0 && edges.every((e) => e.egressUsdMonthly > 0 && e.addedLatencyMs > 0) && !!transferLine, cc ? `${cc.id}: ${edges.map((e) => `${e.from} -> ${e.to} ${money(e.egressUsdMonthly)}/month +${e.addedLatencyMs} ms`).join("; ")}.` : "no cross-cloud placement was chosen");

  // explanation
  const text = r.explanations.crossCloud;
  const mentionsEdge = edges.length > 0 && edges.every((e) => text.includes(`${money(e.egressUsdMonthly)}/month, +${e.addedLatencyMs} ms`));
  C.expect(ctx, "explanation", mentionsEdge && /cross-cloud/.test(text) && /not an invoice/.test(text) && /identity federation/.test(text), mentionsEdge ? "the explanation lists every cross-cloud edge with its egress and latency." : "the explanation does not state every cross-cloud edge's egress and latency.");

  // determinism
  const same = r.crossCloud.deterministicSeed === r.crossCloudRepeat.deterministicSeed && r.crossCloud.chosen?.id === r.crossCloudRepeat.chosen?.id && r.crossCloud.chosen?.cost.monthlyUsd === r.crossCloudRepeat.chosen?.cost.monthlyUsd;
  C.expect(ctx, "determinism", same, `seed ${r.crossCloud.deterministicSeed.slice(0, 12)} / ${r.crossCloudRepeat.deterministicSeed.slice(0, 12)}.`);

  // honest refusal
  const t = r.tooTight;
  const numeric = t.rejected.length > 0 && t.rejected.every((x) => x.reasons.length > 0) && t.rejected.some((x) => x.reasons.some((y) => /^budget:.*\$\d/.test(y)));
  C.expect(ctx, "honest-refusal", t.chosen === undefined && numeric, t.chosen ? `unexpectedly chose ${t.chosen.id}` : `${t.rejected.length} candidates rejected; example: ${t.rejected[0]?.reasons[0] ?? "none"}`);

  // residency
  const rs = r.residency.chosen;
  const allEu = !!rs && Object.values(rs.assignments).every((a) => {
    const info = regionInfo(a.provider, a.region);
    return !!info && regionSatisfiesResidency(info, ["eu"]);
  });
  C.expect(ctx, "residency", allEu, rs ? `${rs.id}: ${[...new Set(Object.values(rs.assignments).map((a) => `${a.provider}/${a.region}`))].join(", ")}.` : "no EU placement was chosen");

  // written back
  const crossNotes = r.placedGraph?.notes.filter((n) => /^cross_cloud:|cross_cloud/.test(n)) ?? [];
  const delta = r.placedEstimateUsd !== undefined && cc ? r.placedEstimateUsd - cc.cost.monthlyUsd : undefined;
  C.expect(
    ctx,
    "written-back",
    !r.placedError && crossNotes.length > 0 && r.placedEstimateUsd !== undefined,
    r.placedError
      ? `re-expansion failed: ${r.placedError}`
      : `${crossNotes.length} cross-cloud note(s); the expanded graph prices at ${r.placedEstimateUsd !== undefined ? money(r.placedEstimateUsd) : "n/a"}/month against the solver's ${cc ? money(cc.cost.monthlyUsd) : "n/a"} (difference ${delta !== undefined ? money(delta) : "n/a"}; the two use different graphs, so they are reported, not asserted equal).`,
  );

  // no cloud
  C.expect(ctx, "no-cloud", ctx.session === undefined && ctx.controlPlane === undefined && ctx.evidence.provenance !== "live", "no live session and no control plane client were present.");
}

export const demoJ: ScenarioDefinition = {
  id: "J",
  title: "Multi-cloud planning (plan only)",
  summary: "From the sample app to a priced, explained placement across clouds: analysis, manifest, resource graph, placement solver, cross-cloud egress and latency, written back into the manifest. No cloud is contacted.",
  needs: { cloud: "none", controlPlane: false, temporal: false },
  mutates: false,
  createsResources: false,
  dependsOn: [],
  prerequisites: [{ id: "sample-app", description: "the sample app is present at fixtures/acceptance-app", kind: "offline", check: () => (Object.keys(safeFiles()).length > 0 ? { ok: true } : { ok: false, detail: "fixtures/acceptance-app was not found; run from the repository root" }) }],
  steps: [
    {
      id: "plan-chain",
      title: "Analyse, expand, solve, price, explain, write back",
      effect: "none",
      plan: () => [
        "read the files of fixtures/acceptance-app (no network)",
        "analyzeRepository -> proposeArchitecture -> V1 manifest -> upgradeManifest (aws, ap-south-1) -> expandManifest",
        "solvePlacement for four constraint sets: the spec example (India + Singapore, $500, survive one failure), forced cross-cloud pins (web on aws, database on gcp), an impossible $10 budget, EU residency",
        "re-solve the cross-cloud case to prove determinism",
        "write the chosen placement into the manifest as nodePlacement, expand again and price the result",
      ],
      async run(ctx) {
        const r = runPlanningChain();
        ctx.state.set("j.result", r);
        ctx.state.set("j.report", renderReport(r));
        ctx.log(renderReport(r));
        ctx.evidence.note(renderReport(r), "J");
        for (const [label, p] of [["example", r.example], ["cross-cloud", r.crossCloud], ["tight-budget", r.tooTight], ["residency", r.residency]] as const) {
          ctx.evidence.planDigest("J", `placement seed (${label})`, p.deterministicSeed);
        }
        ctx.evidence.planDigest("J", "manifest digest", digest(r.manifest));
        ctx.evidence.planDigest("J", "resource graph digest", r.graph.graphDigest);
        recordChecks(ctx, r);
        return { detail: `${r.graph.nodes.length} graph nodes; ${r.crossCloud.chosen?.id ?? "no cross-cloud placement"}` };
      },
    },
  ],
  passCriteria: CRITERIA,
  proves: [
    "The merged analysis, resource-expansion and placement modules compose end to end on a real application's files.",
    "The solver is deterministic: the same inputs give the same seed, choice and cost.",
    "Cross-cloud placements are costed (egress per month) and carry added latency, and the explanation says so.",
    "Impossible constraints produce a refusal with numbers, not a recommendation; residency is a hard filter.",
  ],
  cannotProve: [
    "That any chosen provider can actually build the placement: placement checks price and native-type capability, not whether a driver exists (GCP, Azure and OCI drivers are not implemented; AWS is first).",
    "That the prices are current: the catalog is a static snapshot, partly remembered or derived rather than read from a provider feed, and the estimate says how much of it rests on weak evidence.",
    "That latency numbers match a real network: they come from an approximate geographic table.",
    "Anything about a real cloud, credentials, the control plane or Temporal: none of them is touched.",
  ],
  blockedOn: [],
  runsLocally: true,
  costNote: "free: no cloud is contacted",
};

function safeFiles(): Record<string, string> {
  try {
    return loadFixtureFiles();
  } catch {
    return {};
  }
}

/** The human-readable report: the explanations plus a fixed header. Stable for a given input. */
export function renderReport(r: PlanningResult): string {
  const hash = createHash("sha256").update(JSON.stringify([r.example.deterministicSeed, r.crossCloud.deterministicSeed])).digest("hex").slice(0, 12);
  return [
    `Demo J: planning for the Zenith sample app (report ${hash}).`,
    `Analysis: ${r.analysis.services} service(s), port ${r.analysis.port ?? "?"}, health ${r.analysis.healthPath ?? "?"}, datastores [${r.analysis.datastores.join(", ")}]; graph of ${r.graph.nodes.length} nodes (${r.graph.graphDigest.slice(0, 12)}).`,
    "",
    "== Constraint set 1: users in India and Singapore, at most $500/month, survive one failure, managed Postgres ==",
    r.explanations.example,
    "",
    "== Constraint set 2: web pinned to aws, database pinned to gcp (cross-cloud) ==",
    r.explanations.crossCloud,
    "",
    "== Constraint set 3: an impossible $10/month budget ==",
    r.explanations.tooTight,
    "",
    `== Written back: ${r.placedError ? `FAILED (${r.placedError})` : `${r.placedGraph?.nodes.length ?? 0} nodes, ${r.placedGraph?.notes.filter((n) => /cross_cloud/.test(n)).length ?? 0} cross-cloud note(s), priced at ${r.placedEstimateUsd !== undefined ? money(r.placedEstimateUsd) : "n/a"}/month`} ==`,
  ].join("\n");
}
