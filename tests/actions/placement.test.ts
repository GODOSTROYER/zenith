/** Real action registry and manifest editor. Stored verification is faked;
 * broker authorization uses the existing signed-grant test harness. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import type { ActionContext } from "@/lib/actions/core";

tempDataDir("zenith-placement-actions-");
const { db, resetDb } = await import("@/lib/db/store");
const { runAction, getAction } = await import("@/lib/actions/core");
await import("@/lib/actions/defs");
const { manifestForPlacement } = await import("@/lib/actions/defs/placement");
const { placementReads, recommendPlacement } = await import("@/lib/placement/recommend");
const { setPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const { ids, makeHarness } = await import("../agent-v3/support");
const { expandManifest } = await import("@/lib/resources/expand");
const { Resource } = await import("@/lib/domain/types");

const ctx: ActionContext = { workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a", actor: { type: "user", id: "bob", name: "Bob" } };
const constraints = { userRegions: ["india"] };
beforeEach(async () => {
  const h = await makeHarness();
  setPlatformBrokerForTests(h.broker);
  resetDb({ workspaces: [{ id: ids.ws, name: "A", slug: "a", createdAt: "2026-09-30T00:00:00Z" }],
    members: [{ id: "bob", workspaceId: ids.ws, name: "Bob", email: "bob@example.test", role: "editor" }],
    projects: [{ ...h.projects.get(ids.project)!, createdAt: "2026-09-30T00:00:00Z", origin: { type: "blank" } }],
    environments: [{ ...h.environments.get(ids.env)!, createdAt: "2026-09-30T00:00:00Z", policies: { approvalRequired: false, allowStatefulDeletion: false } }],
    connections: [{ id: "conn-a", workspaceId: ids.ws, provider: "aws", label: "AWS", region: "ap-south-1", status: "healthy", grantedPermissions: [], createdAt: "2026-09-30T00:00:00Z" }] });
  vi.spyOn(placementReads, "connections").mockResolvedValue([{ workspaceId: ids.ws, provider: "aws", verified: true }]);
});
afterEach(() => { vi.restoreAllMocks(); setPlatformBrokerForTests(null); });

async function applyInput() {
  const recommendation = await recommendPlacement({ workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, constraints });
  expect(recommendation.result.chosen).toBeDefined();
  return { projectId: ids.project, environmentId: ids.env, constraints, candidateId: recommendation.result.chosen!.id, expectedHash: recommendation.manifestHash, expectedSeed: recommendation.result.deterministicSeed };
}

describe("placement actions", () => {
  it("registers a read-only recommendation plan with no approval and no writes", async () => {
    expect(getAction("placement.recommend").mutates).toBe(false);
    const before = JSON.stringify(db());
    const r = await runAction("placement.recommend", ctx, {}, { mode: "plan" });
    expect(r.plan?.blocked).toBeUndefined(); expect(r.plan?.requiresApproval).toBe(false);
    expect(r.plan?.details.join(" ")).toMatch(/estimate/i); expect(JSON.stringify(db())).toBe(before);
  });
  it("returns structured recommendation data without editing the manifest", async () => {
    const before = JSON.stringify(db().projects[0].workingManifest);
    const r = await runAction("placement.recommend", ctx, { constraints }, { mode: "execute" });
    expect(r.result?.ok).toBe(true); expect(r.result?.data).toHaveProperty("result.chosen.cost.lines");
    expect(JSON.stringify(db().projects[0].workingManifest)).toBe(before);
  });
  it("reviews through the existing editor, saves V2 placement and exposes it in the next plan", async () => {
    const input = await applyInput();
    const before = JSON.stringify({ projects: db().projects, environments: db().environments });
    const planSpy = vi.spyOn(getAction("project.updateManifest"), "plan");
    const r = await runAction("placement.apply", ctx, input, { mode: "plan" });
    expect(planSpy).toHaveBeenCalledWith(ctx, expect.objectContaining({ manifest: expect.objectContaining({ version: 2, placement: expect.objectContaining({ regions: expect.any(Array) }) }) }));
    expect(r.plan?.blocked).toBeUndefined();
    expect(JSON.stringify({ projects: db().projects, environments: db().environments })).toBe(before);
    const execution = await runAction("placement.apply", ctx, input, { mode: "execute" });
    expect(execution.result?.ok).toBe(true);
    const manifest = db().projects[0].workingManifest;
    expect(manifest.version).toBe(2);
    if (manifest.version !== 2) throw new Error("Expected V2 placement");
    expect(manifest.placement).toMatchObject({ provider: "aws", regions: expect.any(Array), zones: expect.any(Number) });
    expect(db().environments[0].connectionId).toBe("conn-a");
    const next = await runAction("deploy.plan", ctx, {}, { mode: "plan" });
    expect(next.plan?.details.join(" ")).toContain("placement");
  });
  it("writes exact provider and region pins into the proposed V2 manifest", async () => {
    const recommendation = await recommendPlacement({ workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, constraints });
    const candidate = recommendation.result.chosen!;
    const manifest = manifestForPlacement(db().projects[0].workingManifest, candidate);
    expect(manifest.placement?.provider).toBe("aws"); expect(manifest.nodePlacement?.["svc-a"]).toBeDefined();
    const graph = expandManifest(manifest, { id: "env-a", name: "Staging", class: "staging", provider: "aws", region: "us-west-2", baseDomain: "example.test" });
    const web = graph.nodes.find((n) => n.address === "container_service/web-app")!;
    expect(web.region).toBe(candidate.assignments[web.address].region);
  });
  it("refuses stale manifest tokens without writing", async () => {
    const input = await applyInput();
    db().projects[0].workingManifest.services[0].replicas++;
    const before = JSON.stringify(db().projects[0].workingManifest);
    const r = await runAction("placement.apply", ctx, input, { mode: "execute" });
    expect(r.result?.error).toMatch(/working copy changed/i); expect(JSON.stringify(db().projects[0].workingManifest)).toBe(before);
  });
  it("stages cross-cloud pins for primary nodes without repointing the environment", async () => {
    db().projects[0].workingManifest.resources.push(Resource.parse({ id: "db-a", name: "main-db", kind: "postgres" }));
    vi.mocked(placementReads.connections).mockResolvedValue(["aws", "gcp"].map((provider) => ({ workspaceId: ids.ws, provider, verified: true })));
    const r = await recommendPlacement({ workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env,
      constraints: { userRegions: ["india"], componentProviders: { web: "aws", database: "gcp" } } });
    expect(r.result.chosen?.topology).toBe("cross_cloud");
    const oldConnection = db().environments[0].connectionId;
    const manifest = manifestForPlacement(db().projects[0].workingManifest, r.result.chosen!);
    expect(manifest.nodePlacement?.["svc-a"].provider).toBe("aws");
    expect(manifest.nodePlacement?.["db-a"].provider).toBe("gcp");
    expect(db().environments[0].connectionId).toBe(oldConnection);
  });
  it("refuses a multi-region model that expansion cannot reproduce", async () => {
    const r = await recommendPlacement({ workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env,
      constraints: { userRegions: ["india", "europe"], availabilityTarget: 99.99 } });
    expect(r.result.chosen?.topology).toBe("multi_region");
    expect(() => manifestForPlacement(db().projects[0].workingManifest, r.result.chosen!)).toThrow(/multi-region deployment wiring/);
  });
  it("refuses a provider that lost verification since recommendation", async () => {
    const input = await applyInput(); vi.mocked(placementReads.connections).mockResolvedValue([]);
    const r = await runAction("placement.apply", ctx, input, { mode: "execute" });
    expect(r.result?.ok).toBe(false); expect(r.result?.error).toMatch(/no longer eligible/);
  });
  it("requires a human, and a known candidate bound to the seed", async () => {
    const input = await applyInput();
    const nonhuman = await runAction("placement.apply", { ...ctx, actor: { type: "navigator", id: "bob", name: "Bob" }, autonomy: "autonomous" }, input, { mode: "execute" });
    expect(nonhuman.result?.error).toMatch(/person must review/);
    const stale = await runAction("placement.apply", ctx, { ...input, expectedSeed: "stale" }, { mode: "execute" });
    expect(stale.result?.error).toMatch(/inputs or verified connections changed/);
    const invented = await runAction("placement.apply", ctx, { ...input, candidateId: "invented" }, { mode: "execute" });
    expect(invented.result?.error).toMatch(/no longer eligible/);
  });
  it("refuses applying an unconnected discovery option with a connect fix", async () => {
    const r = await recommendPlacement({ workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, constraints, includeUnconnected: true });
    const candidate = r.unconnectedCandidates[0]; expect(candidate).toBeDefined();
    const apply = await runAction("placement.apply", ctx, { projectId: ids.project, environmentId: ids.env, constraints, includeUnconnected: true, candidateId: candidate.id, expectedHash: r.manifestHash, expectedSeed: r.result.deterministicSeed }, { mode: "execute" });
    expect(apply.result?.error).toMatch(/Connect and verify/);
  });
  it("uniformly refuses missing and foreign project ids", async () => {
    const a = await runAction("placement.recommend", ctx, { projectId: "foreign" }, { mode: "plan" });
    const b = await runAction("placement.recommend", ctx, { projectId: "missing" }, { mode: "plan" });
    expect(a.plan?.summary).toBe(b.plan?.summary); expect(a.plan?.blocked).not.toMatch(/web-app/);
  });
});
