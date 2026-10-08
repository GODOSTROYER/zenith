/** Foreign identifiers and nonexistent identifiers give byte-identical bodies.
 * These tests use real broker tenancy checks plus separately scoped fake rows. */
import { describe, expect, it, vi } from "vitest";
import { TOOL_NAMES, type ToolName } from "@/lib/agent-access/v3/contract";
import { argsFor, ids, makeHarness, proposeDeploy } from "./support";

describe.each(TOOL_NAMES)("%s tenant matrix", (name) => {
  it("foreign/missing workspace, project and environment; no proposal persisted", async () => {
    const h = await makeHarness();
    const p = await proposeDeploy(h);
    h.propose.mockClear();
    h.ports.broker = vi.fn(async () => h.broker);
    const args = argsFor(name, p.id, p.digest);
    const dimensions = args.target ? Object.keys(args.target) : ["workspaceId"];
    for (const dimension of dimensions) {
      const foreign = dimension === "workspaceId" ? ids.foreignWs : dimension === "projectId" ? ids.foreignProject : ids.foreignEnv;
      const mutate = (id: string) => args.target ? { ...args, target: { ...(args.target as object), [dimension]: id } } : { ...args, [dimension]: id };
      const a = await h.invoke(name, mutate(foreign));
      const b = await h.invoke(name, mutate("missing"));
      expect(a.error?.code).toBe("not_found");
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.authorizeRead).not.toHaveBeenCalled();
    expect(h.getOperationDetail).not.toHaveBeenCalled();
    expect(h.store.allEvents().filter((e) => e.type === "operation.proposed")).toHaveLength(1);
    expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.ports.broker).not.toHaveBeenCalled();
  });
});

it.each(["zenith_get_topology", "zenith_estimate_cost", "zenith_plan_change", "zenith_prepare_deploy", "zenith_compare_revisions"] as ToolName[])("%s hides foreign revisions", async (name) => {
  const h = await makeHarness();
  const key = name === "zenith_compare_revisions" ? "fromRevisionId" : "revisionId";
  const a = await h.invoke(name, { ...argsFor(name), [key]: ids.foreignRevision });
  const b = await h.invoke(name, { ...argsFor(name), [key]: "missing" });
  expect(a.error?.code).toBe("not_found"); expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(h.propose).not.toHaveBeenCalled();
});
it.each(["zenith_restart_service", "zenith_scale_service", "zenith_query_logs", "zenith_query_metrics"] as ToolName[])("%s hides foreign services", async (name) => {
  const h = await makeHarness();
  const a = await h.invoke(name, { ...argsFor(name), serviceId: ids.foreignService });
  const b = await h.invoke(name, { ...argsFor(name), serviceId: "missing" });
  expect(a.error?.code).toBe("not_found"); expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(h.store.allEvents().filter((e) => e.type === "operation.proposed")).toHaveLength(0);
});
it.each(["zenith_get_operation", "zenith_get_operation_events", "zenith_execute_approved_operation"] as ToolName[])("%s hides foreign operations", async (name) => {
  const h = await makeHarness();
  const foreign = await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId: ids.foreignWs, projectId: ids.foreignProject, environmentId: ids.foreignEnv } },
    { kind: "user", id: "mallory", name: "mallory" });
  const a = await h.invoke(name, argsFor(name, foreign.operation.id, foreign.operation.proposalDigest));
  const b = await h.invoke(name, argsFor(name));
  expect(a.error?.code).toBe("not_found"); expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(h.beginExecution).not.toHaveBeenCalled();
});
