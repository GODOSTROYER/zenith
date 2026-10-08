/**
 * PROD-LIFE-11 at the front door: the four portability capabilities go through the
 * same broker, policy and human-approval path as every other capability, and a
 * request that cannot work is refused before an operation exists.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { createBroker } from "@/lib/capabilities/platform";
import { STORE_KINDS, approveAs, expectBrokerError, makeHarness, proposeOk, user, type Harness } from "./support";

const destination = { resourceAddress: "object_store/backups", credentialsRef: "vault:proj/backups/creds" };

function request(h: Harness, capability: string, resourceId: string, input: Record<string, unknown>) {
  return { capability, scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId }, input };
}

describe("portability capabilities in the catalog", () => {
  it("are mutating, resource scoped, and never unattended where they change who owns an object", () => {
    for (const name of ["data.export", "data.import", "resource.adopt", "resource.release"] as const) {
      expect(CAPABILITIES[name]).toMatchObject({ mutates: true, scopeLevel: "resource", risk: "high" });
    }
    expect(CAPABILITIES["data.export"].defaultAutonomy).toBe(5);
    expect(CAPABILITIES["data.import"].defaultAutonomy).toBe(5);
    expect(CAPABILITIES["resource.adopt"].defaultAutonomy).toBe(6);
    expect(CAPABILITIES["resource.release"].defaultAutonomy).toBe(6);
    expect(CAPABILITIES["resource.adopt"]).not.toHaveProperty("escapeHatch");
  });
});

describe.each(STORE_KINDS)("portability proposals [%s]", (kind) => {
  it("turns a valid export into an operation a human must approve, showing the approver exactly what it does", async () => {
    const h = await makeHarness({ kind });
    const op = await proposeOk(h, request(h, "data.export", h.ids.resADbProd, { destination }), user("bob"));
    expect(op.operation.status).toBe("awaiting_approval");
    expect(op.operation.proposal.details?.some((d) => d.startsWith("Export:") && d.includes("object_store/backups"))).toBe(true);
    expect(op.operation.proposal.input).toEqual({ destination });
    // a human approves the exact digest; nobody else can
    const approved = await approveAs(h, op.operation, "alice");
    expect(approved.operation.status).toBe("approved");
  });

  it("refuses unsupported resources, wrong ownership and malformed inputs before any operation exists", async () => {
    const h = await makeHarness({ kind });
    // a container service is not a data service
    const web = await expectBrokerError(h.broker.propose(request(h, "data.export", h.ids.resAWebProd, { destination }), user("bob")), "conflict");
    expect(web.details).toMatchObject({ reason: "portability_unsupported", operation: "export", kind: "container_service" });
    // adopt needs a referenced resource; the database in this world is managed
    const owned = await expectBrokerError(h.broker.propose(request(h, "resource.adopt", h.ids.resADbProd, { claim: { externalId: "db-1", acknowledge: true } }), user("bob")), "conflict");
    expect(owned.details).toMatchObject({ reason: "portability_ownership", ownership: "managed" });
    // release needs a managed one, import too: export of a managed one is fine (above)
    expect((await expectBrokerError(h.broker.propose(request(h, "data.import", h.ids.resADbProd, { destination }), user("bob")), "invalid_request")).message).toMatch(/data.import input is invalid/);
    expect((await expectBrokerError(h.broker.propose(request(h, "data.export", h.ids.resADbProd, { destination: { ...destination, credentialsRef: "plain-text-secret" } }), user("bob")), "invalid_request")).message).toMatch(/input is invalid/);
    expect((await expectBrokerError(h.broker.propose(request(h, "resource.adopt", h.ids.resADbProd, { claim: { externalId: "db-1" } }), user("bob")), "invalid_request")).message).toMatch(/input is invalid/);
    // no resource in the scope
    const noResource = { capability: "data.export", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, input: { destination } };
    await expect(h.broker.propose(noResource, user("bob"))).rejects.toBeTruthy();
    // sandbox environments have no real service
    const sandbox = { capability: "data.export", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envASbx, resourceId: h.ids.resAWebSbx }, input: { destination } };
    await expect(h.broker.propose(sandbox, user("bob"))).rejects.toBeTruthy();
  });

  it("never carries a credential value: only a vault reference passes", async () => {
    const h = await makeHarness({ kind });
    const secret = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    await expectBrokerError(h.broker.propose(request(h, "data.export", h.ids.resADbProd, { destination: { ...destination, credentialsRef: `vault:${secret}` } , note: secret }), user("bob")), "secret_material");
  });

  it("check answers the same refusals without persisting anything", async () => {
    const h = await makeHarness({ kind });
    await expectBrokerError(h.broker.check(request(h, "resource.adopt", h.ids.resADbProd, { claim: { externalId: "db-1", acknowledge: true } }), user("bob")), "conflict");
    const ok = await h.broker.check(request(h, "data.export", h.ids.resADbProd, { destination }), user("bob"));
    expect(ok.decision.outcome).toBe("require_approval");
  });

  it("normalizes the claim so the approver reviews the explicit lifecycle", async () => {
    const h = await makeHarness({ kind });
    h.world.resources.set(`${h.ids.resADbProd}_ref`, { environmentId: h.ids.envAProd, facts: { address: "postgres/legacy", kind: "postgres", stateful: true, ownership: "referenced", publiclyExposed: false } });
    const op = await proposeOk(h, request(h, "resource.adopt", `${h.ids.resADbProd}_ref`, { claim: { externalId: "db-1", acknowledge: true } }), user("bob"));
    expect(op.operation.status).toBe("awaiting_approval");
    expect(op.operation.proposal.input).toEqual({ claim: { externalId: "db-1", acknowledge: true, lifecycle: "manage", fields: [] } });
    expect(op.operation.proposal.details?.join(" ")).toContain("does NOT allow Zenith to delete");
  });

  it.each(["data.export", "data.import"])("uses the canonical resource provider for %s in a mixed-placement environment", async (capability) => {
    const h = await makeHarness({ kind });
    const scopes = h.deps.scopes;
    h.deps.scopes = { resolve: async (scope) => {
      const resolved = await scopes.resolve(scope);
      if (!resolved?.environment || !resolved.resource) return resolved;
      return { ...resolved, environment: { ...resolved.environment, provider: "kubernetes" }, resourceProvider: "aws", resource: { ...resolved.resource, address: "object_store/customer-data", kind: "object_store" } };
    } };
    h.broker = createBroker(h.deps);
    const input = capability === "data.import" ? { destination, exportId: "export-owned" } : { destination };
    const result = await proposeOk(h, request(h, capability, h.ids.resADbProd, input), user("bob"));
    expect(result.operation.status).toBe("awaiting_approval");
    expect(result.operation.proposal.scope.resourceId).toBe(h.ids.resADbProd);
  });

  it("refuses an unsupported canonical provider even when the environment default supports export", async () => {
    const h = await makeHarness({ kind });
    const scopes = h.deps.scopes;
    h.deps.scopes = { resolve: async (scope) => {
      const resolved = await scopes.resolve(scope);
      if (!resolved?.resource) return resolved;
      return { ...resolved, resourceProvider: "kubernetes", resource: { ...resolved.resource, address: "object_store/customer-data", kind: "object_store" } };
    } };
    h.broker = createBroker(h.deps);
    const error = await expectBrokerError(h.broker.propose(request(h, "data.export", h.ids.resADbProd, { destination }), user("bob")), "conflict");
    expect(error.details).toMatchObject({ reason: "portability_unsupported", provider: "kubernetes", kind: "object_store" });
  });

  it("refuses import after release and preserves the policy denial for mutations on a referenced resource", async () => {
    const h = await makeHarness({ kind });
    const input = { destination, exportId: "export-owned" };
    expect((await h.broker.check(request(h, "data.import", h.ids.resADbProd, input), user("bob"))).decision.outcome).toBe("require_approval");
    const current = h.world.resources.get(h.ids.resADbProd)!;
    h.world.resources.set(h.ids.resADbProd, { ...current, facts: { ...current.facts, ownership: "referenced" } });
    const error = await expectBrokerError(h.broker.propose(request(h, "data.import", h.ids.resADbProd, input), user("bob")), "conflict");
    expect(error.details).toMatchObject({ reason: "portability_ownership", ownership: "referenced" });
    const exported = await h.broker.check(request(h, "data.export", h.ids.resADbProd, { destination }), user("bob"));
    expect(exported.decision.outcome).toBe("deny");
    expect(exported.decision.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unowned_resource_mutation" })]));
  });
});
