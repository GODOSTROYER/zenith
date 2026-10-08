import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductContext } from "@/lib/execution/ports";
import { createDefaultManagedSubstrate } from "@/lib/platform/zenith-managed";
import { assertBillingAdmitted } from "@/lib/billing/admission";
import { assignPlan, getAccount } from "@/lib/billing/store";
import { suspendWorkspace } from "@/lib/billing/standing";
import { LANES, newWorkspace, openLane } from "../controlplane/_support/harness";
import { FULL_ENV } from "../providers/zenith/support";

const product = { loadContext: async ({ workspaceId, environmentId }: { workspaceId: string; environmentId: string }) => ({ workspace: { id: workspaceId, slug: "acme" }, environment: { id: environmentId } }) as ProductContext };
describe.each(LANES)("billing assignment selects managed capacity [$name]", lane => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  it("re-reads upgrades and downgrades without changing running workloads or suspending the account", async () => {
    const ws = newWorkspace();
    const managed = createDefaultManagedSubstrate({ env: { ...FULL_ENV, ZENITH_BILLING: "managed", ZENITH_MANAGED_DEFAULT_PLAN: "invalid-ignored" }, product, db: ctx.db });
    for (const [planId, tier] of [["free_provisional", "free"], ["scale_provisional", "pro"], ["team_provisional", "starter"], ["free_provisional", "free"]]) {
      await assignPlan(ctx.db, { workspaceId: ws, planId, actor: "operator" });
      expect((await managed.tenants.resolve({ workspaceId: ws, environmentId: "env-billing" })).planTier).toBe(tier);
      expect((await getAccount(ctx.db, ws))?.status).toBe("active");
    }
    expect((await ctx.db.query<{ n: number }>("select count(*)::int as n from platform.resources where workspace_id = $1", [ws]))[0].n).toBe(0);
  });
  it("refuses absent or unreadable billing assignments before any platform credential read", async () => {
    let reads = 0;
    const ws = newWorkspace();
    const managed = createDefaultManagedSubstrate({ env: { ...FULL_ENV, ZENITH_BILLING: "managed", ZENITH_MANAGED_DEFAULT_PLAN: "pro" }, product, db: ctx.db, readPlatformSecret: async () => { reads++; return "unused"; } });
    await expect(managed.tenants.resolve({ workspaceId: ws, environmentId: "env-billing" })).rejects.toMatchObject({ code: "tenant_unresolved" });
    await expect(assertBillingAdmitted({ workspaceId: ws, kind: "deploy" }, { env: { ZENITH_BILLING: "managed" }, store: async () => ctx.db })).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(reads).toBe(0);
  });
  it("keeps tenant resolution, reads and destroy available during suspension while refusing new work", async () => {
    const ws = newWorkspace();
    await assignPlan(ctx.db, { workspaceId: ws, planId: "team_provisional", actor: "operator" });
    await suspendWorkspace(ctx.db, { workspaceId: ws, actor: "operator", reason: "review", now: new Date() });
    const managed = createDefaultManagedSubstrate({ env: { ...FULL_ENV, ZENITH_BILLING: "managed" }, product, db: ctx.db });
    expect((await managed.tenants.resolve({ workspaceId: ws, environmentId: "env-billing" })).planTier).toBe("starter");
    const opts = { env: { ZENITH_BILLING: "managed" }, store: async () => ctx.db };
    await expect(assertBillingAdmitted({ workspaceId: ws, kind: "deploy" }, opts)).rejects.toMatchObject({ code: "billing_suspended" });
    for (const kind of ["export", "destroy"]) await expect(assertBillingAdmitted({ workspaceId: ws, kind }, opts)).resolves.toBeUndefined();
  });
  it("disabled billing uses the operator tier with zero billing store I/O", async () => {
    const managed = createDefaultManagedSubstrate({ env: { ...FULL_ENV, ZENITH_MANAGED_DEFAULT_PLAN: "pro" }, product, db: { query: async () => { throw new Error("forbidden"); } } as never });
    expect((await managed.tenants.resolve({ workspaceId: newWorkspace(), environmentId: "env-billing" })).planTier).toBe("pro");
  });
});
