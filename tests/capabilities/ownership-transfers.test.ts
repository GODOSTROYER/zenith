/**
 * PROD-LIFE-12: the default-on broker guard and persisted ownership transfers.
 * Needs the platform schema (PGlite lane here; set ZENITH_TEST_PLATFORM_PG_URL for Postgres as well).
 *
 *   conflict -> refused with the exact transfer digest
 *   requestOwnershipTransfer -> proposal names the exact transfer, human approval required
 *   approval (human, exact digest) -> durable, tenant-scoped transfer row
 *   next proposal -> allowed; revocation -> refused again
 */
import { describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { STORE_KINDS, approveAs, closeSharedPgliteAfterAll, expectBrokerError, makeHarness, proposeOk, requestFor, user, type Harness } from "./support";

closeSharedPgliteAfterAll();

const ADDRESS = "container_service/web";

async function seedAutoscaledService(h: Harness): Promise<void> {
  await h.db!.query(
    `insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, spec_digest, spec)
     values ($1,$2,$3,$4,'container_service','aws','aws:ecs_service','managed',$5,$6::text::jsonb)`,
    [h.ids.resAWebProd, h.ids.wsA, h.ids.envAProd, ADDRESS, "a".repeat(64), JSON.stringify({ replicas: 2, autoscaling: { min: 2, max: 8 } })]
  );
}

const scale = (h: Harness, extra: Record<string, unknown> = {}) => requestFor(h, "service.scale", "prod", { input: { replicas: 5, ...extra } });

describe.each(STORE_KINDS.filter((k) => k !== "memory"))("ownership transfers [%s]", (kind) => {
  it("refuses scaling an autoscaled service by default and names the transfer an approver would need", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const err = await expectBrokerError(h.broker.propose(scale(h), user("bob")), "conflict");
    expect(err.details).toMatchObject({ reason: "field_ownership_conflict", conflicts: [{ owner: "autoscaler", writer: "native-op", verdict: "transfer_required" }] });
  });

  it("persists a transfer only when a human approves the exact proposal that names it", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const op = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    expect(op.operation.status).toBe("awaiting_approval");
    const transfers = (op.operation.proposal as { broker?: { ownershipTransfers?: { digest: string; from: string; to: string }[] } }).broker?.ownershipTransfers;
    expect(transfers).toHaveLength(1);
    expect(transfers![0]).toMatchObject({ from: "autoscaler", to: "native-op" });

    expect(await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd)).toEqual([]);
    await approveAs(h, op.operation, "dave");
    const active = await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd, ADDRESS);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ address: ADDRESS, from: "autoscaler", to: "native-op", digest: transfers![0]!.digest });
    // a foreign workspace sees nothing and cannot revoke
    expect(await repos.ownershipTransfers.listActive(h.db!, "ws_other", h.ids.envAProd)).toEqual([]);
    expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: "ws_other", transferDigest: active[0]!.digest, operationId: op.id, revokedBy: "x" })).toBe(false);

    // with the transfer on record the next scale proposal is no longer a conflict
    const next = await proposeOk(h, scale(h), user("bob"));
    expect(["awaiting_approval", "approved"]).toContain(next.operation.status);

    // revocation is one-way and restores the refusal
    expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: h.ids.wsA, transferDigest: active[0]!.digest, operationId: op.id, revokedBy: "dave" })).toBe(true);
    expect(await repos.ownershipTransfers.revoke(h.db!, { workspaceId: h.ids.wsA, transferDigest: active[0]!.digest, operationId: op.id, revokedBy: "dave" })).toBe(false);
    await expectBrokerError(h.broker.propose(scale(h), user("bob")), "conflict");
  });

  it("records nothing when the proposal is rejected, and rows cannot be deleted or rewritten", async () => {
    const h = await makeHarness({ kind });
    await seedAutoscaledService(h);
    const op = await proposeOk(h, scale(h, { requestOwnershipTransfer: true }), user("bob"));
    await h.broker.reject({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.digest, approver: user("dave"), session: { method: "browser_session", subject: "dave", verifiedAtMs: Date.now() } });
    expect(await repos.ownershipTransfers.listActive(h.db!, h.ids.wsA, h.ids.envAProd)).toEqual([]);

    const approved = await proposeOk(h, scale(h, { requestOwnershipTransfer: true, again: true }), user("bob"));
    await approveAs(h, approved.operation, "dave");
    await expect(h.db!.query("delete from platform.ownership_transfers where workspace_id = $1", [h.ids.wsA])).rejects.toThrow();
    await expect(h.db!.query("update platform.ownership_transfers set to_owner = 'iac' where workspace_id = $1", [h.ids.wsA])).rejects.toThrow();
  });

  it("lets a native scale on a manifest-only field proceed with an approver-visible warning", async () => {
    const h = await makeHarness({ kind });
    await h.db!.query(
      `insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, spec_digest, spec)
       values ($1,$2,$3,'vm/a','container_service','aws','aws_instance','managed',$4,'{}'::jsonb)`,
      [h.ids.resAWebProd, h.ids.wsA, h.ids.envAProd, "b".repeat(64)]
    );
    const ok = await proposeOk(h, scale(h), user("bob"));
    expect(ok.operation.proposal.details?.some((d) => d.startsWith("Ownership note"))).toBe(true);
  });
});
