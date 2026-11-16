/** Real SQL consent/audit tests; browser identity and membership are explicit broker fixtures. */
import { describe, expect, it } from "vitest";
import { readOptimizerSettings, setOptimizerSettings } from "@/lib/cost/optimizer-settings-service";
import { repos } from "@/lib/controlplane/db";
import { PG_URL, closeSharedPgliteAfterAll, makeHarness, sharedDatabase, user } from "../capabilities/support";

closeSharedPgliteAfterAll();
for (const kind of ["pglite", "postgres"] as const) describe.skipIf(kind === "postgres" && !PG_URL)(`optimizer human consent [${kind}${kind === "postgres" ? "; needs ZENITH_TEST_PLATFORM_PG_URL" : ""}]`, () => {
  async function setup() {
    const h = await makeHarness({ kind });
    const db = await sharedDatabase(kind);
    const input = { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, actor: user("alice"), session: { method: "browser_session" as const, subject: "alice", verifiedAtMs: h.clock.now().getTime() } };
    return { h, db, input };
  }
  it("defaults off and records consent plus audit, without operations or approvals", async () => {
    const { h, db, input } = await setup();
    expect(await readOptimizerSettings(db, h.broker, input)).toMatchObject({ enabled: false, version: 0 });
    const saved = await setOptimizerSettings(db, h.broker, input, { enabled: true, expectedVersion: 0 });
    expect(saved).toMatchObject({ settings: { enabled: true, version: 1, updatedBy: "alice" }, proposalOnly: true });
    const events = await repos.events.list(db, input.workspaceId, { environmentId: input.environmentId });
    expect(events.some(e => e.data.kind === "optimizer_settings_changed" && e.data.enabled === true)).toBe(true);
    expect((await h.store.listOperations(input.workspaceId)).items).toHaveLength(0);
    expect(await setOptimizerSettings(db, h.broker, input, { enabled: false, expectedVersion: 1 })).toMatchObject({ settings: { enabled: false, version: 2 } });
  });
  it("refuses bearer-shaped actors, non-admins, cross-tenant scope and malformed consent", async () => {
    const { h, db, input } = await setup();
    await expect(setOptimizerSettings(db, h.broker, { ...input, actor: { kind: "integration", id: "agent", name: "Agent", onBehalfOf: "alice" } }, { enabled: true, expectedVersion: 0 })).rejects.toMatchObject({ code: "approver_not_human" });
    await expect(setOptimizerSettings(db, h.broker, { ...input, actor: user("bob"), session: { ...input.session, subject: "bob" } }, { enabled: true, expectedVersion: 0 })).rejects.toMatchObject({ code: "role_insufficient" });
    await expect(setOptimizerSettings(db, h.broker, { ...input, environmentId: h.ids.envBProd }, { enabled: true, expectedVersion: 0 })).rejects.toMatchObject({ code: "not_found" });
    await expect(setOptimizerSettings(db, h.broker, input, { enabled: true, approved: true })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await repos.optimizerSettings.getOptimizerSettings(db, input.workspaceId, input.environmentId)).toMatchObject({ enabled: false, version: 0 });
  });
  it("refuses a nonexistent expected version and serializes simultaneous first opt-ins", async () => {
    const { h, db, input } = await setup();
    await expect(setOptimizerSettings(db, h.broker, input, { enabled: true, expectedVersion: 1 })).rejects.toMatchObject({ code: "conflict" });
    const results = await Promise.allSettled([true, false].map(enabled => setOptimizerSettings(db, h.broker, input, { enabled, expectedVersion: 0 })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await readOptimizerSettings(db, h.broker, input)).version).toBe(1);
  });
});
