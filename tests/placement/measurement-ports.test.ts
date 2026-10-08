/** Real broker grants with explicit product/observe fixtures, not cloud acceptance. */
import { describe, expect, it } from "vitest";
import { createMeasurementDeps } from "@/lib/cost/optimizer/measurement-ports";
import { OPTIMIZER_PRINCIPAL } from "@/lib/platform/optimizer-pass";
import { graphFor } from "@/lib/agent-access/v3/context";
import { upgradeManifest } from "@/lib/resources/upgrade";
import type { ReconcileEnvironment } from "@/lib/reconcile/types";
import type { MetricQuery } from "@/lib/observability/types";
import { denyDecision, ids, makeHarness } from "../agent-v3/support";

async function setup() {
  const h = await makeHarness();
  const current = h.environments.get(ids.env)!;
  const revision = h.revisions.get(ids.revision)!;
  const graph = graphFor(revision.manifest, current);
  const env: ReconcileEnvironment = { workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, provider: current.provider, region: current.region, class: current.class };
  const query: MetricQuery = { scope: { workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, addresses: [graph.nodes[0]!.address] }, metrics: ["cpu.utilization"], range: { from: h.clock.now().toISOString() } };
  return { h, current, revision, graph, env, query, deps: createMeasurementDeps(h.broker, h.ports.observability, h.ports.reads, h.clock.now) };
}

describe("optimizer measurements broker and applied-policy adapter", () => {
  it("uses a current scoped broker grant inside the observe session", async () => {
    const { h, deps, env, graph, query } = await setup();
    expect(await deps.read(env, graph, query)).toBe(h.metricResult);
    expect(h.authorizeRead).toHaveBeenCalledWith({ capability: "metrics.read", scope: { workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env } }, OPTIMIZER_PRINCIPAL, { ctx: { via: "workflow" } });
    expect(h.sessionRequests).toHaveLength(1);
    expect(h.sessionRequests[0]).toMatchObject({ grant: { cap: "metrics.read", ws: ids.ws, proj: ids.project, env: ids.env } });
    expect(h.trace.indexOf("withSession")).toBeLessThan(h.trace.indexOf("cloudMetrics"));
  });
  it("refuses policy denial, foreign query scopes and cancellation before opening a session", async () => {
    const { h, deps, env, graph, query } = await setup();
    h.setDecision(denyDecision);
    await expect(deps.read(env, graph, query)).rejects.toMatchObject({ code: "policy_denied" });
    await expect(deps.read(env, graph, { ...query, scope: { ...query.scope, workspaceId: ids.foreignWs } })).rejects.toMatchObject({ code: "not_found" });
    const controller = new AbortController(); controller.abort();
    await expect(deps.read(env, graph, query, controller.signal)).rejects.toThrow();
    expect(h.sessionRequests).toHaveLength(0);
    expect(h.fabric.queryMetrics).not.toHaveBeenCalled();
  });
  it("retains the applied V2 budget, latency, residency and availability constraints", async () => {
    const { deps, env, revision } = await setup();
    if (revision.manifest.version !== 1) throw new Error("fixture requires V1");
    const manifest = upgradeManifest(revision.manifest, { provider: "aws", region: "us-east-1" });
    manifest.constraints = { budgetUsdMonthly: 200, latencyTargetMs: 80, availabilityTarget: 99.9, userRegions: ["US"], tolerateSingleFailure: false };
    manifest.placement = { provider: "aws", regions: ["us-east-1"], zones: 2, residency: ["US"] };
    revision.manifest = manifest;
    expect(await deps.constraints(env)).toMatchObject({ budgetUsdMonthly: 200, latencyTargetMs: 80, availabilityTarget: 99.9, userRegions: ["US"], residency: ["US"], tolerateSingleFailure: true });
  });
  it("refuses unknown legacy policies and missing or foreign applied revisions", async () => {
    const { deps, env, revision, current } = await setup();
    await expect(deps.constraints(env)).rejects.toMatchObject({ code: "invalid_state" });
    revision.projectId = ids.foreignProject;
    await expect(deps.constraints(env)).rejects.toMatchObject({ code: "not_found" });
    delete current.deployedRevisionId;
    await expect(deps.constraints(env)).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("reads authoritative V1 environment policies without rewriting the applied revision", async () => {
    const { deps, env, current, revision } = await setup();
    const before = structuredClone(revision.manifest);
    current.policies = { approvalRequired: true, allowStatefulDeletion: false, budgetUsdMonthly: 123 };
    expect(await deps.constraints(env)).toMatchObject({ budgetUsdMonthly: 123, userRegions: [], tolerateSingleFailure: false });
    expect(revision.manifest).toEqual(before);
    current.policies = { ...current.policies, budgetUsdMonthly: Number.NaN };
    await expect(deps.constraints(env)).rejects.toMatchObject({ code: "invalid_state" });
  });
});
