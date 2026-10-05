/**
 * PROD-LIFE-12: the broker refuses a native operation that writes a field
 * another writer owns, before anything is persisted, and accepts it once an
 * exact ownership transfer is on record.
 */
import { describe, expect, it } from "vitest";
import { transferDigest, type OwnershipTransfer } from "@/lib/ownership";
import type { ResourceNode } from "@/lib/resources/types";
import { STORE_KINDS, closeSharedPgliteAfterAll, expectBrokerError, makeHarness, proposeOk, requestFor, user } from "./support";

closeSharedPgliteAfterAll();

const node = (spec: Record<string, unknown>): Pick<ResourceNode, "address" | "nativeType" | "spec"> => ({ address: "container_service/web", nativeType: "aws:ecs_service", spec });

describe.each(STORE_KINDS)("propose field ownership [%s]", (kind) => {
  it("refuses service.scale on an autoscaled service and records nothing", async () => {
    const h = await makeHarness({ kind });
    const err = await expectBrokerError(
      h.broker.propose(requestFor(h, "service.scale", "sbx", { input: { replicas: 5 } }), user("bob"), { fieldOwnership: { node: node({ replicas: 2, autoscaling: { min: 2, max: 8 } }) } }),
      "conflict"
    );
    expect(err.details).toMatchObject({ reason: "field_ownership_conflict", conflicts: [{ owner: "autoscaler", writer: "native-op", verdict: "transfer_required" }] });
    expect(JSON.stringify(err.details)).toMatch(/transferDigest/);
  });

  it("check refuses the same way without persisting", async () => {
    const h = await makeHarness({ kind });
    await expectBrokerError(
      h.broker.check(requestFor(h, "service.scale", "sbx", { input: { replicas: 5 } }), user("bob"), { fieldOwnership: { node: node({ replicas: 2 }) } }),
      "conflict"
    );
  });

  it("accepts service.scale after an approved transfer to native-op", async () => {
    const h = await makeHarness({ kind });
    const base = { address: "container_service/web", resourceType: "aws:ecs_service", path: "replicas", from: "iac" as const, to: "native-op" as const };
    const transfer: OwnershipTransfer = { ...base, approvalId: "apr_9", approvedAt: new Date().toISOString(), digest: transferDigest(base) };
    const r = await proposeOk(h, requestFor(h, "service.scale", "sbx", { input: { replicas: 5 } }), user("bob"), { fieldOwnership: { node: node({ replicas: 2 }), transfers: [transfer] } });
    expect(r.decision.outcome).toBe("allow");
  });

  it("does not interfere when no ownership guard is supplied", async () => {
    const h = await makeHarness({ kind });
    const r = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    expect(r.operation.status).toBe("approved");
  });
});
