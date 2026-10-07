/**
 * PROD-DUR-04: standing grants are explicitly bounded (scope, capabilities, risk, principals, count, expiry),
 * created and revoked only by a person in a browser, recorded as ordinary approvals, never cover destructive or
 * high-risk-gated work, and stop counting at dispatch the moment they are revoked, expired or their creator loses
 * admin. Every test runs on both the in-memory store and the real PGlite platform store.
 */
import { describe, expect, it } from "vitest";
import { standingGrantRefusal, standingIneligibleReason, principalKeyOf, lapsedStandingApprovalIds, type StandingGrant } from "@/lib/capabilities/standing-grants";
import { capability } from "@/lib/capabilities/catalog";
import { STORE_KINDS, closeSharedPgliteAfterAll, expectBrokerError, integrationOf, makeHarness, navigator, requestFor, requireApproval, scriptedEngine, sessionFor, user, type Harness } from "./support";

closeSharedPgliteAfterAll();

const engine = (sod = false) => scriptedEngine("standing-test", () => requireApproval(1, "editor", sod));
const HOUR = 3_600_000;

const create = (h: Harness, over: Record<string, unknown> = {}, actor = "alice") =>
  h.broker.createStandingGrant({
    workspaceId: h.ids.wsA,
    actor: user(actor),
    session: sessionFor(actor),
    scope: { environmentId: h.ids.envAProd, projectId: h.ids.projA },
    capabilities: ["service.restart"],
    maxRisk: "high",
    allowedPrincipals: [`integration:${h.ids.intRW}`],
    maxUses: 2,
    lifetimeMs: HOUR,
    ...over,
  } as Parameters<Harness["broker"]["createStandingGrant"]>[0]);

const agent = (h: Harness, onBehalfOf = "bob") => integrationOf(h, "intRW", onBehalfOf);
let n = 0;
const proposeRestart = (h: Harness, principal = agent(h), where: "prod" | "stg" | "sbx" = "prod", capabilityName: "service.restart" | "service.scale" = "service.restart", ctx?: Parameters<Harness["broker"]["propose"]>[2]) =>
  h.broker.propose(requestFor(h, capabilityName, where, { reason: `standing ${++n}`, ...(capabilityName === "service.scale" ? { input: { replicas: 2 } } : {}) }), principal, ctx);
const status = async (h: Harness, id: string) => (await h.store.getOperation(h.ids.wsA, id))!.status;

describe.each(STORE_KINDS)("standing grants [%s]", (kind) => {
  describe("creation is a person's bounded decision", () => {
    it("records every bound and audits the creation", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const g = await create(h);
      expect(g).toMatchObject({ createdBy: "alice", environmentId: h.ids.envAProd, projectId: h.ids.projA, capabilities: ["service.restart"], maxRisk: "high", maxUses: 2, uses: 0, status: "active", allowedPrincipals: [`integration:${h.ids.intRW}`] });
      expect(Date.parse(g.expiresAt) - Date.parse(g.createdAt)).toBe(HOUR);
      const events = await h.store.listEvents(h.ids.wsA, { environmentId: h.ids.envAProd });
      expect(events.find((e) => e.data.kind === "standing_grant_created")?.data).toMatchObject({ grantId: g.id, capabilities: ["service.restart"], maxUses: 2 });
    });

    it("needs a human admin with their own browser session", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await expectBrokerError(create(h, {}, "bob"), "admin_required");
      await expectBrokerError(create(h, {}, "carol"), "admin_required");
      await expectBrokerError(h.broker.createStandingGrant({ ...(await baseInput(h)), actor: agent(h) }), "approver_not_human");
      await expectBrokerError(h.broker.createStandingGrant({ ...(await baseInput(h)), session: sessionFor("erin") }), "browser_session_required");
      await expectBrokerError(h.broker.createStandingGrant({ ...(await baseInput(h)), actor: user("mallory"), session: sessionFor("mallory") }), "not_found");
      expect(await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") })).toHaveLength(0);
    });

    it.each([
      ["a destructive capability", { capabilities: ["infrastructure.destroy"] }],
      ["a data-destroying capability", { capabilities: ["database.delete"] }],
      ["an escape hatch", { capabilities: ["machine.exec"] }],
      ["a capability that never runs unattended", { capabilities: ["identity.modify"] }],
      ["a capability that changes nothing", { capabilities: ["logs.read"] }],
      ["an unknown capability", { capabilities: ["not.a.capability"] }],
      ["no capabilities", { capabilities: [] }],
      ["a critical risk ceiling", { maxRisk: "critical" }],
      ["a capability above the risk ceiling", { capabilities: ["deployment.deploy"], maxRisk: "medium" }],
      ["no principals", { allowedPrincipals: [] }],
      ["a human principal", { allowedPrincipals: ["user:bob"] }],
      ["a malformed principal", { allowedPrincipals: ["integration:"] }],
      ["zero uses", { maxUses: 0 }],
      ["an unbounded number of uses", { maxUses: 1001 }],
      ["a fractional number of uses", { maxUses: 1.5 }],
      ["a lifetime under five minutes", { lifetimeMs: 4 * 60_000 }],
      ["a lifetime over thirty days", { lifetimeMs: 31 * 24 * HOUR }],
      ["a lifetime that is not a number", { lifetimeMs: Number.NaN }],
    ])("refuses %s", async (_label, over) => {
      const h = await makeHarness({ kind, engine: engine() });
      await expectBrokerError(create(h, over), "invalid_request");
      expect(await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") })).toHaveLength(0);
    });

    it("refuses a scope that does not chain inside the workspace", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await expectBrokerError(create(h, { scope: { environmentId: h.ids.envBProd } }), "not_found");
      await expectBrokerError(create(h, { scope: { environmentId: h.ids.envAProd, resourceId: h.ids.resBWeb } }), "not_found");
    });
  });

  describe("use at proposal", () => {
    it("approves an allowed agent's matching proposal through an ordinary, attributable approval", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const g = await create(h);
      const result = await proposeRestart(h);
      expect(result.operation.status).toBe("approved");
      expect(result.decision.outcome).toBe("require_approval");
      const approvals = await h.store.listApprovals(h.ids.wsA, result.operation.id);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ decision: "approve", approverRole: "admin" });
      expect(approvals[0].approver).toMatchObject({ kind: "user", id: "alice" });
      expect(approvals[0].reason).toContain(g.id);
      const events = await h.store.listEvents(h.ids.wsA, { operationId: result.operation.id });
      expect(events.find((e) => e.data.kind === "standing_grant_used")?.data).toMatchObject({ grantId: g.id, approvalId: approvals[0].id, usesAfter: 1, maxUses: 2 });
      const [listed] = await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("carol") });
      expect(listed.uses).toBe(1);
      // the grant the approval stands for is honoured at execution like any approval
      const begun = await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: result.operation.id, holder: "worker:1", audience: "worker" });
      expect(begun.operation.status).toBe("running");
    });

    it("never spends more than its count, and the next proposal waits for a person", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await create(h, { maxUses: 2 });
      const a = await proposeRestart(h);
      const b = await proposeRestart(h);
      const c = await proposeRestart(h);
      expect([a.operation.status, b.operation.status, c.operation.status]).toEqual(["approved", "approved", "awaiting_approval"]);
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") }))[0].uses).toBe(2);
    });

    it("cannot be overspent by concurrent proposals", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await create(h, { maxUses: 2 });
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => proposeRestart(h)));
      const approved = results.filter((r) => r.operation.status === "approved");
      expect(approved).toHaveLength(2);
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") }))[0].uses).toBe(2);
    });

    it("stops at its expiry", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await create(h);
      h.clock.advance(HOUR + 1000);
      expect((await proposeRestart(h)).operation.status).toBe("awaiting_approval");
    });

    it("only covers its environment, capability list and allowed agents", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await create(h);
      expect((await proposeRestart(h, agent(h), "stg")).operation.status).toBe("awaiting_approval");
      expect((await proposeRestart(h, agent(h), "prod", "service.scale")).operation.status).toBe("awaiting_approval");
      expect((await proposeRestart(h, integrationOf(h, "intScoped", "bob"), "sbx")).operation.status).not.toBe("approved");
      expect((await proposeRestart(h, navigator("bob"))).operation.status).toBe("awaiting_approval");
      expect((await proposeRestart(h, user("bob"))).operation.status).toBe("awaiting_approval");
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") }))[0].uses).toBe(0);
    });

    it("a resource-scoped grant covers only that resource", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await create(h, { scope: { environmentId: h.ids.envAProd, projectId: h.ids.projA, resourceId: h.ids.resAWebProd } });
      expect((await proposeRestart(h)).operation.status).toBe("approved");
      const other = await h.broker.propose(requestFor(h, "database.snapshot", "prod", { reason: "snap" }), agent(h));
      expect(other.operation.status).toBe("awaiting_approval");
    });

    it("is bounded by the risk ceiling the policy evaluates, not the catalog floor", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await create(h, { maxRisk: "medium" });
      expect((await proposeRestart(h, agent(h), "prod", "service.restart", { risk: "critical" })).operation.status).toBe("awaiting_approval");
      expect((await proposeRestart(h)).operation.status).toBe("approved");
    });

    it("keeps separation of duties: an agent acting for the grant's creator is not self-approved", async () => {
      const h = await makeHarness({ kind, engine: engine(true) });
      await create(h);
      expect((await proposeRestart(h, agent(h, "alice"))).operation.status).toBe("awaiting_approval");
      expect((await proposeRestart(h, agent(h, "bob"))).operation.status).toBe("approved");
    });

    it("does not cover a requirement of more than one approver", async () => {
      const h = await makeHarness({ kind, engine: scriptedEngine("two", () => requireApproval(2, "editor", false)) });
      await create(h);
      expect((await proposeRestart(h)).operation.status).toBe("awaiting_approval");
    });

    it("never overrides a policy denial and spends nothing on it", async () => {
      const h = await makeHarness({ kind, engine: scriptedEngine("deny", () => ({ outcome: "deny", reasons: [{ code: "no", message: "no" }] })) });
      await create(h);
      const r = await proposeRestart(h);
      expect(r.operation.status).toBe("denied");
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") }))[0].uses).toBe(0);
    });

    it("is not available when the creator is no longer an admin", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      await create(h);
      h.world.members.set(`${h.ids.wsA}|alice`, "editor");
      expect((await proposeRestart(h)).operation.status).toBe("awaiting_approval");
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("erin") }))[0].uses).toBe(0);
    });

    it("never covers a capability the catalog marks destructive, even if a grant row somehow named it", () => {
      const grant: StandingGrant = { id: "g", workspaceId: "w", createdBy: "alice", createdByName: "alice", environmentId: "e", capabilities: ["infrastructure.destroy"], maxRisk: "high", allowedPrincipals: ["integration:a"], maxUses: 5, uses: 0, expiresAt: new Date(Date.now() + HOUR).toISOString(), createdAt: new Date().toISOString(), status: "active" };
      const ctx = { def: capability("infrastructure.destroy"), risk: "high" as const, scope: { environmentId: "e" }, principal: { kind: "integration" as const, id: "a", name: "a", onBehalfOf: "bob" }, approval: { count: 1, minRole: "admin" as const, separationOfDuties: false }, hasOwnershipTransfers: false, now: new Date() };
      expect(standingGrantRefusal(grant, ctx)).toBe("capability_never_standing");
      expect(standingIneligibleReason(capability("database.restore"))).toMatch(/destructive/);
      expect(standingIneligibleReason(capability("provider.native"))).toMatch(/unrestricted/);
      expect(standingIneligibleReason(capability("resource.adopt"))).toMatch(/never runs unattended/);
      expect(standingIneligibleReason(capability("service.restart"))).toBeUndefined();
      expect(principalKeyOf(ctx.principal)).toBe("integration:a");
    });
  });

  describe("dispatch-time revocation", () => {
    async function approvedUnderGrant(h: Harness) {
      const g = await create(h);
      const r = await proposeRestart(h);
      expect(r.operation.status).toBe("approved");
      return { g, id: r.operation.id };
    }
    const begin = (h: Harness, id: string) => h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: id, holder: "worker:1", audience: "worker" });

    it("a revoked grant stops an operation that was approved under it but not yet dispatched", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const { g, id } = await approvedUnderGrant(h);
      await h.broker.revokeStandingGrant({ workspaceId: h.ids.wsA, id: g.id, actor: user("erin"), session: sessionFor("erin"), reason: "no longer wanted" });
      await expectBrokerError(begin(h, id), "standing_grant_lapsed");
      expect(await status(h, id)).toBe("approved"); // nothing was claimed or consumed
      const op = (await h.store.getOperation(h.ids.wsA, id))!;
      expect((await lapsedStandingApprovalIds(h.deps, op)).size).toBe(1);
      expect((await h.store.listApprovals(h.ids.wsA, id)).every((a) => !a.consumedAt)).toBe(true);
    });

    it("an expired grant stops it too", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const { id } = await approvedUnderGrant(h);
      h.clock.advance(HOUR + 1000);
      await expectBrokerError(begin(h, id), "standing_grant_lapsed");
    });

    it("so does the creator losing the admin role", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const { id } = await approvedUnderGrant(h);
      h.world.members.set(`${h.ids.wsA}|alice`, "editor");
      await expectBrokerError(begin(h, id), "standing_grant_lapsed");
    });

    it("an unrevoked, unexpired grant dispatches normally and a human approval is unaffected by any grant", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const { id } = await approvedUnderGrant(h);
      expect((await begin(h, id)).operation.status).toBe("running");
      const human = await proposeRestart(h, user("bob"));
      await h.broker.approve({ workspaceId: h.ids.wsA, operationId: human.operation.id, proposalDigest: human.operation.proposalDigest, approver: user("dave"), session: sessionFor("dave") });
      expect((await begin(h, human.operation.id)).operation.status).toBe("running");
    });

    it("revocation is idempotent, audited, and bars further use", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const g = await create(h, { maxUses: 5 });
      const first = await h.broker.revokeStandingGrant({ workspaceId: h.ids.wsA, id: g.id, actor: user("alice"), session: sessionFor("alice"), reason: "done" });
      expect(first).toMatchObject({ status: "revoked", revokedBy: "alice", revokedReason: "done" });
      const again = await h.broker.revokeStandingGrant({ workspaceId: h.ids.wsA, id: g.id, actor: user("erin"), session: sessionFor("erin") });
      expect(again.revokedBy).toBe("alice");
      const events = await h.store.listEvents(h.ids.wsA, { environmentId: h.ids.envAProd });
      expect(events.filter((e) => e.data.kind === "standing_grant_revoked")).toHaveLength(2);
      expect((await proposeRestart(h)).operation.status).toBe("awaiting_approval");
    });

    it("revocation needs a person: the creator or another admin, in a browser; not an editor, not an agent", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const g = await create(h);
      const revoke = (actor: ReturnType<typeof user>, session = sessionFor(actor.id)) => h.broker.revokeStandingGrant({ workspaceId: h.ids.wsA, id: g.id, actor, session });
      await expectBrokerError(revoke(user("bob")), "role_insufficient");
      await expectBrokerError(revoke(agent(h), sessionFor("bob")), "approver_not_human");
      await expectBrokerError(revoke(user("erin"), sessionFor("alice")), "browser_session_required");
      await expectBrokerError(revoke(user("mallory")), "not_found");
      expect((await h.broker.revokeStandingGrant({ workspaceId: h.ids.wsA, id: "does-not-exist", actor: user("alice"), session: sessionFor("alice") }).catch((e: unknown) => (e as { code: string }).code))).toBe("not_found");
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("alice") }))[0].status).toBe("active");
    });
  });

  describe("usage history", () => {
    it("lists the operations a grant approved, newest first, to any member, and only for a visible grant", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const g = await create(h);
      const a = await proposeRestart(h);
      const b = await proposeRestart(h);
      const uses = await h.broker.listStandingGrantUsage({ workspaceId: h.ids.wsA, principal: user("carol"), grantId: g.id });
      expect(uses.map((u) => u.operationId).sort()).toEqual([a.operation.id, b.operation.id].sort());
      expect(uses).toHaveLength(2);
      expect(uses.every((u) => u.principalKey === `integration:${h.ids.intRW}` && u.approvalId)).toBe(true);
      await expectBrokerError(h.broker.listStandingGrantUsage({ workspaceId: h.ids.wsA, principal: user("carol"), grantId: "nope" }), "not_found");
      await expectBrokerError(h.broker.listStandingGrantUsage({ workspaceId: h.ids.wsA, principal: user("mallory"), grantId: g.id }), "not_found");
    });
  });

  describe("listing and tenancy", () => {
    it("lists to any member, filters by environment and activity, and never crosses workspaces", async () => {
      const h = await makeHarness({ kind, engine: engine() });
      const a = await create(h);
      const b = await create(h, { scope: { environmentId: h.ids.envAStg, projectId: h.ids.projA } });
      await h.broker.revokeStandingGrant({ workspaceId: h.ids.wsA, id: b.id, actor: user("alice"), session: sessionFor("alice") });
      const all = await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("carol") });
      expect(all.map((g) => g.id).sort()).toEqual([a.id, b.id].sort());
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("carol"), environmentId: h.ids.envAStg })).map((g) => g.id)).toEqual([b.id]);
      expect((await h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("carol"), activeOnly: true })).map((g) => g.id)).toEqual([a.id]);
      await expectBrokerError(h.broker.listStandingGrants({ workspaceId: h.ids.wsA, principal: user("mallory") }), "not_found");
      expect(await h.store.standingGrants!.get(h.ids.wsB, a.id)).toBeNull();
      expect(await h.store.standingGrants!.list(h.ids.wsB)).toEqual([]);
    });
  });
});

async function baseInput(h: Harness) {
  return {
    workspaceId: h.ids.wsA,
    actor: user("alice"),
    session: sessionFor("alice"),
    scope: { environmentId: h.ids.envAProd, projectId: h.ids.projA },
    capabilities: ["service.restart"],
    maxRisk: "high" as const,
    allowedPrincipals: [`integration:${h.ids.intRW}`],
    maxUses: 2,
    lifetimeMs: HOUR,
  };
}
