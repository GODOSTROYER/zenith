import { describe, expect, it } from "vitest";
import { STORE_KINDS, closeSharedPgliteAfterAll, makeHarness, proposeOk, requestFor, user } from "./support";

closeSharedPgliteAfterAll();

describe.each(STORE_KINDS)("smoke [%s]", (kind) => {
  it("proposes in a sandbox (allow) and production (approval)", async () => {
    const h = await makeHarness({ kind });
    const allow = await proposeOk(h, requestFor(h, "service.restart", "sbx"), user("bob"));
    expect(allow.decision.outcome).toBe("allow");
    expect(allow.operation.status).toBe("approved");
    const needs = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    expect(needs.decision.outcome).toBe("require_approval");
    expect(needs.operation.status).toBe("awaiting_approval");
    const events = await h.broker.listOperationEvents({ workspaceId: h.ids.wsA, operationId: needs.id, principal: user("bob") });
    expect(events.items.map((e) => e.type)).toEqual(["operation.proposed", "policy.evaluated"]);
  });
});
