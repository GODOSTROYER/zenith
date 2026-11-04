/** Fake Google REST responses; no live project, inventory agent or guest execution. */
import { describe, expect, it, vi } from "vitest";
import type { GcpSession } from "@/lib/credentials/types";
import { createGcpOsManagementMachineDriver, executeMachineOperation, MACHINE_OPERATIONS } from "@/lib/machines";
import { GCP_MACHINE_REFUSAL } from "@/lib/machines/transports/gcp-os-management";
import { fakeClock, grantFor, MemoryEvidence, requestFor, sessions } from "./_helpers";

const PROJECT = "zenith-test";
const TARGET = `projects/${PROJECT}/zones/us-central1-a/instances/host`;
const ID = "9876543210123456789";
const request = () => requestFor("machine.inspect", {}, { transport: "gcp_os_management", targetId: TARGET });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup() {
  const clock = fakeClock();
  const calls: { url: string; method?: string; signal?: AbortSignal | null }[] = [];
  const state = {
    compute: { id: ID, name: "host", metadata: { items: [{ key: "secret", value: "metadata-secret-canary" }] }, labels: { secret: "labels-canary" } } as Record<string, unknown>,
    inventory: { name: `projects/123456789/locations/us-central1-a/instances/${ID}/inventory`, updateTime: "2026-09-29T12:00:00Z", osInfo: { hostname: "host-guest", shortName: "debian", longName: "Debian GNU/Linux", version: "12", architecture: "x86_64", kernelRelease: "6.1.0", osconfigAgentVersion: "agent-canary" }, items: { ignored: "package-secret-canary" } } as Record<string, unknown>,
    computeStatus: 200, inventoryStatus: 200, invalidInventory: false,
  };
  const session: GcpSession = {
    provider: "gcp", projectId: PROJECT, region: "us-central1", expiresAt: "2099-01-01T00:00:00Z", childProcessEnv: () => ({}),
    async authorizedFetch(url, init) {
      calls.push({ url, method: init?.method, signal: init?.signal });
      if (url.startsWith("https://compute.googleapis.com/")) return json(state.compute, state.computeStatus);
      if (state.invalidInventory) return new Response("invalid JSON password=secret-canary", { status: 200 });
      return json(state.inventory, state.inventoryStatus);
    },
  };
  const driver = createGcpOsManagementMachineDriver(clock);
  const execute = (req = request(), signal = new AbortController().signal) => driver.execute(req, session, signal);
  return { state, calls, session, driver, execute, clock };
}

describe("GCP inventory transport", () => {
  it("reads only Compute and BASIC inventory and reports the cached timestamp", async () => {
    const s = setup();
    const result = await s.execute();
    expect(result).toMatchObject({ ok: true, simulated: false, transport: "gcp_os_management", data: { hostname: "host-guest", os: { id: "debian", version: "12", pretty: "Debian GNU/Linux" }, kernel: "6.1.0", arch: "x86_64", inventory: { state: "available", observedAt: "2026-09-29T12:00:00.000Z" } } });
    expect(s.calls.map((c) => c.url)).toEqual([`https://compute.googleapis.com/compute/v1/${TARGET}`, `https://osconfig.googleapis.com/v1/projects/${PROJECT}/locations/us-central1-a/instances/${ID}/inventory?view=BASIC`]);
    expect(s.calls.every((c) => c.method === "GET" && c.signal instanceof AbortSignal)).toBe(true);
    expect(result.data).not.toHaveProperty("uptimeSec"); expect(result.data).not.toHaveProperty("cpuCount");
    for (const canary of ["metadata-secret-canary", "labels-canary", "agent-canary", "package-secret-canary"]) expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each(MACHINE_OPERATIONS.filter((op) => op !== "machine.inspect"))("%s is explicitly refused before any cloud call", async (op) => {
    const s = setup(); expect(s.driver.unsupported?.[op]).toBe(GCP_MACHINE_REFUSAL);
    await expect(s.execute({ ...request(), operation: op })).rejects.toMatchObject({ code: "unsupported_operation", message: GCP_MACHINE_REFUSAL });
    expect(s.calls).toHaveLength(0);
  });

  it.each([[404, "missing"], [403, "inaccessible"], [429, "unavailable"], [503, "unavailable"]] as const)("inventory HTTP %s yields %s with absent guest facts", async (status, state) => {
    const s = setup(); s.state.inventoryStatus = status;
    expect(await s.execute()).toMatchObject({ ok: true, data: { inventory: { state } } });
    expect((await s.execute()).data.hostname).toBeUndefined();
  });

  it("invalid inventory JSON is unavailable, not fabricated guest facts", async () => {
    const s = setup(); s.state.invalidInventory = true;
    expect(await s.execute()).toMatchObject({ ok: true, data: { inventory: { state: "unavailable" } } });
  });

  it("absent guest fields and timestamps remain unknown", async () => {
    const s = setup(); delete s.state.inventory.osInfo; s.state.inventory.updateTime = "unknown";
    const result = await s.execute();
    expect(result.data.hostname).toBeUndefined(); expect(result.data.kernel).toBeUndefined(); expect(result.data.inventory).toEqual({ state: "available" });
  });

  it.each([[404, "target_unreachable"], [403, "denied"], [429, "transport_error"], [500, "transport_error"]] as const)("Compute HTTP %s fails as %s without inventory probing", async (status, code) => {
    const s = setup(); s.state.computeStatus = status;
    await expect(s.execute()).rejects.toMatchObject({ code }); expect(s.calls).toHaveLength(1);
  });

  it.each(["host", TARGET + "?alt=evil", TARGET.replace(PROJECT, "foreign-project"), TARGET.replace("/host", "/../host"), "https://evil.example/compute/v1/" + TARGET])( "unsafe or foreign identity is refused (%s)", async (targetId) => {
    const s = setup(); const r = request(); r.target.targetId = targetId;
    await expect(s.execute(r)).rejects.toBeDefined(); expect(s.calls).toHaveLength(0);
  });

  it("accepts scoped Compute selfLinks and numeric ids without following response URLs", async () => {
    const s = setup(); const r = request(); r.target.targetId = "https://www.googleapis.com/compute/v1/" + TARGET;
    expect((await s.execute(r)).ok).toBe(true);
    r.target.targetId = TARGET.replace("/host", `/${ID}`); expect((await s.execute(r)).ok).toBe(true);
    s.state.compute.selfLink = "https://evil.example/secret"; expect((await s.execute(r)).ok).toBe(true);
    expect(s.calls.every((c) => !c.url.includes("evil"))).toBe(true);
  });

  it("refuses mismatched Compute and inventory identities", async () => {
    const s = setup(); s.state.compute.name = "other";
    await expect(s.execute()).rejects.toMatchObject({ code: "protocol_violation" }); expect(s.calls).toHaveLength(1);
    s.state.compute.name = "host";
    for (const name of ["invalid", `projects/${PROJECT}/locations/other-zone/instances/${ID}/inventory`, `projects/${PROJECT}/locations/us-central1-a/instances/99/inventory`, `projects/foreign-project/locations/us-central1-a/instances/${ID}/inventory`]) {
      s.state.inventory.name = name; await expect(s.execute()).rejects.toMatchObject({ code: "protocol_violation" });
    }
  });

  it("cancels before reads and between Compute and inventory", async () => {
    const s = setup(); const controller = new AbortController(); controller.abort();
    await expect(s.execute(request(), controller.signal)).rejects.toMatchObject({ code: "aborted" }); expect(s.calls).toHaveLength(0);
    const midway = new AbortController(); const original = s.session.authorizedFetch;
    s.session.authorizedFetch = async (url, init) => { const response = await original(url, init); midway.abort(); return response; };
    await expect(s.execute(request(), midway.signal)).rejects.toMatchObject({ code: "aborted" }); expect(s.calls).toHaveLength(1);
  });

  it("redacts bounded response fields and persists one evidence record", async () => {
    const s = setup(); (s.state.inventory.osInfo as Record<string, unknown>).longName = "password=fixture-secret";
    const evidence = new MemoryEvidence();
    const result = await executeMachineOperation(request(), { drivers: { gcp_os_management: s.driver }, grant: grantFor("machine.inspect"), sessions: sessions(s.session), evidence, signal: new AbortController().signal, now: () => new Date(s.clock.now()) });
    expect(result.evidenceId).toBe("ev-1"); expect(evidence.records).toHaveLength(1); expect(JSON.stringify({ result, records: evidence.records })).not.toContain("fixture-secret");
    expect(evidence.records[0].simulated).toBe(false);
    const bounded = request(); bounded.maxOutputBytes = 50; expect(await s.execute(bounded)).toMatchObject({ ok: false, data: { error: "output_limit" } });
  });

  it("wall-clock budget cancels a hung Compute read without exposing its exception", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.session.authorizedFetch = async (_url, init) => new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error("private-cause-canary")), { once: true }); });
      const r = request(); r.timeoutSec = 1;
      const result = s.execute(r).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await result).toMatchObject({ code: "target_unreachable" }); expect(String(await result)).not.toContain("private-cause-canary");
    } finally { vi.useRealTimers(); }
  });

  it("refusal evidence is recorded before opening any credential session", async () => {
    const s = setup(); const evidence = new MemoryEvidence(); const scope = sessions(s.session);
    const r = { ...request(), operation: "machine.service.restart" as const, args: { unit: "nginx.service" } };
    await expect(executeMachineOperation(r, { drivers: { gcp_os_management: s.driver }, grant: grantFor(r.operation), sessions: scope, evidence, signal: new AbortController().signal, now: () => new Date(s.clock.now()) })).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(scope.opened).toBe(0); expect(evidence.records).toHaveLength(1); expect(evidence.records[0].summary).toMatchObject({ code: "unsupported_operation", message: expect.stringContaining("on-demand") });
  });
});
