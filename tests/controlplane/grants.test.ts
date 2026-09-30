/**
 * Capability grants: single-use consumption, revocation, expiry, tenancy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { PlatformDbError } from "@/lib/controlplane/db";
import { LANES, expectCode, newWorkspace, openLane, seedApprovedOperation, uid } from "./_support/harness";

describe.each(LANES)("capability grants [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  const db = () => ctx.db;

  async function grantFor(over: { issuedAt?: string; expiresAt?: string; audience?: string } = {}) {
    const seeded = await seedApprovedOperation(db());
    const jti = uid("jti");
    const now = Date.now();
    const grant = await repos.grants.insert(db(), {
      jti,
      workspaceId: seeded.workspaceId,
      operationId: seeded.operation.id,
      capability: "infrastructure.apply",
      audience: over.audience ?? "worker",
      issuedAt: over.issuedAt ?? new Date(now).toISOString(),
      expiresAt: over.expiresAt ?? new Date(now + 5 * 60_000).toISOString(),
    });
    return { seeded, grant, ws: seeded.workspaceId, jti };
  }

  it("records an issued grant and reports it active", async () => {
    const { grant, ws, jti } = await grantFor();
    expect(grant).toMatchObject({ jti, workspaceId: ws, capability: "infrastructure.apply", audience: "worker" });
    expect(grant.consumedAt).toBeUndefined();
    expect(await repos.grants.status(db(), ws, jti)).toBe("active");
    expect(await repos.grants.get(db(), ws, jti)).toEqual(grant);
  });

  it("consume succeeds exactly once; the second consume returns false", async () => {
    const { ws, jti } = await grantFor();
    expect(await repos.grants.consume(db(), { workspaceId: ws, jti })).toBe(true);
    expect(await repos.grants.consume(db(), { workspaceId: ws, jti })).toBe(false);
    expect(await repos.grants.status(db(), ws, jti)).toBe("consumed");
    expect((await repos.grants.get(db(), ws, jti))?.consumedAt).toBeDefined();
  });

  it("concurrent consumers of one grant: exactly one wins", async () => {
    const { ws, jti } = await grantFor();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? ctx.db : ctx.db2).tx((tx) => repos.grants.consume(tx, { workspaceId: ws, jti }))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a revoked, expired, unknown, wrong-workspace or wrong-audience grant cannot be consumed", async () => {
    const revoked = await grantFor();
    expect(await repos.grants.revoke(db(), revoked.ws, revoked.jti)).toBe(true);
    expect(await repos.grants.revoke(db(), revoked.ws, revoked.jti)).toBe(false);
    expect(await repos.grants.isRevoked(db(), revoked.ws, revoked.jti)).toBe(true);
    expect(await repos.grants.consume(db(), { workspaceId: revoked.ws, jti: revoked.jti })).toBe(false);

    const past = Date.now() - 30 * 60_000;
    const expired = await grantFor({ issuedAt: new Date(past).toISOString(), expiresAt: new Date(past + 60_000).toISOString() });
    expect(await repos.grants.status(db(), expired.ws, expired.jti)).toBe("expired");
    expect(await repos.grants.consume(db(), { workspaceId: expired.ws, jti: expired.jti })).toBe(false);

    const good = await grantFor({ audience: "runner:run_1" });
    expect(await repos.grants.consume(db(), { workspaceId: good.ws, jti: "jti_does_not_exist" })).toBe(false);
    expect(await repos.grants.status(db(), good.ws, "jti_does_not_exist")).toBe("unknown");
    expect(await repos.grants.isRevoked(db(), good.ws, "jti_does_not_exist")).toBe(false); // unknown is not "revoked"
    expect(await repos.grants.consume(db(), { workspaceId: newWorkspace(), jti: good.jti })).toBe(false);
    expect(await repos.grants.consume(db(), { workspaceId: good.ws, jti: good.jti, audience: "worker" })).toBe(false);
    // none of the refusals consumed it
    expect(await repos.grants.status(db(), good.ws, good.jti)).toBe("active");
    expect(await repos.grants.consume(db(), { workspaceId: good.ws, jti: good.jti, audience: "runner:run_1" })).toBe(true);
  });

  it("revokeForOperation revokes live grants but not ones already consumed", async () => {
    const { seeded, ws, jti } = await grantFor();
    const second = uid("jti");
    const now = Date.now();
    await repos.grants.insert(db(), { jti: second, workspaceId: ws, operationId: seeded.operation.id, capability: "x", audience: "worker", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
    await repos.grants.consume(db(), { workspaceId: ws, jti });
    expect(await repos.grants.revokeForOperation(db(), ws, seeded.operation.id)).toBe(1);
    expect(await repos.grants.status(db(), ws, second)).toBe("revoked");
    expect(await repos.grants.status(db(), ws, jti)).toBe("consumed");
    expect(await repos.grants.revokeForOperation(db(), newWorkspace(), seeded.operation.id)).toBe(0);
  });

  it("refuses a grant that outlives one hour, expires before it is issued, or names another workspace's operation", async () => {
    const seeded = await seedApprovedOperation(db());
    const base = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, capability: "x", audience: "worker" };
    const t = Date.now();
    await expectCode(repos.grants.insert(db(), { ...base, jti: uid("j"), issuedAt: new Date(t).toISOString(), expiresAt: new Date(t + 61 * 60_000).toISOString() }), "invalid_input");
    await expectCode(repos.grants.insert(db(), { ...base, jti: uid("j"), issuedAt: new Date(t).toISOString(), expiresAt: new Date(t - 1).toISOString() }), "invalid_input");
    const err = await repos.grants
      .insert(db(), { ...base, workspaceId: newWorkspace(), jti: uid("j"), issuedAt: new Date(t).toISOString(), expiresAt: new Date(t + 60_000).toISOString() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformDbError);
    expect((err as PlatformDbError).sqlstate).toBe("23503"); // composite FK: a grant cannot point at another tenant's operation
  });

  it("get and status are workspace scoped", async () => {
    const { ws, jti } = await grantFor();
    expect(await repos.grants.get(db(), ws, jti)).not.toBeNull();
    expect(await repos.grants.get(db(), newWorkspace(), jti)).toBeNull();
    expect(await repos.grants.status(db(), newWorkspace(), jti)).toBe("unknown");
  });
});
