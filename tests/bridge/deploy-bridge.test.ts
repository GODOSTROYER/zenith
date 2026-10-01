/** Real broker, signer and product scope/role adapters; workflow gateway is fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext, ActionResult } from "@/lib/actions/core";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-bridge-deploy-", { fast: true });
const { ctx, seed, ready, manifest } = await import("./support");
const { db, q, readEvents, readAudit } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
const { ensureEngine } = await import("@/lib/engine/engine");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
const { beginWorkflow, approveWorkflowDeployment } = await import("@/lib/bridge/lifecycle");
const { createBroker, setPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const { productRoleResolver, productScopeResolver } = await import("@/lib/capabilities/product-adapters");
const { BrokerError } = await import("@/lib/capabilities/errors");
const { makeHarness, scriptedEngine, allowDecision, requireApproval } = await import("../capabilities/support");
await import("@/lib/actions/defs");

let h: Awaited<ReturnType<typeof makeHarness>>;
let broker: ReturnType<typeof createBroker>;
const gateway = { startDeploy: vi.fn<(input: DeployWorkflowInput) => Promise<unknown>>(async () => ({ started: true })), signalApproval: vi.fn(async (_id: string) => ({ delivered: true as const })), cancelOperation: vi.fn(async (_id: string) => ({ delivered: true as const })) };
const readiness = vi.fn(async () => ready);
const platformConnection = vi.fn(async () => ({ status: "verified" as const }));
const exec = async (action: string, input: unknown = {}, context: ActionContext = ctx, key?: string): Promise<ActionResult> => (await runAction(action, context, input, { mode: "execute", idempotencyKey: key })).result!;
const plan = async (action = "deploy.apply", input: unknown = {}, context: ActionContext = ctx) => (await runAction(action, context, input, { mode: "plan" })).plan!;
const latest = () => db().deployments.at(-1)!;
const browserCtx = { ...ctx, actor: { type: "user" as const, id: "admin-b", name: "Admin B" } };
const browser = () => setBridgeDepsForTests({ workflows: gateway, readiness, platformConnection, browserSession: async (c) => ({ method: "browser_session", subject: c.actor.id, verifiedAtMs: Date.now() }) });

beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); gateway.startDeploy.mockResolvedValue({ started: true }); gateway.signalApproval.mockResolvedValue({ delivered: true }); gateway.cancelOperation.mockResolvedValue({ delivered: true });
  seed(); ensureEngine();
  h = await makeHarness({ engine: scriptedEngine("bridge-v1", () => allowDecision()) });
  broker = createBroker({ ...h.deps, scopes: productScopeResolver(), roles: productRoleResolver() });
  setPlatformBrokerForTests(broker);
  readiness.mockResolvedValue(ready); platformConnection.mockResolvedValue({ status: "verified" });
  setBridgeDepsForTests({ workflows: gateway, readiness, platformConnection });
});
afterEach(() => { setBridgeDepsForTests(null); setPlatformBrokerForTests(null); vi.restoreAllMocks(); });

describe("routing and proposals", () => {
  it("unlinked legacy AWS stays Preview without probing or writing", async () => {
    q.connection("bridge-connection")!.platformConnectionId = undefined;
    expect((await plan()).blocked).toMatch(/Preview provider.*never applies/);
    expect((await exec("deploy.apply")).error).toContain("connection.createAws");
    expect(readiness).not.toHaveBeenCalled(); expect(db().deployments).toHaveLength(0); expect(db().revisions).toHaveLength(1);
  });
  it("failed readiness supplies fixes before revision/deployment/proposal writes", async () => {
    readiness.mockResolvedValue({ ...ready, ready: false, checks: [{ id: "temporal", ok: false, detail: "unreachable", fix: "Start Temporal and a worker." }] });
    const propose = vi.spyOn(broker, "propose");
    expect((await plan()).blocked).toContain("Start Temporal and a worker.");
    expect((await exec("deploy.apply")).error).toMatch(/Preview provider/);
    expect(db().revisions).toHaveLength(1); expect(db().deployments).toHaveLength(0); expect(propose).not.toHaveBeenCalled();
  });
  it("unverified platform connections refuse apply", async () => {
    platformConnection.mockResolvedValue(null as never);
    expect((await exec("deploy.apply")).error).toContain("connection.verifyAws");
    expect(db().deployments).toHaveLength(0);
  });
  it("plan shows broker decision/reasons/approval without writing", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(2, "admin", true)));
    const p = await plan(); expect(p.details.join(" ")).toMatch(/require_approval.*scripted/); expect(p.details.join(" ")).toContain("2 distinct admin"); expect(p.requiresApproval).toBe(true);
    expect((await h.store.listOperations(ctx.workspaceId)).items).toHaveLength(0);
  });
  it("plan maps BrokerError fix to blocked", async () => {
    vi.spyOn(broker, "check").mockRejectedValue(new BrokerError("platform_store_unavailable", "Store unavailable.", "Run the migration."));
    expect((await plan()).blocked).toContain("Run the migration.");
  });
  it("allowed deploy claims once and sends exact ids-only workflow input", async () => {
    const begin = vi.spyOn(broker, "beginExecution"); const propose = vi.spyOn(broker, "propose");
    const result = await exec("deploy.apply"); expect(result.ok).toBe(true);
    const d = latest(); expect(d).toMatchObject({ executor: "workflow", status: "planning", operationId: expect.any(String), workflowStartedAt: expect.any(String) });
    expect(d.steps).toHaveLength(15); expect(d.steps.every((s) => s.status === "pending")).toBe(true);
    expect(begin).toHaveBeenCalledExactlyOnceWith({ workspaceId: ctx.workspaceId, operationId: d.operationId, holder: `workflow:${d.operationId}`, audience: "worker", leaseMs: 300_000 });
    expect(gateway.startDeploy).toHaveBeenCalledExactlyOnceWith({ operationId: d.operationId, workspaceId: ctx.workspaceId, projectId: ctx.projectId, environmentId: ctx.environmentId, revisionId: d.revisionId, deploymentId: d.id, connectionId: "bridge-connection", preApproved: true, build: false });
    expect(propose.mock.calls[0][0]).toMatchObject({ capability: "deployment.deploy", input: { revisionId: d.revisionId, deploymentId: d.id } });
    expect((await h.store.getOperation(ctx.workspaceId, d.operationId!))?.status).toBe("running");
  });
  it("source builds set build=true", async () => {
    q.project(ctx.projectId!)!.workingManifest.services[0].source = { type: "git", repo: "acme/web", ref: "main" };
    expect((await exec("deploy.apply")).ok).toBe(true); expect(gateway.startDeploy.mock.calls[0][0].build).toBe(true);
  });
  it("blueprint sources do not declare a git build pipeline", async () => {
    // The real worker rejects non-sandbox blueprint artifacts during validation;
    // this fake gateway only checks the ids-only startup flag's contract.
    q.project(ctx.projectId!)!.workingManifest.services[0].source = { type: "blueprint", blueprint: "echo" };
    expect((await exec("deploy.apply")).ok).toBe(true); expect(gateway.startDeploy.mock.calls[0][0].build).toBe(false);
  });
  it("approval-required proposal parks with a platform pointer and digest", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1)));
    const r = await exec("deploy.apply"); expect(r.ok).toBe(true); expect(latest().status).toBe("awaiting_approval"); expect(gateway.startDeploy).not.toHaveBeenCalled();
    expect(r.data).toMatchObject({ operationId: latest().operationId, proposalDigest: expect.any(String), approval: `/api/platform/v1/operations/${latest().operationId}` });
  });
  it("policy denial projects failed/skipped with reasons, no workflow", async () => {
    h.setEngine(scriptedEngine("deny", () => ({ outcome: "deny", reasons: [{ code: "no", message: "Budget is exceeded.", rule: "test" }] })));
    expect((await plan()).blocked).toContain("Budget is exceeded.");
    const r = await exec("deploy.apply"); expect(r.ok).toBe(false); expect(r.error).toContain("Budget is exceeded."); expect(latest().status).toBe("failed"); expect(latest().steps.every((s) => s.status === "skipped")).toBe(true); expect(gateway.startDeploy).not.toHaveBeenCalled();
  });
  it("action replay and repeated start cannot double-start", async () => {
    const a = await exec("deploy.apply", {}, ctx, "bridge-replay");
    const b = await exec("deploy.apply", {}, ctx, "bridge-replay"); expect(a).toEqual(b);
    await Promise.all([beginWorkflow(ctx, latest()), beginWorkflow(ctx, latest())]);
    expect(gateway.startDeploy).toHaveBeenCalledTimes(1); expect(db().deployments).toHaveLength(1);
  });
  it("concurrent starts of a parked approved operation share exactly one claim and workflow", async () => {
    q.environment(ctx.environmentId!)!.policies.approvalRequired = true;
    await exec("deploy.apply"); const begin = vi.spyOn(broker, "beginExecution");
    const result = await Promise.all([beginWorkflow(ctx, latest()), beginWorkflow(ctx, latest())]);
    expect(result.every((r) => r.ok)).toBe(true); expect(begin).toHaveBeenCalledTimes(1); expect(gateway.startDeploy).toHaveBeenCalledTimes(1);
  });
});

describe("approval and cancellation", () => {
  it("product approval policy parks even when broker allows, then browser starts", async () => {
    q.environment(ctx.environmentId!)!.policies.approvalRequired = true;
    await exec("deploy.apply"); const d = latest(); expect(d.status).toBe("awaiting_approval"); expect(gateway.startDeploy).not.toHaveBeenCalled();
    browser(); const p = await plan("deploy.approve", { deploymentId: d.id }, browserCtx); expect(p.details.join(" ")).toMatch(/digest.*[a-f0-9]/); expect(p.details.join(" ")).toContain("real change");
    expect((await exec("deploy.approve", { deploymentId: d.id }, browserCtx)).ok).toBe(true); expect(gateway.startDeploy).toHaveBeenCalledTimes(1); expect(d.workflowStartedAt).toBeTruthy();
  });
  it("browser approval uses the real broker before startup", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1, "admin", true))); await exec("deploy.apply");
    const approve = vi.spyOn(broker, "approve"); browser();
    expect((await exec("deploy.approve", { deploymentId: latest().id }, browserCtx)).ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1); expect((await h.store.listApprovals(ctx.workspaceId, latest().operationId!))[0].consumedAt).toBeTruthy(); expect(gateway.startDeploy).toHaveBeenCalledTimes(1);
  });
  it("product approval forwards the browser's reviewed plan digest without substituting the current digest", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1, "admin", true))); await exec("deploy.apply");
    const approve = vi.spyOn(broker, "approve"); browser();
    const planDigest = "a".repeat(64);
    await exec("deploy.approve", { deploymentId: latest().id, planDigest }, browserCtx);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ planDigest }));
  });
  it("a projected workflow approval gate records approval then signals, never starts twice", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1))); await exec("deploy.apply"); const d = latest();
    // Represents a worker that already started and parked at its plan gate.
    d.workflowStartedAt = new Date().toISOString(); browser();
    expect((await exec("deploy.approve", { deploymentId: d.id }, browserCtx)).ok).toBe(true);
    expect(gateway.signalApproval).toHaveBeenCalledExactlyOnceWith(d.operationId); expect(gateway.startDeploy).not.toHaveBeenCalled();
  });
  it("multiple approvals do not start until the required count", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(2))); await exec("deploy.apply"); const id = latest().id; browser();
    expect((await exec("deploy.approve", { deploymentId: id }, browserCtx)).summary).toContain("1/2"); expect(gateway.startDeploy).not.toHaveBeenCalled();
    expect((await exec("deploy.approve", { deploymentId: id })).ok).toBe(true); expect(gateway.startDeploy).toHaveBeenCalledTimes(1);
  });
  it.each(["outside_request", "navigator", "integration"])("refuses %s approvals with no broker write", async (kind) => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1))); await exec("deploy.apply"); const approve = vi.spyOn(broker, "approve");
    let c = ctx;
    if (kind === "navigator") c = { ...ctx, actor: { ...ctx.actor, type: "navigator" }, autonomy: "autonomous" };
    if (kind === "integration") c = { ...ctx, integration: { operationId: "test", proposalDigest: "test", clientId: "test" } };
    const r = await exec("deploy.approve", { deploymentId: latest().id }, c);
    expect(r.ok).toBe(false); expect(approve).not.toHaveBeenCalled(); expect(gateway.startDeploy).not.toHaveBeenCalled();
    if (kind !== "navigator") expect(r.error).toMatch(/browser session/);
  });
  it("production requester cannot approve while another admin exists", async () => {
    q.environment(ctx.environmentId!)!.class = "production"; q.environment(ctx.environmentId!)!.policies.approvalRequired = true;
    await exec("deploy.apply"); browser(); const approve = vi.spyOn(broker, "approve");
    expect((await exec("deploy.approve", { deploymentId: latest().id })).error).toContain("second person"); expect(approve).not.toHaveBeenCalled(); expect(gateway.startDeploy).not.toHaveBeenCalled();
  });
  it("bridge itself refuses agents even when a test injects a browser-proof factory", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1))); await exec("deploy.apply"); browser(); const approve = vi.spyOn(broker, "approve");
    expect((await approveWorkflowDeployment({ ...ctx, actor: { ...ctx.actor, type: "navigator" } }, latest())).ok).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });
  it("expired proposals refuse approval without starting a workflow", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1))); await exec("deploy.apply"); browser(); h.clock.advance(25 * 60 * 60 * 1000);
    const r = await exec("deploy.approve", { deploymentId: latest().id }, browserCtx); expect(r.ok).toBe(false); expect(r.error).toMatch(/expired/); expect(gateway.startDeploy).not.toHaveBeenCalled();
  });
  it("maps broker separation failure without startup", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1, "admin", true))); await exec("deploy.apply"); browser();
    expect((await exec("deploy.approve", { deploymentId: latest().id })).error).toMatch(/request|separat/i); expect(gateway.startDeploy).not.toHaveBeenCalled();
  });
  it("pre-start cancellation settles both records, skips steps and releases a matching product lease", async () => {
    h.setEngine(scriptedEngine("approval", () => requireApproval(1))); await exec("deploy.apply"); const d = latest(); q.environment(d.environmentId)!.activeDeploymentId = d.id;
    expect((await exec("deploy.cancel", { deploymentId: d.id })).ok).toBe(true);
    expect(d.status).toBe("cancelled"); expect(d.endedAt).toBeTruthy(); expect(d.steps.every((s) => s.status === "skipped")).toBe(true); expect(q.environment(d.environmentId)!.activeDeploymentId).toBeUndefined();
    expect((await h.store.getOperation(ctx.workspaceId, d.operationId!))?.status).toBe("cancelled"); expect(gateway.cancelOperation).not.toHaveBeenCalled();
  });
  it("running cancellation signals without claiming a final outcome", async () => {
    await exec("deploy.apply"); const d = latest();
    expect((await exec("deploy.cancel", { deploymentId: d.id })).ok).toBe(true); expect(d.status).toBe("planning"); expect(gateway.cancelOperation).toHaveBeenCalledExactlyOnceWith(d.operationId);
  });
  it("missing cancellation signal is reported honestly", async () => {
    await exec("deploy.apply");
    gateway.cancelOperation.mockResolvedValueOnce({ delivered: false, reason: "not_found" } as never);
    const r = await exec("deploy.cancel", { deploymentId: latest().id }); expect(r.ok).toBe(false); expect(r.data).toMatchObject({ delivered: false, reason: "not_found" }); expect(latest().status).toBe("planning");
  });
});

describe("rollback, failures, tenant and secret boundaries", () => {
  it("rollback proposes deployment.rollback with no rollbackOf or relabelled origin", async () => {
    const propose = vi.spyOn(broker, "propose");
    expect((await exec("deploy.rollback", { toRevisionId: "bridge-r1" })).ok).toBe(true);
    expect(propose.mock.calls[0][0]).toMatchObject({ capability: "deployment.rollback", input: { revisionId: "bridge-r1", deploymentId: latest().id } }); expect(latest()).not.toHaveProperty("rollbackOf"); expect(latest().changeSummary).toBe("Roll back to r1");
  });
  it("promotion delegates to the same brokered saved-revision path", async () => {
    const to = q.environment(ctx.environmentId!)!; db().environments.push({ ...to, id: "bridge-source", deployedRevisionId: "bridge-r1" }); const propose = vi.spyOn(broker, "propose");
    expect((await exec("deploy.promote", { environmentId: to.id, sourceEnvironmentId: "bridge-source", revisionId: "bridge-r1" })).ok).toBe(true); expect(propose.mock.calls[0][0]).toMatchObject({ capability: "deployment.rollback" });
  });
  it("stateful deletion still blocks apply, rollback and promotion before broker writes", async () => {
    const live = manifest(); live.resources.push({ id: "db", name: "main", kind: "postgres", config: {}, size: "small", ownership: "managed" });
    db().revisions.push({ ...db().revisions[0], id: "bridge-live", number: 2, manifest: live }); q.environment(ctx.environmentId!)!.deployedRevisionId = "bridge-live";
    const propose = vi.spyOn(broker, "propose");
    for (const action of ["deploy.apply", "deploy.rollback"]) expect((await exec(action, action === "deploy.rollback" ? { toRevisionId: "bridge-r1" } : {})).error).toContain("destroys the data");
    db().environments.push({ ...q.environment(ctx.environmentId!)!, id: "bridge-source", deployedRevisionId: "bridge-r1" });
    expect((await exec("deploy.promote", { environmentId: ctx.environmentId, sourceEnvironmentId: "bridge-source", revisionId: "bridge-r1" })).error).toContain("destroys the data"); expect(propose).not.toHaveBeenCalled();
  });
  it.each([false, true])("startup failure settles the operation (ambiguous timeout=%s) without leaking transport errors", async (timeout) => {
    const error = new Error(timeout ? "starting CANARY timed out" : "CANARY-private-value"); if (timeout) error.name = "TemporalUnavailableError";
    gateway.startDeploy.mockRejectedValueOnce(error);
    const r = await exec("deploy.apply"); expect(r.ok).toBe(false); expect(latest().status).toBe("failed"); expect(JSON.stringify(r)).not.toContain("CANARY");
    expect((await h.store.getOperation(ctx.workspaceId, latest().operationId!))?.status).toBe(timeout ? "uncertain" : "failed");
  });
  it("foreign workspace deployment ids behave as missing", async () => {
    await exec("deploy.apply"); const id = latest().id; const foreign = { ...ctx, workspaceId: "foreign" };
    for (const action of ["deploy.approve", "deploy.cancel"]) {
      const a = await exec(action, { deploymentId: id }, foreign); const b = await exec(action, { deploymentId: "missing" }, foreign); expect(a.error?.replace(id, "missing")).toBe(b.error); expect(a.error).toContain("does not exist"); expect(a.ok).toBe(false);
    }
  });
  it("compact grants stay out of deployments, events, audit and action results", async () => {
    const begin = vi.spyOn(broker, "beginExecution"); const r = await exec("deploy.apply"); const claimed = await begin.mock.results[0].value;
    const visible = JSON.stringify({ deployment: latest(), events: readEvents(latest().id), audit: readAudit(), result: r });
    expect(visible).not.toContain(claimed.grant); expect(visible).not.toContain(h.signerEnv.ZENITH_CONTROL_SIGNING_JWK);
  });
});
