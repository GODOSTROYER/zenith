/**
 * Actual bridge and MCP callers through the real workflow client. The broker,
 * signer and local product store are real test implementations; policy and
 * cloud ports are fixtures, and Temporal transport is intercepted. No live
 * workflow/history or cloud execution is claimed.
 */
import type { Client } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDayTwo, startDeploy } from "@/lib/workflows/client";
import { WORKFLOW_TYPES } from "@/lib/workflows/types";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-workflow-callers-", { fast: true });
const { McpDeployInput } = await import("@/lib/agent-access/v3/deploy-admission");
const { ctx, seed, ready } = await import("../bridge/support");
const { db, q } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
const { ensureEngine } = await import("@/lib/engine/engine");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
const { createBroker, setPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const { productRoleResolver, productScopeResolver } = await import("@/lib/capabilities/product-adapters");
const { makeHarness: brokerHarness, scriptedEngine, allowDecision } = await import("../capabilities/support");
const { makeHarness: agentHarness, argsFor, ids, proposeDeploy, approve, requireApproval } = await import("../agent-v3/support");
await import("@/lib/actions/defs");

function transport() {
  const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ firstExecutionRunId: "synthetic-run" }));
  return { start, client: { workflow: { start } } as unknown as Client };
}

afterEach(() => {
  setBridgeDepsForTests(null);
  setPlatformBrokerForTests(null);
  vi.restoreAllMocks();
});

describe("existing callers remain compatible with the scalar payload contract", () => {
  it.each([false, true])("bridge lifecycle forwards all deploy fields (build=%s)", async (build) => {
    seed();
    ensureEngine();
    if (build) q.project(ctx.projectId!)!.workingManifest.services[0].source = { type: "git", repo: "acme/web", ref: "main" };
    const h = await brokerHarness({ engine: scriptedEngine("caller-compatibility", () => allowDecision()) });
    const broker = createBroker({ ...h.deps, scopes: productScopeResolver(), roles: productRoleResolver() });
    setPlatformBrokerForTests(broker);
    const wire = transport();
    const start = vi.fn((input: DeployWorkflowInput) => startDeploy(input, { client: wire.client }));
    setBridgeDepsForTests({
      workflows: {
        startDeploy: start,
        signalApproval: async () => ({ delivered: true }),
        cancelOperation: async () => ({ delivered: true }),
      },
      readiness: async () => ready,
      platformConnection: async () => ({ status: "verified" }),
    });
    const result = await runAction("deploy.apply", ctx, {}, { mode: "execute" });
    expect(result.result?.ok, result.result?.error).toBe(true);
    const deployment = db().deployments.at(-1)!;
    const expected = {
      operationId: deployment.operationId, workspaceId: ctx.workspaceId, projectId: ctx.projectId,
      environmentId: ctx.environmentId, revisionId: deployment.revisionId, deploymentId: deployment.id,
      connectionId: "bridge-connection", preApproved: true, build,
    };
    expect(start).toHaveBeenCalledExactlyOnceWith(expected);
    expect(wire.start).toHaveBeenCalledExactlyOnceWith(WORKFLOW_TYPES.deploy, expect.objectContaining({ args: [expected] }));
  });

  it.each([false, true])("agent-v3 deploy forwards its full payload (approvalRequired=%s)", async (approvalRequired) => {
    const h = await agentHarness(approvalRequired ? () => requireApproval() : undefined);
    const wire = transport();
    h.ports.workflows.startDeploy = vi.fn(async (input) => {
      if (approvalRequired) {
        const approvals = await h.store.listApprovals(ids.ws, input.operationId);
        expect(approvals).toHaveLength(1);
        expect(approvals[0].consumedAt).toBeDefined();
      }
      return startDeploy(input, { client: wire.client });
    });
    const proposal = await proposeDeploy(h);
    const saved = await h.store.getOperation(ids.ws, proposal.id);
    expect(saved?.proposalDigest).toBe(proposal.digest);
    const { deploymentId } = McpDeployInput.parse(saved!.proposal.input);
    expect(deploymentId).toMatch(/^mcp-deploy-[a-f0-9]{64}$/);
    const bound = h.deployments.get(deploymentId)!;
    expect(bound.operationId).toBe(proposal.id);
    expect(bound.input).toEqual(saved!.proposal.input);
    expect(bound.integrationId).toBe(h.principal.principal.id);
    expect(bound.subject).toBe(h.principal.principal.kind === "integration" ? h.principal.principal.onBehalfOf : undefined);
    if (approvalRequired) {
      const refused = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", proposal.id, proposal.digest));
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("approval_required");
      expect(h.beginExecution).not.toHaveBeenCalled();
      expect(h.ports.workflows.startDeploy).not.toHaveBeenCalled();
      expect(wire.start).not.toHaveBeenCalled();
      await approve(h, proposal.id, proposal.digest);
      expect((await h.store.listApprovals(ids.ws, proposal.id))[0].consumedAt).toBeUndefined();
    }
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", proposal.id, proposal.digest));
    expect(result.ok, result.error?.message).toBe(true);
    const expected = {
      operationId: proposal.id, workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env,
      revisionId: ids.revision, deploymentId, connectionId: "conn-a",
      // The initial proposal approval is consumed by the broker claim. The worker's concrete-plan review remains separate.
      preApproved: true, build: false,
    };
    expect(h.beginExecution).toHaveBeenCalledTimes(1);
    if (approvalRequired) {
      const approvals = await h.store.listApprovals(ids.ws, proposal.id);
      expect(approvals).toHaveLength(1);
      expect(approvals[0].consumedAt).toBeDefined();
    }
    expect(h.ports.workflows.startDeploy).toHaveBeenCalledExactlyOnceWith(expected, "new");
    expect(wire.start).toHaveBeenCalledExactlyOnceWith(WORKFLOW_TYPES.deploy, expect.objectContaining({ args: [expected] }));
  });

  it.each([
    { tool: "zenith_restart_service", capability: "service.restart" },
    { tool: "zenith_scale_service", capability: "service.scale" },
  ] as const)("agent-v3 $capability forwards every day-two field", async ({ tool, capability }) => {
    const h = await agentHarness();
    const wire = transport();
    h.ports.workflows.startDayTwo = vi.fn((input) => startDayTwo(input, { client: wire.client }));
    const proposal = await h.invoke(tool, argsFor(tool));
    expect(proposal.ok, proposal.error?.message).toBe(true);
    const operationId = proposal.data.operationId as string;
    const result = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", operationId, proposal.data.proposalDigest as string));
    expect(result.ok, result.error?.message).toBe(true);
    const expected = { operationId, workspaceId: ids.ws, environmentId: ids.env, capability };
    expect(h.ports.workflows.startDayTwo).toHaveBeenCalledExactlyOnceWith(expected, "new");
    expect(wire.start).toHaveBeenCalledExactlyOnceWith(WORKFLOW_TYPES.dayTwo, expect.objectContaining({ args: [expected] }));
  });
});
