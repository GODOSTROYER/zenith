/** Policy precedes product/cloud reads, and the returned read-grant claims
 * are the only authority passed to the session port. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { placementReads } from "@/lib/placement/recommend";
import { argsFor, allowDecision, denyDecision, makeHarness, proposeDeploy, READ_TOOLS, ids } from "./support";

afterEach(() => vi.restoreAllMocks());

describe.each(READ_TOOLS)("%s read authorization", (name) => {
  it("authorizes before product/cloud/events reads", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.trace.length = 0;
    // Placement also reads stored connection verification and environment
    // policies, which the older MCP project-read fixtures do not contain.
    if (name === "zenith_recommend_placement") {
      vi.spyOn(placementReads, "project").mockImplementation(h.ports.reads.project);
      vi.spyOn(placementReads, "environment").mockImplementation(async (ws, project, env) => {
        const row = await h.ports.reads.environment(ws, project, env);
        return row ? { ...row, createdAt: h.clock.now().toISOString(), policies: { approvalRequired: false, allowStatefulDeletion: false } } : null;
      });
      vi.spyOn(placementReads, "connections").mockImplementation(async (ws) => {
        h.trace.push("connections"); return [{ workspaceId: ws, provider: "aws", verified: true }];
      });
    }
    const result = await h.invoke(name, argsFor(name, p.id));
    expect(result.ok).toBe(true); expect(h.authorizeRead).toHaveBeenCalledTimes(1);
    // Operation metadata is loaded membership/grant-scoped to discover its
    // environment. No text/events/workflow query is exposed before policy.
    expect(h.trace[0]).toBe("authorizeRead");
    expect(h.trace.filter((t) => t.startsWith("cloud")).length).toBeLessThanOrEqual(1);
  });
  it("policy deny stops every subsequent read", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h); h.trace.length = 0;
    h.setDecision(denyDecision);
    const result = await h.invoke(name, argsFor(name, p.id));
    expect(result.error?.code).toBe("policy_denied"); expect(h.trace).toEqual(["authorizeRead"]);
    expect(h.sessionRequests).toEqual([]); expect(h.ports.workflows.progress).not.toHaveBeenCalled();
  });
});

it.each(["zenith_query_logs", "zenith_query_metrics"] as const)("%s carries exact authorized claims and coverage", async (name) => {
  const h = await makeHarness(); const result = await h.invoke(name, argsFor(name));
  expect(result.ok).toBe(true);
  const authorization = await h.authorizeRead.mock.results[0].value;
  expect(h.sessionRequests[0]).toMatchObject({ workspaceId: ids.ws, environment: { id: ids.env, connectionId: "conn-a" }, grant: authorization.claims });
  expect(authorization.claims).toMatchObject({ cap: name === "zenith_query_logs" ? "logs.read" : "metrics.read", ws: ids.ws, proj: ids.project, env: ids.env });
  expect(result).toMatchObject({ simulated: true, truncated: true, unavailable: [{ source: "fake-gap", reason: "Read unavailable." }], notes: ["Fake coverage note."] });
  expect(h.trace.indexOf("withSession")).toBeLessThan(h.trace.indexOf(name === "zenith_query_logs" ? "cloudLogs" : "cloudMetrics"));
  expect(JSON.stringify(result)).not.toContain(authorization.grant);
});
it("default investigator reports an explicit gap", async () => {
  const h = await makeHarness(); const result = await h.invoke("zenith_investigate_incident", argsFor("zenith_investigate_incident"));
  expect(result.data.investigated).toBe(false); expect(result.unavailable[0].source).toBe("incident-engine");
  expect(h.ports.investigator.investigate).not.toHaveBeenCalled();
});
it("read approval requirements are refused without a product read", async () => {
  const h = await makeHarness(() => ({ ...allowDecision(), outcome: "require_approval", approval: { count: 1, minRole: "editor", separationOfDuties: false } }));
  const result = await h.invoke("zenith_get_topology", argsFor("zenith_get_topology"));
  expect(result.error?.code).toBe("policy_denied"); expect(h.ports.reads.project).not.toHaveBeenCalled();
});
