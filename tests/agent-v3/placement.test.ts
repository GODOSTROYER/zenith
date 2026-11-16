/** Real MCP dispatcher, policy broker and solver; product read seams are fakes. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { placementReads } from "@/lib/placement/recommend";
import { runTool } from "@/lib/agent-access/v3/tools";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";
import { RecommendPlacementInput } from "@/lib/agent-access/v3/schemas";
import { digest } from "@/lib/controlplane/digest";
import { principalFromIdentity } from "@/lib/agent-access/v3/principal";
import { identity, ids, makeHarness, target, denyDecision, canaries } from "./support";

const PLACEMENT_TOOL = toolDescriptor("zenith_recommend_placement")!;
afterEach(() => vi.restoreAllMocks());
async function prepare() {
  const h = await makeHarness();
  vi.spyOn(placementReads, "project").mockImplementation(async (ws, p) => h.projects.get(p)?.workspaceId === ws ? h.projects.get(p)! : null);
  vi.spyOn(placementReads, "environment").mockImplementation(async (_ws, _p, e) => {
    const env = h.environments.get(e);
    return env ? { ...env, createdAt: "2026-09-30T00:00:00Z", policies: { approvalRequired: false, allowStatefulDeletion: false } } : null;
  });
  vi.spyOn(placementReads, "connections").mockResolvedValue([{ workspaceId: ids.ws, provider: "aws", verified: true }]);
  return h;
}
describe("placement MCP tool", () => {
  it("has a strict, deterministic read contract requiring plan scope", () => {
    expect(PLACEMENT_TOOL.capability).toBe("placement.solve"); expect(PLACEMENT_TOOL.requiredScope).toBe("plan");
    expect(PLACEMENT_TOOL.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(PLACEMENT_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(PLACEMENT_TOOL.schemaDigest).toBe(`sha256:${digest(PLACEMENT_TOOL.inputSchema)}`);
    // COST-02 deliberately adds the extended usage dimensions in placement schema v2.
    expect({ schemaVersion: PLACEMENT_TOOL.schemaVersion, schemaDigest: PLACEMENT_TOOL.schemaDigest }).toEqual({ schemaVersion: 2,
      schemaDigest: "sha256:05139168b57e9e2c3b1d294cdd8df1df278cff54f15f64b526ef88effddf8531" });
    expect(RecommendPlacementInput.safeParse({ target, approved: true }).success).toBe(false);
  });
  it("authorizes before any product read and returns explanation and costs as untrusted data", async () => {
    const h = await prepare();
    const project = vi.mocked(placementReads.project);
    project.mockImplementation(async () => { expect(h.authorizeRead).toHaveBeenCalled(); return h.projects.get(ids.project)!; });
    const result = await runTool(PLACEMENT_TOOL.name, { target, constraints: { userRegions: ["india"] } }, { principal: h.principal, ports: h.ports });
    expect(result.ok).toBe(true);
    expect(h.authorizeRead).toHaveBeenCalledWith(expect.objectContaining({ capability: "placement.solve", scope: target }), h.principal.principal);
    expect(result.untrusted_data?.content.explanation).toMatch(/estimate/i);
    expect(result.untrusted_data?.content.result).toHaveProperty("chosen.cost.lines");
    expect(result.data).not.toHaveProperty("explanation");
    expect(result.data).not.toHaveProperty("grant");
    expect(JSON.stringify(result)).not.toContain("config-value-never-return");
    expect(h.propose).not.toHaveBeenCalled(); expect(h.starts.deploy).toEqual([]);
  });
  it("policy denial prevents product and connection reads", async () => {
    const h = await prepare(); h.setDecision(() => denyDecision());
    const result = await runTool(PLACEMENT_TOOL.name, { target }, { principal: h.principal, ports: h.ports });
    expect(result.error?.code).toBe("policy_denied");
    expect(placementReads.project).not.toHaveBeenCalled(); expect(placementReads.connections).not.toHaveBeenCalled();
  });
  it("requires plan scope even though the tool is read-only", async () => {
    const h = await prepare();
    const result = await runTool(PLACEMENT_TOOL.name, { target }, { principal: principalFromIdentity(identity({ scopes: ["read"] })), ports: h.ports });
    expect(result.ok).toBe(false); expect(h.authorizeRead).not.toHaveBeenCalled(); expect(placementReads.project).not.toHaveBeenCalled();
  });
  it("grant boundaries refuse foreign ids before authorization or reads", async () => {
    const h = await prepare();
    const a = await runTool(PLACEMENT_TOOL.name, { target: { ...target, projectId: ids.foreignProject } }, { principal: h.principal, ports: h.ports });
    const b = await runTool(PLACEMENT_TOOL.name, { target: { ...target, projectId: "missing" } }, { principal: h.principal, ports: h.ports });
    expect(a.error).toEqual(b.error); expect(a.error?.code).toBe("not_found"); expect(h.authorizeRead).not.toHaveBeenCalled();
  });
  it("rejects unknown approval fields and scrubs secret canaries in external text", async () => {
    const h = await prepare();
    const bad = await runTool(PLACEMENT_TOOL.name, { target, approved: true }, { principal: h.principal, ports: h.ports });
    expect(bad.error?.code).toBe("invalid_input");
    h.projects.get(ids.project)!.workingManifest.services[0].env[0].value = canaries[0];
    const result = await runTool(PLACEMENT_TOOL.name, { target }, { principal: h.principal, ports: h.ports });
    expect(result.ok).toBe(true);
    for (const secret of canaries) expect(JSON.stringify(result)).not.toContain(secret);
  });
});
