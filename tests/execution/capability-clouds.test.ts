/** Machine target/session integration through execution activities, using fake brokers/transports. */
import { afterEach, describe, expect, it } from "vitest";
import type { AzureSession, CredentialRequest, GcpSession } from "@/lib/credentials/types";
import type { MachineExecutionPort, StoredResource } from "@/lib/execution/ports";
import { StepFailedError } from "@/lib/execution/errors";
import { createMachineDrivers, type MachineRequest } from "@/lib/machines";
import { MemoryEvidence } from "../machines/_helpers";
import { createWorld, NOW, type World } from "./fakes/world";
import { ENV, OP, WS } from "./fakes/fixtures";

const SUB = "11111111-2222-3333-4444-555555555555";
const AZURE = `/subscriptions/${SUB}/resourceGroups/app/providers/Microsoft.Compute/virtualMachines/host`;
const GCP = "projects/zenith-test/zones/us-central1-a/instances/host";
const worlds: World[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

async function setup(provider: "azure" | "gcp", externalId = provider === "azure" ? AZURE : GCP, nativeType = provider === "azure" ? "azure:virtual_machine" : "gcp:compute_instance") {
  const w = createWorld({ op: { capability: "machine.inspect", resourceId: "res-machine", status: "running", proposal: { capability: "machine.inspect", scope: { workspaceId: WS, environmentId: ENV, resourceId: "res-machine" }, input: {}, summary: "inspect cloud machine", details: [], risk: "low" } } });
  worlds.push(w);
  const row: StoredResource = { id: "res-machine", workspaceId: WS, environmentId: ENV, address: "compute_instance/host", provider, nativeType, kind: "compute_instance", ownership: "managed", spec: {}, specDigest: "a".repeat(64), status: "active", dependsOn: [], origin: [], labels: {} };
  w.resources.rows.set(row.id, row);
  w.connections.connections[0].config = provider === "azure" ? { provider, mode: "oidc_web_identity", tenantId: "tenant", clientId: "client", subscriptionId: SUB, region: "eastus" } : { provider, mode: "oidc_web_identity", projectId: "zenith-test", workloadIdentityProvider: "pool", observeServiceAccount: "observe", deployServiceAccount: "deploy", region: "us-central1" };
  const transport = provider === "azure" ? "azure_run_command" : "gcp_os_management";
  const requests: CredentialRequest[] = [];
  const session: AzureSession | GcpSession = provider === "azure" ? { provider, subscriptionId: SUB, region: "eastus", expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: async () => new Response("{}"), childProcessEnv: () => ({}) } : { provider, projectId: "zenith-test", region: "us-central1", expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: async () => new Response("{}"), childProcessEnv: () => ({}) };
  w.deps.credentials = { withSession: async (r, fn) => { requests.push(r); return fn(session); }, verifyConnection: async () => ({ ok: true, detail: "fake" }) };
  const evidence = new MemoryEvidence();
  const calls: MachineRequest[] = [];
  const plane: MachineExecutionPort = {
    boundMachine: async () => null,
    latestObservation: async () => ({ address: row.address, externalId, presence: "present", attributes: {}, observedAt: NOW, source: "fake", simulated: false }),
    evidence,
    drivers: { [transport]: { transport, supports: ["machine.inspect"], execute: async (r: MachineRequest, supplied: unknown) => {
      expect(supplied).toBe(session); calls.push(r);
      return { ok: true, operation: r.operation, transport, data: {}, startedAt: NOW, finishedAt: NOW, simulated: false };
    } } },
  };
  w.deps.machines = plane;
  const lease = await w.lease();
  return { w, row, calls, requests, plane, lease, evidence, transport };
}

describe("cloud machine capability targets", () => {
  it.each(["azure", "gcp"] as const)("%s observed VM identity reaches its transport under an observe broker grant", async (provider) => {
    const s = await setup(provider);
    expect(await s.w.activities.executeCapability({ operationId: OP, lease: s.lease })).toEqual({ ok: true, summary: "machine.inspect succeeded" });
    expect(s.calls[0].target).toMatchObject({ transport: s.transport, targetId: provider === "azure" ? AZURE : GCP, workspaceId: WS, environmentId: ENV, resourceId: s.row.id });
    expect(s.requests).toHaveLength(1); expect(s.requests[0]).toMatchObject({ purpose: "observe", grant: { ws: WS, env: ENV, res: s.row.id, op: OP, cap: "machine.inspect" } });
    expect(s.evidence.records).toHaveLength(1);
  });

  it("normalizes the Compute selfLink to a scoped resource name", async () => {
    const s = await setup("gcp", "https://www.googleapis.com/compute/v1/" + GCP);
    await s.w.activities.executeCapability({ operationId: OP, lease: s.lease });
    expect(s.calls[0].target.targetId).toBe(GCP);
  });

  it.each([
    ["azure", "host", "azure:virtual_machine"], ["azure", AZURE + "?secret=canary", "azure:virtual_machine"], ["azure", AZURE, "azure:container_app"],
    ["gcp", "host", "gcp:compute_instance"], ["gcp", GCP + "/../other", "gcp:compute_instance"], ["gcp", GCP, "gcp:cloud_run_service"],
  ] as const)("%s malformed identity or non-VM type (%s, %s) is refused before grants/sessions", async (provider, id, nativeType) => {
    const s = await setup(provider, id, nativeType);
    await expect(s.w.activities.executeCapability({ operationId: OP, lease: s.lease })).rejects.toBeInstanceOf(StepFailedError);
    expect(s.requests).toHaveLength(0); expect(s.calls).toHaveLength(0); expect(s.w.broker.grants).toHaveLength(0);
  });

  it.each(["azure", "gcp"] as const)("%s requires a present nonsimulated observation in production", async (provider) => {
    const s = await setup(provider); s.row.externalId = provider === "azure" ? AZURE : GCP;
    const original = s.plane.latestObservation;
    s.plane.latestObservation = async (...args) => ({ ...(await original(...args))!, simulated: true });
    await expect(s.w.activities.executeCapability({ operationId: OP, lease: s.lease })).rejects.toThrow(/unknown/);
    s.plane.latestObservation = async () => null;
    await expect(s.w.activities.executeCapability({ operationId: OP, lease: s.lease })).rejects.toThrow(/unknown/);
    expect(s.requests).toHaveLength(0); expect(s.calls).toHaveLength(0);
  });

  it("the configured GCP driver refuses mutation with evidence before credential acquisition", async () => {
    const s = await setup("gcp");
    s.w.ops.seed({ resourceId: s.row.id, capability: "machine.service.restart", proposal: { capability: "machine.service.restart", scope: { workspaceId: WS, environmentId: ENV, resourceId: s.row.id }, input: { unit: "nginx.service" }, summary: "restart", details: [], risk: "high" } });
    s.plane.drivers = createMachineDrivers();
    await expect(s.w.activities.executeCapability({ operationId: OP, lease: s.lease })).rejects.toThrow(/unsupported_operation/);
    expect(s.requests).toHaveLength(0); expect(s.evidence.records[0].summary).toMatchObject({ code: "unsupported_operation" });
  });
});
