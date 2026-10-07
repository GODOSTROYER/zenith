/**
 * Start / resume / adopt (PROD-MACH-06) against the real memory capability
 * broker and the run-store contract: model output only becomes a broker
 * proposal, tenants are isolated, resume re-reads the same commit, and adoption
 * refuses anything but an approved operation naming the stored manifest.
 */
import { describe, expect, it } from "vitest";
import { snapshotFromFiles } from "@/lib/analysis";
import { digest } from "@/lib/controlplane/digest";
import { AdoptionRefused, AGENT_PLAN_STAGE, agentProposalInput, assertAdoptable } from "@/lib/coding-agent/proposal-sink";
import { AgentServiceError, resumeRun, startRun, type AgentCaller, type SourceReader } from "@/lib/coding-agent/service";
import { memoryRunStore } from "@/lib/coding-agent/store";
import { goodAgentScript, scriptedProvider } from "@/lib/coding-agent/eval/scripted";
import type { ProposalArtifact } from "@/lib/coding-agent/types";
import { makeHarness, user } from "../capabilities/support";

const PKG = JSON.stringify({ name: "shop", version: "1.0.0", dependencies: { express: "^4.19.0", pg: "^8.11.0" } });
const FILES = { "package.json": PKG, "server.js": 'const express = require("express");\napp.listen(process.env.PORT || 3000);\n' };
const COMMIT = "b".repeat(40);

function reader(over: { commit?: () => string } = {}): { read: SourceReader; requests: { ref: string }[] } {
  const requests: { ref: string }[] = [];
  const read: SourceReader = async (req, withSource) => {
    requests.push({ ref: req.ref });
    return withSource(snapshotFromFiles(FILES, { source: { kind: "fixture" } }), { repository: req.repository, commit: over.commit?.() ?? COMMIT });
  };
  return { read, requests };
}

describe("start, proposal through the broker, resume", () => {
  it("submits the manifest as an infrastructure.plan proposal built from digests, and executes nothing", async () => {
    const h = await makeHarness({ kind: "memory" });
    const store = memoryRunStore();
    const { read } = reader();
    const provider = scriptedProvider(goodAgentScript());
    const caller: AgentCaller = { workspaceId: h.ids.wsA, userId: "bob", principal: user("bob") };
    const { run, outcome } = await startRun({ store, provider, readSource: read, broker: async () => h.broker }, caller, {
      task: "Propose a staging deployment.",
      source: { repository: "acme/shop", ref: "main" },
      target: { projectId: h.ids.projA, environmentId: h.ids.envAStg },
    });
    expect(outcome.status).toBe("completed");
    expect(run.status).toBe("completed");
    expect(run.model).toBe("claude-sonnet-5-5");
    expect(run.proposalOperationId).toBeTruthy();
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: run.proposalOperationId!, principal: caller.principal });
    const op = detail.operation;
    expect(op.capability).toBe("infrastructure.plan");
    expect(["approved", "awaiting_approval", "denied"]).toContain(op.status);
    expect(op.status).not.toBe("succeeded");
    const artifact = (run.result as { artifact: ProposalArtifact }).artifact;
    expect(op.proposal.input).toEqual(agentProposalInput(artifact, { repository: "acme/shop", commit: COMMIT }, run.id));
    expect(JSON.stringify(op.proposal.input)).not.toContain("Nothing is deployed");
    expect(op.proposal.details.join("\n")).toContain("(unverified text)");
  });

  it("without a target nothing is submitted, and the proposal stays in the run", async () => {
    const store = memoryRunStore();
    const h = await makeHarness({ kind: "memory" });
    const { run } = await startRun({ store, provider: scriptedProvider(goodAgentScript()), readSource: reader().read }, { workspaceId: h.ids.wsA, userId: "bob", principal: user("bob") }, { task: "Propose.", source: { repository: "acme/shop", ref: "main" } });
    expect(run.proposalOperationId).toBeUndefined();
    expect((run.result as { artifact: unknown }).artifact).toBeTruthy();
  });

  it("refuses an unpriced model, a bad repository, an oversized task and a target without a broker", async () => {
    const store = memoryRunStore();
    const deps = { store, provider: scriptedProvider([]), readSource: reader().read };
    const caller: AgentCaller = { workspaceId: "ws_1", userId: "u", principal: user("u") };
    const ok = { task: "t", source: { repository: "acme/shop", ref: "main" } };
    await expect(startRun(deps, caller, { ...ok, model: "gpt-x" })).rejects.toBeInstanceOf(AgentServiceError);
    await expect(startRun(deps, caller, { ...ok, source: { repository: "not a repo", ref: "main" } })).rejects.toThrow(/owner\/name/);
    await expect(startRun(deps, caller, { ...ok, task: "x".repeat(2_001) })).rejects.toThrow(/1 to 2000/);
    await expect(startRun(deps, caller, { ...ok, target: { projectId: "p", environmentId: "e" } })).rejects.toThrow(/broker/);
    await expect(startRun(deps, caller, { ...ok, limits: { toolCalls: 0 } })).rejects.toThrow(/positive integer/);
  });

  it("a budget stop persists a checkpoint; resume re-reads the SAME commit, can raise limits and finishes without repeating work", async () => {
    const store = memoryRunStore();
    const provider = scriptedProvider(goodAgentScript());
    const r = reader();
    const caller: AgentCaller = { workspaceId: "ws_1", userId: "u", principal: user("u") };
    const deps = { store, provider, readSource: r.read };
    const first = await startRun(deps, caller, { task: "Propose.", source: { repository: "acme/shop", ref: "main" }, limits: { toolCalls: 2 } });
    expect(first.run.status).toBe("budget_exhausted");
    expect(first.run.stopReason).toEqual({ kind: "budget", dimension: "toolCalls" });
    expect((first.run.usage as { toolCalls: number }).toolCalls).toBe(2);

    // Lowering a limit is ignored: the run stops again at the same place, without another model call.
    const lowered = await resumeRun(deps, caller, first.run.id, { limits: { toolCalls: 1 } });
    expect(lowered.run.status).toBe("budget_exhausted");
    expect((lowered.run.limits as { toolCalls: number }).toolCalls).toBe(2);
    expect(provider.calls.length).toBe(3);

    // Raising applies, within the platform ceiling.
    const done = await resumeRun(deps, caller, first.run.id, { limits: { toolCalls: 40, spendMicroUsd: 3_000_000 } });
    expect(r.requests.at(-1)?.ref).toBe(COMMIT);
    expect(done.run.status).toBe("completed");
    expect((done.run.limits as { toolCalls: number }).toolCalls).toBe(40);
    expect((done.run.limits as { spendMicroUsd: number }).spendMicroUsd).toBe(3_000_000);
    expect(provider.calls.length).toBe(5);
    // completed runs cannot be resumed again
    await expect(resumeRun(deps, caller, first.run.id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("a source whose commit moved cannot continue a stopped run, and the run stays resumable", async () => {
    const store = memoryRunStore();
    const provider = scriptedProvider(goodAgentScript());
    let commit = COMMIT;
    const deps = { store, provider, readSource: reader({ commit: () => commit }).read };
    const caller: AgentCaller = { workspaceId: "ws_1", userId: "u", principal: user("u") };
    const first = await startRun(deps, caller, { task: "Propose.", source: { repository: "acme/shop", ref: "main" }, limits: { toolCalls: 2 } });
    commit = "c".repeat(40);
    await expect(resumeRun(deps, caller, first.run.id, { limits: { toolCalls: 40 } })).rejects.toMatchObject({ code: "invalid_state" });
    expect((await store.get("ws_1", first.run.id))?.status).toBe("failed");
    commit = COMMIT;
    const again = await resumeRun(deps, caller, first.run.id, { limits: { toolCalls: 40 } });
    expect(again.run.status).toBe("completed");
  });

  it("is tenant scoped: another workspace cannot read or resume a run", async () => {
    const store = memoryRunStore();
    const deps = { store, provider: scriptedProvider(goodAgentScript()), readSource: reader().read };
    const a: AgentCaller = { workspaceId: "ws_a", userId: "a", principal: user("a") };
    const b: AgentCaller = { workspaceId: "ws_b", userId: "b", principal: user("b") };
    const run = (await startRun(deps, a, { task: "Propose.", source: { repository: "acme/shop", ref: "main" }, limits: { toolCalls: 2 } })).run;
    expect(await store.get("ws_b", run.id)).toBeNull();
    expect(await store.list("ws_b")).toEqual([]);
    await expect(resumeRun(deps, b, run.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("a crashed worker's stale running row can be claimed, a fresh one cannot", async () => {
    const store = memoryRunStore();
    const created = await store.create({ id: "car_stale", workspaceId: "ws_a", createdBy: "a", model: "claude-sonnet-5-5", task: "t", source: { repository: "acme/shop", commit: COMMIT }, limits: {}, usage: {}, checkpoint: {} });
    await expect(store.claimResume({ workspaceId: "ws_a", id: created.id, limits: {} })).rejects.toMatchObject({ code: "invalid_state" });
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      const claimed = await store.claimResume({ workspaceId: "ws_a", id: created.id, limits: {} });
      expect(claimed.status).toBe("running");
    } finally {
      Date.now = realNow;
    }
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
