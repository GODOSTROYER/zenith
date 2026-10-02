/** Real isolated Temporal and control store; provider reads and fixture policy are explicitly scripted. */
import path from "node:path";
import { describe, expect } from "vitest";
import { Context, ApplicationFailure } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-canonical-reconcile-", { fast: true });
const { createHeldReconcileActivity } = await import("@/lib/execution/verify");
const { createRuntime } = await import("@/lib/execution/runtime");
const { createLeasesPort } = await import("@/lib/execution/platform");
const { composeReconcilePorts } = await import("@/lib/platform/reconcile");
const { repos } = await import("@/lib/controlplane/db");
const { loadGraphFromStore, loadPlatformEnvironment, registerEnvironment } = await import("@/lib/reconcile/platform");
const { FakeCredentialBroker } = await import("../execution/fakes/broker");
const { createWorld } = await import("../execution/fakes/world");
const { closeSharedPgliteAfterAll, makeHarness, requireApproval, scriptedEngine } = await import("../capabilities/support");
const { World, tinyGraph } = await import("../reconcile/_support");
const { RECONCILE_WORKFLOW_ID, WORKFLOW_TYPES } = await import("@/lib/workflows/types");
const { makeHarness: temporalHarness, serverSuite, uniqueId, workflowBundlePath } = await import("./support");
import type { ReconcileWorkflowResult } from "@/lib/workflows/types";
closeSharedPgliteAfterAll();
const { scenario } = serverSuite("local");

describe("canonical reconciliation through the real Temporal SDK", () => {
  scenario("persists an observation and broker proposal under the same real fence, without bypassing human approval", async (h) => {
    const control = await makeHarness({ kind: "pglite", engine: scriptedEngine("reconcile-fixture-approval-v1", () => requireApproval(1)) });
    // Reads must be authorized independently from the mutating repair proposal.
    control.setEngine(scriptedEngine("reconcile-fixture-approval-v1", (input) => input.request.mutates ? requireApproval(1) : { outcome: "allow", reasons: [] }));
    const db = control.db;
    if (!db) throw new Error("Canonical Temporal fixture requires the actual control store.");
    const env = { workspaceId: control.ids.wsA, projectId: control.ids.projA, environmentId: control.ids.envAProd, class: "production" as const, provider: "aws" as const, region: "us-east-1" };
    const connection = await repos.connections.create(db, { workspaceId: env.workspaceId, createdBy: "alice", config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012", region: env.region, observeRoleArn: "arn:aws:iam::123456789012:role/reconcile-fixture-observe", deployRoleArn: "arn:aws:iam::123456789012:role/reconcile-fixture-deploy", externalId: "reconcile-fixture" } });
    await repos.connections.recordVerification(db, { workspaceId: env.workspaceId, id: connection.id, ok: true, detail: "Scripted provider fixture, not live acceptance." });
    await registerEnvironment(db, { environment: { ...env, connection: { id: connection.id, status: "verified" } } });
    const graph = tinyGraph(env.environmentId, 1);
    for (const node of graph.nodes) {
      const resource = await repos.resources.upsertDesired(db, { workspaceId: env.workspaceId, projectId: env.projectId, environmentId: env.environmentId, node, status: "active" });
      control.world.resources.set(resource.id, { environmentId: env.environmentId, facts: { address: node.address, kind: node.kind, stateful: false, ownership: "managed", publiclyExposed: false } });
    }
    const provider = new World().allPresent(graph).patch(graph.nodes[0].address, { presence: "missing" });
    const credentials = new FakeCredentialBroker();
    const canonical = { ...composeReconcilePorts(db, credentials, async () => control.broker), driverFor: provider.driverFor };
    const leases = createLeasesPort(db);
    const execution = createWorld();
    const runtime = createRuntime({ ...execution.deps, leases, heartbeat: (detail) => Context.current().heartbeat(detail), activitySignal: () => Context.current().cancellationSignal });
    h.fake.activities.acquireLease = async (input) => {
      const lease = await leases.acquire({ ...input, holder: input.operationId, workspaceId: env.workspaceId });
      if (!lease) throw ApplicationFailure.create({ type: "LeaseBusy", nonRetryable: true, message: "Fixture lease already held." });
      return { scope: lease.scope, holder: lease.holder, fenceToken: lease.fenceToken };
    };
    h.fake.activities.releaseLease = async ({ lease }) => { await leases.release(lease); };
    h.fake.activities.reconcileObserve = createHeldReconcileActivity(runtime, { ports: canonical, loadEnvironment: (ws, id) => loadPlatformEnvironment(db, ws, id), loadGraph: (environment) => loadGraphFromStore(db, environment) });
    try {
      const input = { workspaceId: env.workspaceId, environmentId: env.environmentId, allowAutoRepair: true };
      const handle = await h.run(async () => {
        const started = await h.client.workflow.start(WORKFLOW_TYPES.reconcile, { workflowId: RECONCILE_WORKFLOW_ID(env.environmentId), taskQueue: h.taskQueue, args: [input] });
        const result = await started.result() as ReconcileWorkflowResult;
        expect(result).toMatchObject({ status: "observed", drift: 1, unknown: 0, repair: "considered", repairs: { proposed: 1, awaitingApproval: 1, started: 0, denied: 0 } });
        expect(result.repairs?.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(result)).not.toContain(graph.nodes[0].address);
        return started;
      });
      const operations = await db.query<{ status: string; capability: string; proposal: { scope: { resourceId: string } } }>("select status,capability,proposal from platform.operations where workspace_id=$1 and environment_id=$2", [env.workspaceId, env.environmentId]);
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({ status: "awaiting_approval", capability: "drift.repair" });
      expect((await repos.drift.latest(db, env.workspaceId, env.environmentId))?.findings).toHaveLength(1);
      expect(await repos.leases.current(db, `reconcile:${env.environmentId}`)).toBeNull();
      expect(credentials.sessions).toHaveLength(1);
      expect(credentials.sessions[0]).toMatchObject({ purpose: "observe", capability: "infrastructure.observe", revoked: true });
      expect(provider.operationCalls).toEqual([]);
      await Worker.runReplayHistory({ workflowBundle: { codePath: h.bundle } }, await handle.fetchHistory(), handle.workflowId);
    } finally { execution.dispose(); }
  }, 120_000);

  scenario("records the exact pre-patch workflow and replays its original command/result branch", async (h) => {
    const legacyBundle = await workflowBundlePath(path.resolve(__dirname, "fixtures/reconcile-legacy.ts"), "baseline-83ec97f");
    const legacy = temporalHarness(h.server, legacyBundle);
    const environmentId = uniqueId("legacy-reconcile");
    const input = { workspaceId: "ws-1", environmentId, allowAutoRepair: true };
    const handle = await legacy.run(async () => {
      const started = await legacy.client.workflow.start(WORKFLOW_TYPES.reconcile, { workflowId: RECONCILE_WORKFLOW_ID(environmentId), taskQueue: legacy.taskQueue, args: [input] });
      expect(await started.result()).toEqual({ environmentId, status: "observed", drift: 1, unknown: 0, repair: "not_implemented" });
      return started;
    });
    const call = legacy.fake.callsTo("reconcileObserve")[0];
    expect(call?.input).not.toHaveProperty("allowAutoRepair");
    expect(call?.result).toEqual({ drift: 1, unknown: 0 });
    const history = await handle.fetchHistory();
    expect(JSON.stringify(history)).not.toContain("reconcile-canonical-proposals-v1");
    await Worker.runReplayHistory({ workflowBundle: { codePath: h.bundle } }, history, handle.workflowId);
  }, 120_000);
});
