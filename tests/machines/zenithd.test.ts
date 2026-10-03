/**
 * zenithd transport through a fake `MachineRequestDispatcher`: what is handed
 * to the queue, how the agent's answer is validated and mapped, and what
 * happens when the answer never comes. Also the simulated transport, whose
 * output doubles as a known-good agent result for every operation.
 */
import { describe, expect, it } from "vitest";
import {
  createSimulatedMachineDriver,
  createZenithdMachineDriver,
  IMPLEMENTED_OPERATIONS,
  MachineOperationError,
  MachineResultDataSchemas,
  type ImplementedOperation,
  type MachineDispatchOutcome,
  type MachineRequest,
  type MachineRequestDispatcher,
} from "@/lib/machines";
import { requestFor, T0 } from "./_helpers";

const GRANT_JWS = "eyJhbGciOiJFZERTQSJ9.payload.signature";

class FakeDispatcher implements MachineRequestDispatcher {
  enqueued: { req: MachineRequest; grantJws: string }[] = [];
  awaited: string[] = [];
  enqueueError?: Error;
  outcome: MachineDispatchOutcome | ((req: MachineRequest) => MachineDispatchOutcome) = { status: "succeeded", result: {} };
  /** never answer; reject when the wait signal aborts */
  hang = false;
  async enqueue(req: MachineRequest, grantJws: string): Promise<string> {
    if (this.enqueueError) throw this.enqueueError;
    this.enqueued.push({ req, grantJws });
    return `mreq_${this.enqueued.length}`;
  }
  async await(id: string, signal: AbortSignal): Promise<MachineDispatchOutcome> {
    this.awaited.push(id);
    if (this.hang) {
      await new Promise<void>((_res, rej) => {
        if (signal.aborted) return rej(signal.reason);
        signal.addEventListener("abort", () => rej(signal.reason), { once: true });
      });
    }
    const last = this.enqueued[this.enqueued.length - 1].req;
    return typeof this.outcome === "function" ? this.outcome(last) : this.outcome;
  }
}

const session = { grantJws: GRANT_JWS };
const req = (op: Parameters<typeof requestFor>[0], args: Record<string, unknown> = {}, over: NonNullable<Parameters<typeof requestFor>[2]> = {}) => requestFor(op, args, { transport: "zenithd", targetId: "mac_abc123", ...over });

function setup(graceSec = 30) {
  const d = new FakeDispatcher();
  const driver = createZenithdMachineDriver({ dispatcher: d, queueGraceSec: graceSec, now: () => T0 });
  return { d, driver, run: (r: MachineRequest, s: unknown = session, signal = new AbortController().signal) => driver.execute(r, s, signal) };
}

/** a known-good agent result for an operation: what the simulated transport produces */
async function goodResult(op: ImplementedOperation, args: Record<string, unknown>) {
  const sim = createSimulatedMachineDriver("zenithd", { now: () => T0 });
  const r = await sim.execute(req(op, args), undefined, new AbortController().signal);
  return r;
}

describe("dispatch", () => {
  it("hands the validated, normalized request and the grant JWS to the queue, then waits on the returned id", async () => {
    const { d, run } = setup();
    d.outcome = { status: "succeeded", result: (await goodResult("file.read", { path: "/var/log/a" })).data };
    await run(req("file.read", { path: "/var//log/./a" }));
    expect(d.enqueued).toHaveLength(1);
    expect(d.enqueued[0].grantJws).toBe(GRANT_JWS);
    expect(d.enqueued[0].req.args).toEqual({ path: "/var/log/a", maxBytes: 65536 });
    expect(d.enqueued[0].req.target.targetId).toBe("mac_abc123");
    expect(d.awaited).toEqual(["mreq_1"]);
  });

  it("refuses without a grant JWS, for a bad machine id, hostile args or an unsupported operation, before queueing", async () => {
    const { d, run } = setup();
    await expect(run(req("machine.inspect"), null)).rejects.toMatchObject({ code: "transport_error" });
    await expect(run(req("machine.inspect"), { grantJws: "" })).rejects.toMatchObject({ code: "transport_error" });
    await expect(run(req("machine.inspect", {}, { targetId: "mac abc; id" }))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(run(req("service.status", { unit: "x;id.service" }))).rejects.toMatchObject({ code: "invalid_args" });
    await expect(run(req("file.write", {}))).rejects.toMatchObject({ code: "invalid_args" });
    expect(d.enqueued).toHaveLength(0);
  });

  it("a queue failure is a retryable transport error (nothing was dispatched)", async () => {
    const { d, run } = setup();
    d.enqueueError = new Error("db down");
    const err = await run(req("machine.inspect")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "transport_error" });
    expect((err as MachineOperationError).retryable).toBe(true);
  });

  it("supports every implemented operation except none (zenithd implements the whole table)", () => {
    const { driver } = setup();
    expect([...driver.supports].sort()).toEqual([...IMPLEMENTED_OPERATIONS].sort());
  });
});

describe("result validation", () => {
  const cases: [ImplementedOperation, Record<string, unknown>][] = [
    ["machine.inspect", {}],
    ["process.list", { limit: 5 }],
    ["service.status", { unit: "nginx.service" }],
    ["machine.service.restart", { unit: "nginx.service" }],
    ["container.list", {}],
    ["container.inspect", { container: "web" }],
    ["container.logs", { container: "web", lines: 10 }],
    ["file.read", { path: "/var/log/a" }],
    ["network.portCheck", { host: "db.internal", port: 5432 }],
    ["network.dnsCheck", { name: "example.com" }],
    ["system.metrics", {}],
    ["system.logs", {}],
  ];

  it.each(cases)("%s: a conforming agent result is passed through as data", async (op, args) => {
    const { d, run } = setup();
    const good = await goodResult(op, args);
    d.outcome = { status: "succeeded", result: good.data, startedAt: "2026-09-30T12:00:00.000Z", finishedAt: "2026-09-30T12:00:01.000Z" };
    const res = await run(req(op, args));
    expect(res).toMatchObject({ ok: true, operation: op, transport: "zenithd", transportRef: "mreq_1", simulated: false, startedAt: "2026-09-30T12:00:00.000Z", finishedAt: "2026-09-30T12:00:01.000Z" });
    expect(res.data).toEqual(MachineResultDataSchemas[op].parse(good.data));
  });

  it("strips fields the contract does not define (an agent cannot smuggle extras to callers)", async () => {
    const { d, run } = setup();
    d.outcome = { status: "succeeded", result: { unit: "nginx.service", loadState: "loaded", activeState: "active", shellPassword: "hunter2", nested: { a: 1 } } };
    const res = await run(req("service.status", { unit: "nginx.service" }));
    expect(res.data).toEqual({ unit: "nginx.service", loadState: "loaded", activeState: "active" });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", "active"],
    ["wrong field type", { unit: "x.service", loadState: 1, activeState: "active" }],
    ["missing required field", { unit: "x.service", loadState: "loaded" }],
    ["oversize string", { unit: "x".repeat(500), loadState: "a", activeState: "b" }],
  ])("malformed agent result (%s) is ok:false malformed_result, never passed through", async (_name, result) => {
    const { d, run } = setup();
    d.outcome = { status: "succeeded", result };
    const res = await run(req("service.status", { unit: "x.service" }));
    expect(res).toMatchObject({ ok: false, data: { error: "malformed_result" } });
    expect(JSON.stringify(res.data)).not.toContain("hunter2");
  });

  it("bounds list sizes the agent returns", async () => {
    const { d, run } = setup();
    d.outcome = { status: "succeeded", result: { processes: Array.from({ length: 501 }, (_, i) => ({ pid: i, command: "x" })), truncated: false } };
    expect(await run(req("process.list", {}))).toMatchObject({ ok: false, data: { error: "malformed_result" } });
  });

  it("agent-supplied timestamps are used only when they parse", async () => {
    const { d, run } = setup();
    d.outcome = { status: "succeeded", result: (await goodResult("system.metrics", {})).data, startedAt: "not a date", finishedAt: "<script>" };
    const res = await run(req("system.metrics"));
    expect(res.startedAt).toBe(new Date(T0).toISOString());
    expect(res.finishedAt).toBe(new Date(T0).toISOString());
  });
});

describe("status mapping", () => {
  it("failed: carries the agent's failure code when it is valid, else command_failed", async () => {
    const { d, run } = setup();
    d.outcome = { status: "failed", result: { error: "unavailable", reason: "docker is not installed" } };
    expect(await run(req("container.list"))).toMatchObject({ ok: false, data: { error: "unavailable", reason: "docker is not installed" } });
    d.outcome = { status: "failed", result: { error: "made_up_code" }, error: "systemctl exited 1" };
    expect(await run(req("service.status", { unit: "a.service" }))).toMatchObject({ ok: false, data: { error: "command_failed", reason: "systemctl exited 1" } });
    d.outcome = { status: "failed" };
    expect(await run(req("service.status", { unit: "a.service" }))).toMatchObject({ ok: false, data: { error: "command_failed" } });
  });

  it("rejected: a local guard on the machine said no", async () => {
    const { d, run } = setup();
    d.outcome = { status: "rejected", error: "files.readAllow does not include /etc/shadow" };
    expect(await run(req("file.read", { path: "/var/log/a" }))).toMatchObject({ ok: false, data: { error: "refused", reason: "files.readAllow does not include /etc/shadow" } });
    d.outcome = { status: "rejected" };
    expect(await run(req("machine.service.restart", { unit: "a.service" }))).toMatchObject({ ok: false, data: { error: "refused" } });
  });

  it("timed_out: the agent's own deadline is a definite result", async () => {
    const { d, run } = setup();
    d.outcome = { status: "timed_out", error: "deadline exceeded" };
    expect(await run(req("system.logs"))).toMatchObject({ ok: false, data: { error: "timeout", timedOut: true } });
    expect(await run(req("machine.exec", { argv: ["/bin/sleep", "10"], timeoutSec: 5 }))).toMatchObject({ ok: false, data: { error: "timeout", exitCode: null }, output: { stdout: "", stderr: "", exitCode: null, truncated: false } });
  });

  it("uncertain: the control plane lost the agent; surfaced as an error carrying the request id", async () => {
    const { d, run } = setup();
    d.outcome = { status: "uncertain" };
    await expect(run(req("machine.service.restart", { unit: "a.service" }))).rejects.toMatchObject({ code: "uncertain", transportRef: "mreq_1" });
  });

  it("machine.exec: output is bounded and returned with the exit code; nonzero is ok:false", async () => {
    const { d, run } = setup();
    d.outcome = { status: "succeeded", exitCode: 0, output: { stdout: "hello\n", stderr: "", truncated: false } };
    const a = await run(req("machine.exec", { argv: ["echo", "hello"], timeoutSec: 5 }));
    expect(a).toMatchObject({ ok: true, data: { exitCode: 0 }, output: { stdout: "hello\n", stderr: "", exitCode: 0, truncated: false } });

    d.outcome = { status: "failed", exitCode: 2, output: { stdout: "é".repeat(500), stderr: "bad", truncated: false } };
    const b = await run(req("machine.exec", { argv: ["false"], timeoutSec: 5 }, { maxOutputBytes: 101 }));
    expect(b).toMatchObject({ ok: false, data: { exitCode: 2 } });
    expect(Buffer.byteLength(b.output!.stdout)).toBeLessThanOrEqual(101);
    expect(b.output!.truncated).toBe(true);

    d.outcome = { status: "succeeded", exitCode: 0, output: { stdout: "x", stderr: "", truncated: true } };
    expect((await run(req("container.exec", { argv: ["x"], timeoutSec: 5 }))).output!.truncated).toBe(true);
  });

  it("machine.exec disabled on the machine (default) is a refusal, not a failure of the command", async () => {
    const { d, run } = setup();
    d.outcome = { status: "rejected", error: "exec.enabled is false on this machine" };
    expect(await run(req("machine.exec", { argv: ["id"], timeoutSec: 5 }))).toMatchObject({ ok: false, data: { error: "refused", exitCode: null }, output: { stdout: "", stderr: "", exitCode: null, truncated: false } });
  });

  it("exec without an exit code (agent omitted it) is never ok", async () => {
    const { d, run } = setup();
    d.outcome = { status: "succeeded", output: { stdout: "x", stderr: "", truncated: false } };
    const res = await run(req("machine.exec", { argv: ["x"], timeoutSec: 5 }));
    expect(res.ok).toBe(false);
    expect(res.output!.exitCode).toBeNull();
  });
});

describe("waiting", () => {
  it("user abort: aborted for reads, uncertain for mutations (the request is already queued)", async () => {
    const { d, run } = setup();
    d.hang = true;
    const ac = new AbortController();
    const read = run(req("machine.inspect"), session, ac.signal).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 10);
    expect(await read).toMatchObject({ code: "aborted", transportRef: "mreq_1" });

    const ac2 = new AbortController();
    const write = run(req("machine.service.restart", { unit: "a.service" }), session, ac2.signal).catch((e: unknown) => e);
    setTimeout(() => ac2.abort(), 10);
    expect(await write).toMatchObject({ code: "uncertain", transportRef: "mreq_2" });
  });

  it("no answer within the time budget is uncertain for both reads and mutations", async () => {
    const { d, run } = setup(0);
    d.hang = true;
    await expect(run(req("machine.inspect", {}, { timeoutSec: 1 }))).rejects.toMatchObject({ code: "uncertain", transportRef: "mreq_1" });
    const write = await run(req("machine.service.restart", { unit: "a.service" }, { timeoutSec: 1 })).catch((e: unknown) => e);
    expect(write).toMatchObject({ code: "uncertain", transportRef: "mreq_2" });
  });

  it("a dispatcher failure after dispatch is uncertain and cannot be retried", async () => {
    const { d, driver } = setup();
    d.await = async () => {
      throw new Error("connection reset");
    };
    const err = await driver.execute(req("machine.inspect"), session, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "uncertain", transportRef: "mreq_1" });
    expect((err as MachineOperationError).retryable).toBe(false);
  });
});

describe("simulated transport", () => {
  const sim = createSimulatedMachineDriver("aws_ssm", { now: () => T0 });
  const go = (op: Parameters<typeof requestFor>[0], args: Record<string, unknown> = {}, over: NonNullable<Parameters<typeof requestFor>[2]> = {}) => sim.execute(requestFor(op, args, over), undefined, new AbortController().signal);

  it("every implemented operation returns schema-valid data labelled simulated", async () => {
    const minimal: Record<Exclude<ImplementedOperation, "file.write">, Record<string, unknown>> = {
      "machine.inspect": {},
      "process.list": { limit: 5 },
      "service.status": { unit: "nginx.service" },
      "machine.service.restart": { unit: "nginx.service" },
      "container.list": { all: true },
      "container.inspect": { container: "web" },
      "container.logs": { container: "web", lines: 10 },
      "container.exec": { argv: ["ls"], timeoutSec: 5 },
      "file.read": { path: "/var/log/a" },
      "network.portCheck": { host: "example.com", port: 443 },
      "network.dnsCheck": { name: "example.com", recordType: "TXT" },
      "system.metrics": {},
      "system.logs": { lines: 5 },
      "machine.exec": { argv: ["ls"], timeoutSec: 5 },
    };
    for (const op of sim.supports as Exclude<ImplementedOperation, "file.write">[]) {
      const r = await go(op, minimal[op]);
      expect(r, op).toMatchObject({ ok: true, simulated: true, transport: "aws_ssm", operation: op });
      expect(r.transportRef, op).toMatch(/^sim-[0-9a-f]{8}$/);
      expect(MachineResultDataSchemas[op].safeParse(r.data).success, op).toBe(true);
    }
    expect(sim.simulated).toBe(true);
  });

  it("is deterministic: same request, same data; different targets differ", async () => {
    const a = await go("machine.inspect");
    const b = await go("machine.inspect");
    expect(b.data).toEqual(a.data);
    expect(b.transportRef).toBe(a.transportRef);
    const c = await go("machine.inspect", {}, { targetId: "i-0fedcba9876543210" });
    expect(c.data).not.toEqual(a.data);
    expect(String(a.data.hostname)).toMatch(/^sim-/);
  });

  it("says so in text payloads and never executes exec-style requests", async () => {
    const e = await go("machine.exec", { argv: ["rm", "-rf", "/"], timeoutSec: 5 });
    expect(e.output).toEqual({ stdout: "[simulated] not executed: rm\n", stderr: "", exitCode: 0, truncated: false });
    expect(String((await go("file.read", { path: "/etc/nginx/nginx.conf" })).data.content)).toContain("[simulated]");
    expect(String((await go("container.logs", { container: "web", lines: 3 })).data.content)).toContain("[simulated]");
  });

  it("validates arguments like the real transports and honours the output budget", async () => {
    await expect(go("service.status", { unit: "a b" })).rejects.toMatchObject({ code: "invalid_args" });
    await expect(go("file.write", {})).rejects.toMatchObject({ code: "unsupported_operation" });
    const r = await go("system.logs", { lines: 5000 }, { maxOutputBytes: 500 });
    expect(Buffer.byteLength(String(r.data.content))).toBeLessThanOrEqual(500);
    expect(r.data.truncated).toBe(true);
  });
});
