/** Registry adapter contracts. Stored approval/transfer concurrency has a separate PostgreSQL gate. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as transfers from "@/lib/controlplane/db/repos/ownership-transfers";
import type { Sql } from "@/lib/controlplane/types";
import { transferDigest } from "@/lib/ownership/registry";
import { createOptimizerOwnership } from "@/lib/cost/optimizer/optimizer-ownership";

afterEach(() => vi.restoreAllMocks());
const now = () => new Date("2026-10-08T00:00:00Z");
const scope = { workspaceId: "ws-contract", environmentId: "env-contract" };
function setup(autoscaled = false, approved = false) {
  const query = vi.fn(async (sql: string): Promise<Record<string, unknown>[]> => sql.startsWith("select count") ? [{ count: 1 }] : [{ id: "resource-contract" }]);
  const db = { query } as unknown as Sql;
  const transfer = { address: "service/web", resourceType: "aws:ecs_service", path: "replicas", from: autoscaled ? "autoscaler" as const : "iac" as const, to: "native-op" as const, approvalId: "approval-contract", approvedAt: "2026-10-07T00:00:00Z" };
  const guard = vi.spyOn(transfers, "guardFor").mockResolvedValue({ node: { address: "service/web", nativeType: "aws:ecs_service", spec: {} }, facts: { autoscaled }, transfers: approved ? [{ ...transfer, digest: transferDigest(transfer) }] : [] });
  return { query, guard, ownership: createOptimizerOwnership(db, scope, now) };
}
describe("optimizer ownership against LIFE-12", () => {
  it("refuses manifest-owned and autoscaler-owned fields without an approved native transfer", async () => {
    expect(await setup().ownership.check({ address: "service/web", field: "spec.replicas" })).toMatchObject({ owner: "external" });
    expect(await setup(true).ownership.check({ address: "service/web", field: "spec.replicas" })).toMatchObject({ owner: "external" });
  });
  it("honors an exact approved transfer and binds every store read to the environment and workspace", async () => {
    const { ownership, query, guard } = setup(false, true);
    expect(await ownership.check({ address: "service/web", field: "spec.replicas" })).toEqual({ owner: "zenith" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("workspace_id = $1 and environment_id = $2"), [scope.workspaceId, scope.environmentId, "service/web"]);
    expect(guard).toHaveBeenCalledWith(expect.anything(), scope.workspaceId, scope.environmentId, "resource-contract");
    expect(await ownership.check({ address: "service/web", field: "spec.size" })).toMatchObject({ owner: "external" });
  });
  it("refuses unsupported fields, absent/ambiguous resources and unavailable ownership stores", async () => {
    const { ownership, query, guard } = setup();
    expect(await ownership.check({ address: "service/web", field: "region" })).toMatchObject({ owner: "unknown" });
    query.mockResolvedValue([]);
    expect(await ownership.check({ address: "service/web", field: "spec.size" })).toMatchObject({ owner: "unknown" });
    query.mockImplementation(async sql => sql.startsWith("select count") ? [{ count: 1 }] : [{ id: "resource-contract" }]);
    guard.mockRejectedValue(new Error("store unavailable"));
    await expect(ownership.check({ address: "service/web", field: "spec.replicas" })).rejects.toThrow("store unavailable");
  });
});
