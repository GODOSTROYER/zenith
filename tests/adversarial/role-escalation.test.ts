/**
 * Threat class: role and scope escalation (PROD-OPS-08).
 *
 * Attacker model: a viewer, an editor, an agent holding a narrower integration credential, a member of another tenant,
 * the Navigator and a system principal. Each tries to do what only a more privileged principal may: change workspace
 * policy, raise environment autonomy, mint a standing pre-approval, or have a mutation allowed.
 *
 * The cases are generated from the capability catalog (every mutating capability, in production and sandbox) and from a
 * list of admin-only broker operations, rather than from a hand-picked list: a new capability or operation is attacked
 * automatically. Public broker only; both the in-memory and the real PGlite platform store.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { STORE_KINDS, closeSharedPgliteAfterAll, integrationOf, makeHarness, navigator, requestFor, sessionFor, systemPrincipal, user, type Harness } from "../capabilities/support";

closeSharedPgliteAfterAll();

type Actor = { label: string; principal: ReturnType<typeof user>; session: ReturnType<typeof sessionFor>; workspaceId?: "wsB" };

const nonAdmins = (h: Harness): Actor[] => [
  { label: "viewer", principal: user("carol"), session: sessionFor("carol") },
  { label: "editor", principal: user("bob"), session: sessionFor("bob") },
  { label: "second editor", principal: user("dave"), session: sessionFor("dave") },
  { label: "admin of another workspace", principal: user("mallory"), session: sessionFor("mallory") },
  { label: "integration of an editor", principal: integrationOf(h, "intRW", "bob"), session: sessionFor("bob") },
  { label: "navigator acting for an admin", principal: navigator("alice"), session: sessionFor("alice") },
  { label: "user principal claiming to act for an admin", principal: { ...user("bob"), onBehalfOf: "alice" }, session: sessionFor("bob") },
  { label: "system", principal: systemPrincipal(), session: sessionFor("reconciler") },
  { label: "editor presenting an admin's session", principal: user("bob"), session: sessionFor("alice") },
];

const settled = async <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code?: string }> => {
  try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, code: (error as { code?: string }).code }; }
};

/** What a proposal ended up as, whether it threw or returned a decision. */
const outcomeOf = async (h: Harness, request: Record<string, unknown>, principal: ReturnType<typeof user>): Promise<string> => {
  const result = await settled(h.broker.propose(request, principal));
  return result.ok ? `decision:${result.value.decision.outcome}` : `refused:${result.code ?? "error"}`;
};

describe.each(STORE_KINDS)("admin-only operations [%s]", (kind) => {
  it("no non-admin principal can change workspace policy, raise autonomy, or mint or revoke a standing grant", async () => {
    const h = await makeHarness({ kind });
    const grant = await h.broker.createStandingGrant({
      workspaceId: h.ids.wsA, actor: user("alice"), session: sessionFor("alice"),
      scope: { environmentId: h.ids.envAProd, projectId: h.ids.projA }, capabilities: ["service.restart"], maxRisk: "high",
      allowedPrincipals: [`integration:${h.ids.intRW}`], maxUses: 1, lifetimeMs: 3_600_000,
    } as Parameters<Harness["broker"]["createStandingGrant"]>[0]);
    const policyBefore = JSON.stringify(await h.broker.getWorkspacePolicy({ workspaceId: h.ids.wsA, principal: user("alice") }));
    const autonomyBefore = JSON.stringify(await h.broker.getAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, principal: user("alice") }));

    const succeeded: string[] = [];
    for (const actor of nonAdmins(h)) {
      const common = { workspaceId: h.ids.wsA, actor: actor.principal, session: actor.session };
      const attempts: [string, Promise<unknown>][] = [
        ["setWorkspacePolicy", h.broker.setWorkspacePolicy({ ...common, overrides: {} })],
        ["setAutonomy 5", h.broker.setAutonomy({ ...common, environmentId: h.ids.envAProd, level: 5 })],
        ["createStandingGrant", h.broker.createStandingGrant({
          ...common, scope: { environmentId: h.ids.envAProd, projectId: h.ids.projA }, capabilities: ["service.restart"], maxRisk: "high",
          allowedPrincipals: [`integration:${h.ids.intRW}`], maxUses: 5, lifetimeMs: 3_600_000,
        } as Parameters<Harness["broker"]["createStandingGrant"]>[0])],
        ["revokeStandingGrant", h.broker.revokeStandingGrant({ ...common, id: grant.id })],
      ];
      for (const [name, promise] of attempts) {
        if ((await settled(promise)).ok) succeeded.push(`${actor.label}: ${name}`);
      }
    }
    expect(succeeded).toEqual([]);
    expect(JSON.stringify(await h.broker.getWorkspacePolicy({ workspaceId: h.ids.wsA, principal: user("alice") }))).toBe(policyBefore);
    expect(JSON.stringify(await h.broker.getAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, principal: user("alice") }))).toBe(autonomyBefore);
    const stillActive = await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") });
    expect(stillActive.filter((g) => g.id === grant.id).every((g) => g.status === "active")).toBe(true);
    expect(stillActive).toHaveLength(1);
  });

  it("the same operations work for a genuine admin, so the refusals above are about the role", async () => {
    const h = await makeHarness({ kind });
    await expect(h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, level: 2, actor: user("alice"), session: sessionFor("alice") })).resolves.toBeTruthy();
  });

  it("a foreign admin gets the same answer for a real and a made-up workspace or environment (no existence oracle)", async () => {
    const h = await makeHarness({ kind });
    const call = (workspaceId: string, environmentId: string) =>
      settled(h.broker.setAutonomy({ workspaceId, environmentId, level: 5, actor: user("mallory"), session: sessionFor("mallory") }));
    const real = await call(h.ids.wsA, h.ids.envAProd);
    const phantom = await call("ws_phantom", "env_phantom");
    const phantomEnv = await call(h.ids.wsA, "env_phantom");
    expect(real.ok || phantom.ok || phantomEnv.ok).toBe(false);
    expect((real as { code?: string }).code).toBe((phantom as { code?: string }).code);
    expect((real as { code?: string }).code).toBe((phantomEnv as { code?: string }).code);
  });
});

describe.each(STORE_KINDS)("generated capability escalation sweep [%s]", (kind) => {
  const mutating = Object.entries(CAPABILITIES).filter(([, def]) => def.mutates).map(([name]) => name);

  it("the catalog still has mutating capabilities to attack (the sweep is not vacuous)", () => {
    expect(mutating.length).toBeGreaterThan(10);
  });

  it("a viewer's proposal of any mutating capability, anywhere, is never allowed or sent for approval", async () => {
    const h = await makeHarness({ kind });
    const escaped: string[] = [];
    for (const name of mutating) {
      for (const where of ["prod", "sbx"] as const) {
        const request = requestFor(h, name as never, where);
        const outcome = await outcomeOf(h, request, user("carol"));
        if (outcome === "decision:allow" || outcome === "decision:require_approval") escaped.push(`${name}@${where}: ${outcome}`);
      }
    }
    expect(escaped).toEqual([]);
  }, 240_000);

  it("a read-only credential cannot get any mutating capability allowed or queued", async () => {
    const h = await makeHarness({ kind });
    const escaped: string[] = [];
    for (const name of mutating) {
      for (const where of ["prod", "sbx"] as const) {
        const outcome = await outcomeOf(h, requestFor(h, name as never, where), integrationOf(h, "intRO", "bob"));
        if (outcome === "decision:allow" || outcome === "decision:require_approval") escaped.push(`${name}@${where}: ${outcome}`);
      }
    }
    expect(escaped).toEqual([]);
  }, 240_000);

  it("a credential scoped to one environment cannot act in another (production), for any capability", async () => {
    const h = await makeHarness({ kind });
    const escaped: string[] = [];
    const envScoped = Object.entries(CAPABILITIES).filter(([, def]) => def.scopeLevel === "environment" || def.scopeLevel === "resource").map(([n]) => n);
    for (const name of envScoped) {
      const outcome = await outcomeOf(h, requestFor(h, name as never, "prod"), integrationOf(h, "intScoped", "bob"));
      if (outcome === "decision:allow" || outcome === "decision:require_approval") escaped.push(`${name}: ${outcome}`);
    }
    expect(escaped).toEqual([]);
  }, 240_000);

  it("no principal can propose into a workspace it is not a member of, naming it in the scope", async () => {
    const h = await makeHarness({ kind });
    const escaped: string[] = [];
    for (const name of Object.keys(CAPABILITIES)) {
      for (const who of [user("mallory"), integrationOf(h, "intRW", "mallory"), navigator("mallory")]) {
        const outcome = await outcomeOf(h, requestFor(h, name as never, "sbx"), who);
        if (outcome.startsWith("decision:allow") || outcome === "decision:require_approval") escaped.push(`${name} by ${who.kind}: ${outcome}`);
      }
    }
    expect(escaped).toEqual([]);
  }, 240_000);

  it("an operation a viewer or a foreign admin did not create cannot be cancelled, and the requester can", async () => {
    const h = await makeHarness({ kind });
    const op = await h.broker.propose(requestFor(h, "service.restart", "prod"), user("bob"));
    for (const who of [user("carol"), user("mallory"), integrationOf(h, "intRW", "mallory")]) {
      const result = await settled(h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: op.operation.id, principal: who }));
      expect(result.ok, who.id).toBe(false);
    }
    expect((await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.operation.id, principal: user("bob") })).operation.status).toBe("awaiting_approval");
    await expect(h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: op.operation.id, principal: user("bob") })).resolves.toBeTruthy();
  });

  it("reading another workspace's operations through any principal lists nothing and details nothing", async () => {
    const h = await makeHarness({ kind });
    const op = await h.broker.propose(requestFor(h, "service.restart", "prod"), user("bob"));
    for (const who of [user("mallory"), integrationOf(h, "intRW", "mallory"), navigator("mallory")]) {
      const list = await settled(h.broker.listOperations({ workspaceId: h.ids.wsA, principal: who }));
      expect(list.ok ? (list.value as { items: unknown[] }).items.length : 0, `list as ${who.kind}`).toBe(0);
      const detail = await settled(h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.operation.id, principal: who }));
      expect(detail.ok, `detail as ${who.kind}`).toBe(false);
      const viaOwn = await settled(h.broker.getOperationDetail({ workspaceId: h.ids.wsB, operationId: op.operation.id, principal: user("mallory") }));
      expect(viaOwn.ok, "detail naming their own workspace").toBe(false);
    }
  });
});
