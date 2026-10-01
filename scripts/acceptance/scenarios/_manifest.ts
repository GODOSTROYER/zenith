/**
 * The manifest the live scenarios deploy: the sample app, analysed by the merged
 * repository-analysis module (not hand-written), with a route host under the
 * operator's DNS zone and a local cost estimate from the merged cost engine.
 *
 * The estimate is what the cost guard checks BEFORE anything is created; the
 * plan's own cost (from the control plane) is checked again after planning.
 */
import { analyzeRepository, proposeArchitecture, snapshotFromFiles } from "@/lib/analysis";
import { Manifest as ManifestV1Schema, type Manifest } from "@/lib/domain/types";
import { estimateGraphCost, loadDefaultCatalog } from "@/lib/placement";
import { expandManifest, upgradeManifest, type ExpandEnv } from "@/lib/resources";
import { loadFixtureFiles } from "./_shared";

export interface LiveManifest {
  manifest: Manifest;
  /** local list-price estimate of the whole environment, USD/month */
  estimateUsd: number;
  /** the route host, when a DNS zone is configured */
  host?: string;
  summary: { services: number; resources: number; port?: number; healthPath?: string };
}

export function buildLiveManifest(opts: { runId: string; region: string; dnsZone?: string; replicas?: number; files?: Record<string, string> }): LiveManifest {
  const requirements = analyzeRepository(snapshotFromFiles(opts.files ?? loadFixtureFiles()));
  const proposal = proposeArchitecture(requirements, { environmentClass: "sandbox", provider: "aws", regions: [opts.region] });
  const parsed = ManifestV1Schema.parse(proposal.manifest);
  const web = parsed.services.find((s) => s.kind === "web");
  if (!web) throw new Error("The analysis of the sample app produced no web service.");
  if (!parsed.resources.some((r) => r.kind === "postgres")) throw new Error("The analysis of the sample app produced no Postgres resource.");

  const host = opts.dnsZone ? `${opts.runId}.${opts.dnsZone}` : undefined;
  const manifest: Manifest = {
    ...parsed,
    services: parsed.services.map((s) => (s.id === web.id && opts.replicas !== undefined ? { ...s, replicas: opts.replicas } : s)),
    routes: parsed.routes.map((r) => (host ? { ...r, host, managedDns: true, tls: true } : r)),
  };

  const env: ExpandEnv = { id: opts.runId, name: opts.runId, class: "sandbox", provider: "aws", region: opts.region, baseDomain: opts.dnsZone ?? "example.invalid" };
  const graph = expandManifest(upgradeManifest(manifest, { provider: "aws", region: opts.region }), env);
  const estimate = estimateGraphCost(graph, { catalog: loadDefaultCatalog(), now: "2026-09-30T00:00:00.000Z" });
  return { manifest, estimateUsd: estimate.monthlyUsd, ...(host ? { host } : {}), summary: { services: manifest.services.length, resources: manifest.resources.length, port: web.port, healthPath: web.healthPath } };
}
