/**
 * PROD-MACH-02 guest binding store (real PGlite, plus Postgres when ZENITH_TEST_PLATFORM_PG_URL is set):
 * tenancy, the SQL-level connection gate on every issuance, and revocation in the same commit as the
 * connection revoke (both revokeAudited and plain revoke).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { guestObjectName } from "@/lib/providers/kubernetes/guest";
import { LANES, newWorkspace, openLane } from "./_support/harness";

const config = (ref: string): KubernetesConnectionConfig => ({ provider: "kubernetes", mode: "scoped_guest", server: "https://cluster.example.test", caData: Buffer.from("ca").toString("base64"), credentialRef: ref, namespaces: ["app"] });

describe.each(LANES)("kubernetes guest bindings [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });

  async function fixture() {
    const workspaceId = newWorkspace();
    const c = await repos.connections.create(ctx.db, { workspaceId, createdBy: "admin", config: config(`vault:minter/${workspaceId}`) });
    await repos.connections.recordVerification(ctx.db, { workspaceId, id: c.id, ok: true, detail: "fixture" });
    const input = { workspaceId, connectionId: c.id, namespace: "app", profile: "read" as const, objectName: guestObjectName(workspaceId, c.id, "read") };
    return { workspaceId, connectionId: c.id, input };
  }

  it("creates one row per scope, idempotently, and never stores credential material", async () => {
    const f = await fixture();
    const a = (await repos.k8sGuestBindings.ensure(ctx.db, f.input))!;
    const b = (await repos.k8sGuestBindings.ensure(ctx.db, f.input))!;
    expect(a.id).toBe(b.id);
    expect(a.status).toBe("provisioning");
    const exec = (await repos.k8sGuestBindings.ensure(ctx.db, { ...f.input, profile: "exec", objectName: guestObjectName(f.workspaceId, f.connectionId, "exec") }))!;
    expect(exec.id).not.toBe(a.id);
    const columns = await ctx.db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'platform' and table_name = 'k8s_guest_bindings'");
    expect(columns.map((c) => c.column_name).filter((n) => /token|secret|kubeconfig|credential/.test(n))).toEqual([]);
  });

  it("is tenant scoped: a foreign workspace cannot read, activate, record or list", async () => {
    const f = await fixture(), other = newWorkspace();
    const row = (await repos.k8sGuestBindings.ensure(ctx.db, f.input))!;
    expect(await repos.k8sGuestBindings.ensure(ctx.db, { ...f.input, workspaceId: other })).toBeNull();
    expect(await repos.k8sGuestBindings.get(ctx.db, other, row.id)).toBeNull();
    expect(await repos.k8sGuestBindings.markActive(ctx.db, other, row.id, "uid-1")).toBeNull();
    expect(await repos.k8sGuestBindings.recordIssuance(ctx.db, other, row.id, new Date(Date.now() + 600_000))).toBe(false);
    expect(await repos.k8sGuestBindings.listOpen(ctx.db, other, f.connectionId)).toEqual([]);
    expect(await repos.k8sGuestBindings.markRevoking(ctx.db, other, row.id)).toBe(false);
    expect((await repos.k8sGuestBindings.get(ctx.db, f.workspaceId, row.id))!.status).toBe("provisioning");
  });

  it("records issuances only while the binding is active", async () => {
    const f = await fixture();
    const row = (await repos.k8sGuestBindings.ensure(ctx.db, f.input))!;
    expect(await repos.k8sGuestBindings.recordIssuance(ctx.db, f.workspaceId, row.id, new Date(Date.now() + 600_000))).toBe(false);
    expect((await repos.k8sGuestBindings.markActive(ctx.db, f.workspaceId, row.id, "uid-1"))!.status).toBe("active");
    expect(await repos.k8sGuestBindings.recordIssuance(ctx.db, f.workspaceId, row.id, new Date(Date.now() + 600_000))).toBe(true);
    const after = (await repos.k8sGuestBindings.get(ctx.db, f.workspaceId, row.id))!;
    expect(after).toMatchObject({ status: "active", saUid: "uid-1", issuedCount: 1 });
    expect(after.lastTokenExpiresAt).toBeTruthy();
  });

  it.each([["revokeAudited"], ["revoke"]] as const)("connection %s moves open bindings to revoking in the same commit and blocks every later mint", async (path) => {
    const f = await fixture();
    const row = (await repos.k8sGuestBindings.ensure(ctx.db, f.input))!;
    await repos.k8sGuestBindings.markActive(ctx.db, f.workspaceId, row.id, "uid-1");
    if (path === "revokeAudited") await repos.connections.revokeAudited(ctx.db, { workspaceId: f.workspaceId, id: f.connectionId, actorId: "admin", reason: "test" });
    else await repos.connections.revoke(ctx.db, f.workspaceId, f.connectionId);
    expect((await repos.k8sGuestBindings.get(ctx.db, f.workspaceId, row.id))!.status).toBe("revoking");
    expect(await repos.k8sGuestBindings.recordIssuance(ctx.db, f.workspaceId, row.id, new Date(Date.now() + 600_000))).toBe(false);
    expect(await repos.k8sGuestBindings.markActive(ctx.db, f.workspaceId, row.id, "uid-2")).toBeNull();
    // A revoked connection cannot acquire a new binding, and an existing row is never resurrected.
    expect(await repos.k8sGuestBindings.ensure(ctx.db, { ...f.input, namespace: "other", objectName: "zg-other" })).toBeNull();
    expect((await repos.k8sGuestBindings.listOpen(ctx.db, f.workspaceId, f.connectionId)).map((b) => b.status)).toEqual(["revoking"]);
    // Deletion confirmed -> revoked; repeating is harmless.
    expect(await repos.k8sGuestBindings.markRevoked(ctx.db, f.workspaceId, row.id)).toBe(true);
    expect(await repos.k8sGuestBindings.markRevoked(ctx.db, f.workspaceId, row.id)).toBe(true);
    expect(await repos.k8sGuestBindings.listOpen(ctx.db, f.workspaceId, f.connectionId)).toEqual([]);
    expect((await repos.k8sGuestBindings.listForConnection(ctx.db, f.workspaceId, f.connectionId))[0]).toMatchObject({ status: "revoked" });
  });

  it("a connection revoked behind the row's back still gates issuance in SQL", async () => {
    const f = await fixture();
    const row = (await repos.k8sGuestBindings.ensure(ctx.db, f.input))!;
    await repos.k8sGuestBindings.markActive(ctx.db, f.workspaceId, row.id, "uid-1");
    await ctx.db.query("update platform.provider_connections set status = 'revoked' where workspace_id = $1 and id = $2", [f.workspaceId, f.connectionId]);
    expect(await repos.k8sGuestBindings.recordIssuance(ctx.db, f.workspaceId, row.id, new Date(Date.now() + 600_000))).toBe(false);
  });

  it("only stable error codes are accepted", async () => {
    const f = await fixture();
    const row = (await repos.k8sGuestBindings.ensure(ctx.db, f.input))!;
    await repos.k8sGuestBindings.recordError(ctx.db, f.workspaceId, row.id, "cluster_error");
    expect((await repos.k8sGuestBindings.get(ctx.db, f.workspaceId, row.id))!.lastError).toBe("cluster_error");
    await expect(repos.k8sGuestBindings.recordError(ctx.db, f.workspaceId, row.id, "Bearer abc.def.ghi")).rejects.toThrow();
  });
});
