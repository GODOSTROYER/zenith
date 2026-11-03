import { describe, expect, it, vi } from "vitest";
import { BrokerError } from "@/lib/capabilities/errors";
import { catalogFor } from "@/lib/agent-access/v3/catalog";
import { principalFromIdentity } from "@/lib/agent-access/v3/principal";
import { runTool } from "@/lib/agent-access/v3/tools";
import { allowDecision, argsFor, denyDecision, identity, ids, makeHarness, target } from "./support";

describe("source context consent and authority", () => {
  it("keeps repository context out of generic read grants and requires both export and plan for returns", async () => {
    expect(catalogFor(["read"]).map(t => t.name)).not.toContain("zenith_get_handoff");
    expect(catalogFor(["read", "export"]).map(t => t.name)).toContain("zenith_get_handoff");
    for (const scopes of [["read", "plan"], ["read", "export"]]) {
      expect(catalogFor(scopes).map(t => t.name)).not.toContain("zenith_submit_source_proposal");
      const h = await makeHarness();
      expect((await runTool("zenith_submit_source_proposal", argsFor("zenith_submit_source_proposal"), { ports: h.ports, principal: principalFromIdentity(identity({ scopes })) })).error?.code).toBe("insufficient_scope");
      expect(h.authorizeRead).not.toHaveBeenCalled();
      expect(h.ports.sourceContext?.get).not.toHaveBeenCalled();
    }
    expect(catalogFor(["read", "export", "plan"]).map(t => t.name)).toContain("zenith_submit_source_proposal");
  });
  it("uses the exact source capability before source retrieval and puts findings under untrusted_data", async () => {
    const h = await makeHarness();
    const result = await h.invoke("zenith_get_handoff", argsFor("zenith_get_handoff"));
    expect(result.ok).toBe(true);
    expect(h.authorizeRead).toHaveBeenCalledWith({ capability: "source.context.read", scope: target }, expect.objectContaining({ kind: "integration" }));
    expect(h.trace[0]).toBe("authorizeRead");
    expect(result.untrusted_data?.content.context).toMatchObject({ source: { commit: "a".repeat(40) } });
    expect(result.data).not.toHaveProperty("task");
    expect(result.data).not.toHaveProperty("markdown");
  });
  it("fails closed when the source grant is revoked or a cached adapter returns another project", async () => {
    const h = await makeHarness();
    vi.mocked(h.ports.sourceContext!.get).mockRejectedValueOnce(new BrokerError("policy_denied", "Source revoked."));
    expect((await h.invoke("zenith_get_handoff", argsFor("zenith_get_handoff"))).error?.code).toBe("policy_denied");
    const stored = await h.ports.sourceContext!.get({ workspaceId: ids.ws, target, runId: "run-a" });
    stored.context.target!.projectId = "other";
    vi.mocked(h.ports.sourceContext!.get).mockResolvedValueOnce(stored);
    expect((await h.invoke("zenith_get_handoff", argsFor("zenith_get_handoff"))).error?.code).toBe("not_found");
  });
  it("refuses an export when consent is revoked during the GitHub-backed context read", async () => {
    const h = await makeHarness(input => input.request.capability === "source.context.read" && !input.principal.integrationScopes?.includes("export") ? denyDecision() : allowDecision());
    const read = vi.mocked(h.ports.sourceContext!.get);
    const original = read.getMockImplementation()!;
    read.mockImplementation(async request => {
      const handoff = await original(request);
      h.world.integrations.get(`${ids.ws}|${ids.integration}`)!.scopes = ["read", "plan"];
      return handoff;
    });
    const result = await h.invoke("zenith_get_handoff", argsFor("zenith_get_handoff"));
    expect(result.error?.code).toBe("policy_denied");
    expect(result.untrusted_data?.content).not.toHaveProperty("context");
    expect(result.untrusted_data?.content).not.toHaveProperty("markdown");
    expect(JSON.stringify(result)).not.toContain("Analysis summary");
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.authorizeRead.mock.calls.filter(([request]) => (request as { capability?: string }).capability === "source.context.read")).toHaveLength(2);
  });
});

describe("returned source proposals", () => {
  async function setup() {
    const h = await makeHarness();
    const handoff = await h.ports.sourceContext!.get({ workspaceId: ids.ws, target, runId: "run-a" });
    const args = { ...argsFor("zenith_submit_source_proposal"), expectedDigest: handoff.digest };
    return { h, args };
  }
  it("records a bounded review proposal without executing, applying or spending a model budget", async () => {
    const { h, args } = await setup();
    const first = await h.invoke("zenith_submit_source_proposal", args);
    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({ capability: "infrastructure.plan", executed: false });
    const op = await h.store.getOperation(ids.ws, first.data.operationId as string);
    expect(op?.proposal.input).toMatchObject({ stage: "coding_agent_source_return", baseCommit: "a".repeat(40), result: { kind: "commit", newCommit: "c".repeat(40) } });
    const retry = await h.invoke("zenith_submit_source_proposal", args);
    expect(retry.data).toMatchObject({ operationId: first.data.operationId, replayed: true });
    expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.ports.workflows.startDeploy).not.toHaveBeenCalled();
    const execute = await h.invoke("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", first.data.operationId as string, first.data.proposalDigest as string));
    expect(execute.error?.code).toBe("not_executable");
  });
  it("rejects wrong base commit, stale handoff and paths escaping the repository before proposal persistence", async () => {
    const { h, args } = await setup();
    expect((await h.invoke("zenith_submit_source_proposal", { ...args, baseCommit: "e".repeat(40) })).error?.code).toBe("source_mismatch");
    expect((await h.invoke("zenith_submit_source_proposal", { ...args, expectedDigest: "f".repeat(64) })).error?.code).toBe("source_mismatch");
    for (const path of ["../secrets", "/tmp/file", "apps/../../file"]) {
      expect((await h.invoke("zenith_submit_source_proposal", { ...args, changedFiles: [{ path, change: "modified" }] })).error?.code).toBe("invalid_input");
    }
    expect(h.propose).not.toHaveBeenCalled();
  });
  it("denies a revoked integration or removed source before storing a return", async () => {
    const { h, args } = await setup();
    h.world.integrations.delete(`${ids.ws}|${ids.integration}`);
    expect((await h.invoke("zenith_submit_source_proposal", args)).ok).toBe(false);
    expect(h.propose).not.toHaveBeenCalled();
    const next = await setup();
    vi.mocked(next.h.ports.sourceContext!.get).mockRejectedValue(new BrokerError("policy_denied", "Source revoked."));
    expect((await next.h.invoke("zenith_submit_source_proposal", next.args)).error?.code).toBe("policy_denied");
    expect(next.h.propose).not.toHaveBeenCalled();
  });
});
