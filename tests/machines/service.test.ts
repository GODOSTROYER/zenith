/**
 * `executeMachineOperation`: authorization defence in depth, limits, evidence
 * and redaction, with fake drivers so each rule is tested in isolation.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createMachineDrivers,
  createSimulatedMachineDriver,
  executeMachineOperation,
  machineTransportFor,
  MachineOperationError,
  type MachineDriver,
  type MachineOperation,
  type MachineRequest,
  type MachineResult,
} from "@/lib/machines";
import { grantFor, MemoryEvidence, okResult, requestFor, sessions, T0 } from "./_helpers";

const NOW = () => new Date(T0);

function harness(driver: Partial<MachineDriver> & { execute?: MachineDriver["execute"] } = {}, opts: { transport?: MachineDriver["transport"] } = {}) {
  const transport = opts.transport ?? "aws_ssm";
  const executed: MachineRequest[] = [];
  const d: MachineDriver = {
    transport,
    supports: ["machine.inspect", "service.status", "machine.service.restart", "file.read", "container.logs", "machine.exec", "network.dnsCheck", "system.logs"],
    execute: async (req) => {
      executed.push(req);
      return okResult(req, { transport });
    },
    ...driver,
  };
  const evidence = new MemoryEvidence();
  const sess = sessions("session-token-object");
  const run = (req: MachineRequest, grant = grantFor(req.operation), signal = new AbortController().signal) =>
    executeMachineOperation(req, { grant, drivers: { [transport]: d }, sessions: sess, evidence, signal, now: NOW });
  return { d, run, executed, evidence, sess };
}

describe("happy path", () => {
  it("validates, runs inside a session scope with parsed args, and records one evidence record", async () => {
    const h = harness({ execute: async (req, session) => {
      h.executed.push(req);
      expect(session).toBe("session-token-object");
      return okResult(req, { transport: "aws_ssm" }, { unit: req.args.unit, loadState: "loaded", activeState: "active" });
    } });
    const res = await h.run(requestFor("service.status", { unit: "nginx.service" }));
    expect(res).toMatchObject({ ok: true, operation: "service.status", evidenceId: "ev-1" });
    expect(h.sess.opened).toBe(1);
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0].args).toEqual({ unit: "nginx.service" });
    expect(h.evidence.records).toHaveLength(1);
    expect(h.evidence.records[0]).toMatchObject({
      workspaceId: "ws-1",
      operationId: "op-1",
      kind: "machine_request",
      simulated: false,
      summary: { operation: "service.status", targetId: "i-0123456789abcdef0", transport: "aws_ssm", outcome: "succeeded", ok: true, args: { unit: "nginx.service" }, result: { activeState: "active" } },
    });
    expect(h.evidence.records[0].digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes the normalized arguments (defaults filled, paths canonical), not the caller's object", async () => {
    const h = harness();
    await h.run(requestFor("file.read", { path: "/var//log/./x.log" }));
    expect(h.executed[0].args).toEqual({ path: "/var/log/x.log", maxBytes: 65536 });
  });
});

describe("grant checks (defence in depth)", () => {
  const req = () => requestFor("service.status", { unit: "nginx.service" });
  const cases: [string, Parameters<typeof grantFor>[1], string][] = [
    ["wrong capability", { cap: "machine.service.restart" }, "grant_mismatch"],
    ["wrong operation id", { op: "some-other-op" }, "grant_mismatch"],
    ["wrong workspace", { ws: "ws-OTHER" }, "grant_mismatch"],
    ["wrong environment", { env: "env-OTHER" }, "grant_mismatch"],
    ["wrong resource", { res: "res-OTHER" }, "grant_mismatch"],
    ["no resource on a resource-scoped capability", { res: undefined }, "grant_mismatch"],
    ["expired", { exp: Math.floor(T0 / 1000) - 1 }, "grant_expired"],
    ["expires exactly now", { exp: Math.floor(T0 / 1000) }, "grant_expired"],
  ];
  it.each(cases)("refuses: %s", async (_name, over, code) => {
    const h = harness();
    const err = await h.run(req(), grantFor("service.status", over)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MachineOperationError);
    expect(err).toMatchObject({ code });
    // nothing ran, no credentials were requested
    expect(h.executed).toHaveLength(0);
    expect(h.sess.opened).toBe(0);
    // and the refusal is itself evidence
    expect(h.evidence.records).toHaveLength(1);
    expect(h.evidence.records[0].summary).toMatchObject({ outcome: "rejected", code });
  });

  it("a grant for a different capability cannot be used to escalate read-only to exec", async () => {
    const h = harness();
    const exec = requestFor("machine.exec", { argv: ["id"], timeoutSec: 5 });
    await expect(h.run(exec, grantFor("service.status"))).rejects.toMatchObject({ code: "grant_mismatch" });
    expect(h.executed).toHaveLength(0);
  });

  it("a grant naming an environment does not authorize a target without one", async () => {
    const h = harness();
    const r = requestFor("service.status", { unit: "a.service" });
    r.target = { ...r.target, environmentId: undefined };
    await expect(h.run(r)).rejects.toMatchObject({ code: "grant_mismatch" });
  });

  it("accepts a grant that matches on every scope field it carries", async () => {
    const h = harness();
    await expect(h.run(req(), grantFor("service.status", { env: undefined }))).resolves.toMatchObject({ ok: true });
  });
});

describe("grant constraints (policy restrict)", () => {
  it("lowers timeout and output budgets but never raises them", async () => {
    const h = harness();
    await h.run(requestFor("machine.inspect", {}, { timeoutSec: 120, maxOutputBytes: 500_000 }), grantFor("machine.inspect", { constraints: { maxTimeoutSec: 20, maxOutputBytes: 1000 } }));
    expect(h.executed[0]).toMatchObject({ timeoutSec: 20, maxOutputBytes: 1000 });
    await h.run(requestFor("machine.inspect", {}, { timeoutSec: 10, maxOutputBytes: 100 }), grantFor("machine.inspect", { constraints: { maxTimeoutSec: 200, maxOutputBytes: 9999 } }));
    expect(h.executed[1]).toMatchObject({ timeoutSec: 10, maxOutputBytes: 100 });
  });

  it("refuses lines above maxLines and paths outside pathPrefixes", async () => {
    const h = harness();
    await expect(h.run(requestFor("container.logs", { container: "web", lines: 600 }), grantFor("container.logs", { constraints: { maxLines: 500 } }))).rejects.toMatchObject({ code: "limit_exceeded" });
    await h.run(requestFor("container.logs", { container: "web", lines: 500 }), grantFor("container.logs", { constraints: { maxLines: 500 } }));

    const g = grantFor("file.read", { constraints: { pathPrefixes: ["/var/log/app/"] } });
    await expect(h.run(requestFor("file.read", { path: "/var/log/other/x.log" }), g)).rejects.toMatchObject({ code: "denied" });
    await expect(h.run(requestFor("file.read", { path: "/etc/nginx/nginx.conf" }), g)).rejects.toMatchObject({ code: "denied" });
    await expect(h.run(requestFor("file.read", { path: "/var/log/app/server.key" }), g)).rejects.toMatchObject({ code: "denied" });
    await expect(h.run(requestFor("file.read", { path: "/var/log/app/a.log" }), g)).resolves.toMatchObject({ ok: true });
    expect(h.executed.filter((r) => r.operation === "file.read")).toHaveLength(1);
  });

  it("constraints this executor cannot read fail closed; constraints for other executors are ignored", async () => {
    const h = harness();
    await expect(h.run(requestFor("machine.inspect", {}), grantFor("machine.inspect", { constraints: { maxTimeoutSec: "soon" } }))).rejects.toMatchObject({ code: "grant_mismatch" });
    await expect(h.run(requestFor("machine.inspect", {}), grantFor("machine.inspect", { constraints: { maxTimeoutSec: -5 } }))).rejects.toMatchObject({ code: "grant_mismatch" });
    await expect(h.run(requestFor("machine.inspect", {}), grantFor("machine.inspect", { constraints: { region: "eu-west-1", deployWindow: "weekdays" } }))).resolves.toMatchObject({ ok: true });
  });
});

describe("transport and operation support", () => {
  it("refuses a target whose transport has no driver", async () => {
    const h = harness();
    const r = requestFor("machine.inspect", {}, { transport: "azure_run_command" });
    await expect(h.run(r)).rejects.toMatchObject({ code: "unsupported_transport" });
    expect(h.evidence.records[0].summary).toMatchObject({ outcome: "rejected", code: "unsupported_transport" });
  });

  it("surfaces the driver's own explanation for an unsupported operation", async () => {
    const h = harness({ supports: ["machine.inspect"], unsupported: { "service.status": "no systemd here" } });
    await expect(h.run(requestFor("service.status", { unit: "a.service" }))).rejects.toMatchObject({ code: "unsupported_operation", message: "no systemd here" });
    await expect(h.run(requestFor("file.read", { path: "/var/log/x" }))).rejects.toMatchObject({ code: "unsupported_operation" });
  });

  it("operations in the vocabulary that nothing implements are refused as such", async () => {
    const h = harness({ supports: ["file.write" as MachineOperation] });
    await expect(h.run(requestFor("file.write", {}))).rejects.toMatchObject({ code: "unsupported_operation", message: expect.stringMatching(/no transport implements/) });
  });
});

describe("argument and envelope validation", () => {
  it("invalid args: field-level issues, no values, nothing executed", async () => {
    const h = harness();
    const err = (await h.run(requestFor("service.status", { unit: "CANARY;rm -rf /" })).catch((e: unknown) => e)) as MachineOperationError;
    expect(err.code).toBe("invalid_args");
    expect(err.detail.issues?.length).toBeGreaterThan(0);
    expect(JSON.stringify({ m: err.message, i: err.detail.issues })).not.toContain("CANARY");
    expect(JSON.stringify(h.evidence.records)).not.toContain("CANARY");
    expect(h.executed).toHaveLength(0);
  });

  it("a malformed envelope is refused without evidence (nothing trustworthy to attach it to)", async () => {
    const h = harness();
    const bad = { ...requestFor("machine.inspect", {}), timeoutSec: 9999 } as MachineRequest;
    await expect(h.run(bad)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(h.run({ ...requestFor("machine.inspect", {}), maxOutputBytes: 2 * 1024 * 1024 })).rejects.toMatchObject({ code: "invalid_request" });
    expect(h.evidence.records).toHaveLength(0);
  });

  it("a command's own timeout may not exceed the request's budget", async () => {
    const h = harness();
    await expect(h.run(requestFor("machine.exec", { argv: ["sleep", "100"], timeoutSec: 100 }, { timeoutSec: 30 }))).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(h.run(requestFor("machine.exec", { argv: ["sleep", "100"], timeoutSec: 100 }, { timeoutSec: 120 }), grantFor("machine.exec", { constraints: { maxTimeoutSec: 60 } }))).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(h.run(requestFor("machine.exec", { argv: ["true"], timeoutSec: 30 }, { timeoutSec: 30 }))).resolves.toMatchObject({ ok: true });
  });

  it("an already-aborted signal stops before anything happens", async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness();
    await expect(h.run(requestFor("machine.inspect", {}), grantFor("machine.inspect"), ac.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(h.sess.opened).toBe(0);
  });
});

describe("evidence never contains content", () => {
  const CANARY = "TOP-SECRET-FILE-CONTENT-7f3a";

  it("file.read: the result carries content, the evidence carries only path, sizes and flags", async () => {
    const h = harness({
      execute: async (req) => okResult(req, { transport: "aws_ssm" }, { path: "/var/log/app.log", sizeBytes: 40, bytesRead: 40, truncated: false, encoding: "utf8", content: `line\n${CANARY}\n`, sha256: "a".repeat(64) }),
    });
    const res = await h.run(requestFor("file.read", { path: "/var/log/app.log" }));
    expect(String(res.data.content)).toContain(CANARY);
    const ev = JSON.stringify(h.evidence.records);
    expect(ev).not.toContain(CANARY);
    expect(h.evidence.records[0].summary).toMatchObject({ args: { path: "/var/log/app.log", maxBytes: 65536 }, result: { sizeBytes: 40, bytesRead: 40, truncated: false } });
    expect(h.evidence.records[0].blob).toBeUndefined();
  });

  it("log, dns and list results are summarized by counts only", async () => {
    const h = harness({
      execute: async (req) => {
        if (req.operation === "container.logs") return okResult(req, { transport: "aws_ssm" }, { container: "web", lines: 2, content: `a\n${CANARY}\n`, truncated: false });
        if (req.operation === "system.logs") return okResult(req, { transport: "aws_ssm" }, { lines: 1, content: CANARY, truncated: false });
        return okResult(req, { transport: "aws_ssm" }, { name: "x.example.com", recordType: "TXT", resolved: true, answers: [CANARY, "b"] });
      },
    });
    await h.run(requestFor("container.logs", { container: "web" }));
    await h.run(requestFor("system.logs", {}));
    await h.run(requestFor("network.dnsCheck", { name: "x.example.com", recordType: "TXT" }));
    expect(JSON.stringify(h.evidence.records)).not.toContain(CANARY);
    expect(h.evidence.records[2].summary).toMatchObject({ answerCount: 2, result: { resolved: true } });
  });

  it("exec: argv and exit code are in the summary (redacted); full redacted output goes only to the blob", async () => {
    const h = harness({
      execute: async (req) =>
        okResult(req, { transport: "aws_ssm" }, { exitCode: 0 }, { output: { stdout: `out ${CANARY}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789`, stderr: "err", exitCode: 0, truncated: false } }),
    });
    await h.run(requestFor("machine.exec", { argv: ["curl", "-H", "X-Api-Key: hunter2hunter2", "--password=sup3rs3cret!", "https://u:pw123456@example.com/"], cwd: "/srv", timeoutSec: 10 }));
    const rec = h.evidence.records[0];
    const summary = JSON.stringify(rec.summary);
    expect(summary).not.toContain(CANARY); // stdout content is not in the summary
    expect(summary).not.toContain("hunter2hunter2");
    expect(summary).not.toContain("sup3rs3cret");
    expect(summary).not.toContain("pw123456");
    expect(rec.summary).toMatchObject({ exitCode: 0, stdoutBytes: expect.any(Number), args: { cwd: "/srv", timeoutSec: 10, argv: expect.any(Array) } });
    const blob = JSON.parse(rec.blob!) as { argv: string[]; stdout: string };
    expect(blob.argv[0]).toBe("curl");
    expect(blob.stdout).toContain(CANARY); // "recorded in full" — for exec only, and redacted
    expect(blob.stdout).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.stringify(blob)).not.toContain("sup3rs3cret");
  });

  it("failure results carry the failure code, not the reason text (which may quote file contents)", async () => {
    const h = harness({
      execute: async (req) => ({ ...okResult(req, { transport: "aws_ssm" }), ok: false, data: { error: "command_failed", reason: `head: ${CANARY}: Is a directory`, exitCode: 1 } }),
    });
    const res = await h.run(requestFor("file.read", { path: "/var/log/app.log" }));
    expect(res.ok).toBe(false);
    expect(JSON.stringify(h.evidence.records)).not.toContain(CANARY);
    expect(h.evidence.records[0].summary).toMatchObject({ outcome: "failed", result: { error: "command_failed", exitCode: 1 } });
  });
});

describe("redaction and output limits on the way out", () => {
  it("redacts credential patterns in content and exec output, and flags file/log results as redacted", async () => {
    const h = harness({
      execute: async (req) => {
        if (req.operation === "machine.exec") return okResult(req, { transport: "aws_ssm" }, { exitCode: 0 }, { output: { stdout: "key AKIAABCDEFGHIJKLMNOP\n", stderr: "password=hunter2hunter2", exitCode: 0, truncated: false } });
        return okResult(req, { transport: "aws_ssm" }, { path: "/var/log/a", bytesRead: 10, truncated: false, encoding: "utf8", content: "db_password = hunter2hunter2\nBearer abcdefghijklmnopqrstuvwxyz0123456789\n" });
      },
    });
    const f = await h.run(requestFor("file.read", { path: "/var/log/a" }));
    expect(String(f.data.content)).not.toContain("hunter2hunter2");
    expect(String(f.data.content)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(f.data.redacted).toBe(true);
    const e = await h.run(requestFor("machine.exec", { argv: ["env"], timeoutSec: 5 }));
    expect(e.output!.stdout).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(e.output!.stderr).not.toContain("hunter2hunter2");
  });

  it("does not flag clean content as redacted", async () => {
    const h = harness({ execute: async (req) => okResult(req, { transport: "aws_ssm" }, { path: "/var/log/a", bytesRead: 3, truncated: false, encoding: "utf8", content: "ok\n" }) });
    const f = await h.run(requestFor("file.read", { path: "/var/log/a" }));
    expect(f.data.redacted).toBeUndefined();
  });

  it("re-enforces maxOutputBytes even when a driver over-returns", async () => {
    const h = harness({
      execute: async (req) =>
        okResult(req, { transport: "aws_ssm" }, { path: "/var/log/a", bytesRead: 5000, truncated: false, encoding: "utf8", content: "é".repeat(2500) }, { output: { stdout: "x".repeat(5000), stderr: "y".repeat(5000), exitCode: 0, truncated: false } }),
    });
    const r = await h.run(requestFor("file.read", { path: "/var/log/a" }, { maxOutputBytes: 1000 }));
    expect(Buffer.byteLength(String(r.data.content))).toBeLessThanOrEqual(1000);
    expect(r.data.truncated).toBe(true);
    expect(Buffer.byteLength(r.output!.stdout)).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(r.output!.stderr)).toBeLessThanOrEqual(1000);
    expect(r.output!.truncated).toBe(true);
  });
});

describe("driver misbehaviour and failures", () => {
  it("a result for a different operation or transport is a protocol violation", async () => {
    const wrongOp = harness({ execute: async (req) => ({ ...okResult(req, { transport: "aws_ssm" }), operation: "machine.exec" as const }) });
    await expect(wrongOp.run(requestFor("machine.inspect", {}))).rejects.toMatchObject({ code: "protocol_violation" });
    const wrongTransport = harness({ execute: async (req) => okResult(req, { transport: "zenithd" }) });
    await expect(wrongTransport.run(requestFor("machine.inspect", {}))).rejects.toMatchObject({ code: "protocol_violation" });
  });

  it("unexpected throws become transport_error (with evidence); MachineOperationErrors pass through", async () => {
    const h = harness({ execute: async () => { throw new TypeError("boom"); } });
    await expect(h.run(requestFor("machine.inspect", {}))).rejects.toMatchObject({ code: "transport_error" });
    expect(h.evidence.records[0].summary).toMatchObject({ outcome: "rejected", code: "transport_error" });

    const u = harness({ execute: async () => { throw new MachineOperationError("uncertain", "maybe ran", { transportRef: "cmd-1" }); } });
    await expect(u.run(requestFor("machine.service.restart", { unit: "a.service" }))).rejects.toMatchObject({ code: "uncertain", transportRef: "cmd-1" });
    expect(u.evidence.records[0].summary).toMatchObject({ outcome: "uncertain", code: "uncertain", transportRef: "cmd-1" });
  });

  it("a credential broker denial is a denial, not a driver bug", async () => {
    const denied = Object.assign(new Error("denied"), { code: "credential_denied" });
    const h = harness();
    const ev = new MemoryEvidence();
    const res = executeMachineOperation(requestFor("machine.inspect", {}), {
      grant: grantFor("machine.inspect"),
      drivers: { aws_ssm: h.d },
      sessions: { withSession: async () => { throw denied; } },
      evidence: ev,
      signal: new AbortController().signal,
      now: NOW,
    });
    await expect(res).rejects.toMatchObject({ code: "denied" });
    expect(h.executed).toHaveLength(0);
  });

  it("evidence failure after execution is reported with the result attached, never swallowed", async () => {
    const h = harness();
    h.evidence.failWith = new Error("db down");
    const err = (await h.run(requestFor("machine.service.restart", { unit: "nginx.service" })).catch((e: unknown) => e)) as MachineOperationError;
    expect(err).toBeInstanceOf(MachineOperationError);
    expect(err.code).toBe("evidence_failed");
    expect(err.detail.result).toMatchObject({ ok: true, operation: "machine.service.restart" });
    expect(h.executed).toHaveLength(1); // it ran; the caller must know
  });

  it("a failing evidence sink never masks the original refusal", async () => {
    const h = harness();
    h.evidence.failWith = new Error("db down");
    await expect(h.run(requestFor("service.status", { unit: "a.service" }), grantFor("service.status", { ws: "other" }))).rejects.toMatchObject({ code: "grant_mismatch" });
  });
});

describe("simulated drivers", () => {
  it("results and evidence are labelled simulated, and the driver contacts nothing", async () => {
    const evidence = new MemoryEvidence();
    const drivers = createMachineDrivers({ sandbox: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await executeMachineOperation(requestFor("service.status", { unit: "nginx.service" }), {
      grant: grantFor("service.status"),
      drivers,
      sessions: sessions(undefined),
      evidence,
      signal: new AbortController().signal,
      now: NOW,
    });
    expect(res.simulated).toBe(true);
    expect(res.transportRef).toMatch(/^sim-/);
    expect(evidence.records[0].simulated).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("a rejected request to a simulated driver is still marked simulated in evidence", async () => {
    const evidence = new MemoryEvidence();
    await executeMachineOperation(requestFor("service.status", { unit: "bad unit" }), {
      grant: grantFor("service.status"),
      drivers: { aws_ssm: createSimulatedMachineDriver("aws_ssm") },
      sessions: sessions(),
      evidence,
      signal: new AbortController().signal,
      now: NOW,
    }).catch(() => undefined);
    expect(evidence.records[0].simulated).toBe(true);
  });
});

describe("driver table", () => {
  it("sandbox mode simulates every transport; production mode configures only what it is given", () => {
    const sandbox = createMachineDrivers({ sandbox: true });
    expect(Object.keys(sandbox).sort()).toEqual(["aws_ssm", "azure_run_command", "gcp_os_management", "kubernetes", "zenithd"]);
    const prod = createMachineDrivers({});
    expect(Object.keys(prod).sort()).toEqual(["aws_ssm", "kubernetes"]);
    const withAgent = createMachineDrivers({ dispatcher: { enqueue: async () => "m", await: async () => ({ status: "succeeded" }) } });
    expect(Object.keys(withAgent).sort()).toEqual(["aws_ssm", "kubernetes", "zenithd"]);
  });

  it("machineTransportFor resolves by target transport or refuses", () => {
    const prod = createMachineDrivers({});
    expect(machineTransportFor(requestFor("machine.inspect").target, prod).transport).toBe("aws_ssm");
    expect(() => machineTransportFor(requestFor("machine.inspect", {}, { transport: "zenithd" }).target, prod)).toThrowError(expect.objectContaining({ code: "unsupported_transport" }));
    expect(() => machineTransportFor(requestFor("machine.inspect", {}, { transport: "gcp_os_management" }).target, prod)).toThrow(MachineOperationError);
  });
});

describe("types stay honest", () => {
  it("MachineResult from a driver round-trips through the service without gaining fields", async () => {
    const h = harness();
    const res: MachineResult = await h.run(requestFor("machine.inspect", {}));
    expect(Object.keys(res).sort()).toEqual(["data", "evidenceId", "finishedAt", "ok", "operation", "simulated", "startedAt", "transport"]);
  });
});
