import { describe, expect, it } from "vitest";
import { RecommendPlacementInput } from "@/lib/agent-access/v3/schemas";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";

const target = { workspaceId: "ws-test", projectId: "proj-test" };
describe("MCP placement extended usage v2", () => {
  it("publishes and preserves every extended dimension", () => {
    const usage = { interAzGb: 10, storageIoMillions: 3, crossRegionBackupCopyGb: 20 };
    expect(RecommendPlacementInput.parse({ target, constraints: { usage } }).constraints?.usage).toEqual(usage);
    expect(toolDescriptor("zenith_recommend_placement")?.schemaVersion).toBe(2);
  });
  it.each([-1, Infinity, NaN])("refuses invalid quantities %s", value => {
    for (const field of ["interAzGb", "storageIoMillions", "crossRegionBackupCopyGb"]) expect(RecommendPlacementInput.safeParse({ target, constraints: { usage: { [field]: value } } }).success).toBe(false);
  });
  it("rejects invented usage fields and accepts explicit zero", () => {
    expect(RecommendPlacementInput.safeParse({ target, constraints: { usage: { interAzGb: 0 } } }).success).toBe(true);
    expect(RecommendPlacementInput.safeParse({ target, constraints: { usage: { freeTransfer: true } } }).success).toBe(false);
  });
});
