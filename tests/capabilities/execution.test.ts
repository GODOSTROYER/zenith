/**
 * Execution: the gate from "approved" to "a grant exists", and completion.
 * Every test runs against both stores; grants are signed by the credential
 * broker's signer and verified with the credential broker's verifier.
 */
import { describe, expect, it } from "vitest";
import { verifyCapabilityGrant, type PublicJwk } from "@/lib/credentials";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { CredentialGrantSigner } from "@/lib/capabilities/credential-signer";
import { createBroker } from "@/lib/capabilities/platform";
import { loadPlanFixture } from "../policy/plan-fixtures";
import { STORE_KINDS, allowDecision, approveAs, closeSharedPgliteAfterAll, expectBrokerError, makeHarness, proposeOk, requestFor, requireApproval, scriptedEngine, user, type Harness } from "./support";

closeSharedPgliteAfterAll();

const CANARY = "AKIAIOSFODNN7EXAMPLE";

const begin = (h: Harness, operationId: string, extra: Record<string, unknown> = {}) =>
  h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId, holder: "worker:1", audience: "worker", ...extra });

const verify = async (h: Harness, grant: string, extra: Partial<Parameters<typeof verifyCapabilityGrant>[1]> = {}): Promise<CapabilityGrantClaims> =>
  verifyCapabilityGrant(grant, { audience: "worker", keys: [(await h.publicJwk()) as unknown as PublicJwk], now: h.clock.now(), ...extra });

/** A sandbox restart the policy allowed outright. */
const allowed = (h: Harness) => proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
/** A production restart a person approved. */
async function approvedProd(h: Harness) {
  const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
  await approveAs(h, op.operation, "dave");
  return op;
}

describe.each(STORE_KINDS)("beginExecution [%s]", (kind) => {
  it("issues a grant whose claims bind the operation, digest, scope and requester", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    const begun = await begin(h, op.id);
    expect(begun.operation.status).toBe("running");
    const claims = await verify(h, begun.grant, { expectedCapability: "service.restart", expectedOperationId: op.id });
    expect(claims).toMatchObject({
      iss: "zenith-control",
      aud: "worker",
      sub: "bob",
      cap: "service.restart",
      op: op.id,
      digest: op.digest,
      ws: h.ids.wsA,
      proj: h.ids.projA,
      env: h.ids.envASbx,
      res: h.ids.resAWebSbx,
    });
    expect(claims.jti).toMatch(/^grt_/);
    expect(claims.fence).toBeUndefined();
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(900);
    expect(begun.claims).toEqual(claims);
    // the compact JWS is what the executing surface presents; it is not stored
    expect(begun.grant.split(".")).toHaveLength(3);
  });

  it("names the requesting human, not the agent, as the subject", async () => {
    const h = await makeHarness({ kind });
    const { integrationOf } = await import("./support");
    const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), integrationOf(h, "intRW", "bob"));
    const begun = await begin(h, op.id);
    expect(begun.claims.sub).toBe("bob");
  });

  it("is single-use: the recorded grant consumes exactly once, only for its audience and workspace", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    const { claims } = await begin(h, op.id, { audience: "runner:r1" });
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsB, jti: claims.jti })).toBe(false);
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: claims.jti, audience: "worker" })).toBe(false);
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: claims.jti, audience: "runner:r1" })).toBe(true);
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: claims.jti, audience: "runner:r1" })).toBe(false);
  });

  it("carries the lease fence, and refuses a stale one without consuming anything", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    const stale = await h.acquireLease(h.ids.envAProd);
    await h.loseLease(stale.scope);
    await expectBrokerError(begin(h, op.id, { lease: stale }), "lease_lost");
    // the approval survived the failed claim
    expect((await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).approvals[0].consumed).toBe(false);

    const lease = await h.acquireLease(h.ids.envAProd);
    const begun = await begin(h, op.id, { lease });
    expect(begun.claims.fence).toBe(lease.fenceToken);
    expect((await verify(h, begun.grant)).fence).toBe(lease.fenceToken);
  });

  it("takes the grant's constraints and lifetime from the decision, capped at 900 seconds", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => allowDecision({ grantDurationSec: 120, maxLines: 10 })) });
    const op = await allowed(h);
    const begun = await begin(h, op.id);
    expect(begun.claims.exp - begun.claims.iat).toBe(120);
    expect(begun.claims.constraints).toEqual({ grantDurationSec: 120, maxLines: 10 });

    const long = await makeHarness({ kind, engine: scriptedEngine("v1", () => allowDecision({ grantDurationSec: 3600 })) });
    const b = await begin(long, (await allowed(long)).id);
    expect(b.claims.exp - b.claims.iat).toBe(900);
  });

  it("derives the lifetime from the real policy's grantDurationSec", async () => {
    const h = await makeHarness({ kind });
    const short = await proposeOk(h, requestFor(h, "service.restart", "sbx", { requestedDurationSec: 30 }), user("bob"));
    const b1 = await begin(h, short.id);
    expect(b1.claims.exp - b1.claims.iat).toBe(30);
    expect(b1.claims.constraints).toMatchObject({ grantDurationSec: 30 });
    const long = await proposeOk(h, requestFor(h, "service.restart", "sbx", { requestedDurationSec: 3600 }), user("bob"));
    const b2 = await begin(h, long.id);
    expect(b2.claims.exp - b2.claims.iat).toBe(900);
    const none = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    const b3 = await begin(h, none.id);
    expect(b3.claims.exp - b3.claims.iat).toBe(900);
    expect(b3.claims.constraints).toBeUndefined();
  });

  it("never outlives the operation", async () => {
    const h = await makeHarness({ kind });
    const op = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"), { ttlMs: 60_000 });
    const begun = await begin(h, op.id);
    expect(begun.claims.exp).toBeLessThanOrEqual(Math.floor(Date.parse(op.operation.expiresAt) / 1000));
    expect(begun.claims.exp - begun.claims.iat).toBeLessThanOrEqual(60);
  });

  it("consumes the approval once: a second begin is refused, and so is a concurrent one", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    const begun = await begin(h, op.id);
    expect(begun.operation.status).toBe("running");
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(detail.approvals[0].consumed).toBe(true);
    await expectBrokerError(begin(h, op.id), "already_claimed");

    const other = await approvedProd(h);
    const settled = await Promise.allSettled([begin(h, other.id, { holder: "w1" }), begin(h, other.id, { holder: "w2" }), begin(h, other.id, { holder: "w3" })]);
    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    expect(lost.every((r) => (r.reason as { code: string }).code === "already_claimed")).toBe(true);
  });

  it("refuses anything that is not approved", async () => {
    const h = await makeHarness({ kind });
    const waiting = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    await expectBrokerError(begin(h, waiting.id), "invalid_state");
    const denied = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("carol"));
    await expectBrokerError(begin(h, denied.id), "invalid_state");
    await expectBrokerError(begin(h, "op_missing"), "not_found");
  });

  it("refuses an expired operation, and an expired approval", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    await h.expireApprovals(op.id);
    const error = await expectBrokerError(begin(h, op.id), "approval_required");
    expect(error.status).toBe(409);

    const old = await allowed(h);
    await h.expireOperation(old.id);
    await expectBrokerError(begin(h, old.id), "operation_expired");
    expect((await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: old.id, principal: user("bob") })).operation.status).toBe("expired");
  });

  it("does not sign with a missing key — and does not burn the approval", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    const broken = createBroker({ ...h.deps, signer: new CredentialGrantSigner({}) });
    await expectBrokerError(broken.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: "w", audience: "worker" }), "signer_unavailable");
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(detail.operation.status).toBe("approved");
    expect(detail.approvals[0].consumed).toBe(false);
    expect((await begin(h, op.id)).operation.status).toBe("running");
  });

  it("ends the operation truthfully when a grant cannot be issued after the claim", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    const flaky = createBroker({ ...h.deps, signer: { ready: async () => undefined, sign: async () => { throw new Error("hsm offline"); } } });
    await expectBrokerError(flaky.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: "w", audience: "worker" }), "grant_issue_failed");
    const after = (await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).operation;
    expect(after.status).toBe("failed");
    expect(after.error).toContain("nothing was executed");
  });
});

describe.each(STORE_KINDS)("re-evaluation at execution [%s]", (kind) => {
  it("refuses with reapproval_required when a policy change makes the approval insufficient", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1, "editor")) });
    const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    await approveAs(h, op.operation, "dave");

    h.setEngine(scriptedEngine("v2", () => requireApproval(1, "admin")));
    const error = await expectBrokerError(begin(h, op.id), "reapproval_required");
    expect(error.details).toMatchObject({ have: 0 });

    h.setEngine(scriptedEngine("v3", () => requireApproval(2, "editor")));
    await expectBrokerError(begin(h, op.id), "reapproval_required");

    h.setEngine(scriptedEngine("v4", () => requireApproval(1, "editor", true)));
    // dave is not the requester (bob): separation of duties is satisfied
    expect((await begin(h, op.id)).operation.status).toBe("running");
  });

  it("does not invalidate an approval just because the bundle version changed", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1, "editor")) });
    const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    const approved = await approveAs(h, op.operation, "dave");
    expect(approved.approval.policyVersion).toBe("v1");
    h.setEngine(scriptedEngine("v2", () => requireApproval(1, "editor")));
    const begun = await begin(h, op.id);
    expect(begun.operation.status).toBe("running");
  });

  it("re-checks separation of duties against the current policy", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1, "editor", false)) });
    const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    await approveAs(h, op.operation, "bob"); // allowed at the time: no separation of duties yet
    h.setEngine(scriptedEngine("v2", () => requireApproval(1, "editor", true)));
    await expectBrokerError(begin(h, op.id), "reapproval_required");
  });

  it("re-checks that each approver still holds the required role", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    h.world.members.set(`${h.ids.wsA}|dave`, "viewer");
    await expectBrokerError(begin(h, op.id), "reapproval_required");
    h.world.members.delete(`${h.ids.wsA}|dave`);
    await expectBrokerError(begin(h, op.id), "reapproval_required");
  });

  it("denies and ends the operation when policy now denies it", async () => {
    const h = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1)) });
    const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    await approveAs(h, op.operation, "dave");
    h.setEngine(scriptedEngine("v2", () => ({ outcome: "deny", reasons: [{ code: "frozen", message: "change freeze", rule: "test" }] })));
    const error = await expectBrokerError(begin(h, op.id), "policy_denied");
    expect(error.details).toMatchObject({ reasons: ["frozen"] });
    const after = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") });
    expect(after.operation.status).toBe("cancelled");
    expect(after.operation.error).toContain("frozen");
    const events = (await h.broker.listOperationEvents({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).items;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["operation.denied", "operation.cancelled"]));
    expect(events.find((e) => (e.data as { kind?: string }).kind === "execution_refused")?.data).toMatchObject({ outcome: "deny", reasons: ["frozen"] });
    // and it stays ended
    h.setEngine(scriptedEngine("v3", () => allowDecision()));
    await expectBrokerError(begin(h, op.id), "invalid_state");
  });

  it("denies when the requester has lost access or the target is gone", async () => {
    const h = await makeHarness({ kind });
    const removed = await approvedProd(h);
    h.world.members.delete(`${h.ids.wsA}|bob`);
    await expectBrokerError(begin(h, removed.id), "policy_denied");
    h.world.members.set(`${h.ids.wsA}|bob`, "editor");

    const gone = await approvedProd(h);
    h.world.resources.delete(h.ids.resAWebProd);
    await expectBrokerError(begin(h, gone.id), "policy_denied");
  });

  it("requires approval when an operation policy allowed is now gated", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    expect(op.operation.status).toBe("approved");
    await h.store.putEnvironmentAutonomy({ workspaceId: h.ids.wsA, environmentId: h.ids.envASbx, autonomyLevel: 2, updatedBy: "alice" });
    const error = await expectBrokerError(begin(h, op.id), "approval_required");
    expect(error.message).toContain("Policy now requires an approval");
    // nothing was claimed
    expect((await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).operation.status).toBe("approved");
  });

  it("denies when an applied workspace policy now forbids the capability", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    await h.store.putWorkspacePolicy({ workspaceId: h.ids.wsA, params: { deniedCapabilities: ["service.restart"] }, updatedBy: "alice" });
    await expectBrokerError(begin(h, op.id), "policy_denied");
  });

  it("fails closed when the policy engine cannot load", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    h.setEngine(async () => {
      throw new Error("wasm missing");
    });
    await expectBrokerError(begin(h, op.id), "policy_unavailable");
    expect((await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).operation.status).toBe("approved");
  });

  it("records a new decision only when the decision changed", async () => {
    const h = await makeHarness({ kind });
    if (!h.db) return; // decisions are only listable in the database
    const same = await approvedProd(h);
    await begin(h, same.id);
    const rows = await h.db.query<{ n: number }>("select count(*)::int as n from platform.policy_decisions where operation_id = $1", [same.id]);
    expect(rows[0].n).toBe(1);

    const h2 = await makeHarness({ kind, engine: scriptedEngine("v1", () => requireApproval(1)) });
    const op = await proposeOk(h2, requestFor(h2, "service.restart", "prod"), user("bob"));
    await approveAs(h2, op.operation, "dave");
    h2.setEngine(scriptedEngine("v2", () => requireApproval(1)));
    await begin(h2, op.id);
    const changed = await h2.db!.query<{ policy_version: string }>("select policy_version from platform.policy_decisions where operation_id = $1 order by evaluated_at", [op.id]);
    expect(changed.map((r) => r.policy_version)).toEqual(["v1", "v2"]);
  });
});

describe.each(STORE_KINDS)("plans at execution [%s]", (kind) => {
  it("refuses a regenerated plan that differs from the approved one", async () => {
    const h = await makeHarness({ kind });
    const planned = loadPlanFixture("web-stack-create");
    const other = loadPlanFixture("no-changes");
    const op = await proposeOk(h, requestFor(h, "infrastructure.apply", "sbx"), user("bob"), { plan: planned });
    expect(op.decision.outcome).toBe("require_approval");
    await approveAs(h, op.operation, "alice");
    const error = await expectBrokerError(begin(h, op.id, { plan: other }), "plan_changed");
    expect(error.details).toMatchObject({ approvedPlanDigest: planned.planDigest });
    // the same facts under a different digest are also a different plan
    await expectBrokerError(begin(h, op.id, { plan: { ...planned, planDigest: "f".repeat(64) } }), "plan_changed");
    const begun = await begin(h, op.id, { plan: planned });
    expect(begun.operation.status).toBe("running");
  });

  it("evaluates the approved facts again at execution", async () => {
    const h = await makeHarness({ kind });
    const planned = loadPlanFixture("web-stack-create");
    const op = await proposeOk(h, requestFor(h, "infrastructure.apply", "sbx"), user("bob"), { plan: planned });
    await approveAs(h, op.operation, "alice");
    await h.store.putWorkspacePolicy({ workspaceId: h.ids.wsA, params: { approvedRegions: ["eu-west-1"] }, updatedBy: "alice" });
    // the stored facts name regions outside the newly approved list
    await expectBrokerError(begin(h, op.id), "policy_denied");
  });
});

describe.each(STORE_KINDS)("completeExecution [%s]", (kind) => {
  const complete = (h: Harness, operationId: string, outcome: "succeeded" | "failed" | "uncertain", extra: Record<string, unknown> = {}) =>
    h.broker.completeExecution({ workspaceId: h.ids.wsA, operationId, outcome, ...extra } as Parameters<Harness["broker"]["completeExecution"]>[0]);

  it("ends a running operation as succeeded, failed or uncertain, with events", async () => {
    const h = await makeHarness({ kind });
    const outcomes = { succeeded: "operation.succeeded", failed: "operation.failed", uncertain: "operation.uncertain" } as const;
    for (const outcome of ["succeeded", "failed", "uncertain"] as const) {
      const op = await allowed(h);
      await begin(h, op.id);
      const done = await complete(h, op.id, outcome, { result: { restarted: 1 }, error: outcome === "succeeded" ? undefined : "it went sideways" });
      expect(done.status).toBe(outcome);
      expect(done.finishedAt).toBeTruthy();
      const types = (await h.broker.listOperationEvents({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") })).items.map((e) => e.type);
      expect(types).toContain(outcomes[outcome]);
    }
  });

  it("is idempotent for the same outcome and refuses a different one", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    await begin(h, op.id);
    await complete(h, op.id, "succeeded");
    expect((await complete(h, op.id, "succeeded")).status).toBe("succeeded");
    await expectBrokerError(complete(h, op.id, "failed"), "invalid_state");
    const fresh = await allowed(h);
    await expectBrokerError(complete(h, fresh.id, "succeeded"), "invalid_state"); // approved, not running
  });

  it("scrubs secret-shaped values from what the executor reports", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    await begin(h, op.id);
    const done = await complete(h, op.id, "failed", { result: { log: `connected with ${CANARY}`, nested: { password: "hunter2hunter2" } }, error: `auth failed for ${CANARY}` });
    const text = JSON.stringify(done);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[redacted]");
    const detail = JSON.stringify(await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("bob") }));
    expect(detail).not.toContain(CANARY);
  });

  it("bounds an oversized result", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    await begin(h, op.id);
    const done = await complete(h, op.id, "succeeded", { result: { big: "x".repeat(200_000) } });
    expect(done.result).toMatchObject({ truncated: true });
  });

  it("revokes the grant it issued", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    const { claims } = await begin(h, op.id);
    await complete(h, op.id, "succeeded");
    expect(await h.store.consumeGrant({ workspaceId: h.ids.wsA, jti: claims.jti })).toBe(false);
  });

  it("refuses a stale fence and the wrong workspace", async () => {
    const h = await makeHarness({ kind });
    const op = await approvedProd(h);
    const lease = await h.acquireLease(h.ids.envAProd);
    await begin(h, op.id, { lease });
    await h.loseLease(lease.scope);
    await expectBrokerError(complete(h, op.id, "succeeded", { fence: lease }), "lease_lost");
    await expectBrokerError(h.broker.completeExecution({ workspaceId: h.ids.wsB, operationId: op.id, outcome: "succeeded" }), "not_found");
    // the executor can still report what it knows, without the fence
    expect((await complete(h, op.id, "uncertain", { error: "lease lost mid-flight" })).status).toBe("uncertain");
  });

  it("markUncertain ends a running operation as uncertain", async () => {
    const h = await makeHarness({ kind });
    const op = await allowed(h);
    await begin(h, op.id);
    const done = await h.broker.markUncertain({ workspaceId: h.ids.wsA, operationId: op.id, reason: "worker crashed after the API call" });
    expect(done.status).toBe("uncertain");
    expect(done.error).toContain("worker crashed");
    await expectBrokerError(begin(h, op.id), "invalid_state");
  });
});
