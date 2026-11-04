/**
 * PROD-DUR-03 / PROD-DUR-04 on the real SQL store (migration 31): approved semantics are write-once and tenant
 * scoped; a standing grant's identity and bounds are immutable, its count can never be exceeded (also under
 * concurrency), a revoked grant stays revoked, and a use that produced an approval cannot be voided.
 * PGlite always; real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set (see `_support/harness.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { createPlatformStandingGrantStore } from "@/lib/controlplane/db/repos/standing-grants";
import { computeExecutableSemantics, type ExecutableSemanticsInputs } from "@/lib/execution/semantics/digest";
import type { SemanticsStore } from "@/lib/execution/semantics/store";
import type { NewStandingGrant, StandingGrantStore } from "@/lib/capabilities/standing-grants";
import { LANES, newWorkspace, openLane, proposalFor, seedApprovedOperation, uid } from "./_support/harness";

const hex = (c: string): string => c.repeat(64);

function inputs(over: Partial<ExecutableSemanticsInputs> = {}): ExecutableSemanticsInputs {
  return {
    revision: { id: "rev_1", deployedRevisionId: null, manifestDigest: hex("1") },
    recipe: { executableSourceDigest: null, sources: [] },
    scripts: { release: null },
    migrations: null,
    targets: { graphDigest: hex("a"), provider: "aws", region: "us-east-1", environmentId: "env", connectionId: "conn", connectionConfigDigest: hex("b") },
    configuration: { configDigest: hex("c") },
    providerLocks: { lockDigest: hex("d"), tofuVersion: "1.12.5" },
    backend: { kind: "s3", configDigest: hex("e") },
    savedPlan: { planDigest: hex("f") },
    provenance: { pipelines: [] },
    ownership: { transfers: [] },
    runbook: null,
    decommission: { adoptions: [] },
    ...over,
  };
}

describe("migration inventory", () => {
  it("31 creates the semantics and standing grant tables with row level security", () => {
    const m = PLATFORM_MIGRATIONS.find((x) => x.name === "executable_semantics");
    expect(m?.version).toBe(31);
    for (const table of ["approved_semantics", "standing_grants", "standing_grant_uses"]) {
      expect(m!.sql).toContain(`platform.${table}`);
      expect(m!.sql).toContain(`alter table platform.${table} enable row level security`);
    }
  });
});

describe.each(LANES)("approved semantics and standing grants [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let semantics: SemanticsStore;
  let grants: StandingGrantStore;
  beforeAll(async () => {
    ctx = await openLane(lane);
    semantics = createPlatformSemanticsStore(ctx.db);
    grants = createPlatformStandingGrantStore(ctx.db);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  const newGrant = (ws: string, over: Partial<NewStandingGrant> = {}): NewStandingGrant => ({
    id: uid("sgr"),
    workspaceId: ws,
    createdBy: "alice",
    createdByName: "Alice",
    environmentId: "env_1",
    capabilities: ["service.restart"],
    maxRisk: "high",
    allowedPrincipals: ["integration:agent_1"],
    maxUses: 3,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  });
  const op = async (ws: string) => (await seedApprovedOperation(ctx.db, ws, { proposal: proposalFor(ws) })).operation;

  describe("approved semantics", () => {
    it("is write-once per operation and plan, idempotent for the same digest", async () => {
      const ws = newWorkspace();
      const o = await op(ws);
      const sem = computeExecutableSemantics(inputs());
      const first = await semantics.record({ workspaceId: ws, operationId: o.id, planDigest: hex("f"), semantics: sem });
      expect(first.semantics).toEqual(sem);
      expect(await semantics.record({ workspaceId: ws, operationId: o.id, planDigest: hex("f"), semantics: sem })).toMatchObject({ planDigest: hex("f") });
      const moved = computeExecutableSemantics(inputs({ configuration: { configDigest: hex("0") } }));
      await expect(semantics.record({ workspaceId: ws, operationId: o.id, planDigest: hex("f"), semantics: moved })).rejects.toMatchObject({ code: "conflict" });
      expect((await semantics.get(ws, o.id, hex("f")))?.semantics.digest).toBe(sem.digest);
    });

    it("cannot be updated or deleted, even directly in SQL", async () => {
      const ws = newWorkspace();
      const o = await op(ws);
      await semantics.record({ workspaceId: ws, operationId: o.id, planDigest: hex("f"), semantics: computeExecutableSemantics(inputs()) });
      await expect(ctx.db.query("update platform.approved_semantics set semantics_digest = $3 where workspace_id = $1 and operation_id = $2", [ws, o.id, hex("0")])).rejects.toThrow(/write-once/);
      await expect(ctx.db.query("delete from platform.approved_semantics where workspace_id = $1 and operation_id = $2", [ws, o.id])).rejects.toThrow(/write-once/);
    });

    it("rejects a digest that does not match its stored document", async () => {
      const ws = newWorkspace();
      const o = await op(ws);
      const sem = computeExecutableSemantics(inputs());
      await expect(ctx.db.query("insert into platform.approved_semantics(workspace_id, operation_id, plan_digest, semantics_digest, semantics) values ($1,$2,$3,$4,$5::text::jsonb)", [ws, o.id, hex("f"), hex("0"), JSON.stringify(sem)])).rejects.toThrow();
    });

    it("is tenant scoped: another workspace neither reads it nor can bind it to this operation", async () => {
      const ws = newWorkspace();
      const other = newWorkspace();
      const o = await op(ws);
      const sem = computeExecutableSemantics(inputs());
      await semantics.record({ workspaceId: ws, operationId: o.id, planDigest: hex("f"), semantics: sem });
      expect(await semantics.get(other, o.id, hex("f"))).toBeNull();
      await expect(semantics.record({ workspaceId: other, operationId: o.id, planDigest: hex("f"), semantics: sem })).rejects.toThrow();
    });

    it("refuses malformed input before touching the database", async () => {
      await expect(semantics.record({ workspaceId: "w", operationId: "o", planDigest: "nope", semantics: computeExecutableSemantics(inputs()) })).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("standing grants", () => {
    it("round-trips every bound and is tenant scoped", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws, { projectId: "proj_1", resourceId: "res_1", capabilities: ["service.restart", "service.scale"], allowedPrincipals: ["integration:a", "navigator:n"] }));
      expect(g).toMatchObject({ workspaceId: ws, createdBy: "alice", projectId: "proj_1", resourceId: "res_1", capabilities: ["service.restart", "service.scale"], allowedPrincipals: ["integration:a", "navigator:n"], maxUses: 3, uses: 0, status: "active" });
      expect(await grants.get(ws, g.id)).toEqual(g);
      expect(await grants.get(newWorkspace(), g.id)).toBeNull();
      expect(await grants.list(newWorkspace())).toEqual([]);
      expect((await grants.list(ws, { environmentId: "env_1" })).map((x) => x.id)).toEqual([g.id]);
      expect(await grants.list(ws, { environmentId: "env_other" })).toEqual([]);
    });

    it("enforces its bounds in the database too", async () => {
      const ws = newWorkspace();
      const bad = async (over: Partial<NewStandingGrant>) => expect(grants.create(newGrant(ws, over))).rejects.toThrow();
      await bad({ maxUses: 0 });
      await bad({ maxUses: 1001 });
      await bad({ maxRisk: "critical" as never });
      await bad({ capabilities: [] });
      await bad({ allowedPrincipals: [] });
      await bad({ expiresAt: new Date(Date.now() + 31 * 24 * 3_600_000).toISOString() });
      await bad({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    });

    it("keeps its scope, capabilities, principals, count and expiry for life", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws));
      for (const [col, value] of [["max_uses", 999], ["environment_id", "env_2"], ["created_by", "mallory"]] as const) {
        await expect(ctx.db.query(`update platform.standing_grants set ${col} = $3 where workspace_id = $1 and id = $2`, [ws, g.id, value])).rejects.toThrow(/keeps the scope/);
      }
      await expect(ctx.db.query("update platform.standing_grants set capabilities = '[\"database.delete\"]'::jsonb where workspace_id = $1 and id = $2", [ws, g.id])).rejects.toThrow(/keeps the scope/);
      await expect(ctx.db.query("update platform.standing_grants set uses = 4 where workspace_id = $1 and id = $2", [ws, g.id])).rejects.toThrow();
      await expect(ctx.db.query("delete from platform.standing_grants where workspace_id = $1 and id = $2", [ws, g.id])).rejects.toThrow(/cannot be deleted/);
    });

    it("reserves a use atomically and refuses the (count + 1)th", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws, { maxUses: 2 }));
      const reserve = async (principal = "integration:agent_1") => grants.reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: (await op(ws)).id, principalKey: principal, now: new Date() });
      const a = await reserve();
      const b = await reserve();
      const c = await reserve();
      expect(a).toMatchObject({ ok: true });
      expect(b).toMatchObject({ ok: true, grant: { uses: 2 } });
      expect(c).toEqual({ ok: false, reason: "exhausted" });
      expect((await grants.get(ws, g.id))?.uses).toBe(2);
    });

    it("cannot be overspent concurrently, from independent connections where the engine has them", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws, { maxUses: 3 }));
      const other = createPlatformStandingGrantStore(ctx.db2);
      const ops = await Promise.all(Array.from({ length: 10 }, () => op(ws)));
      const results = await Promise.all(ops.map((o, i) => (i % 2 ? grants : other).reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: o.id, principalKey: "integration:agent_1", now: new Date() })));
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect((await grants.get(ws, g.id))?.uses).toBe(3);
    });

    it("one operation can use a grant once", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws));
      const o = await op(ws);
      const first = await grants.reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: o.id, principalKey: "integration:agent_1", now: new Date() });
      const second = await grants.reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: o.id, principalKey: "integration:agent_1", now: new Date() });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect((await grants.get(ws, g.id))?.uses).toBe(1);
    });

    it("refuses a use after expiry or revocation, and a foreign workspace never reaches it", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws));
      const o = await op(ws);
      const base = { workspaceId: ws, grantId: g.id, operationId: o.id, principalKey: "integration:agent_1" };
      expect(await grants.reserveUse({ ...base, useId: uid("sgu"), now: new Date(Date.now() + 2 * 3_600_000) })).toEqual({ ok: false, reason: "expired" });
      expect(await grants.reserveUse({ ...base, workspaceId: newWorkspace(), useId: uid("sgu"), now: new Date() })).toEqual({ ok: false, reason: "not_found" });
      const revoked = await grants.revoke({ workspaceId: ws, id: g.id, revokedBy: "erin", reason: "done", at: new Date() });
      expect(revoked).toMatchObject({ status: "revoked", revokedBy: "erin", revokedReason: "done" });
      expect(await grants.reserveUse({ ...base, useId: uid("sgu"), now: new Date() })).toEqual({ ok: false, reason: "revoked" });
      expect((await grants.get(ws, g.id))?.uses).toBe(0);
    });

    it("a revoked grant stays revoked and revocation is idempotent", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws));
      const first = await grants.revoke({ workspaceId: ws, id: g.id, revokedBy: "erin", at: new Date() });
      const again = await grants.revoke({ workspaceId: ws, id: g.id, revokedBy: "alice", at: new Date() });
      expect(again?.revokedBy).toBe("erin");
      expect(again?.revokedAt).toBe(first?.revokedAt);
      await expect(ctx.db.query("update platform.standing_grants set status = 'active', revoked_at = null where workspace_id = $1 and id = $2", [ws, g.id])).rejects.toThrow();
      expect(await grants.revoke({ workspaceId: newWorkspace(), id: g.id, revokedBy: "x", at: new Date() })).toBeNull();
    });

    it("lists only active grants on request", async () => {
      const ws = newWorkspace();
      const live = await grants.create(newGrant(ws));
      const dead = await grants.create(newGrant(ws));
      await grants.revoke({ workspaceId: ws, id: dead.id, revokedBy: "erin", at: new Date() });
      expect((await grants.list(ws, { activeOnly: true })).map((x) => x.id)).toEqual([live.id]);
      expect((await grants.list(ws)).map((x) => x.id).sort()).toEqual([live.id, dead.id].sort());
    });

    it("attaches an approval once, and a use that produced an approval cannot be voided", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws));
      const o = await op(ws);
      const reserved = await grants.reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: o.id, principalKey: "integration:agent_1", now: new Date() });
      if (!reserved.ok) throw new Error("expected a reservation");
      expect(await grants.attachApproval({ workspaceId: ws, useId: reserved.use.id, approvalId: "apr_1" })).toBe(true);
      expect(await grants.attachApproval({ workspaceId: ws, useId: reserved.use.id, approvalId: "apr_2" })).toBe(false);
      expect(await grants.voidUse({ workspaceId: ws, useId: reserved.use.id, at: new Date() })).toBe(false);
      expect((await grants.usesForOperation(ws, o.id))[0]).toMatchObject({ approvalId: "apr_1", grantId: g.id });
      expect((await grants.usesForGrant(ws, g.id)).map((u) => u.id)).toEqual([reserved.use.id]);
      expect(await grants.usesForGrant(newWorkspace(), g.id)).toEqual([]);
      expect((await grants.get(ws, g.id))?.uses).toBe(1);
      await expect(ctx.db.query("update platform.standing_grant_uses set approval_id = 'apr_9' where workspace_id = $1 and id = $2", [ws, reserved.use.id])).rejects.toThrow(/attached once/);
    });

    it("voiding an unapproved use returns the count", async () => {
      const ws = newWorkspace();
      const g = await grants.create(newGrant(ws, { maxUses: 1 }));
      const o = await op(ws);
      const reserved = await grants.reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: o.id, principalKey: "integration:agent_1", now: new Date() });
      if (!reserved.ok) throw new Error("expected a reservation");
      expect((await grants.get(ws, g.id))?.uses).toBe(1);
      expect(await grants.voidUse({ workspaceId: ws, useId: reserved.use.id, at: new Date() })).toBe(true);
      expect((await grants.get(ws, g.id))?.uses).toBe(0);
      expect(await grants.voidUse({ workspaceId: ws, useId: reserved.use.id, at: new Date() })).toBe(false);
      const again = await grants.reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: o.id, principalKey: "integration:agent_1", now: new Date() });
      expect(again.ok).toBe(true);
      expect((await grants.usesForOperation(ws, o.id)).map((u) => Boolean(u.voidedAt))).toEqual([true, false]);
    });

    it("a use cannot name another workspace's operation or grant", async () => {
      const ws = newWorkspace();
      const other = newWorkspace();
      const g = await grants.create(newGrant(ws));
      const foreignOp = await op(other);
      await expect(grants.reserveUse({ workspaceId: ws, grantId: g.id, useId: uid("sgu"), operationId: foreignOp.id, principalKey: "integration:agent_1", now: new Date() })).rejects.toThrow();
      expect((await grants.get(ws, g.id))?.uses).toBe(0);
    });
  });
});
