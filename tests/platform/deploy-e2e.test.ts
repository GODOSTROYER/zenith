/** Contract evidence only: real composition/Temporal/stores, fake tofu and mocked AWS. */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { defaultPayloadConverter } from "@temporalio/common";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowResult, WorkerActivities, StepName } from "@/lib/workflows/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-compose-e2e-", { fast: true });
const { resetDb, save, q } = await import("@/lib/db/store");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { createBroker } = await import("@/lib/capabilities/platform");
const { PlatformBrokerStore } = await import("@/lib/capabilities/platform-store");
const { productRoleResolver, productScopeResolver } = await import("@/lib/capabilities/product-adapters");
const { CredentialGrantSigner } = await import("@/lib/capabilities/credential-signer");
const { loadPolicyEngine } = await import("@/lib/policy");
const { generateSigningJwk, serializePrivateJwk, resetSignerCache } = await import("@/lib/credentials/signing");
const { composeExecutionActivities } = await import("@/lib/platform/execution");
const { createExecutionBroker } = await import("@/lib/platform/broker");
const { createProductPort, executionHolder, CLAIM_LEASE_MS } = await import("@/lib/execution");
const { createSafeProber } = await import("@/lib/execution/prober");
const { buildDesiredState } = await import("@/lib/execution/graph");
const { startDeploy } = await import("@/lib/workflows/client");
const { createExecutionWorker } = await import("../../workers/execution/run");
const { executionWorkerConfigFromEnv } = await import("../../workers/execution/config");
const { startTestServer, workflowBundlePath, uniqueId, findTemporalCli } = await import("../workflows/support");
const { FakeTofu } = await import("../execution/fakes/tofu");
const { webDbManifest, makePlan, change, connectionConfig, WS, PROJECT, ENV, REVISION, DEPLOYMENT, PRODUCT_CONNECTION, PLATFORM_CONNECTION } = await import("../execution/fakes/fixtures");
const { mockAwsCloud, SESSION_CANARY } = await import("./aws-cloud");

const author = { type: "user" as const, id: "local", name: "Requester" };
const requester = { kind: "user" as const, id: "local", name: "Requester" };
const approver = { kind: "user" as const, id: "approver", name: "Reviewer" };
const image = `ghcr.io/acme/web@sha256:${"a".repeat(64)}`;
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>["server"];
let skipReason: string | undefined;
let bundle: string, planDir: string;
let cloud: ReturnType<typeof mockAwsCloud>;
let tofu: InstanceType<typeof FakeTofu>;
let broker: ReturnType<typeof createBroker>;
let activities: WorkerActivities;
const reviewedPlan = makePlan({ changes: [change({ address: "aws_db_instance.postgres_db", nodeAddress: "postgres/db", type: "aws_db_instance", action: "create", changes: [{ path: "publicly_accessible", before: false, after: false, sensitive: false, forcesReplacement: false }] })] });

beforeAll(async () => {
  // Network-dependent downloads are opt-in. Installed CLI always uses its own random port.
  const timeSkipping = process.env.ZENITH_COMPOSE_TEMPORAL_MODE === "time-skipping";
  if (timeSkipping || findTemporalCli() || process.env.ZENITH_TEST_TEMPORAL_DOWNLOAD === "1") {
    const started = await startTestServer(timeSkipping ? "time-skipping" : "local"); server = started.server; skipReason = started.skipReason;
  } else skipReason = "Temporal CLI unavailable. Set ZENITH_TEST_TEMPORAL_CLI to the installed binary; downloads require ZENITH_TEST_TEMPORAL_DOWNLOAD=1.";
  if (server) bundle = await workflowBundlePath();
  planDir = await mkdtemp(path.join(os.tmpdir(), "zenith-compose-plan-"));
  vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK", serializePrivateJwk(await generateSigningJwk("EdDSA")));
  resetSignerCache();
}, 180_000);
beforeEach(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  const manifest = webDbManifest(); manifest.services[0].source = { type: "image", image };
  const at = new Date().toISOString();
  resetDb({
    workspaces: [{ id: WS, name: "Atlas", slug: "atlas", createdAt: at }],
    members: [{ id: "local", workspaceId: WS, name: "Requester", email: "requester@example.test", role: "admin" }, { id: "approver", workspaceId: WS, name: "Reviewer", email: "reviewer@example.test", role: "admin" }],
    connections: [{ id: PRODUCT_CONNECTION, workspaceId: WS, provider: "aws", label: "AWS contract", region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: at }],
    projects: [{ id: PROJECT, workspaceId: WS, name: "Atlas", slug: "atlas", workingManifest: manifest, createdAt: at, origin: { type: "blank" } }],
    environments: [{ id: ENV, projectId: PROJECT, name: "production", class: "production", connectionId: PRODUCT_CONNECTION, region: "us-east-1", policies: { approvalRequired: true, allowStatefulDeletion: false }, baseDomain: "atlas.zenith.test", createdAt: at }],
    revisions: [{ id: REVISION, projectId: PROJECT, number: 1, manifest, message: "contract deployment", author, createdAt: at }],
    deployments: [{ id: DEPLOYMENT, projectId: PROJECT, environmentId: ENV, revisionId: REVISION, status: "planning", steps: [], outputs: [], changeSummary: "deploy", estCostDeltaUsd: 0, actor: author, createdAt: at }],
  }); save();
  await repos.connections.create(db, { id: PLATFORM_CONNECTION, workspaceId: WS, legacyConnectionId: PRODUCT_CONNECTION, createdBy: "local", config: { ...connectionConfig, mode: "aws_assume_role", externalId: "zenith-contract-external-id" } });
  await repos.connections.recordVerification(db, { workspaceId: WS, id: PLATFORM_CONNECTION, ok: true, detail: "Contract fixture; no cloud identity was checked." });
  broker = createBroker({ store: new PlatformBrokerStore(db), scopes: productScopeResolver(), roles: productRoleResolver(), signer: new CredentialGrantSigner(), clock: { now: () => new Date() }, policy: () => loadPolicyEngine() });
  const product = await createProductPort().loadContext({ workspaceId: WS, environmentId: ENV, revisionId: REVISION, deploymentId: DEPLOYMENT });
  const desired = buildDesiredState(product); expect(desired.problems).toEqual([]); expect(desired.graph).toBeDefined();
  cloud = mockAwsCloud(desired.graph!, WS, ENV, image);
  tofu = new FakeTofu(); tofu.planFactory = () => reviewedPlan;
  activities = composed();
}, 60_000);
afterEach(async () => { cloud?.restore(); await db?.close(); });
afterAll(async () => { await server?.env.teardown(); vi.unstubAllEnvs(); resetSignerCache(); });
function composed(temporal = true) {
  const prober = createSafeProber({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async (req) => {
    expect(req.host).toBe("app.atlas.zenith.test"); expect(req.path).toBe("/healthz");
    return { status: 200, latencyMs: 5, bytes: 2, truncated: false, bodyDigest: "0".repeat(64), tlsExpiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() };
  } });
  return composeExecutionActivities({ db, workerIdentity: "compose-contract", planDir, secretKey: "1".repeat(64), ports: { tofu, prober, broker: createExecutionBroker(db, async () => broker), heartbeat: temporal ? (d) => Context.current().heartbeat(d) : () => undefined, activitySignal: temporal ? () => Context.current().cancellationSignal : () => undefined } });
}

async function approvedOperation() {
  const proposal = await broker.propose({ capability: "deployment.deploy", scope: { workspaceId: WS, projectId: PROJECT, environmentId: ENV }, input: { revisionId: REVISION, deploymentId: DEPLOYMENT }, idempotencyKey: uniqueId("deploy") }, requester, { via: "workflow", plan: reviewedPlan });
  expect(proposal.decision.outcome).toBe("require_approval");
  expect(proposal.operation.status).toBe("awaiting_approval");
  await expect(broker.approve({ workspaceId: WS, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest, approver: { kind: "navigator", id: "model", name: "Model", onBehalfOf: "approver" }, session: { method: "browser_session", subject: "approver", verifiedAtMs: Date.now() } })).rejects.toThrow();
  await broker.approve({ workspaceId: WS, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest, approver, session: { method: "browser_session", subject: "approver", verifiedAtMs: Date.now() } });
  await broker.beginExecution({ workspaceId: WS, operationId: proposal.operation.id, holder: executionHolder(proposal.operation.id), leaseMs: CLAIM_LEASE_MS, audience: "worker" });
  return proposal.operation.id;
}
async function runDeploy(operationId: string, during?: () => Promise<void>) {
  const taskQueue = uniqueId("compose-queue");
  const config = executionWorkerConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: server!.env.address, ZENITH_WORKER_TASK_QUEUE: taskQueue, ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000" });
  const worker = await createExecutionWorker({ config, connection: server!.env.nativeConnection, activities, workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" } });
  return worker.runUntil(async () => {
    const started = await startDeploy({ operationId, workspaceId: WS, projectId: PROJECT, environmentId: ENV, connectionId: PLATFORM_CONNECTION, revisionId: REVISION, deploymentId: DEPLOYMENT, build: true, preApproved: false }, { client: server!.env.client, taskQueue });
    const handle = server!.env.client.workflow.getHandle(started.workflowId);
    const pending: Promise<WorkflowResult> = handle.result();
    if (during) await Promise.race([during(), pending.then((r) => { throw new Error(`Workflow ended before the held apply: ${r.status}`); })]);
    const result = await pending;
    return { result, history: await handle.fetchHistory() };
  });
}

describe("composed deploy workflow (contract evidence)", () => {
  it("approves the plan as a browser human, deploys every step, and reads actual mocked steady state/health", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    expect(server!.env.address).not.toMatch(/:7233$/);
    const op = await approvedOperation();
    const { result, history } = await runDeploy(op);
    expect(result.status).toBe("succeeded");
    const operation = await repos.operations.get(db, WS, op);
    expect(operation?.status).toBe("succeeded");
    expect(tofu.applyCalls).toHaveLength(1);
    expect(tofu.applyCalls[0].fingerprintKey).toMatch(/^[a-f0-9]{64}$/);
    expect(tofu.planCalls.length).toBeGreaterThanOrEqual(2);
    expect(q.deployment(DEPLOYMENT)?.status).toBe("succeeded");
    expect(q.deployment(DEPLOYMENT)?.steps.map((s) => s.id.replace(/^step-/, ""))).toEqual(["validate", "lease", "plan", "policy", "approval", "final_plan", "apply_infrastructure", "build", "deploy", "migrate", "verify_infrastructure", "verify_application", "observe", "finalize", "release"]);
    const evidence = await repos.evidence.list(db, WS, { operationId: op, limit: 200 });
    expect(evidence.some((e) => e.kind === "tofu_plan")).toBe(true);
    expect(evidence.some((e) => e.kind === "verification")).toBe(true);
    expect(await broker.deps.store.listApprovals(WS, op)).toHaveLength(1);
    expect((await db.query("select id from platform.policy_decisions where workspace_id=$1 and operation_id=$2", [WS, op])).length).toBeGreaterThan(1);
    expect((await db.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [WS, op])).length).toBeGreaterThan(1);
    const events = await repos.events.list(db, WS, { operationId: op, limit: 500 });
    expect(events.some((e) => e.type === "credential.assumed")).toBe(true);
    expect(cloud.ecs.commandCalls((await import("@aws-sdk/client-ecs")).DescribeServicesCommand).length).toBeGreaterThan(0);
    expect(cloud.elb.commandCalls((await import("@aws-sdk/client-elastic-load-balancing-v2")).DescribeTargetHealthCommand).length).toBeGreaterThan(0);
    expect(cloud.rds.calls().length).toBeGreaterThan(0);
    const historyPayloads = (history.events ?? []).flatMap((event) => Object.values(event).filter((value) => value && typeof value === "object").flatMap((attrs) => Object.values(attrs).filter((value) => value && typeof value === "object" && "payloads" in value).flatMap((value) => (value as { payloads: Parameters<typeof defaultPayloadConverter.fromPayload>[0][] }).payloads.map((p) => defaultPayloadConverter.fromPayload(p)))));
    const serialized = JSON.stringify({ events, evidence, projection: q.deployment(DEPLOYMENT), historyPayloads });
    expect(serialized).not.toContain(SESSION_CANARY);
    expect(serialized).not.toContain(process.env.ZENITH_CONTROL_SIGNING_JWK);
    expect(serialized).not.toContain("FAKE-BINARY-PLAN-FILE");
  }, 120_000);
  it("denies a discovered public database before apply", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    const op = await approvedOperation();
    const publicPlan = makePlan({ changes: [change({ address: "aws_db_instance.postgres_db", nodeAddress: "postgres/db", type: "aws_db_instance", action: "create", changes: [{ path: "publicly_accessible", before: false, after: true, sensitive: false, forcesReplacement: false }] })] });
    tofu.planFactory = () => publicPlan;
    const { result } = await runDeploy(op);
    expect(result.status).toBe("failed");
    expect(tofu.applyCalls).toHaveLength(0);
    const decisions = await db.query<{ outcome: string; reasons: unknown }>("select outcome, reasons from platform.policy_decisions where workspace_id=$1 and operation_id=$2", [WS, op]);
    expect(decisions.some((d) => d.outcome === "deny" && JSON.stringify(d.reasons).includes("public_database"))).toBe(true);
  }, 120_000);
  it("loses its lease while apply is in flight and ends uncertain without retrying apply", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    const op = await approvedOperation();
    let finish!: () => void;
    tofu.applyGate = new Promise<void>((resolve) => { finish = resolve; });
    const { result } = await runDeploy(op, async () => {
      await tofu.applyStarted;
      try { await db.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and scope=$2", [WS, `env:${ENV}`]); }
      finally { finish(); }
    });
    expect(result.status).toBe("uncertain");
    expect((await repos.operations.get(db, WS, op))?.status).toBe("uncertain");
    expect(tofu.applyCalls).toHaveLength(1);
  }, 120_000);
});

describe("composed activities against local stores (no Temporal fallback)", () => {
  it("runs the complete deploy activity chain with real policy, credentials and driver reads", async () => {
    activities = composed(false);
    const operationId = await approvedOperation();
    await activities.markOperation({ operationId, status: "running" });
    const step = async <T>(name: StepName, fn: () => Promise<T>): Promise<T> => {
      await activities.recordStep({ operationId, deploymentId: DEPLOYMENT, step: name, status: "running" });
      const result = await fn();
      await activities.recordStep({ operationId, deploymentId: DEPLOYMENT, step: name, status: "done" });
      return result;
    };
    expect((await step("validate", () => activities.validateDesiredState({ operationId }))).problems).toEqual([]);
    const lease = await step("lease", () => activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 }));
    try {
      const plan = await step("plan", () => activities.planInfrastructure({ operationId, lease }));
      expect((await step("policy", () => activities.evaluatePolicy({ operationId, planDigest: plan.planDigest }))).outcome).toBe("require_approval");
      expect((await step("approval", () => activities.checkApproval({ operationId }))).approved).toBe(true);
      await step("final_plan", () => activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease }));
      await step("apply_infrastructure", () => activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease }));
      const built = await step("build", () => activities.buildArtifacts({ operationId, lease }));
      expect((await step("deploy", () => activities.deployWorkloads({ operationId, lease, images: built.images }))).services).toBe(1);
      expect((await step("migrate", () => activities.runMigrations({ operationId, lease }))).ran).toBe(false);
      const verified = await step("verify_infrastructure", () => activities.verifyInfrastructure({ operationId }));
      expect(verified).toMatchObject({ status: "passed", failed: 0 });
      expect(await step("verify_application", () => activities.verifyApplication({ operationId }))).toMatchObject({ status: "passed", failed: 0 });
      await step("observe", () => activities.observeEnvironment({ operationId }));
      await step("finalize", () => activities.markOperation({ operationId, status: "succeeded" }));
      await step("release", () => activities.releaseLease({ lease }));
      expect((await repos.operations.get(db, WS, operationId))?.status).toBe("succeeded");
      expect(q.deployment(DEPLOYMENT)?.status).toBe("succeeded");
      expect(tofu.applyCalls).toHaveLength(1);
      const main = JSON.parse(tofu.planCalls[0].ws.files.find((f) => f.path === "main.tf.json")!.content) as { locals: Record<string, unknown> };
      const references = [...JSON.stringify(main).matchAll(/local\.(ref_[a-z0-9_]+)/g)].map((m) => m[1]);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) expect(main.locals).toHaveProperty(reference);
      expect((await db.query("select environment_id from platform.reconcile_state where workspace_id=$1 and environment_id=$2", [WS, ENV])).length).toBe(1);
      const evidence = await repos.evidence.list(db, WS, { operationId, limit: 200 });
      const events = await repos.events.list(db, WS, { operationId, limit: 500 });
      expect(JSON.stringify({ evidence, events, deployment: q.deployment(DEPLOYMENT) })).not.toContain(SESSION_CANARY);
      expect(cloud.ecs.calls().length).toBeGreaterThan(0);
      expect(cloud.elb.commandCalls((await import("@aws-sdk/client-elastic-load-balancing-v2")).DescribeTargetHealthCommand).length).toBeGreaterThan(0);
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("evaluates a public database plan as deny without any apply call", async () => {
    activities = composed(false);
    const operationId = await approvedOperation();
    tofu.planFactory = () => makePlan({ changes: [change({ address: "aws_db_instance.db", type: "aws_db_instance", action: "create", changes: [{ path: "publicly_accessible", before: false, after: true, sensitive: false, forcesReplacement: false }] })] });
    await activities.validateDesiredState({ operationId });
    const lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    try {
      const plan = await activities.planInfrastructure({ operationId, lease });
      const decision = await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
      expect(decision.outcome).toBe("deny"); expect(decision.reasons).toContain("public_database");
      expect(tofu.applyCalls).toHaveLength(0);
      await expect(createExecutionBroker(db, async () => broker).issueGrant(operationId, "worker", lease)).rejects.toThrow();
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("maps a lost apply fence to a non-retryable LeaseLost and permits only uncertain finalization", async () => {
    activities = composed(false);
    const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    const lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    const plan = await activities.planInfrastructure({ operationId, lease });
    let finish!: () => void; tofu.applyGate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease });
    const assertion = expect(pending).rejects.toMatchObject({ type: "LeaseLost", nonRetryable: true });
    await tofu.applyStarted;
    await db.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and scope=$2", [WS, lease.scope]);
    finish(); await assertion;
    await activities.markOperation({ operationId, status: "uncertain", error: "Apply lease lost; external outcome unknown." });
    expect((await repos.operations.get(db, WS, operationId))?.status).toBe("uncertain");
    expect(tofu.applyCalls).toHaveLength(1);
  }, 60_000);
  it("atomically reaps runner and machine jobs, marks owning operations uncertain, and audits once", async () => {
    const { ensurePlatformApp, platformRunnerReaperPass, resetPlatformAppForTests } = await import("@/lib/platform/app");
    const { resetPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
    const { resetRunnerRuntime } = await import("@/lib/runners/runtime");
    const { wireReconcilePorts } = await import("@/lib/reconcile/ports");
    const { createMachineRequestQueue } = await import("@/lib/runners/db/machine-requests");
    const operationId = await approvedOperation();
    const second = await approvedOperation();
    const runnerHash = "a".repeat(64), machineHash = "b".repeat(64);
    await repos.runners.createRegistrationToken(db, { tokenHash: runnerHash, workspaceId: WS, kind: "runner", binding: {}, createdBy: "local" });
    await repos.runners.createRegistrationToken(db, { tokenHash: machineHash, workspaceId: WS, kind: "machine", binding: {}, createdBy: "local" });
    const runner = await repos.runners.registerRunner(db, { tokenHash: runnerHash, name: "Contract runner", publicKey: "a".repeat(43) });
    const machine = await repos.machines.registerMachine(db, { tokenHash: machineHash, name: "Contract machine", publicKey: "b".repeat(43) });
    await repos.jobs.enqueue(db, { id: "runner-expired", workspaceId: WS, runnerId: runner.id, operationId, kind: "aws-sdk.call", capability: "deployment.deploy", envelope: "contract-opaque-envelope" });
    await createMachineRequestQueue(db).enqueue({ id: "machine-expired", workspaceId: WS, agentId: machine.id, operationId: second, kind: "machine.inspect", capability: "deployment.deploy", envelope: "contract-opaque-envelope" });
    await db.query("update platform.runner_jobs set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1", [WS]);
    await db.query("update platform.machine_requests set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1", [WS]);
    resetPlatformAppForTests();
    try {
      expect(await ensurePlatformApp(db)).toBe(true);
      expect(await platformRunnerReaperPass()).toEqual({ ran: true, jobs: 2 });
      expect((await repos.operations.get(db, WS, operationId))?.status).toBe("uncertain");
      expect((await repos.operations.get(db, WS, second))?.status).toBe("uncertain");
      expect(await platformRunnerReaperPass()).toEqual({ ran: true, jobs: 0 });
      const events = await repos.events.list(db, WS, { limit: 500 });
      expect(events.filter((e) => e.type === "runner.job.completed")).toHaveLength(1);
      expect(events.filter((e) => e.type === "machine.request.completed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("contract-opaque-envelope");
    } finally { resetPlatformAppForTests(); resetPlatformBrokerForTests(); resetRunnerRuntime(); wireReconcilePorts(null); }
  }, 60_000);
  it("resolves platform repair resource ids only through the owning workspace/environment chain", async () => {
    const { platformScopeResolver } = await import("@/lib/platform/scopes");
    activities = composed(false); const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    const nodes = await repos.resources.listByEnvironment(db, WS, ENV);
    const resource = nodes.find((n) => n.kind === "postgres")!;
    const scopes = platformScopeResolver(db);
    expect(await scopes.resolve({ workspaceId: WS, projectId: PROJECT, environmentId: ENV, resourceId: resource.id })).toMatchObject({ resource: { address: "postgres/db", ownership: "managed", stateful: true } });
    expect(await scopes.resolve({ workspaceId: "foreign", projectId: PROJECT, environmentId: ENV, resourceId: resource.id })).toBeNull();
    expect(await scopes.resolve({ workspaceId: WS, projectId: PROJECT, environmentId: "foreign", resourceId: resource.id })).toBeNull();
  }, 60_000);
  it("refuses grants after a human approver loses their required role", async () => {
    activities = composed(false); const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    const lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    try {
      await activities.planInfrastructure({ operationId, lease });
      const store = (await import("@/lib/db/store")).db();
      store.members.find((m) => m.id === approver.id)!.role = "viewer"; save();
      await expect(createExecutionBroker(db, async () => broker).issueGrant(operationId, "worker", lease)).rejects.toThrow("human approval");
      expect(await activities.checkApproval({ operationId })).toMatchObject({ approved: false });
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
});
