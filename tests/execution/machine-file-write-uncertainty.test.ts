/**
 * Actual MachineService, sealed PGlite persistence, capability activity and
 * deterministic workflow/SQL ledger projection. Transport, policy/grant and
 * Temporal scheduling are fixtures: this is not Linux, signed-agent, browser
 * approval, real PostgreSQL or live Temporal acceptance evidence.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import type { ExecutionActivities } from "@/lib/workflows/types";
import type { MachineDispatchOutcome, MachineRequestDispatcher } from "@/lib/machines/types";
import type { AgentRecord } from "@/lib/runners/ports";
import type { StoredResource } from "@/lib/execution/ports";
import { tempDataDir } from "../_support/data-dir";

const state = vi.hoisted(() => ({ activities: {} as Partial<ExecutionActivities>, options: [] as unknown[] }));
vi.mock("@temporalio/workflow", async () => ({
  ...await import("@temporalio/common"),
  proxyActivities: (options: unknown) => {
    state.options.push(options);
    return new Proxy({}, { get: (_obj, name: keyof ExecutionActivities) => (...args: unknown[]) => {
      const fn = state.activities[name];
      if (!fn) throw new Error("Unexpected fixture activity.");
      return Reflect.apply(fn, state.activities, args);
    } });
  },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: 2 },
  CancellationScope: class {
    static nonCancellable<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
    async run<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
    cancel() {}
  },
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  setHandler: vi.fn(),
  workflowInfo: () => ({ workflowId: "op-op-act-1" }),
  isCancellation: () => false,
  log: { warn: vi.fn() },
  patched: () => false,
  condition: async () => { throw new Error("No approval-wait fixture is configured."); },
}));

tempDataDir("zenith-write-uncertainty-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { createOperationsPort, executionHolder } = await import("@/lib/execution/platform");
const { createMachineEvidenceSink, machineResultSealer } = await import("@/lib/machines/persistence");
const { createZenithdMachineDriver } = await import("@/lib/machines/transports/zenithd");
const { createMachineSessionProvider } = await import("@/lib/machines/sessions");
const { executeMachineOperation } = await import("@/lib/machines/service");
const { MachineOperationError } = await import("@/lib/machines/errors");
const { dayTwoOperationWorkflow } = await import("@/lib/workflows/definitions/dayTwo");
const { ACTIVITY_OPTIONS } = await import("@/lib/workflows/definitions/policies");
const { createWorld, NOW } = await import("./fakes/world");
const { CANARY_GRANT, ENV, OP, PROJECT, WS } = await import("./fakes/fixtures");

let db: Awaited<ReturnType<typeof openPlatformDb>>;
let w: ReturnType<typeof createWorld>;
const args = { path: "/opt/customer/settings.txt", contentRef: "settings", contentVersion: "c".repeat(64), expectedSha256: null };
const token = `fw_${"a".repeat(32)}`;
const unknownReceipt = { error: "mutation_uncertain", phase: "rename", effect: "unknown", postcondition: "unverified", backupRef: token, transactionRef: token };
const committedReceipt = { path: args.path, contentVersion: args.contentVersion, changed: true, created: true, bytesWritten: 24, phase: "verified", effect: "committed", postcondition: "verified", transactionRef: token };

beforeEach(async () => { db = await openPlatformDb({ kind: "pglite" }); });
afterEach(async () => { vi.restoreAllMocks(); w?.dispose(); await db.close(); });

async function harness(outcome: MachineDispatchOutcome, operation: "file.write" | "service.status" = "file.write") {
  const input = operation === "file.write" ? args : { unit: "fixture.service" };
  const proposal = { capability: operation, scope: { workspaceId: WS, projectId: PROJECT, environmentId: ENV, resourceId: "res-machine" }, input, summary: "Scripted machine outcome", details: [], risk: operation === "file.write" ? "high" as const : "low" as const };
  const { operation: approved } = await repos.operations.create(db, { id: OP, workspaceId: WS, principal: { kind: "user", id: "fixture-operator", name: "Fixture operator" }, status: "approved", proposal });
  const running = await repos.operations.claimForExecution(db, { workspaceId: WS, id: OP, expectedDigest: approved.proposalDigest, holder: executionHolder(OP) });
  w = createWorld({ op: running });
  w.deps.ops = createOperationsPort(db);
  const row: StoredResource = { id: "res-machine", workspaceId: WS, environmentId: ENV, address: "compute_instance/host", provider: "aws", nativeType: "aws:ec2_instance", kind: "compute_instance", ownership: "managed", spec: {}, specDigest: "a".repeat(64), status: "active", dependsOn: [], origin: [], labels: {} };
  w.resources.rows.set(row.id, row);
  const binding: AgentRecord = { kind: "machine", id: "mac_fixture", workspaceId: WS, environmentId: ENV, address: row.address, status: "active", stale: false, name: "Fixture host", protocol: "zenith.machine/v1", publicKey: "fixture-public-key", capabilities: [operation], labels: {}, host: {}, registeredAt: NOW };
  const dispatcher = {
    enqueue: vi.fn<MachineRequestDispatcher["enqueue"]>(async () => "mreq_fixture"),
    await: vi.fn<MachineRequestDispatcher["await"]>(async () => outcome),
  };
  const driver = createZenithdMachineDriver({ dispatcher, now: () => Date.parse(NOW) });
  const sealer = machineResultSealer(randomBytes(32).toString("hex"));
  const sink = () => createMachineEvidenceSink(db, sealer);
  const evidence = sink();
  const fallback = vi.fn(async () => null);
  w.deps.machines = { boundMachine: async () => binding, latestObservation: fallback, drivers: { zenithd: driver }, evidence };
  const execute = vi.fn(w.activities.executeCapability);
  const verify = vi.fn(w.activities.verifyApplication);
  state.activities = {
    ...w.activities,
    // Policy and grant admission are explicit fixtures; no human approval is
    // asserted. Exercise the actual capability and terminal projection below.
    evaluatePolicy: async () => ({ outcome: "allow", decisionId: "fixture-policy", reasons: [] }),
    executeCapability: execute,
    verifyApplication: verify,
  };
  const run = () => dayTwoOperationWorkflow({ operationId: OP, workspaceId: WS, environmentId: ENV, capability: operation });
  const replay = async () => {
    const req = dispatcher.enqueue.mock.calls[0][0];
    const { claims, jws } = await w.broker.issueGrant(OP, "machine:mac_fixture");
    return executeMachineOperation(req, { grant: claims, drivers: { zenithd: driver }, sessions: createMachineSessionProvider({ credentials: w.credentials, grantJws: jws }), evidence: sink(), signal: new AbortController().signal, now: () => new Date(NOW) });
  };
  return { dispatcher, evidence, sink, execute, verify, fallback, run, replay };
}

describe("file.write canonical uncertainty projection", () => {
  it("retains an unknown receipt and finalizes the actual workflow and SQL operation uncertain", async () => {
    const h = await harness({ status: "failed", result: unknownReceipt });
    const outcome = await h.run();
    expect(outcome.status).toBe("uncertain");
    expect((await repos.operations.get(db, WS, OP))?.status).toBe("uncertain");
    const activityFailure = await h.execute.mock.results[0].value.catch((e: unknown) => e);
    expect(activityFailure).toBeInstanceOf(ApplicationFailure);
    expect(activityFailure).toMatchObject({ type: "MachineUncertain", nonRetryable: true });
    const records = await repos.evidence.list(db, WS, { operationId: OP });
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.summary.outcome === "dispatching")).toBeDefined();
    const receipt = records.find((r) => r.summary.outcome === "uncertain");
    expect(receipt?.summary).toMatchObject({ ok: false, transportRef: "mreq_fixture", result: unknownReceipt });
    const unexpectedDispatch = vi.fn(async () => { throw new Error("Cached receipt must prevent execution."); });
    const cached = await h.sink().runOnce!(h.dispatcher.enqueue.mock.calls[0][0], unexpectedDispatch);
    expect(cached).toMatchObject({ ok: false, evidenceId: receipt?.id, transportRef: "mreq_fixture", data: unknownReceipt });
    expect(unexpectedDispatch).not.toHaveBeenCalled();
    const cachedError = await h.replay().catch((e: unknown) => e);
    expect(cachedError).toBeInstanceOf(MachineOperationError);
    expect(cachedError).toMatchObject({ code: "uncertain", retryable: false, detail: { result: cached }, transportRef: "mreq_fixture" });
    expect(h.dispatcher.enqueue).toHaveBeenCalledOnce();
    expect(h.dispatcher.enqueue.mock.calls[0][0].target).toMatchObject({ workspaceId: WS, environmentId: ENV, resourceId: "res-machine", targetId: "mac_fixture", transport: "zenithd" });
    expect(h.dispatcher.enqueue.mock.calls[0][1]).toBe(CANARY_GRANT);
    expect(w.broker.grants[0]).toMatchObject({ audience: "machine:mac_fixture", fence: { scope: `env:${ENV}`, fenceToken: 1 } });
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(w.credentials.sessions).toHaveLength(0);
    expect(JSON.stringify({ outcome, records, stored: w.stored() })).not.toContain(CANARY_GRANT);
    expect(ACTIVITY_OPTIONS.executeCapability.retry).toMatchObject({ maximumAttempts: 1 });
    expect(state.options).toContainEqual(ACTIVITY_OPTIONS.executeCapability);
  });

  it("completion-audit failure preserves a permanent dispatch marker and an uncertain, nonreplayable operation", async () => {
    const h = await harness({ status: "succeeded", result: committedReceipt });
    const record = vi.spyOn(h.evidence, "record").mockRejectedValue(new Error("Scripted completion audit outage"));
    const outcome = await h.run();
    expect(outcome.status).toBe("uncertain");
    expect((await repos.operations.get(db, WS, OP))?.status).toBe("uncertain");
    const failure = await h.execute.mock.results[0].value.catch((e: unknown) => e);
    expect(failure).toMatchObject({ type: "MachineUncertain", nonRetryable: true });
    record.mockRestore();
    const error = await h.replay().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MachineOperationError);
    expect(error).toMatchObject({ code: "uncertain", retryable: false });
    const records = await repos.evidence.list(db, WS, { operationId: OP });
    expect(records.filter((r) => r.summary.outcome === "dispatching")).toHaveLength(1);
    expect(h.dispatcher.enqueue).toHaveBeenCalledOnce();
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it("a genuine precommit effect:none refusal remains failed and cached without another dispatch", async () => {
    const receipt = { error: "refused", phase: "guard", effect: "none", postcondition: "unverified" };
    const h = await harness({ status: "rejected", result: receipt });
    expect((await h.run()).status).toBe("failed");
    expect((await repos.operations.get(db, WS, OP))?.status).toBe("failed");
    expect(await h.replay()).toMatchObject({ ok: false, data: receipt });
    const records = await repos.evidence.list(db, WS, { operationId: OP });
    expect(records.find((r) => r.summary.outcome === "failed")?.summary.result).toMatchObject(receipt);
    expect(records.some((r) => r.summary.outcome === "uncertain")).toBe(false);
    expect(h.dispatcher.enqueue).toHaveBeenCalledOnce();
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("keeps an ordinary read-only failure definitive", async () => {
    const h = await harness({ status: "failed", result: { error: "command_failed" } }, "service.status");
    expect((await h.run()).status).toBe("failed");
    expect((await repos.operations.get(db, WS, OP))?.status).toBe("failed");
    expect(await h.replay()).toMatchObject({ ok: false, data: { error: "command_failed" } });
    expect(h.dispatcher.enqueue).toHaveBeenCalledOnce();
    expect(w.events.ofType("resource.applying")).toHaveLength(0);
  });
});
