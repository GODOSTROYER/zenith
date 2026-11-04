/** Real expansion/solver with explicit in-memory read fixtures; no cloud I/O. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recommendPlacement, type RecommendReads, type PlacementConnection } from "@/lib/placement/recommend";
import { ManifestV2 } from "@/lib/resources/manifest-v2";
import { regionInfo, regionSatisfiesResidency } from "@/lib/placement/latency";
import { notFound } from "@/lib/capabilities/errors";

const input = { workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a" };
const connection = (provider: string, verified = true, workspaceId = "ws-a"): PlacementConnection => ({ workspaceId, provider, verified });
let manifest: ManifestV2;
let connections: PlacementConnection[];
let reads: RecommendReads;

beforeEach(() => {
  manifest = ManifestV2.parse({ version: 2, placement: { provider: "auto" }, constraints: { userRegions: ["india"] },
    services: [{ id: "svc-a", name: "web-app", kind: "web", source: { type: "image", image: "example.test/app:1" }, port: 8080 }],
    resources: [{ id: "db-a", name: "main-db", kind: "postgres" }] });
  connections = [connection("aws")];
  reads = { project: vi.fn(async (ws, p) => ws === "ws-a" && p === "proj-a" ? { id: p, workspaceId: ws, workingManifest: manifest } : null),
    environment: vi.fn<RecommendReads["environment"]>(async (ws, p, e) => ws === "ws-a" && p === "proj-a" && e === "env-a" ? { id: e, projectId: p, provider: "aws", name: "Staging", class: "staging", region: "ap-south-1", connectionId: "conn-a", baseDomain: "example.test", createdAt: "2026-09-30T00:00:00Z", policies: { approvalRequired: false, allowStatefulDeletion: false } } : null),
    connections: vi.fn(async () => connections) };
});

describe("product placement recommendation", () => {
  it("ranks only verified workspace providers and returns price lines plus rejection reasons", async () => {
    connections.push(connection("gcp", false), connection("azure", true, "ws-b"));
    const r = await recommendPlacement(input, reads);
    expect(r.connectedProviders).toEqual(["aws"]);
    expect(r.result.chosen).toBeDefined();
    for (const c of [r.result.chosen!, ...r.result.alternatives]) {
      expect(c.requiresConnection).toBe(false);
      expect(Object.values(c.assignments).every((a) => a.provider === "aws")).toBe(true);
      expect(c.cost.lines.length).toBeGreaterThan(0);
    }
    expect(r.result.rejected).toContainEqual(expect.objectContaining({ id: "provider:gcp", reasons: expect.arrayContaining([expect.stringContaining("no verified workspace connection")]) }));
    expect(r.result.rejected.find((r) => r.id === "provider:gcp")!.reasons.some((reason) => reason.startsWith("denylist:"))).toBe(false);
    expect(r.explanation).toMatch(/estimate/i);
  });
  it("keeps cheaper unconnected discovery separate from the connected recommendation", async () => {
    const r = await recommendPlacement({ ...input, includeUnconnected: true }, reads);
    expect(r.result.chosen?.requiresConnection).toBe(false);
    expect(r.unconnectedCandidates.length).toBeGreaterThan(0);
    expect(r.unconnectedCandidates.every((c) => c.requiresConnection && c.missingProviders.length > 0)).toBe(true);
    expect(r.unconnectedCandidates[0].warnings.join(" ")).toMatch(/not ranked above connected/);
  });
  it("does not invent a recommendation when there is no verified connection", async () => {
    connections = [];
    const r = await recommendPlacement({ ...input, includeUnconnected: true }, reads);
    expect(r.result.chosen).toBeUndefined(); expect(r.result.alternatives).toEqual([]);
    expect(r.unconnectedCandidates.length).toBeGreaterThan(0);
    expect(r.explanation).toMatch(/Connect and verify a cloud account/);
  });
  it("refuses an impossible budget with the budget and estimate in the reasons", async () => {
    const r = await recommendPlacement({ ...input, constraints: { budgetUsdMonthly: 1 } }, reads);
    expect(r.result.chosen).toBeUndefined();
    expect(r.result.rejected.some((x) => x.reasons.some((reason) => /budget: estimated \$[\d.]+\/month exceeds the \$1\.00 budget by \$/.test(reason)))).toBe(true);
  });
  it("honors manifest residency and cannot loosen a manifest budget with request overrides", async () => {
    manifest.placement!.residency = ["eu"];
    manifest.constraints!.budgetUsdMonthly = 400;
    const r = await recommendPlacement({ ...input, constraints: { budgetUsdMonthly: 5000 } }, reads);
    expect(r.constraints.budgetUsdMonthly).toBe(400);
    expect(r.result.chosen).toBeDefined();
    for (const a of Object.values(r.result.chosen!.assignments)) expect(regionSatisfiesResidency(regionInfo(a.provider, a.region)!, ["eu"])).toBe(true);
  });
  it("intersects additional residency by geography rather than weakening the manifest", async () => {
    manifest.placement!.residency = ["eu"];
    const r = await recommendPlacement({ ...input, constraints: { residency: ["in"] } }, reads);
    expect(r.result.chosen).toBeUndefined();
    expect(r.result.rejected.some((x) => x.reasons.some((reason) => reason.startsWith("residency:")))).toBe(true);
  });
  it("honors explicit zones and failure tolerance", async () => {
    manifest.placement!.zones = 3;
    manifest.providerConfig = { aws: { natGateways: "per_az" } };
    const r = await recommendPlacement(input, reads);
    expect(r.result.chosen?.availabilityZones).toBe(3);
    expect(r.constraints.tolerateSingleFailure).toBe(true);
    expect(r.result.chosen?.specOverrides?.["container_service/web-app"]?.replicas).toBe(2);
    expect(r.result.chosen?.cost.lines.find((l) => l.sku === "aws.nat_gateway.hour")?.quantity).toBe(3 * 730);
    for (const a of Object.values(r.result.chosen!.assignments)) expect(regionInfo(a.provider, a.region)!.zones).toBeGreaterThanOrEqual(3);
  });
  it("is byte deterministic and never writes or mutates read inputs", async () => {
    const before = JSON.stringify({ manifest, connections });
    const a = await recommendPlacement({ ...input, includeUnconnected: true }, reads);
    const b = await recommendPlacement({ ...input, includeUnconnected: true }, reads);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.result.deterministicSeed).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify({ manifest, connections })).toBe(before);
    expect(Object.keys(reads).sort()).toEqual(["connections", "environment", "project"]);
  });
  it("ignores the order and duplicate verification metadata rows", async () => {
    connections = [connection("aws"), connection("gcp")];
    const a = await recommendPlacement(input, reads);
    connections = [connection("gcp"), connection("aws"), connection("aws")];
    expect(await recommendPlacement(input, reads)).toEqual(a);
  });
  it("upgrades V1 only for planning without saving it", async () => {
    const v1 = { version: 1, services: manifest.services, resources: manifest.resources, routes: [], bindings: [] };
    reads.project = vi.fn(async () => ({ id: "proj-a", workspaceId: "ws-a", workingManifest: v1 }));
    expect((await recommendPlacement({ workspaceId: "ws-a", projectId: "proj-a", constraints: { userRegions: ["india"] } }, reads)).result.chosen).toBeDefined();
    expect(v1.version).toBe(1);
  });
  it("reports missing user geography rather than inventing where users live", async () => {
    manifest.constraints = {};
    const r = await recommendPlacement(input, reads);
    expect(r.result.chosen).toBeUndefined();
    expect(r.result.rejected).toContainEqual({ id: "input", reasons: ["constraints.userRegions is empty: at least one user region is needed to estimate latency"] });
  });
  it.each(["foreign", "missing"])("returns uniform not-found for a %s project before connections are read", async (projectId) => {
    await expect(recommendPlacement({ ...input, projectId }, reads)).rejects.toMatchObject({ code: notFound().code, message: notFound().message });
    expect(reads.connections).not.toHaveBeenCalled();
  });
  it("refuses a mismatched environment and invalid request without echoing input", async () => {
    await expect(recommendPlacement({ ...input, environmentId: "foreign" }, reads)).rejects.toMatchObject({ code: "not_found" });
    await expect(recommendPlacement({ ...input, constraints: { budgetUsdMonthly: -99 } }, reads)).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("keeps a pinned unconnected resource out of the connected ranking", async () => {
    manifest.nodePlacement = { "db-a": { provider: "gcp", region: "asia-south1" } };
    const r = await recommendPlacement(input, reads);
    expect(r.result.chosen).toBeUndefined();
  });
});
