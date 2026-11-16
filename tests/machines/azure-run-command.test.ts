/** Fake ARM contracts; these tests do not contact an Azure subscription. */
import { describe, expect, it, vi } from "vitest";
import type { AzureSession } from "@/lib/credentials/types";
import { createAzureRunCommandMachineDriver, executeMachineOperation, MachineResultDataSchemas, type MachineOperation, type MachineRequest } from "@/lib/machines";
import { AZURE_WIRE_HEADER, azureScriptPlans } from "@/lib/machines/transports/azure-scripts";
import { azureCommandIdentity } from "@/lib/machines/transports/azure-run-command";
import { fakeClock, grantFor, MemoryEvidence, requestFor, sessions } from "./_helpers";
import { OUT } from "./_ssm-output";

const SUB = "11111111-2222-3333-4444-555555555555";
const VM = `/subscriptions/${SUB}/resourceGroups/app/providers/Microsoft.Compute/virtualMachines/host`;
const req = (op: MachineOperation = "machine.inspect", args: Record<string, unknown> = {}, extra: Partial<MachineRequest> = {}) => requestFor(op, args, { transport: "azure_run_command", targetId: VM, ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const wire = (stdout: string, extra: Record<string, unknown> = {}) => AZURE_WIRE_HEADER + JSON.stringify({ stdout: Buffer.from(stdout).toString("base64"), stderr: "", exitCode: 0, truncated: false, timedOut: false, ...extra });

function setup(stdout = OUT.inspect) {
  const clock = fakeClock();
  const calls: { url: string; init?: RequestInit }[] = [];
  const state = {
    osType: "Linux", command: undefined as Record<string, unknown> | undefined, commandPath: "",
    iv: { executionState: "Succeeded", exitCode: 0, output: wire(stdout) } as Record<string, unknown>,
    provisioningState: "Succeeded", putError: undefined as Error | undefined, putStatus: 202,
    pollError: undefined as Error | undefined, pollStatus: 200,
  };
  const session: AzureSession = {
    provider: "azure", subscriptionId: SUB, region: "eastus", expiresAt: "2099-01-01T00:00:00Z", childProcessEnv: () => ({}),
    async authorizedFetch(url, init) {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === VM && init?.method === "GET") return json({ location: "eastus", properties: { storageProfile: { osDisk: { osType: state.osType } } } });
      if (init?.method === "PUT") {
        state.command = JSON.parse(String(init.body)) as Record<string, unknown>;
        state.commandPath = path;
        if (state.putError) throw state.putError;
        return json({}, state.putStatus);
      }
      if (!state.command || path !== state.commandPath) return json({ error: { message: "absent" } }, 404);
      if (state.pollError) throw state.pollError;
      return json({ ...state.command, properties: { ...(state.command.properties as object), provisioningState: state.provisioningState, instanceView: state.iv } }, state.pollStatus);
    },
  };
  const driver = createAzureRunCommandMachineDriver({ ...clock });
  const execute = (r = req(), signal = new AbortController().signal) => driver.execute(r, session, signal);
  return { clock, state, session, calls, driver, execute, puts: () => calls.filter((c) => c.init?.method === "PUT") };
}

const cases: [MachineOperation, Record<string, unknown>, string][] = [
  ["machine.inspect", {}, OUT.inspect], ["process.list", { limit: 5, sortBy: "memory" }, OUT.processes],
  ["service.status", { unit: "nginx.service" }, OUT.serviceStatus], ["machine.service.restart", { unit: "nginx.service" }, OUT.serviceRestart],
  ["container.list", {}, OUT.containerList], ["container.inspect", { container: "web" }, OUT.containerInspect],
  ["container.logs", { container: "web" }, OUT.containerLogs], ["file.read", { path: "/var/log/app.log" }, OUT.fileRead("hello")],
  ["network.portCheck", { host: "db.internal", port: 5432 }, OUT.portOpen], ["network.dnsCheck", { name: "localhost" }, OUT.dns],
  ["system.metrics", {}, OUT.metrics], ["system.logs", {}, OUT.systemLogs], ["machine.exec", { argv: ["echo", "hello"], timeoutSec: 2 }, "hello\n"],
];

describe("Azure managed Run Command", () => {
  it.each(cases)("%s uses a fixed script and returns schema-valid bounded data", async (op, args, stdout) => {
    const s = setup(stdout); const r = req(op, args);
    const result = await s.execute(r);
    expect(result).toMatchObject({ ok: true, operation: op, transport: "azure_run_command", simulated: false });
    expect(MachineResultDataSchemas[op as keyof typeof MachineResultDataSchemas].parse(result.data)).toEqual(result.data);
    expect(s.puts()).toHaveLength(1);
    const body = JSON.parse(String(s.puts()[0].init!.body));
    expect(body.properties).toMatchObject({ asyncExecution: true, timeoutInSeconds: 30, treatFailureAsDeploymentFailure: false });
    expect(body.properties.source.script).toContain("ZENITH_FIXED_PYTHON");
    expect(body.properties).not.toHaveProperty("outputBlobUri");
    expect(s.calls.every((c) => new URL(c.url).origin === "https://management.azure.com")).toBe(true);
    expect(s.calls.filter((c) => c.init?.method === "GET" && c.url.includes("/runCommands/")).every((c) => new URL(c.url).searchParams.get("$expand") === "instanceView")).toBe(true);
  });

  it("reuses a completed request without a second PUT and hashes tenant/request/source identity", async () => {
    const s = setup(); const r = req();
    const first = await s.execute(r); const second = await s.execute(r);
    expect(first.transportRef).toBe(second.transportRef); expect(s.puts()).toHaveLength(1);
    const plan = azureScriptPlans()(r);
    const id = azureCommandIdentity(r, plan);
    expect(id.name).toMatch(/^zenith-[a-f0-9]{48}$/);
    expect(azureCommandIdentity({ ...r, target: { ...r.target, workspaceId: "foreign" } }, plan).name).not.toBe(id.name);
    expect(azureCommandIdentity({ ...r, args: { changed: true } }, plan).name).not.toBe(id.name);
    expect(azureCommandIdentity(r, { ...plan, script: plan.script + "\n" }).name).not.toBe(id.name);
  });

  it("passes hostile exec argv through protected named parameters without changing source", async () => {
    const hostile = ["printf", "';$(touch sentinel);`id`\n{{value}}", "--password", "fixture-secret"];
    const s = setup("ok"); await s.execute(req("machine.exec", { argv: hostile, cwd: "/srv/app", timeoutSec: 3 }));
    const body = JSON.parse(String(s.puts()[0].init!.body));
    const params = body.properties.protectedParameters;
    expect(JSON.parse(Buffer.from(params.find((p: { name: string }) => p.name === "ZENITH_ARGV_B64").value, "base64").toString())).toEqual(hostile);
    expect(body.properties.source.script).toBe(azureScriptPlans()(req("machine.exec", { argv: ["true"], timeoutSec: 3 })).script);
    expect(body.properties.source.script).not.toContain("fixture-secret");
    expect(body.tags).toEqual({ "zenith-request-digest": expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("polls execution despite provisioning success, with bounded exponential backoff", async () => {
    const s = setup(); s.state.iv = { executionState: "Running" };
    let reads = 0; const original = s.session.authorizedFetch;
    s.session.authorizedFetch = async (url, init) => {
      if (url.includes("/runCommands/") && init?.method === "GET" && s.state.command && ++reads === 3) s.state.iv = { executionState: "Succeeded", exitCode: 0, output: wire(OUT.inspect) };
      return original(url, init);
    };
    expect((await s.execute()).ok).toBe(true);
    expect(s.clock.sleeps).toEqual([500, 800, 1280]);
  });

  it.each(["machine.inspect", "machine.service.restart"] as const)("%s pending deadline preserves honest uncertainty", async (op) => {
    const s = setup(); s.state.iv = { executionState: "Running" };
    await expect(s.execute(req(op, op === "machine.inspect" ? {} : { unit: "nginx.service" }, { timeoutSec: 1 }))).rejects.toMatchObject({ code: op === "machine.inspect" ? "target_unreachable" : "uncertain" });
    expect(s.puts()).toHaveLength(1); expect(s.calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  });

  it.each(["TimedOut", "Canceled"])("%s mutating execution is uncertain", async (state) => {
    const s = setup(); s.state.iv = { executionState: state };
    await expect(s.execute(req("machine.service.restart", { unit: "nginx.service" }))).rejects.toMatchObject({ code: "uncertain" });
  });

  it("a collector timeout returns read failure and mutating uncertainty", async () => {
    const s = setup(); s.state.iv.output = wire("", { timedOut: true, exitCode: -9 });
    expect(await s.execute()).toMatchObject({ ok: false, data: { error: "timeout" } });
    await expect(s.execute(req("machine.service.restart", { unit: "nginx.service" }))).rejects.toMatchObject({ code: "uncertain" });
  });

  it.each([64, 65, 66, 69, 1])("guest exit %s returns a clean bounded failure", async (exitCode) => {
    const s = setup(); s.state.iv.output = wire("", { exitCode });
    expect(await s.execute()).toMatchObject({ ok: false, data: { error: exitCode === 1 ? "command_failed" : ["invalid_parameters", "refused", "not_found", "unavailable"][[64, 65, 66, 69].indexOf(exitCode)] } });
  });

  it("Python absence is reported as unavailable", async () => {
    const s = setup(); s.state.iv = { executionState: "Failed", exitCode: 69 };
    expect(await s.execute()).toMatchObject({ ok: false, data: { error: "unavailable" } });
  });

  it.each([["missing", undefined], ["plain text", "bad"], ["missing fields", AZURE_WIRE_HEADER + "{}"], ["provider truncation", "x".repeat(4096)]])("refuses malformed remote output (%s)", async (_label, output) => {
    const s = setup(); s.state.iv.output = output;
    await expect(s.execute()).rejects.toMatchObject({ code: "protocol_violation" });
    await expect(s.execute(req("machine.service.restart", { unit: "nginx.service" }))).rejects.toMatchObject({ code: "uncertain" });
  });

  it("a lost PUT acknowledgement is uncertain, including errors with secret values", async () => {
    const s = setup(); s.state.putError = new Error("secret=canary-never-leak");
    const error = await s.execute(req("machine.service.restart", { unit: "nginx.service" })).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "uncertain", retryable: false }); expect(String(error)).not.toContain("canary-never-leak");
    expect((error as Error).cause).toBeUndefined(); expect(s.puts()).toHaveLength(1);
  });

  it("an explicit PUT denial is clean; an unreadable mutating result is uncertain", async () => {
    const s = setup(); s.state.putStatus = 403;
    await expect(s.execute(req("machine.service.restart", { unit: "nginx.service" }))).rejects.toMatchObject({ code: "denied" });
    const other = setup(); other.state.pollError = new Error("secret=canary");
    await expect(other.execute(req("machine.service.restart", { unit: "nginx.service" }))).rejects.toMatchObject({ code: "uncertain" });
  });

  it("aborts before dispatch and after dispatch with different outcomes", async () => {
    const s = setup(); const pre = new AbortController(); pre.abort();
    await expect(s.execute(req(), pre.signal)).rejects.toMatchObject({ code: "aborted" }); expect(s.calls).toHaveLength(0);
    const after = new AbortController(); const original = s.session.authorizedFetch;
    s.session.authorizedFetch = async (url, init) => { const response = await original(url, init); if (init?.method === "PUT") after.abort(); return response; };
    await expect(s.execute(req("machine.service.restart", { unit: "nginx.service" }), after.signal)).rejects.toMatchObject({ code: "uncertain" });
  });

  it.each(["GET", "PUT"] as const)("wall-clock budget interrupts a hung %s call", async (method) => {
    vi.useFakeTimers();
    try {
      const s = setup(); const original = s.session.authorizedFetch;
      s.session.authorizedFetch = async (url, init) => init?.method === method ? new Promise<Response>((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(new Error("private-cause-canary")), { once: true }); }) : original(url, init);
      const result = s.execute(req(method === "PUT" ? "machine.service.restart" : "machine.inspect", method === "PUT" ? { unit: "nginx.service" } : {}, { timeoutSec: 1 })).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await result).toMatchObject({ code: method === "PUT" ? "uncertain" : "target_unreachable" });
      expect(String(await result)).not.toContain("private-cause-canary");
    } finally { vi.useRealTimers(); }
  });

  it("a completed mutation with invalid semantic output stays uncertain", async () => {
    const s = setup("not a semantic result");
    await expect(s.execute(req("machine.service.restart", { unit: "nginx.service" }))).rejects.toMatchObject({ code: "uncertain" });
    expect(s.puts()).toHaveLength(1);
  });

  it.each(["host", VM + "?x=1", VM + "/runCommands/evil", VM.replace("/host", "/../host"), VM.replace(SUB, "99999999-2222-3333-4444-555555555555")])("unsafe or foreign target is refused before ARM (%s)", async (targetId) => {
    const s = setup(); await expect(s.execute({ ...req(), target: { ...req().target, targetId } })).rejects.toBeDefined(); expect(s.calls).toHaveLength(0);
  });

  it("fails closed for unknown/Windows OS and missing sessions", async () => {
    for (const osType of ["Windows", ""]) { const s = setup(); s.state.osType = osType; await expect(s.execute()).rejects.toMatchObject({ code: "unsupported_operation" }); expect(s.puts()).toHaveLength(0); }
    const s = setup(); await expect(s.driver.execute(req(), undefined, new AbortController().signal)).rejects.toMatchObject({ code: "transport_error" });
  });

  it.each([
    ["service.status", { unit: "nginx.service;id" }], ["machine.service.restart", { unit: "sshd.service" }],
    ["file.read", { path: "/etc/shadow" }], ["file.read", { path: "/srv/app/.env" }],
    ["container.inspect", {}], ["container.list", { labelSelector: "app=web" }], ["machine.exec", { argv: ["echo"], timeoutSec: 31 }],
  ] as [MachineOperation, Record<string, unknown>][])("%s invalid or denied parameters never reach ARM", async (op, args) => {
    const s = setup(); await expect(s.execute(req(op, args))).rejects.toBeDefined(); expect(s.calls).toHaveLength(0);
  });

  it("honors environment-specific guest allowlists and file-read wire limits", async () => {
    const plan = azureScriptPlans({ fileReadPrefixes: ["/srv/app/"], restartAllow: ["nginx.service"] });
    expect(() => plan(req("machine.service.restart", { unit: "app.service" }))).toThrow();
    expect(() => plan(req("file.read", { path: "/var/log/app.log", maxBytes: 100 }))).toThrow();
    const file = plan(req("file.read", { path: "/srv/app/log", maxBytes: 65536 }));
    expect(Number(file.parameters.find((p) => p.name === "SSM_maxBytes")!.value)).toBe(1024);
    const status = plan(req("service.status", { unit: "nginx.service" }));
    expect(status.parameters).toContainEqual({ name: "SSM_unit", value: "nginx.service" });
    expect(status.script).toBe(plan(req("service.status", { unit: "app.service" })).script);
  });

  it("redacts before byte truncation and writes redacted exec evidence", async () => {
    const s = setup("password=fixture-secret\n" + "é".repeat(200));
    s.state.iv.output = wire("password=fixture-secret\n" + "é".repeat(200), { stderr: Buffer.from("token=stderr-secret").toString("base64"), truncated: true });
    const r = req("machine.exec", { argv: ["echo", "--password", "fixture-secret"], timeoutSec: 2 }, { maxOutputBytes: 70 });
    const evidence = new MemoryEvidence();
    const result = await executeMachineOperation(r, { drivers: { azure_run_command: s.driver }, sessions: sessions(s.session), grant: grantFor("machine.exec"), evidence, signal: new AbortController().signal, now: () => new Date(s.clock.now()) });
    expect(result.output!.truncated).toBe(true);
    expect(Buffer.byteLength(result.output!.stdout) + Buffer.byteLength(result.output!.stderr)).toBeLessThanOrEqual(70);
    const serialized = JSON.stringify({ result, evidence: evidence.records });
    expect(serialized).not.toContain("fixture-secret"); expect(serialized).not.toContain("stderr-secret"); expect(evidence.records).toHaveLength(1);
  });

  it("marks clipped logs/lists and rejects clipped file encodings", async () => {
    const logs = setup(); logs.state.iv.output = wire(OUT.systemLogs, { truncated: true }); expect((await logs.execute(req("system.logs"))).data.truncated).toBe(true);
    const file = setup(); file.state.iv.output = wire(OUT.fileRead("hello"), { truncated: true }); expect(await file.execute(req("file.read", { path: "/var/log/app.log" }))).toMatchObject({ ok: false, data: { error: "output_limit" } });
  });
});
