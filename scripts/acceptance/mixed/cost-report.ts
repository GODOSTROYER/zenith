/**
 * `npx tsx scripts/acceptance/mixed/cost-report.ts [--egress-gb N] [--fraction F] [--residency us,eu] [--latency-ms N] [--json]`
 * (PROD-MIX-07). The estimate-only cost, latency and residency report of the reference mixed app's placement
 * (`fixtures/mixed-app/zenith.app.json`): GCP web, AWS enricher, Azure PostgreSQL, INCLUDING the cross-cloud transfer
 * each data-plane edge causes. It reads the bundled dated catalog and calls nothing. The same report for a STORED plan is
 * `GET /api/platform/v1/mixed/plans/:id/economics`.
 *
 * The graph is derived from the manifest's own services, resources, node placement and bindings, so the report cannot
 * drift from the fixture. Every figure is a list-price estimate, never an invoice or a billing cap.
 */
import { mixedEconomics, renderEconomics, type MixedEconomicsReport } from "@/lib/execution/mixed/economics";
import type { CostGraph, CostNode } from "@/lib/placement/cost";
import { loadDefaultCatalog } from "@/lib/placement/pricebook";
import type { CostUsage } from "@/lib/placement/types";
import manifest from "../../../fixtures/mixed-app/zenith.app.json";
import { parseArgs, UsageError } from "../args";

type ManifestShape = {
  services: { id: string; name: string; kind: string; size?: string; replicas?: number }[];
  resources: { id: string; name: string; kind: string; size?: string; config?: Record<string, string | number | boolean> }[];
  bindings: { from: string; to: string; capability: string }[];
  nodePlacement: Record<string, { provider: string; region?: string }>;
};

/** The reference app's cost graph, derived from its manifest. */
export function referenceCostGraph(source: ManifestShape = manifest as ManifestShape): CostGraph {
  const nodes: CostNode[] = [];
  const placed = (id: string, name: string): { provider: string; region: string } => {
    const entry = source.nodePlacement[id] ?? source.nodePlacement[name];
    if (!entry?.region) throw new Error(`The manifest does not place ${name} in a provider region.`);
    return { provider: entry.provider, region: entry.region };
  };
  for (const s of source.services) {
    const where = placed(s.id, s.name);
    // Public workloads: the protected endpoints are reached over public addresses (mutual TLS plus allowlist), so no NAT is assumed.
    nodes.push({ address: `service/${s.name}`, kind: "container_service", ...where, spec: { size: s.size ?? "small", replicas: s.replicas ?? 1, publicIp: true }, ownership: "managed" });
  }
  for (const r of source.resources) {
    const where = placed(r.id, r.name);
    nodes.push({ address: `resource/${r.name}`, kind: r.kind === "postgres" ? "postgres" : "object_store", ...where, spec: { size: r.size ?? "small", ...(r.config?.storageGb ? { storageGb: r.config.storageGb } : {}) }, ownership: "managed" });
  }
  const addressOf = new Map<string, string>([...source.services.flatMap((s) => [[s.id, `service/${s.name}`], [s.name, `service/${s.name}`]] as const), ...source.resources.flatMap((r) => [[r.id, `resource/${r.name}`], [r.name, `resource/${r.name}`]] as const)]);
  const edges = source.bindings.filter((b) => addressOf.has(b.from) && addressOf.has(b.to)).map((b) => ({ from: addressOf.get(b.from)!, to: addressOf.get(b.to)!, relation: "connects_to" }));
  return { nodes, edges };
}

export function referenceEconomics(options: { egressGb?: number; fraction?: number; residency?: readonly string[]; latencyBudgetMs?: number } = {}): MixedEconomicsReport {
  const usage: CostUsage = { ...(options.egressGb !== undefined ? { egressGb: options.egressGb } : {}), ...(options.fraction !== undefined ? { interComponentFraction: options.fraction } : {}) };
  return mixedEconomics({ graph: referenceCostGraph(), catalog: loadDefaultCatalog(), usage, ...(options.residency ? { residency: options.residency } : {}), ...(options.latencyBudgetMs !== undefined ? { latencyBudgetMs: options.latencyBudgetMs } : {}) });
}

export function runCostReportCli(argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } }): number {
  try {
    const args = parseArgs(argv, { booleans: ["json"], strings: ["egress-gb", "fraction", "residency", "latency-ms"] });
    const num = (name: string): number | undefined => {
      const raw = args.values.get(name);
      if (raw === undefined) return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${name} needs a non-negative number.`);
      return value;
    };
    const residency = args.values.get("residency")?.split(",").map((t) => t.trim()).filter(Boolean);
    const report = referenceEconomics({ ...(num("egress-gb") !== undefined ? { egressGb: num("egress-gb")! } : {}), ...(num("fraction") !== undefined ? { fraction: num("fraction")! } : {}), ...(residency ? { residency } : {}), ...(num("latency-ms") !== undefined ? { latencyBudgetMs: num("latency-ms")! } : {}) });
    io.out(`${args.flags.has("json") ? JSON.stringify(report, null, 2) : renderEconomics(report)}\n`);
    return report.priced && report.residency.satisfied ? 0 : 1;
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : "unexpected error"}\n`);
    return 2;
  }
}

if (process.argv[1] && /(?:^|[/\\])cost-report\.(?:ts|mts|js|mjs)$/.test(process.argv[1])) process.exitCode = runCostReportCli(process.argv.slice(2));
