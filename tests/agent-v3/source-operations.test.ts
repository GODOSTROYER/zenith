import { describe, expect, it, vi } from "vitest";
import { BrokerError } from "@/lib/capabilities/errors";
import { principalFromIdentity } from "@/lib/agent-access/v3/principal";
import { runTool } from "@/lib/agent-access/v3/tools";
import { allowDecision, argsFor, denyDecision, identity, ids, makeHarness, target } from "./support";

const privateFinding = "PRIVATE_SOURCE_FINDING";
const readTools = ["zenith_get_operation", "zenith_get_operation_events"] as const;

async function setup(stage: "coding_agent_manifest" | "coding_agent_source_return") {
  const h = await makeHarness();
  const handoff = await h.ports.sourceContext!.get({ workspaceId: ids.ws, target, runId: "run-a" });
  let operationId: string;
  if (stage === "coding_agent_source_return") {
    const result = await h.invoke("zenith_submit_source_proposal", { ...argsFor("zenith_submit_source_proposal"), expectedDigest: handoff.digest, description: privateFinding });
    expect(result.ok).toBe(true);
    operationId = result.data.operationId as string;
  } else {
    const source = handoff.context.source;
    const result = await h.broker.propose({ capability: "infrastructure.plan", scope: target, idempotencyKey: "source-op-0001",
      input: { operation: "plan", stage, runId: handoff.id, source: { repository: source.repository, commit: source.commit, identity: source.sourceIdentity },
        baseManifestHash: handoff.context.baseManifestHash, description: privateFinding }, reason: "Source analysis for human review." }, h.principal.principal, { via: "rest" });
    operationId = result.operation.id;
  }
  await h.store.appendEvent({ type: "operation.started", workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env,
    operationId, correlationId: operationId, data: { summary: privateFinding } });
  vi.mocked(h.ports.sourceContext!.get).mockClear();
  return { h, operationId, handoff };
}

describe.each(["coding_agent_manifest", "coding_agent_source_return"] as const)("source operation projection: %s", stage => {
  it("keeps generic read grants on ledger metadata without disclosing source or event bodies", async () => {
    const { h, operationId } = await setup(stage);
    const principal = principalFromIdentity(identity({ scopes: ["read"] }));
    for (const name of readTools) {
      const result = await runTool(name, argsFor(name, operationId), { ports: h.ports, principal });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain(privateFinding);
      expect(result.untrusted_data).toBeUndefined();
      expect(result.notes).toContainEqual(expect.stringContaining("export consent"));
    }
    expect(h.ports.sourceContext!.get).not.toHaveBeenCalled();
  });

  it("exports only under live source authority and drops details after source revocation", async () => {
    const { h, operationId } = await setup(stage);
    for (const name of readTools) {
      const result = await h.invoke(name, argsFor(name, operationId));
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).toContain(privateFinding);
    }
    expect(h.authorizeRead).toHaveBeenCalledWith({ capability: "source.context.read", scope: target }, h.principal.principal);
    vi.mocked(h.ports.sourceContext!.get).mockRejectedValue(new BrokerError("policy_denied", "Source revoked."));
    for (const name of readTools) {
      const result = await h.invoke(name, argsFor(name, operationId));
      expect(result.ok).toBe(true);
      expect(result.untrusted_data).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(privateFinding);
    }
  });

  it("rechecks persisted export consent even when the caller presents an older identity", async () => {
    const { h, operationId } = await setup(stage);
    h.world.integrations.get(`${ids.ws}|${ids.integration}`)!.scopes = ["read", "plan", "logs", "write"];
    // This harness normally uses an allow-all fake policy. Model the actual
    // integration-scope rule here and verify its input comes from live grants,
    // not the older identity still held by the caller.
    const sourcePolicyInputs: unknown[] = [];
    h.setDecision(input => {
      if (input.request.capability !== "source.context.read") return allowDecision();
      sourcePolicyInputs.push(input);
      return input.principal.integrationScopes?.includes(input.request.integrationScope ?? "") ? allowDecision() : denyDecision();
    });
    for (const name of readTools) {
      const result = await h.invoke(name, argsFor(name, operationId));
      expect(result.ok).toBe(true);
      expect(result.untrusted_data).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(privateFinding);
    }
    expect(h.ports.sourceContext!.get).not.toHaveBeenCalled();
    expect(sourcePolicyInputs).toHaveLength(2);
    for (const input of sourcePolicyInputs) expect(input).toMatchObject({ request: { integrationScope: "export" }, principal: { integrationScopes: ["read", "plan", "logs", "write"] } });
  });

  it("refuses private projections when the retained proposal is for a different base or source", async () => {
    const { h, operationId, handoff } = await setup(stage);
    for (const context of [
      { ...handoff.context, baseManifestHash: "f".repeat(64) },
      { ...handoff.context, source: { ...handoff.context.source, commit: "f".repeat(40) } },
    ]) {
      vi.mocked(h.ports.sourceContext!.get).mockResolvedValueOnce({ ...handoff, context });
      const result = await h.invoke("zenith_get_operation", argsFor("zenith_get_operation", operationId));
      expect(result.data.sourceDetailsAvailable).toBe(false);
      expect(JSON.stringify(result)).not.toContain(privateFinding);
    }
  });
});

it("a source revoked while a returned proposal is recorded cannot leak through its response", async () => {
  const h = await makeHarness();
  const handoff = await h.ports.sourceContext!.get({ workspaceId: ids.ws, target, runId: "run-a" });
  const original = h.propose.getMockImplementation()!;
  h.propose.mockImplementation(async (...args) => {
    const result = await original(...args);
    vi.mocked(h.ports.sourceContext!.get).mockRejectedValue(new BrokerError("policy_denied", "Source revoked."));
    return result;
  });
  const result = await h.invoke("zenith_submit_source_proposal", { ...argsFor("zenith_submit_source_proposal"), expectedDigest: handoff.digest, description: privateFinding });
  expect(result.ok).toBe(true);
  expect(result.data.sourceDetailsAvailable).toBe(false);
  expect(result.untrusted_data).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(privateFinding);
  expect(result.notes).toContainEqual(expect.stringContaining("export consent"));
});
