/** Intercepts Temporal transport; these are payload tests, not real history. */
import type { Client } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { InvalidWorkflowInputError, startDayTwo, startDeploy, startReconcile, startRemediation } from "@/lib/workflows/client";
import { assertNoCanaries, canarySecret } from "../_support/security";

const input = () => ({
  operationId: "op-1", workspaceId: "ws-1", projectId: "project-1", environmentId: "env-1",
  revisionId: "revision-1", deploymentId: "deployment-1", connectionId: "connection-1",
  preApproved: false, build: true, capability: "workload.restart", incidentId: "incident-1", allowAutoRepair: false,
});
const surfaces = [
  { name: "deploy", start: startDeploy, fields: ["operationId", "workspaceId", "projectId", "environmentId", "revisionId", "deploymentId", "connectionId", "preApproved", "build"] },
  { name: "day-two", start: startDayTwo, fields: ["operationId", "workspaceId", "environmentId", "capability"] },
  { name: "remediation", start: startRemediation, fields: ["operationId", "workspaceId", "environmentId", "incidentId"] },
  { name: "reconcile", start: startReconcile, fields: ["workspaceId", "environmentId", "allowAutoRepair"] },
];

function transport() {
  const start = vi.fn(async (_type: string, _options: { args: unknown[] }) => ({ firstExecutionRunId: "synthetic" }));
  return { start, client: { workflow: { start } } as unknown as Client };
}

for (const surface of surfaces) {
  describe(`${surface.name} payload boundary`, () => {
    it("copies only this surface's fields and ignores serialization hooks and cyclic extras", async () => {
      const h = transport();
      const secret = canarySecret(`workflow-${surface.name}`, "password");
      const toJSON = vi.fn(() => ({ nodes: [{ spec: secret }] }));
      const request = { ...input(), nodes: [{ spec: secret }], note: secret, toJSON };
      Object.assign(request, { cycle: request });
      Object.defineProperty(request, "credentials", { enumerable: true, get: () => { throw new Error("extras must not be read"); } });
      await surface.start(request, { client: h.client });
      expect(h.start).toHaveBeenCalledOnce();
      const payload = h.start.mock.calls[0][1].args[0];
      expect(payload).toEqual(Object.fromEntries(Object.entries(input()).filter(([key]) => surface.fields.includes(key))));
      expect(payload === request).toBe(false);
      const serialized = JSON.stringify(h.start.mock.calls);
      assertNoCanaries(serialized, [secret], "transport serialization cannot revive discarded runtime fields");
      expect(toJSON).not.toHaveBeenCalled();
    });

    it.each([null, {}, [], { toJSON: () => "ws-1" }, true, 42, "", "x".repeat(129), "bad id"])("rejects invalid workspace ids without transport or value echo (%j)", async (workspaceId) => {
      const h = transport();
      const request = { ...input(), workspaceId } as unknown as ReturnType<typeof input>;
      await expect(surface.start(request, { client: h.client })).rejects.toBeInstanceOf(InvalidWorkflowInputError);
      expect(h.start).not.toHaveBeenCalled();
    });

    it("rejects credential-shaped ids without echoing them in errors", async () => {
      const h = transport();
      const secret = canarySecret(`workflow-id-${surface.name}`, "aws-access-key-id");
      const err = await surface.start({ ...input(), workspaceId: secret }, { client: h.client }).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(InvalidWorkflowInputError);
      assertNoCanaries(String(err), [secret], "validation errors name fields only");
      expect(h.start).not.toHaveBeenCalled();
    });

    it("rejects getter-backed required fields without evaluating them", async () => {
      const h = transport();
      const getter = vi.fn(() => "ws-1");
      const request = input();
      Object.defineProperty(request, "workspaceId", { get: getter });
      await expect(surface.start(request, { client: h.client })).rejects.toBeInstanceOf(InvalidWorkflowInputError);
      expect(getter).not.toHaveBeenCalled();
      expect(h.start).not.toHaveBeenCalled();
    });
  });
}

it("snapshots arguments before caller mutations can affect the async start", async () => {
  const h = transport();
  const request = input();
  const pending = startDeploy(request, { client: h.client });
  request.workspaceId = "changed-workspace";
  request.build = false;
  await pending;
  expect(h.start.mock.calls[0][1].args[0]).toMatchObject({ workspaceId: "ws-1", build: true });
});

it.each(["preApproved", "build", "allowAutoRepair"])("requires a boolean for %s", async (field) => {
  const h = transport();
  const request = { ...input(), [field]: "false" } as unknown as ReturnType<typeof input>;
  const start = field === "allowAutoRepair" ? startReconcile : startDeploy;
  await expect(start(request, { client: h.client })).rejects.toBeInstanceOf(InvalidWorkflowInputError);
  expect(h.start).not.toHaveBeenCalled();
});
