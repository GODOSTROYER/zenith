/**
 * Durable run lifecycle (PROD-MACH-06) against the real memory capability
 * broker and the run-store contract. The control half (create / resume /
 * cancel) only records state and talks to a launcher; the worker half
 * (`executeRunStep`) does one unit of work per call from the stored checkpoint,
 * which is exactly what the Temporal activity runs. Driving the steps in a
 * loop with a FRESH worker per step is the restart test.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromFiles } from "@/lib/analysis";
import { digest } from "@/lib/controlplane/digest";
import { AdoptionRefused, AGENT_PLAN_STAGE, agentProposalInput, assertAdoptable } from "@/lib/coding-agent/proposal-sink";
import { AgentServiceError, cancelRun, createRun, executeRunStep, failRunStep, resumeRun, type AgentCaller, type AgentControlDeps, type AgentWorkerDeps, type RunLauncher, type SourceReader } from "@/lib/coding-agent/service";
import { memoryRunStore, type CodingAgentRunRow } from "@/lib/coding-agent/store";
import { statelessGoodAgent } from "@/lib/coding-agent/eval/scripted";
import type { ModelProvider, ProposalArtifact } from "@/lib/coding-agent/types";
import { makeHarness } from "../capabilities/support";

const PKG = JSON.stringify({ name: "shop", version: "1.0.0", dependencies: { express: "^4.19.0", pg: "^8.11.0" } });
const FILES = { "package.json": PKG, "server.js": 'const express = require("express");\napp.listen(process.env.PORT || 3000);\n' };
const COMMIT = "b".repeat(40);

function world(options: { launchFails?: boolean } = {}) {
  const store = memoryRunStore();
  const starts: { runId: string; workflowId: string; workspaceId: string }[] = [];
  const cancels: string[] = [];
  let commit = COMMIT;
  const launcher: RunLauncher = {
    async start(i) {
      if (options.launchFails) throw new Error("temporal down");
      starts.push(i);
    },
    async cancel(id) {
      cancels.push(id);
    },
  };
  const control: AgentControlDeps = { store, launcher, resolveSource: async (req) => ({ repository: req.repository, commit }) };
  const read: SourceReader = async (req, withSource) => withSource(snapshotFromFiles(FILES, { source: { kind: "fixture" } }), { repository: req.repository, commit });
  /** A fresh worker: new provider instance, nothing remembered from earlier steps. */
  const worker = (over: Partial<Omit<AgentWorkerDeps, "provider">> & { provider?: ModelProvider } = {}): AgentWorkerDeps => {
    const provider = over.provider ?? statelessGoodAgent();
    const { provider: _ignored, ...rest } = over;
    void _ignored;
    return { store, provider: () => provider, readSource: read, ...rest };
  };
  return { store, starts, cancels, control, worker, setCommit: (c: string) => void (commit = c) };
}

async function drive(deps: () => AgentWorkerDeps, row: Pick<CodingAgentRunRow, "id" | "workspaceId">, max = 40): Promise<{ status: string; steps: number }> {
  for (let i = 1; i <= max; i++) {
    const { status } = await executeRunStep(deps(), { workspaceId: row.workspaceId, runId: row.id });
    if (status !== "running") return { status, steps: i };
  }
  throw new Error("run did not settle");
}

const caller = (workspaceId = "ws_1"): AgentCaller => ({ workspaceId, userId: "bob" });
const REQ = { task: "Propose a staging deployment.", source: { repository: "acme/shop", ref: "main" } };

describe("control: create, resume, cancel", () => {
  it("create only pins the commit, records the run and starts the workflow: no model or repository work, returns at once", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    expect(row).toMatchObject({ status: "running", model: "claude-sonnet-5-5", source: { repository: "acme/shop", commit: COMMIT }, workflowId: `car-${row.id}` });
    expect(w.starts).toEqual([{ runId: row.id, workspaceId: "ws_1", workflowId: `car-${row.id}` }]);
    expect((row.checkpoint as { messages: unknown[]; steps: number })).toMatchObject({ messages: [], steps: 0 });
    // The control deps have no model provider at all: the web side cannot run the agent.
    expect(Object.keys(w.control).sort()).toEqual(["launcher", "resolveSource", "store"]);
  });

  it("refuses an unpriced model, a bad repository, an oversized task and bad limits before anything is recorded", async () => {
    const w = world();
    await expect(createRun(w.control, caller(), { ...REQ, model: "gpt-x" })).rejects.toBeInstanceOf(AgentServiceError);
    await expect(createRun(w.control, caller(), { ...REQ, source: { repository: "not a repo", ref: "main" } })).rejects.toThrow(/owner\/name/);
    await expect(createRun(w.control, caller(), { ...REQ, task: "x".repeat(2_001) })).rejects.toThrow(/1 to 2000/);
    await expect(createRun(w.control, caller(), { ...REQ, limits: { toolCalls: 0 } })).rejects.toThrow(/positive integer/);
    expect(await w.store.list("ws_1")).toEqual([]);
    expect(w.starts).toEqual([]);
  });

  it("an unreachable workflow engine leaves a recorded, failed, resumable run and a clear refusal", async () => {
    const w = world({ launchFails: true });
    await expect(createRun(w.control, caller(), REQ)).rejects.toMatchObject({ code: "unavailable" });
    const [row] = await w.store.list("ws_1");
    expect(row.status).toBe("failed");
    expect(row.stopReason).toEqual({ kind: "provider_error", detail: "scheduler_unavailable" });
  });

  it("resume claims a stopped run with a NEW workflow id; limits only go up; a finished run cannot resume", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), { ...REQ, limits: { toolCalls: 2 } });
    expect((await drive(() => w.worker(), row)).status).toBe("budget_exhausted");

    const lowered = await resumeRun(w.control, caller(), row.id, { limits: { toolCalls: 1 } });
    expect((lowered.limits as { toolCalls: number }).toolCalls).toBe(2);
    expect(lowered.workflowId).not.toBe(row.workflowId);
    expect(w.starts.at(-1)?.workflowId).toBe(lowered.workflowId);
    // still the same ceiling: stops again, without another model turn
    const calls = (await w.store.get("ws_1", row.id))!.checkpoint as { steps: number };
    expect((await drive(() => w.worker(), row)).status).toBe("budget_exhausted");
    expect(((await w.store.get("ws_1", row.id))!.checkpoint as { steps: number }).steps).toBe(calls.steps);

    const raised = await resumeRun(w.control, caller(), row.id, { limits: { toolCalls: 40, spendMicroUsd: 3_000_000 } });
    expect(raised.limits).toMatchObject({ toolCalls: 40, spendMicroUsd: 3_000_000 });
    expect((await drive(() => w.worker(), row)).status).toBe("completed");
    await expect(resumeRun(w.control, caller(), row.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("a failed resume launch puts the run back to failed so it can be resumed again", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), { ...REQ, limits: { toolCalls: 2 } });
    await drive(() => w.worker(), row);
    const broken: AgentControlDeps = { ...w.control, launcher: { start: async () => { throw new Error("down"); }, cancel: async () => undefined } };
    await expect(resumeRun(broken, caller(), row.id, { limits: { toolCalls: 40 } })).rejects.toMatchObject({ code: "unavailable" });
    expect((await w.store.get("ws_1", row.id))?.status).toBe("failed");
    await resumeRun(w.control, caller(), row.id, { limits: { toolCalls: 40 } });
    expect((await drive(() => w.worker(), row)).status).toBe("completed");
  });

  it("cancel makes the row terminal, asks the workflow to cancel, and the worker stops without another model call", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    await executeRunStep(w.worker(), { workspaceId: "ws_1", runId: row.id });
    const cancelled = await cancelRun(w.control, caller(), row.id);
    expect(cancelled.status).toBe("cancelled");
    expect(w.cancels).toEqual([row.workflowId]);
    const provider = statelessGoodAgent();
    expect(await executeRunStep(w.worker({ provider }), { workspaceId: "ws_1", runId: row.id })).toEqual({ status: "cancelled" });
    expect(provider.calls).toHaveLength(0);
    await expect(cancelRun(w.control, caller(), row.id)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(resumeRun(w.control, caller(), row.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("a cancel that lands DURING a step stops the loop at its next checkpoint write and runs nothing more", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    const inner = statelessGoodAgent();
    const provider: ModelProvider = {
      id: "scripted",
      async complete(req) {
        const out = await inner.complete(req);
        await cancelRun(w.control, caller(), row.id); // the operator cancels while the model call is in flight
        return out;
      },
    };
    const result = await executeRunStep(w.worker({ provider }), { workspaceId: "ws_1", runId: row.id });
    expect(result.status).toBe("cancelled");
    expect(inner.calls).toHaveLength(1);
    expect((await w.store.get("ws_1", row.id))?.status).toBe("cancelled");
  });

  it("an aborted activity signal stops the step: the loop persists a cancelled run", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    const controller = new AbortController();
    controller.abort();
    const provider = statelessGoodAgent();
    const result = await executeRunStep(w.worker({ provider }), { workspaceId: "ws_1", runId: row.id, signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(provider.calls).toHaveLength(0);
  });

  it("is tenant scoped: another workspace cannot read, resume, cancel or step a run", async () => {
    const w = world();
    const row = await createRun(w.control, caller("ws_a"), { ...REQ, limits: { toolCalls: 2 } });
    await drive(() => w.worker(), row);
    expect(await w.store.get("ws_b", row.id)).toBeNull();
    expect(await w.store.list("ws_b")).toEqual([]);
    await expect(resumeRun(w.control, caller("ws_b"), row.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(cancelRun(w.control, caller("ws_b"), row.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(executeRunStep(w.worker(), { workspaceId: "ws_b", runId: row.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a crashed worker's stale running row can be resumed, a fresh one cannot", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    await expect(resumeRun(w.control, caller(), row.id)).rejects.toMatchObject({ code: "invalid_state" });
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      const claimed = await resumeRun(w.control, caller(), row.id);
      expect(claimed.status).toBe("running");
      expect(claimed.workflowId).not.toBe(row.workflowId);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("worker: durable steps from the stored checkpoint", () => {
  it("one step is one unit of work and is persisted; a brand-new worker finishes the run from the stored checkpoint (restart)", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    const first = statelessGoodAgent();
    const a = await executeRunStep(w.worker({ provider: first }), { workspaceId: "ws_1", runId: row.id });
    expect(a.status).toBe("running");
    expect(first.calls).toHaveLength(1);
    const stored = (await w.store.get("ws_1", row.id))!;
    expect((stored.checkpoint as { steps: number }).steps).toBe(1);
    expect(stored.status).toBe("running");

    // "Worker restart": every later step runs on a new worker with a new provider and nothing in memory.
    const providers: ReturnType<typeof statelessGoodAgent>[] = [];
    const settled = await drive(() => { const p = statelessGoodAgent(); providers.push(p); return w.worker({ provider: p }); }, row);
    expect(settled.status).toBe("completed");
    expect(first.calls.length + providers.reduce((n, p) => n + p.calls.length, 0)).toBe(5);
    const done = (await w.store.get("ws_1", row.id))!;
    expect((done.checkpoint as { toolHistogram: Record<string, number> }).toolHistogram).toEqual({ list_files: 1, read_file: 1, analyze_repository: 1, propose_manifest: 1 });
    expect((done.result as { artifact: ProposalArtifact }).artifact.manifestDigest).toBeTruthy();
  });

  it("a completed run with a target stores the broker proposal in the SAME write that completes it; execution never starts", async () => {
    const h = await makeHarness({ kind: "memory" });
    const w = world();
    const row = await createRun(w.control, caller(h.ids.wsA), { ...REQ, target: { projectId: h.ids.projA, environmentId: h.ids.envAStg } });
    await drive(() => w.worker({ broker: async () => h.broker }), row);
    const run = (await w.store.get(h.ids.wsA, row.id))!;
    expect(run.status).toBe("completed");
    expect(run.proposalOperationId).toBeTruthy();
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: run.proposalOperationId!, principal: { kind: "user", id: "bob", name: "bob" } });
    expect(detail.operation.capability).toBe("infrastructure.plan");
    expect(["approved", "awaiting_approval", "denied"]).toContain(detail.operation.status);
    const artifact = (run.result as { artifact: ProposalArtifact }).artifact;
    expect(detail.operation.proposal.input).toEqual(agentProposalInput(artifact, { repository: "acme/shop", commit: COMMIT }, run.id));
    expect(detail.operation.proposal.details.join("\n")).toContain("(unverified text)");
  });

  it("without a target nothing is submitted and the proposal stays in the run", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    await drive(() => w.worker(), row);
    const run = (await w.store.get("ws_1", row.id))!;
    expect(run.proposalOperationId).toBeUndefined();
    expect((run.result as { artifact: unknown }).artifact).toBeTruthy();
  });

  it("a budget stop is persisted as budget_exhausted with the reason, and the pending call survives for the resume", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), { ...REQ, limits: { toolCalls: 2 } });
    expect((await drive(() => w.worker(), row)).status).toBe("budget_exhausted");
    const stored = (await w.store.get("ws_1", row.id))!;
    expect(stored.stopReason).toEqual({ kind: "budget", dimension: "toolCalls" });
    expect((stored.usage as { toolCalls: number }).toolCalls).toBe(2);
  });

  it("a source whose commit moved cannot continue a run, and the run stays resumable at the original commit", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    await executeRunStep(w.worker(), { workspaceId: "ws_1", runId: row.id });
    w.setCommit("c".repeat(40));
    expect(await executeRunStep(w.worker(), { workspaceId: "ws_1", runId: row.id })).toEqual({ status: "failed" });
    expect((await w.store.get("ws_1", row.id))?.stopReason).toEqual({ kind: "provider_error", detail: "source_commit_moved" });
    w.setCommit(COMMIT);
    await resumeRun(w.control, caller(), row.id);
    expect((await drive(() => w.worker(), row)).status).toBe("completed");
  });

  it("failRunStep leaves a still-running row failed and resumable, and reports a finished row unchanged", async () => {
    const w = world();
    const row = await createRun(w.control, caller(), REQ);
    expect(await failRunStep({ store: w.store }, "ws_1", row.id, "step_failed")).toEqual({ status: "failed" });
    expect((await w.store.get("ws_1", row.id))?.stopReason).toEqual({ kind: "provider_error", detail: "step_failed" });
    await cancelRun(w.control, caller(), row.id);
    expect(await failRunStep({ store: w.store }, "ws_1", row.id, "late")).toEqual({ status: "cancelled" });
  });
});

describe("adoption gate", () => {
  const artifact: ProposalArtifact = { manifest: { services: [], resources: [] }, manifestDigest: digest({ services: [], resources: [] }), requirementsDigest: "r".repeat(64), explanations: [], unresolved: [], confidence: "high", environmentClass: "staging" };
  const run = { id: "car_1", status: "completed", result: { artifact }, proposalOperationId: "op_1" };
  const op = (over: Record<string, unknown> = {}) =>
    ({ id: "op_1", capability: "infrastructure.plan", status: "approved", proposal: { input: { operation: "plan", stage: AGENT_PLAN_STAGE, runId: "car_1", manifestDigest: artifact.manifestDigest } }, ...over }) as Parameters<typeof assertAdoptable>[1];

  it("accepts only an approved operation of this run naming the stored manifest", () => {
    expect(assertAdoptable(run, op())).toBe(artifact);
  });

  it.each([
    ["not completed", { ...run, status: "budget_exhausted" }, op(), "not_completed"],
    ["no artifact", { ...run, result: {} }, op(), "no_proposal"],
    ["no operation link", { ...run, proposalOperationId: null }, op(), "no_proposal"],
    ["awaiting approval", run, op({ status: "awaiting_approval" }), "not_approved"],
    ["denied", run, op({ status: "denied" }), "not_approved"],
    ["a different operation", run, op({ id: "op_2" }), "wrong_operation"],
    ["a different capability", run, op({ capability: "infrastructure.apply" }), "wrong_operation"],
    ["another run's proposal", run, op({ proposal: { input: { stage: AGENT_PLAN_STAGE, runId: "car_2", manifestDigest: artifact.manifestDigest } } }), "digest_mismatch"],
    ["a different manifest digest", run, op({ proposal: { input: { stage: AGENT_PLAN_STAGE, runId: "car_1", manifestDigest: "d".repeat(64) } } }), "digest_mismatch"],
  ])("refuses %s", (_label, r, o, code) => {
    expect(() => assertAdoptable(r as typeof run, o)).toThrow(AdoptionRefused);
    try {
      assertAdoptable(r as typeof run, o);
    } catch (e) {
      expect((e as AdoptionRefused).code).toBe(code);
    }
  });

  it("refuses a stored manifest that no longer matches its own digest", () => {
    const tampered = { ...run, result: { artifact: { ...artifact, manifest: { services: [{ name: "pwn" }], resources: [] } } } };
    expect(() => assertAdoptable(tampered, op())).toThrow(AdoptionRefused);
  });
});
