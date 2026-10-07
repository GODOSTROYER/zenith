/**
 * PROD-DUR-03 for teardown: the destroy review records the executable semantics, the destroy re-plan and the
 * apply dispatch recompute them, and a mismatch refuses before any deletion (isolated fakes, no cloud).
 */
import { afterEach, describe, expect, it } from "vitest";
import { SemanticsChangedError } from "@/lib/execution/semantics/errors";
import { readExecutableSemantics } from "@/lib/execution/semantics/digest";
import { MemorySemanticsStore } from "@/lib/execution/semantics/store";
import { bucketManifest, change, makePlan, OP, REVISION, WS } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const worlds: World[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

async function reviewed() {
  const store = new MemorySemanticsStore();
  const w = createWorld({ op: { capability: "infrastructure.destroy" }, semantics: store });
  worlds.push(w);
  w.product.base.environment.deployedRevisionId = REVISION;
  const { upgradeManifest } = await import("@/lib/resources/upgrade");
  const v2 = upgradeManifest(bucketManifest(), { provider: "aws", region: "us-east-1" });
  v2.policies = { backup: "daily", ...v2.policies, deletion: "allow" };
  w.product.setManifest(v2);
  w.tofu.planFactory = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, changes: [change({ address: "aws_s3_bucket.object_store_assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  const plan = await w.activities.planDestroyInfrastructure({ operationId: OP, lease });
  w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
  return { w, store, lease, planDigest: plan.planDigest };
}

type Mutable = { activeOwnershipTransfers?: () => Promise<unknown[]> };
const moveOwnership = (w: World): void => {
  (w.resources as unknown as Mutable).activeOwnershipTransfers = async () => [{ address: "object_store/assets", resourceType: "aws_s3_bucket", path: "versioning", from: "iac", to: "release", approvalId: "a", approvedAt: "2026-09-30T00:00:00.000Z", digest: "7".repeat(64) }];
};

describe("teardown executable semantics", () => {
  it("records the semantics at review and shows them in the destroy plan evidence", async () => {
    const { w, store, planDigest } = await reviewed();
    const row = await store.get(WS, OP, planDigest);
    expect(row).not.toBeNull();
    const [evidence] = w.evidence.ofKind("tofu_plan");
    expect(readExecutableSemantics(evidence.summary.semantics)?.digest).toBe(row!.semantics.digest);
  });

  it("applies when nothing relevant changed", async () => {
    const { w, lease, planDigest } = await reviewed();
    await expect(w.activities.applyDestroyInfrastructure({ operationId: OP, planDigest, lease })).resolves.toMatchObject({ deleted: 1 });
  });

  it("refuses at dispatch, before any deletion, when ownership moved after the review", async () => {
    const { w, lease, planDigest } = await reviewed();
    moveOwnership(w);
    const err = await w.activities.applyDestroyInfrastructure({ operationId: OP, planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SemanticsChangedError);
    expect((err as SemanticsChangedError).changed).toEqual(["ownership"]);
    expect((err as Error).message).toMatch(/destroy dispatch/);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    expect(w.ops.uncertain).toHaveLength(0);
  });

  it("refuses the destroy re-plan when the semantics moved", async () => {
    const { w, lease, planDigest } = await reviewed();
    moveOwnership(w);
    const err = await w.activities.finalDestroyPlan({ operationId: OP, approvedPlanDigest: planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SemanticsChangedError);
    expect((err as Error).message).toMatch(/destroy final plan/);
  });

  it("refuses a teardown whose review recorded no semantics", async () => {
    const { w, lease, planDigest } = await reviewed();
    w.deps.semantics = new MemorySemanticsStore();
    await expect(w.activities.applyDestroyInfrastructure({ operationId: OP, planDigest, lease })).rejects.toThrow(/No executable semantics were recorded/);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });
});
