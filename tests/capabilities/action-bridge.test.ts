/**
 * The bridge from product actions to broker capabilities.
 */
import { describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { ACTION_CAPABILITY_MAP, checkActionThroughBroker, mappingFor, principalFromAction } from "@/lib/capabilities/action-bridge";
import { STORE_KINDS, closeSharedPgliteAfterAll, makeHarness, scriptedEngine, type Harness } from "./support";

closeSharedPgliteAfterAll();

const CANARY = "AKIAIOSFODNN7EXAMPLE";

const ctxFor = (h: Harness, over: Partial<ActionContext> = {}): ActionContext => ({
  workspaceId: h.ids.wsA,
  projectId: h.ids.projA,
  actor: { type: "navigator", id: "navigator", name: "Navigator" },
  ...over,
});

describe("the mapping table", () => {
  it("maps only to capabilities that exist, and never forwards a secret-looking field", () => {
    for (const [id, m] of Object.entries(ACTION_CAPABILITY_MAP)) {
      if (m.kind === "local") {
        expect(m.why.length).toBeGreaterThan(10);
        continue;
      }
      expect(Object.prototype.hasOwnProperty.call(CAPABILITIES, m.capability), `${id} -> ${m.capability}`).toBe(true);
      for (const field of m.pick) expect(field, `${id} forwards ${field}`).not.toMatch(/secretvalue|password|token|apikey|credential/i);
    }
  });

  it("covers the deploy and day-two actions the brief names", () => {
    const capOf = (id: string) => {
      const m = mappingFor(id);
      return m?.kind === "capability" ? m.capability : undefined;
    };
    expect(capOf("deploy.apply")).toBe("deployment.deploy");
    expect(capOf("deploy.rollback")).toBe("deployment.rollback");
    expect(capOf("deploy.promote")).toBe("deployment.deploy");
    expect(capOf("ops.restartService")).toBe("service.restart");
    expect(capOf("ops.scaleService")).toBe("service.scale");
    expect(capOf("system.setSecret")).toBe("secret.write");
    expect(capOf("system.rotateSecret")).toBe("secret.write");
    expect(capOf("env.delete")).toBe("infrastructure.destroy");
    expect(mappingFor("system.addService")?.kind).toBe("local");
    expect(mappingFor("constructor")).toBeUndefined();
    expect(mappingFor("__proto__")).toBeUndefined();
  });

  it("covers every action the product registers, except the ones deliberately left for people", async () => {
    await import("@/lib/actions/defs");
    const { actionRegistry } = await import("@/lib/actions/core");
    const unmapped = [...actionRegistry().values()].filter((a) => a.mutates && !mappingFor(a.id)).map((a) => a.id).sort();
    // A NEW mutating action shows up here and fails this test until it is mapped (as a capability or as local)
    // or added to this list on purpose. Unmapped means refused for agents.
    expect(unmapped).toEqual(
      [
        "alerts.createChannel",
        "alerts.deleteChannel",
        "alerts.testChannel",
        "alerts.updateChannel",
        "app.create",
        "app.publish",
        "app.resume",
        "app.rollback",
        "app.suspend",
        "connection.check",
        "connection.create",
        "connection.createAws",
        "connection.disconnect",
        "connection.verifyAws",
        "placement.apply",
        "project.delete",
        "workspace.setAutonomy",
      ].sort()
    );
  });
});

describe("principalFromAction", () => {
  it("maps actors to principals, binding an integration to the human it acts for", () => {
    const h = { ids: { wsA: "w" } } as unknown as Harness;
    expect(principalFromAction(ctxFor(h, { actor: { type: "user", id: "bob", name: "Bob" } }))).toEqual({ kind: "user", id: "bob", name: "Bob" });
    expect(principalFromAction(ctxFor(h))).toEqual({ kind: "navigator", id: "navigator", name: "Navigator" });
    expect(principalFromAction(ctxFor(h, { actor: { type: "system", id: "s", name: "System" } }))).toMatchObject({ kind: "system" });
    const integration = principalFromAction(ctxFor(h, { actor: { type: "user", id: "bob", name: "Bob" }, integration: { operationId: "o", clientId: "cli_1", proposalDigest: "d" } }));
    expect(integration).toMatchObject({ kind: "integration", id: "cli_1", integrationId: "cli_1", onBehalfOf: "bob" });
  });
});

describe.each(STORE_KINDS)("checkActionThroughBroker [%s]", (kind) => {
  it("leaves humans and local actions to runAction", async () => {
    const h = await makeHarness({ kind });
    const human = await checkActionThroughBroker(h.deps, ctxFor(h, { actor: { type: "user", id: "bob", name: "Bob" }, environmentId: h.ids.envAProd }), "deploy.apply", {});
    expect(human).toMatchObject({ kind: "not_brokered" });
    const local = await checkActionThroughBroker(h.deps, ctxFor(h), "system.addService", { name: "x" });
    expect(local).toMatchObject({ kind: "not_brokered" });
    expect((local as { why: string }).why).toContain("working manifest");
  });

  it("refuses an action nobody mapped, for an agent", async () => {
    const h = await makeHarness({ kind });
    const result = await checkActionThroughBroker(h.deps, ctxFor(h), "some.newAction", {});
    expect(result).toMatchObject({ kind: "deny", code: "action_not_mapped" });
  });

  it("decides a mapped action as its capability", async () => {
    const h = await makeHarness({ kind });
    const navigatorCtx = (environmentId: string) => ctxFor(h, { environmentId });
    const prodDeploy = await checkActionThroughBroker(h.deps, navigatorCtx(h.ids.envAProd), "deploy.apply", { message: "ship it" });
    expect(prodDeploy).toMatchObject({ kind: "require_approval", capability: "deployment.deploy" });
    const sbxRestart = await checkActionThroughBroker(h.deps, navigatorCtx(h.ids.envASbx), "ops.restartService", { serviceId: h.ids.resAWebSbx });
    expect(sbxRestart).toMatchObject({ kind: "allow", capability: "service.restart" });
    // a dry run persisted nothing
    expect((await h.store.listOperations(h.ids.wsA)).items).toHaveLength(0);
  });

  it("acts as an integration bound to its credential's scopes", async () => {
    const h = await makeHarness({ kind });
    const asAgent = (id: string): ActionContext => ctxFor(h, { actor: { type: "user", id: "bob", name: "Bob" }, environmentId: h.ids.envASbx, integration: { operationId: "o", clientId: id, proposalDigest: "d" } });
    expect(await checkActionThroughBroker(h.deps, asAgent(h.ids.intRW), "ops.restartService", { serviceId: h.ids.resAWebSbx })).toMatchObject({ kind: "allow" });
    const readOnly = await checkActionThroughBroker(h.deps, asAgent(h.ids.intRO), "ops.restartService", { serviceId: h.ids.resAWebSbx });
    expect(readOnly).toMatchObject({ kind: "deny", code: "policy_denied" });
    expect((readOnly as { decision?: { reasons: { code: string }[] } }).decision?.reasons.map((r) => r.code)).toContain("integration_scope_missing");
  });

  it("persists an operation for a require_approval outcome when asked, and forwards no secret value", async () => {
    const h = await makeHarness({ kind });
    const result = await checkActionThroughBroker(
      h.deps,
      ctxFor(h, { environmentId: h.ids.envAProd }),
      "system.setSecret",
      { serviceId: h.ids.resAWebProd, key: "DATABASE_URL", secretValue: `postgres://u:${CANARY}@db/x`, moveExistingValue: true },
      { persist: true }
    );
    expect(result.kind).toBe("require_approval");
    const proposal = (result as { proposal?: { operation: { id: string; proposal: { input: unknown } } } }).proposal;
    expect(proposal?.operation.proposal.input).toEqual({ serviceId: h.ids.resAWebProd, key: "DATABASE_URL" });
    const stored = await h.store.listOperations(h.ids.wsA);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].principal.kind).toBe("navigator");
    expect(JSON.stringify(stored)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("denies — never allows — when the broker cannot answer", async () => {
    const h = await makeHarness({ kind });
    const foreign = await checkActionThroughBroker(h.deps, ctxFor(h, { environmentId: h.ids.envBProd }), "deploy.apply", {});
    expect(foreign).toMatchObject({ kind: "deny", code: "not_found" });
    h.setEngine(async () => {
      throw new Error("wasm missing");
    });
    const down = await checkActionThroughBroker(h.deps, ctxFor(h, { environmentId: h.ids.envASbx }), "deploy.apply", {});
    expect(down).toMatchObject({ kind: "deny", code: "policy_unavailable" });
    h.setEngine(scriptedEngine("v1", () => ({ outcome: "deny", reasons: [{ code: "frozen", message: "change freeze", rule: "t" }] })));
    const denied = await checkActionThroughBroker(h.deps, ctxFor(h, { environmentId: h.ids.envASbx }), "deploy.apply", {});
    expect(denied).toMatchObject({ kind: "deny", code: "policy_denied", message: "change freeze" });
  });
});
