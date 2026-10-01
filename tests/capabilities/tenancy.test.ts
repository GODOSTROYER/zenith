/**
 * The tenant matrix (ARCHITECTURE invariant 2): a principal in workspace A
 * acting on ids that belong to workspace B gets EXACTLY the answer it would get
 * for ids that do not exist — same code, same message, same fix, same status,
 * same details — from every service call and every store method. Nothing is
 * persisted or logged on either side by those attempts.
 */
import { describe, expect, it } from "vitest";
import { STORE_KINDS, closeSharedPgliteAfterAll, integrationOf, makeHarness, proposeOk, requestFor, sessionFor, user, type Harness, type StoreKind } from "./support";

closeSharedPgliteAfterAll();

interface Shape {
  code: string;
  message: string;
  fix?: string;
  status: number;
  details?: unknown;
}

async function shapeOf(call: () => Promise<unknown>): Promise<Shape> {
  try {
    await call();
  } catch (error) {
    const e = error as Shape;
    return { code: e.code, message: e.message, fix: e.fix, status: e.status, details: e.details };
  }
  throw new Error("expected the call to be refused");
}

const notFoundShape: Shape = {
  code: "not_found",
  message: "The requested item was not found in a workspace you can act in.",
  fix: "Check that the ids belong to a workspace you are a member of.",
  status: 404,
  details: undefined,
};

/** Every call refused with the one not-found answer. */
async function expectAllNotFound(calls: Record<string, () => Promise<unknown>>): Promise<void> {
  for (const [name, call] of Object.entries(calls)) {
    expect({ name, ...(await shapeOf(call)) }).toEqual({ name, ...notFoundShape });
  }
}

interface World2 {
  h: Harness;
  a: { id: string; digest: string };
  b: { id: string; digest: string };
}

async function setup(kind: StoreKind): Promise<World2> {
  const h = await makeHarness({ kind });
  const a = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
  const b = await h.broker.propose(
    { capability: "service.restart", scope: { workspaceId: h.ids.wsB, projectId: h.ids.projB, environmentId: h.ids.envBProd, resourceId: h.ids.resBWeb } },
    user("mallory")
  );
  return { h, a: { id: a.id, digest: a.digest }, b: { id: b.operation.id, digest: b.operation.proposalDigest } };
}

describe.each(STORE_KINDS)("tenant matrix: scope ids [%s]", (kind) => {
  it("answers foreign and missing scope ids identically from propose, check and authorizeRead", async () => {
    const { h } = await setup(kind);
    const bob = user("bob");
    const scopes: Record<string, Record<string, string>> = {
      "workspace B": { workspaceId: h.ids.wsB, projectId: h.ids.projB, environmentId: h.ids.envBProd, resourceId: h.ids.resBWeb },
      "workspace A, project B": { workspaceId: h.ids.wsA, projectId: h.ids.projB, environmentId: h.ids.envAProd, resourceId: h.ids.resAWebProd },
      "workspace A, environment B": { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envBProd, resourceId: h.ids.resAWebProd },
      "workspace A, environment B without a project": { workspaceId: h.ids.wsA, environmentId: h.ids.envBProd, resourceId: h.ids.resAWebProd },
      "workspace A, resource B": { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId: h.ids.resBWeb },
      "resource of another environment": { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId: h.ids.resAWebSbx },
      "nothing exists": { workspaceId: "ws_nope", projectId: "prj_nope", environmentId: "env_nope", resourceId: "res_nope" },
      "missing resource": { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId: "res_nope" },
    };
    const calls: Record<string, () => Promise<unknown>> = {};
    for (const [label, scope] of Object.entries(scopes)) {
      calls[`propose / ${label}`] = () => h.broker.propose({ capability: "service.restart", scope }, bob);
      calls[`check / ${label}`] = () => h.broker.check({ capability: "service.restart", scope }, bob);
      calls[`authorizeRead / ${label}`] = () => h.broker.authorizeRead({ capability: "service.status", scope }, bob);
    }
    await expectAllNotFound(calls);
    // nothing was persisted or logged by any of it
    expect((await h.broker.listOperations({ workspaceId: h.ids.wsA, principal: bob })).items).toHaveLength(1);
    expect((await h.store.listOperations(h.ids.wsB)).items).toHaveLength(1);
    expect((await h.store.listEvents(h.ids.wsB)).every((e) => ["operation.proposed", "policy.evaluated"].includes(e.type))).toBe(true);
  });

  it("answers a non-member the same way, whatever they name", async () => {
    const { h } = await setup(kind);
    const mallory = user("mallory");
    await expectAllNotFound({
      "propose into A": () => h.broker.propose(requestFor(h, "service.restart", "prod"), mallory),
      "check into A": () => h.broker.check(requestFor(h, "service.restart", "prod"), mallory),
      "read into A": () => h.broker.authorizeRead(requestFor(h, "logs.read", "prod"), mallory),
      "a stranger": () => h.broker.propose(requestFor(h, "service.restart", "prod"), user("nobody")),
    });
  });
});

describe.each(STORE_KINDS)("tenant matrix: operation ids [%s]", (kind) => {
  it("answers a foreign operation id exactly like a missing one from every service call", async () => {
    const { h, a, b } = await setup(kind);
    const bob = user("bob");
    const dave = user("dave");
    const missing = { id: "op_does_not_exist", digest: "0".repeat(64) };
    const workspaces = [h.ids.wsA, h.ids.wsB]; // bob is in A only; wsB makes him a non-member

    for (const target of [b, missing]) {
      for (const workspaceId of workspaces) {
        // bob and dave (A members) acting in A or in B, on B's operation or a missing one
        const who = (p: ReturnType<typeof user>) => ({ workspaceId, operationId: target.id, principal: p });
        const decide = (p: ReturnType<typeof user>) => ({ workspaceId, operationId: target.id, proposalDigest: target.digest, approver: p, session: sessionFor(p.id) });
        await expectAllNotFound({
          [`detail ${workspaceId}/${target.id}`]: () => h.broker.getOperationDetail(who(bob)),
          [`events ${workspaceId}/${target.id}`]: () => h.broker.listOperationEvents(who(bob)),
          [`cancel ${workspaceId}/${target.id}`]: () => h.broker.cancelOperation(who(bob)),
          [`approve ${workspaceId}/${target.id}`]: () => h.broker.approve(decide(dave)),
          [`reject ${workspaceId}/${target.id}`]: () => h.broker.reject(decide(dave)),
          [`revoke ${workspaceId}/${target.id}`]: () => h.broker.revokeApproval({ workspaceId, operationId: target.id, actor: dave, session: sessionFor("dave") }),
        });
      }
      // the trusted execution entry points take no principal: a wrong workspace is the same answer
      await expectAllNotFound({
        [`begin ${target.id}`]: () => h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: target.id, holder: "w", audience: "worker" }),
        [`complete ${target.id}`]: () => h.broker.completeExecution({ workspaceId: h.ids.wsA, operationId: target.id, outcome: "succeeded" }),
        [`mark uncertain ${target.id}`]: () => h.broker.markUncertain({ workspaceId: h.ids.wsA, operationId: target.id, reason: "x" }),
      });
    }

    // mallory (B admin) on A's operation, from either workspace
    for (const workspaceId of [h.ids.wsA, h.ids.wsB]) {
      await expectAllNotFound({
        [`mallory detail ${workspaceId}`]: () => h.broker.getOperationDetail({ workspaceId, operationId: a.id, principal: user("mallory") }),
        [`mallory cancel ${workspaceId}`]: () => h.broker.cancelOperation({ workspaceId, operationId: a.id, principal: user("mallory") }),
        [`mallory approve ${workspaceId}`]: () => h.broker.approve({ workspaceId, operationId: a.id, proposalDigest: a.digest, approver: user("mallory"), session: sessionFor("mallory") }),
      });
    }

    // and nothing moved
    expect((await h.broker.getOperationDetail({ workspaceId: h.ids.wsB, operationId: b.id, principal: user("mallory") })).operation.status).toBe("awaiting_approval");
    expect((await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: a.id, principal: bob })).operation.status).toBe("awaiting_approval");
    expect((await h.store.listApprovals(h.ids.wsB, b.id))).toHaveLength(0);
  });

  it("lists only the workspace's own operations, and refuses a workspace the caller is not in", async () => {
    const { h, a, b } = await setup(kind);
    const ids = (await h.broker.listOperations({ workspaceId: h.ids.wsA, principal: user("bob") })).items.map((o) => o.id);
    expect(ids).toEqual([a.id]);
    expect((await h.broker.listOperations({ workspaceId: h.ids.wsB, principal: user("mallory") })).items.map((o) => o.id)).toEqual([b.id]);
    await expectAllNotFound({
      "bob lists B": () => h.broker.listOperations({ workspaceId: h.ids.wsB, principal: user("bob") }),
      "mallory lists A": () => h.broker.listOperations({ workspaceId: h.ids.wsA, principal: user("mallory") }),
      "nobody lists A": () => h.broker.listOperations({ workspaceId: h.ids.wsA, principal: user("nobody") }),
    });
  });

  it("does not let a filter reach across tenants", async () => {
    const { h, b } = await setup(kind);
    const page = await h.broker.listOperations({ workspaceId: h.ids.wsA, principal: user("bob"), filters: { environmentId: h.ids.envBProd, projectId: h.ids.projB } });
    expect(page.items).toHaveLength(0);
    expect(JSON.stringify(page)).not.toContain(b.id);
  });
});

describe.each(STORE_KINDS)("tenant matrix: settings [%s]", (kind) => {
  it("answers foreign environments and workspaces with the one not-found", async () => {
    const { h } = await setup(kind);
    const alice = user("alice");
    await expectAllNotFound({
      "bob reads env B in A": () => h.broker.getAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envBProd, principal: user("bob") }),
      "bob reads env B in B": () => h.broker.getAutonomy({ workspaceId: h.ids.wsB, environmentId: h.ids.envBProd, principal: user("bob") }),
      "alice sets env B in A": () => h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envBProd, level: 5, actor: alice, session: sessionFor("alice") }),
      "alice sets env B in B": () => h.broker.setAutonomy({ workspaceId: h.ids.wsB, environmentId: h.ids.envBProd, level: 5, actor: alice, session: sessionFor("alice") }),
      "mallory sets env A in A": () => h.broker.setAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, level: 5, actor: user("mallory"), session: sessionFor("mallory") }),
      "bob reads B policy": () => h.broker.getWorkspacePolicy({ workspaceId: h.ids.wsB, principal: user("bob") }),
      "alice sets B policy": () => h.broker.setWorkspacePolicy({ workspaceId: h.ids.wsB, overrides: { deniedCapabilities: ["service.restart"] }, actor: alice, session: sessionFor("alice") }),
    });
    expect((await h.store.getEnvironmentSettings(h.ids.wsB, h.ids.envBProd)).isDefault).toBe(true);
    expect((await h.store.getEnvironmentSettings(h.ids.wsA, h.ids.envAProd)).isDefault).toBe(true);
    expect((await h.store.getWorkspacePolicy(h.ids.wsB)).isDefault).toBe(true);
  });
});

describe.each(STORE_KINDS)("tenant matrix: the store itself [%s]", (kind) => {
  it("never returns or changes another workspace's rows", async () => {
    const { h, a, b } = await setup(kind);
    const store = h.store;
    const bDecision = (await h.broker.getOperationDetail({ workspaceId: h.ids.wsB, operationId: b.id, principal: user("mallory") })).operation.policyDecisionId as string;

    expect(await store.getOperation(h.ids.wsA, b.id)).toBeNull();
    expect((await store.listOperations(h.ids.wsA)).items.map((o) => o.id)).toEqual([a.id]);
    expect(await store.getPolicyDecision(h.ids.wsA, bDecision)).toBeNull();
    expect(await store.listApprovals(h.ids.wsA, b.id)).toEqual([]);
    expect(await store.listEvents(h.ids.wsA, { operationId: b.id })).toEqual([]);
    expect(await store.cancelOperation({ workspaceId: h.ids.wsA, id: b.id })).toBeNull();
    expect(await store.expireOperation({ workspaceId: h.ids.wsA, id: b.id })).toBeNull();
    expect(await store.completeOperation({ workspaceId: h.ids.wsA, id: b.id, outcome: "succeeded" })).toBeNull();
    expect(await store.revokeGrantsForOperation(h.ids.wsA, b.id)).toBe(0);

    const refused = async (call: () => Promise<unknown>) => (await shapeOf(call)).code;
    expect(await refused(() => store.claimForExecution({ workspaceId: h.ids.wsA, id: b.id, expectedDigest: b.digest, holder: "w" }))).toBe("not_found");
    expect(
      await refused(() => store.recordApproval({ workspaceId: h.ids.wsA, operationId: b.id, approver: user("dave"), approverRole: "editor", decision: "approve", proposalDigest: b.digest, policyVersion: "v" }))
    ).toBe("not_found");
    expect(
      await refused(() => store.recordPolicyDecision({ workspaceId: h.ids.wsA, operationId: b.id, policyVersion: "v", inputDigest: "1".repeat(64), outcome: "deny", reasons: [{ code: "x", message: "x" }] }))
    ).toBe("not_found");
    const now = new Date();
    const grant = { jti: "grt_tenant_test", workspaceId: h.ids.wsA, operationId: b.id, capability: "service.restart", audience: "worker", issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    expect(await refused(() => store.insertGrant(grant))).toBe("not_found");

    // a real grant of B cannot be consumed or revoked through A
    const bGrant = { ...grant, jti: "grt_tenant_b", workspaceId: h.ids.wsB };
    await store.insertGrant(bGrant);
    expect(await store.consumeGrant({ workspaceId: h.ids.wsA, jti: "grt_tenant_b" })).toBe(false);
    expect(await store.consumeGrant({ workspaceId: h.ids.wsB, jti: "grt_tenant_b" })).toBe(true);

    // settings rows belong to one workspace
    await store.putEnvironmentAutonomy({ workspaceId: h.ids.wsB, environmentId: h.ids.envBProd, autonomyLevel: 3, updatedBy: "mallory" });
    expect(await refused(() => store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envBProd, autonomyLevel: 5, updatedBy: "alice" }))).toBe("not_found");
    expect((await store.getEnvironmentSettings(h.ids.wsA, h.ids.envBProd)).isDefault).toBe(true);
    expect((await store.getEnvironmentSettings(h.ids.wsB, h.ids.envBProd)).autonomyLevel).toBe(3);

    // B's operation is exactly as it was
    expect((await store.getOperation(h.ids.wsB, b.id))?.status).toBe("awaiting_approval");
  });

  it("scopes idempotency keys by workspace", async () => {
    const { h } = await setup(kind);
    const key = "same-key-in-two-tenants";
    const inA = await proposeOk(h, requestFor(h, "service.restart", "prod", { idempotencyKey: key }), user("bob"));
    const inB = await h.broker.propose(
      { capability: "service.restart", scope: { workspaceId: h.ids.wsB, projectId: h.ids.projB, environmentId: h.ids.envBProd, resourceId: h.ids.resBWeb }, idempotencyKey: key },
      user("mallory")
    );
    expect(inB.replayed).toBe(false);
    expect(inB.operation.id).not.toBe(inA.id);
  });
});

describe.each(STORE_KINDS)("tenant matrix: integrations bounded by their grant [%s]", (kind) => {
  it("sees only the projects and environments its credential names", async () => {
    const h = await makeHarness({ kind });
    const scoped = integrationOf(h, "intScoped");
    const prod = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    const sbx = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));

    await expectAllNotFound({
      "propose in prod": () => h.broker.propose(requestFor(h, "service.restart", "prod"), scoped),
      "check in prod": () => h.broker.check(requestFor(h, "service.restart", "prod"), scoped),
      "read in prod": () => h.broker.authorizeRead(requestFor(h, "logs.read", "prod"), scoped),
      "detail of a prod operation": () => h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: prod.id, principal: scoped }),
      "events of a prod operation": () => h.broker.listOperationEvents({ workspaceId: h.ids.wsA, operationId: prod.id, principal: scoped }),
      "cancel a prod operation": () => h.broker.cancelOperation({ workspaceId: h.ids.wsA, operationId: prod.id, principal: scoped }),
      "autonomy of prod": () => h.broker.getAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, principal: scoped }),
    });
    const visible = (await h.broker.listOperations({ workspaceId: h.ids.wsA, principal: scoped })).items.map((o) => o.id);
    expect(visible).toEqual([sbx.id]);
    expect((await h.broker.check(requestFor(h, "service.restart", "sbx"), scoped)).decision.outcome).toBe("allow");
  });

  it("stops the moment the credential is revoked", async () => {
    const h = await makeHarness({ kind });
    const agent = integrationOf(h, "intRW");
    expect((await h.broker.check(requestFor(h, "service.restart", "sbx"), agent)).decision.outcome).toBe("allow");
    h.world.integrations.delete(`${h.ids.wsA}|${h.ids.intRW}`);
    await expectAllNotFound({ "after revocation": () => h.broker.check(requestFor(h, "service.restart", "sbx"), agent) });
  });
});
