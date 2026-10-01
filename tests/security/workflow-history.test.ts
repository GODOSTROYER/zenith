/**
 * Temporal payload boundary (ADR-0009). Default tests intercept the real client
 * start functions before transport; they are not history/runtime evidence.
 * ZENITH_SEC_TEMPORAL=1 enables a real isolated Temporal server + real workflows
 * with fake activities. It may need the SDK's test-server download and must
 * stay gated on offline hosts. No port 7233 or Docker is used by the harness.
 * No production payload codec/encryption is configured in config/client/worker.
 */
import type { Client } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { startDayTwo, startDeploy, startReconcile, startRemediation } from "@/lib/workflows/client";
import { WORKFLOW_ID, WORKFLOW_TYPES } from "@/lib/workflows/types";
import { assertNoCanaries, canarySecret, deepScanForCanaries } from "../_support/security";
import { deployInput, serverSuite } from "../workflows/support";

const canary = canarySecret("temporal/spec", "password", { stable: true });
const starts = [
  { name: "deploy", start: startDeploy }, { name: "day-two", start: startDayTwo },
  { name: "remediation", start: startRemediation }, { name: "reconcile", start: startReconcile },
] as const;
function interceptedClient() {
  const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ firstExecutionRunId: "synthetic-run" }));
  return { start, client: { workflow: { start } } as unknown as Client };
}
const input = () => ({ ...deployInput(), capability: "workload.restart", incidentId: "inc-security", allowAutoRepair: false });

for (const surface of starts) {
  describe(`workflow start boundary: ${surface.name}`, () => {
    it("CONTROL: well-typed ids-only input forwards no node specs or secret values", async () => {
      const h = interceptedClient();
      const request = input();
      await surface.start(request, { client: h.client });
      expect(h.start).toHaveBeenCalledOnce();
      expect(h.start.mock.calls[0][1].args).toEqual([request]);
      assertNoCanaries(h.start.mock.calls[0], [canary], "well-typed workflow request contains references only");
    });

    it.fails(`SEC-F12 (MED, caller boundary): ${surface.name} must refuse or omit runtime node specs before serialization`, async () => {
      const h = interceptedClient();
      // TypeScript structural typing cannot protect a deserialized request.
      const request = { ...input(), nodes: [{ spec: { diagnostic: canary } }], inputs: { value: canary } };
      await surface.start(request, { client: h.client });
      assertNoCanaries(h.start.mock.calls, [canary], "workflow starts must not forward secret-bearing extra runtime properties into durable history");
    });
  });
}

describe.skipIf(process.env.ZENITH_SEC_TEMPORAL !== "1")("real Temporal history (opt-in; fake activities)", () => {
  const { scenario } = serverSuite("local");

  scenario("ids/digests-only inputs and fake activity results leave synthetic node specs outside history", async (h) => {
    // A synthetic external node spec is represented by its digest, never sent.
    // This is contract evidence only, not a production desired-state loader.
    const nodeSpec = { diagnostic: canary };
    h.fake.setResult("validateDesiredState", { nodes: 1, graphDigest: digest(nodeSpec), problems: [] });
    const request = deployInput();
    const handle = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(request.operationId), taskQueue: h.taskQueue, args: [request] });
    const result = await h.run(() => handle.result());
    expect(result).toMatchObject({ status: "succeeded" });
    const history = await handle.fetchHistory();
    expect(history.events!.length, "must scan nonempty real server history").toBeGreaterThan(0);
    assertNoCanaries([history, result, h.fake.calls], [canary], "contract-compliant payloads leave node-spec secrets outside Temporal history");
  });

  scenario("SEC-F12 characterization: runtime node-spec extras reach actual durable history", async (h) => {
    const request = { ...deployInput(), nodes: [{ spec: { diagnostic: canary } }] };
    const { handle } = await startDeploy(request, { client: h.client, taskQueue: h.taskQueue });
    const result = await h.run(() => handle.result());
    expect(result).toMatchObject({ status: "succeeded" });
    expect(deepScanForCanaries(await handle.fetchHistory(), [canary]).length, "Temporal serializes the forwarded extras before workflow code can ignore them").toBeGreaterThan(0);
  });
});
