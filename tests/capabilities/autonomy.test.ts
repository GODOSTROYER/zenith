/**
 * Autonomy 0–5: class defaults, admin-only human-only changes, the Navigator
 * mapping, and what a level does to decisions. Workspace policy settings share
 * the same guards and are tested here too.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_AUTONOMY_BY_CLASS, AUTONOMY_LEVELS, defaultAutonomyFor, describeAutonomy, isAutonomyLevel, levelFromNavigator, navigatorFromLevel } from "@/lib/capabilities/autonomy";
import { AutonomyLevel as NavigatorAutonomy } from "@/lib/domain/types";
import { STORE_KINDS, closeSharedPgliteAfterAll, expectBrokerError, integrationOf, makeHarness, navigator, requestFor, sessionFor, user } from "./support";

closeSharedPgliteAfterAll();

describe("the Navigator mapping and descriptions", () => {
  it("maps observe→0, plan→1, approve→2, bounded→3, autonomous→5 and back", () => {
    expect(NavigatorAutonomy.options.map((n) => levelFromNavigator(n))).toEqual([0, 1, 2, 3, 5]);
    expect(navigatorFromLevel(0)).toBe("observe");
    expect(navigatorFromLevel(1)).toBe("plan");
    expect(navigatorFromLevel(2)).toBe("approve");
    expect(navigatorFromLevel(3)).toBe("bounded");
    expect(navigatorFromLevel(4)).toBe("bounded");
    expect(navigatorFromLevel(5)).toBe("autonomous");
    for (const n of NavigatorAutonomy.options) expect(navigatorFromLevel(levelFromNavigator(n))).toBe(n);
  });

  it("describes every level honestly and validates levels", () => {
    expect(AUTONOMY_LEVELS).toEqual([0, 1, 2, 3, 4, 5]);
    for (const level of AUTONOMY_LEVELS) {
      const d = describeAutonomy(level);
      expect(d.level).toBe(level);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.summary.length).toBeGreaterThan(10);
      expect(d.navigator).toBe(navigatorFromLevel(level));
    }
    expect(describeAutonomy(5).unattended).toContain("still need approval");
    for (const bad of [-1, 6, 1.5, "3", null, undefined, Number.NaN]) expect(isAutonomyLevel(bad)).toBe(false);
  });

  it("defaults are production 2, staging 3, development 3, sandbox 4", () => {
    expect(DEFAULT_AUTONOMY_BY_CLASS).toEqual({ production: 2, staging: 3, development: 3, sandbox: 4 });
    expect(defaultAutonomyFor("production")).toBe(2);
  });
});

describe.each(STORE_KINDS)("environment autonomy [%s]", (kind) => {
  it("reports the class default until an admin sets a level", async () => {
    const h = await makeHarness({ kind });
    const read = (envId: string) => h.broker.getAutonomy({ workspaceId: h.ids.wsA, environmentId: envId, principal: user("carol") });
    expect(await read(h.ids.envAProd)).toMatchObject({ level: 2, defaulted: true, name: "Plan", environmentClass: "production", defaultForClass: 2, version: 0, navigator: "approve" });
    expect(await read(h.ids.envAStg)).toMatchObject({ level: 3, defaulted: true });
    expect(await read(h.ids.envASbx)).toMatchObject({ level: 4, defaulted: true });

    const set = await h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, level: 3, actor: user("alice"), session: sessionFor("alice") });
    expect(set).toMatchObject({ level: 3, defaulted: false, version: 1, updatedBy: "alice", name: "Safe execution" });
    expect(await read(h.ids.envAProd)).toMatchObject({ level: 3, defaulted: false });
    // explicitly setting the level the class would default to is still a configured value
    const same = await h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAStg, level: 3, actor: user("erin"), session: sessionFor("erin") });
    expect(same).toMatchObject({ level: 3, defaulted: false, version: 1 });
  });

  it("changes what is decided", async () => {
    const h = await makeHarness({ kind });
    const decide = async () => (await h.broker.check(requestFor(h, "service.restart", "sbx"), user("bob"))).decision;
    expect((await decide()).outcome).toBe("allow");
    await h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envASbx, level: 2, actor: user("alice"), session: sessionFor("alice") });
    expect((await decide()).outcome).toBe("require_approval");
    await h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envASbx, level: 0, actor: user("alice"), session: sessionFor("alice") });
    expect((await h.broker.check(requestFor(h, "service.restart", "sbx"), navigator("bob"))).decision.outcome).toBe("deny");
    // reads are unaffected by autonomy
    expect((await h.broker.check(requestFor(h, "logs.read", "sbx"), navigator("bob"))).decision.outcome).toBe("allow");
  });

  it("is admin-only", async () => {
    const h = await makeHarness({ kind });
    for (const who of ["bob", "carol", "dave"]) {
      const error = await expectBrokerError(h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, level: 5, actor: user(who), session: sessionFor(who) }), "admin_required");
      expect(error.status).toBe(403);
    }
    expect((await h.broker.getAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, principal: user("bob") })).defaulted).toBe(true);
  });

  it("can never be changed by an agent, the Navigator, or a caller without a browser session", async () => {
    const h = await makeHarness({ kind });
    const set = (actor: ReturnType<typeof user>, session = sessionFor(actor.id)) => h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, level: 5, actor, session });
    await expectBrokerError(set(integrationOf(h, "intRW", "alice")), "approver_not_human");
    await expectBrokerError(set(navigator("alice")), "approver_not_human");
    await expectBrokerError(set({ ...user("alice"), onBehalfOf: "alice" }), "approver_not_human");
    await expectBrokerError(set(user("alice"), sessionFor("bob")), "browser_session_required");
    await expectBrokerError(set(user("alice"), null as never), "browser_session_required");
    expect((await h.broker.getAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, principal: user("alice") })).defaulted).toBe(true);
  });

  it("validates the level and uses optimistic concurrency", async () => {
    const h = await makeHarness({ kind });
    const set = (level: unknown, expectedVersion?: number) =>
      h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, level, actor: user("alice"), session: sessionFor("alice"), expectedVersion });
    for (const bad of [-1, 6, 2.5, "3", null]) await expectBrokerError(set(bad), "invalid_request");
    await set(3, 0);
    await expectBrokerError(set(4, 0), "conflict");
    expect((await set(4, 1)).level).toBe(4);
  });

  it("records who changed it and from what", async () => {
    const h = await makeHarness({ kind });
    await h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, level: 4, actor: user("alice"), session: sessionFor("alice") });
    const change = (await h.store.listEvents(h.ids.wsA)).find((e) => (e.data as { kind?: string }).kind === "autonomy_changed");
    expect(change?.actor?.id).toBe("alice");
    expect(change?.data).toMatchObject({ from: 2, to: 4, environmentClass: "production" });
    expect(change?.environmentId).toBe(h.ids.envAProd);
  });
});

describe.each(STORE_KINDS)("workspace policy [%s]", (kind) => {
  it("reads defaults, then an admin's validated overrides", async () => {
    const h = await makeHarness({ kind });
    const before = await h.broker.getWorkspacePolicy({ workspaceId: h.ids.wsA, principal: user("carol") });
    expect(before).toMatchObject({ isDefault: true, version: 0, overrides: {} });
    expect(before.effective).toMatchObject({ costApprovalThresholdUsd: 50, twoPersonProduction: false, deniedCapabilities: [] });

    const after = await h.broker.setWorkspacePolicy({
      workspaceId: h.ids.wsA,
      overrides: { twoPersonProduction: true, approvedRegions: ["us-east-1", "eu-west-1"], costApprovalThresholdUsd: 10 },
      actor: user("alice"),
      session: sessionFor("alice"),
    });
    expect(after).toMatchObject({ isDefault: false, version: 1, updatedBy: "alice" });
    expect(after.effective).toMatchObject({ twoPersonProduction: true, approvedRegions: ["eu-west-1", "us-east-1"], costApprovalThresholdUsd: 10 });
    // and it changes decisions: production now needs a second person
    const d = (await h.broker.check(requestFor(h, "service.restart", "prod"), user("bob"))).decision;
    expect(d.approval).toMatchObject({ separationOfDuties: true });
  });

  it("refuses invalid policy loudly, without storing it", async () => {
    const h = await makeHarness({ kind });
    const set = (overrides: unknown) => h.broker.setWorkspacePolicy({ workspaceId: h.ids.wsA, overrides, actor: user("alice"), session: sessionFor("alice") });
    const unknownKey = await expectBrokerError(set({ notAKnob: true }), "invalid_request");
    expect(unknownKey.details).toBeDefined();
    await expectBrokerError(set({ deniedCapabilities: ["typo.capability"] }), "invalid_request");
    await expectBrokerError(set({ approvedRegions: [] }), "invalid_request");
    await expectBrokerError(set({ costApprovalThresholdUsd: -5 }), "invalid_request");
    await expectBrokerError(set(["an", "array"]), "invalid_request");
    await expectBrokerError(set(null), "invalid_request");
    expect((await h.broker.getWorkspacePolicy({ workspaceId: h.ids.wsA, principal: user("alice") })).isDefault).toBe(true);
  });

  it("is admin-only, human-only and browser-only, with optimistic concurrency", async () => {
    const h = await makeHarness({ kind });
    const set = (actor: ReturnType<typeof user>, session = sessionFor(actor.id), expectedVersion?: number) =>
      h.broker.setWorkspacePolicy({ workspaceId: h.ids.wsA, overrides: { twoPersonProduction: true }, actor, session, expectedVersion });
    await expectBrokerError(set(user("bob")), "admin_required");
    await expectBrokerError(set(user("carol")), "admin_required");
    await expectBrokerError(set(integrationOf(h, "intRW", "alice")), "approver_not_human");
    await expectBrokerError(set(navigator("alice")), "approver_not_human");
    await expectBrokerError(set(user("alice"), sessionFor("bob")), "browser_session_required");
    await set(user("alice"), undefined, 0);
    await expectBrokerError(set(user("alice"), undefined, 0), "conflict");
    expect((await set(user("erin"), undefined, 1)).version).toBe(2);
  });

  it("records the change in the audit log", async () => {
    const h = await makeHarness({ kind });
    await h.broker.setWorkspacePolicy({ workspaceId: h.ids.wsA, overrides: { twoPersonProduction: true }, actor: user("alice"), session: sessionFor("alice") });
    const change = (await h.store.listEvents(h.ids.wsA)).find((e) => (e.data as { kind?: string }).kind === "workspace_policy_changed");
    expect(change?.data).toMatchObject({ fromVersion: 0, toVersion: 1, keys: ["twoPersonProduction"] });
  });
});
