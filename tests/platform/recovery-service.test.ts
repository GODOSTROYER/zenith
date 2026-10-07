/**
 * PROD-OPS-04: operator continuation through the platform service and its route classification. PGlite (the same
 * SQL the production store runs); the human-only, admin-only and tenant rules are the service's, not the store's.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { bumpRecoveryEpoch } from "@/lib/controlplane/recovery";
import type { Principal } from "@/lib/controlplane/types";
import { platformAccess } from "@/app/api/platform/v1/_lib/bearer-paths";
import { createPlatformRecovery, type PlatformRecovery, type RecoveryNeed } from "@/lib/platform/recovery-service";
import { seedApprovedOperation } from "../controlplane/_support/harness";

const ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3 };
const admin: Principal = { kind: "user", id: "admin-1", name: "Ada Admin" };
const viewer: Principal = { kind: "user", id: "viewer-1", name: "Vic Viewer" };
const agent: Principal = { kind: "integration", id: "int-1", name: "Codex", onBehalfOf: "admin-1", integrationId: "link-1" };

let db: PlatformDbHandle;
let service: PlatformRecovery;
let ws: string, op: string;

beforeAll(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  service = createPlatformRecovery({
    db,
    async authorize(principal: Principal, workspaceId: string, need: RecoveryNeed) {
      const role = workspaceId !== ws ? "none" : principal.id === "admin-1" || principal.kind === "integration" ? "admin" : principal.id === "viewer-1" ? "viewer" : "none";
      if (role === "none") throw notFound();
      if (ROLE_RANK[role]! < ROLE_RANK[need]!) throw new BrokerError("role_insufficient", `This needs the ${need} role in this workspace.`);
    },
  });
  const seeded = await seedApprovedOperation(db);
  ws = seeded.workspaceId;
  op = seeded.operation.id;
  await bumpRecoveryEpoch(db, { restoreRunId: `restore-${randomUUID()}`, actor: "operator:test", reason: "service test" });
}, 60_000);
afterAll(async () => { await db.close(); });

describe("recovery service", () => {
  it("shows the epoch and the work list to a viewer, with the digest a decision must carry", async () => {
    const status = await service.status(viewer, ws);
    expect(status.epoch).toBeGreaterThanOrEqual(1);
    expect(status.pending).toBe(1);
    const items = await service.list(viewer, ws, { state: "pending" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "operation", ref: op, priorState: "approved", allowed: ["resume", "abandon"] });
    expect(items[0]!.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((await service.get(viewer, ws, items[0]!.id)).id).toBe(items[0]!.id);
  });

  it("a stranger to the workspace learns nothing", async () => {
    const stranger: Principal = { kind: "user", id: "stranger", name: "S" };
    await expect(service.list(stranger, ws)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.status(admin, `ws_${randomUUID()}`)).rejects.toMatchObject({ code: "not_found" });
  });

  it("only a signed-in human admin may decide: not an agent credential, not a viewer", async () => {
    const [item] = await service.list(admin, ws, { state: "pending" });
    const decision = { workspaceId: ws, itemId: item!.id, decision: "abandon" as const, bindingDigest: item!.bindingDigest, reason: "no longer wanted" };
    await expect(service.decide({ principal: agent, ...decision })).rejects.toMatchObject({ code: "browser_session_required" });
    await expect(service.decide({ principal: viewer, ...decision })).rejects.toMatchObject({ code: "role_insufficient" });
    expect((await service.get(admin, ws, item!.id)).state).toBe("pending");
  });

  it("maps a stale review to digest_mismatch and a decided item to invalid_state, then records the human", async () => {
    const [item] = await service.list(admin, ws, { state: "pending" });
    await expect(service.decide({ principal: admin, workspaceId: ws, itemId: item!.id, decision: "abandon", bindingDigest: "f".repeat(64), reason: "stale review" })).rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(service.decide({ principal: admin, workspaceId: ws, itemId: item!.id, decision: "keep_uncertain", bindingDigest: item!.bindingDigest, reason: "wrong choice" })).rejects.toMatchObject({ code: "invalid_state" });
    const decided = await service.decide({ principal: admin, workspaceId: ws, itemId: item!.id, decision: "abandon", bindingDigest: item!.bindingDigest, reason: "no longer wanted" });
    expect(decided).toMatchObject({ state: "abandoned", decidedBy: "user:admin-1", decisionReason: "no longer wanted" });
    await expect(service.decide({ principal: admin, workspaceId: ws, itemId: item!.id, decision: "abandon", bindingDigest: item!.bindingDigest, reason: "again" })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await service.status(admin, ws)).pending).toBe(0);
  });
});

describe("route classification", () => {
  it("reads accept a person or a human-bound credential; the decision is the approver's own browser", () => {
    expect(platformAccess("/api/platform/v1/recovery", "GET")).toBe("bearer-capable");
    expect(platformAccess(`/api/platform/v1/recovery/items/ri_${"a".repeat(40)}/decide`, "POST")).toBe("browser-only");
    expect(platformAccess(`/api/platform/v1/recovery/items/ri_${"a".repeat(40)}/decide`, "GET")).toBeUndefined();
    expect(platformAccess("/api/platform/v1/recovery", "POST")).toBeUndefined();
  });
});
