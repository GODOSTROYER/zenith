/**
 * The AWS SSM transport against `aws-sdk-client-mock`: what is sent (exactly
 * the parameters the document allows), how completion is awaited (backoff,
 * eventual consistency, deadline, abort), how every terminal status maps, and
 * the idempotency and exec-quoting rules. Nothing here talks to AWS.
 */
import {
  CancelCommandCommand,
  GetCommandInvocationCommand,
  ListCommandsCommand,
  SendCommandCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { MachineOperationError, argvToCommandLine, createAwsSsmMachineDriver, ssmCommentFor, type MachineRequest, type MachineResult } from "@/lib/machines";
import { awsSession, fakeClock, INSTANCE, requestFor } from "./_helpers";
import { OUT } from "./_ssm-output";
import { findSh } from "./_sh";

const ssm = mockClient(SSMClient);
const COMMAND_ID = "11111111-2222-3333-4444-555555555555";

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name });

function setup(opts: { [k: string]: unknown } = {}) {
  const clock = fakeClock();
  const driver = createAwsSsmMachineDriver({ sleep: clock.sleep, now: clock.now, random: () => 0.5, ...opts });
  const run = (req: MachineRequest, signal: AbortSignal = new AbortController().signal) => driver.execute(req, awsSession(), signal);
  return { clock, driver, run };
}

const sent = () => ssm.commandCalls(SendCommandCommand).map((c) => c.args[0].input);

function succeed(stdout: string, extra: Record<string, unknown> = {}) {
  ssm.on(ListCommandsCommand).resolves({ Commands: [] });
  ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
  ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: stdout, StandardErrorContent: "", ...extra });
}

beforeEach(() => ssm.reset());

describe("SendCommand: exactly what the document allows", () => {
  it("service.status sends one typed document call to one instance", async () => {
    succeed(OUT.serviceStatus);
    const { run } = setup();
    const res = await run(requestFor("service.status", { unit: "nginx.service" }));

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toEqual({
      InstanceIds: [INSTANCE],
      DocumentName: "Zenith-ServiceStatus",
      DocumentVersion: "$DEFAULT",
      Parameters: { unit: ["nginx.service"], executionTimeout: ["30"] },
      TimeoutSeconds: 60,
      Comment: ssmCommentFor(requestFor("service.status", { unit: "nginx.service" })),
    });
    expect(res).toMatchObject({ ok: true, operation: "service.status", transport: "aws_ssm", transportRef: COMMAND_ID, simulated: false });
    expect(res.data).toMatchObject({ unit: "nginx.service", activeState: "active", subState: "running" });
  });

  it("fills defaults and canonicalizes before sending (parsed args, not caller args)", async () => {
    succeed(OUT.systemLogs);
    const { run } = setup();
    await run(requestFor("system.logs", {}));
    expect(sent()[0].Parameters).toEqual({ since: ["1h"], lines: ["200"], executionTimeout: ["30"] });

    ssm.reset();
    succeed(OUT.fileRead("x"));
    await run(requestFor("file.read", { path: "/var//log/./app.log", maxBytes: 999999 }));
    // path canonicalized; maxBytes clamped to what SSM stdout can carry
    expect(sent()[0].Parameters).toEqual({ path: ["/var/log/app.log"], maxBytes: ["16384"], executionTimeout: ["30"] });
  });

  it.each([
    ["machine.inspect", {}, "Zenith-MachineInspect", {}],
    ["process.list", { limit: 10 }, "Zenith-ProcessList", { limit: ["10"], sortBy: ["cpu"] }],
    ["machine.service.restart", { unit: "nginx.service" }, "Zenith-ServiceRestart", { unit: ["nginx.service"] }],
    ["container.list", { all: true }, "Zenith-ContainerList", { all: ["true"], limit: ["100"] }],
    ["container.inspect", { container: "web" }, "Zenith-ContainerInspect", { container: ["web"] }],
    ["container.logs", { container: "web", since: "15m", lines: 50 }, "Zenith-ContainerLogs", { container: ["web"], since: ["15m"], lines: ["50"], timestamps: ["false"] }],
    ["network.portCheck", { host: "db.internal", port: 5432 }, "Zenith-PortCheck", { host: ["db.internal"], port: ["5432"], timeoutSec: ["5"] }],
    ["network.dnsCheck", { name: "example.com", recordType: "MX" }, "Zenith-DnsCheck", { name: ["example.com"], recordType: ["MX"] }],
    ["system.metrics", {}, "Zenith-SystemMetrics", {}],
    ["system.logs", { unit: "ssh.service", since: "2h", lines: 10 }, "Zenith-SystemLogs", { unit: ["ssh.service"], since: ["2h"], lines: ["10"] }],
  ] as const)("%s maps to %s with exact parameters", async (op, args, doc, params) => {
    succeed("zenith.unknown/v1\n"); // content is irrelevant here; only the request is asserted
    const { run } = setup();
    await run(requestFor(op, args as Record<string, unknown>)).catch(() => undefined);
    expect(sent()[0]).toMatchObject({ DocumentName: doc, Parameters: { ...params, executionTimeout: ["30"] } });
  });

  it("every parameter of every call conforms to the document's own allowedPattern (nothing reaches SSM that SSM would reject)", async () => {
    succeed("zenith.unknown/v1\n");
    const { run } = setup();
    const { ZENITH_SSM_DOCUMENTS, checkDocumentParameters, OPERATION_DOCUMENTS } = await import("@/lib/machines/transports/aws-ssm-docs");
    const calls: [Parameters<typeof requestFor>[0], Record<string, unknown>][] = [
      ["service.status", { unit: "a@b:c.service" }],
      ["container.logs", { container: "my-app_1.web", since: "7d", lines: 5000, timestamps: true }],
      ["network.dnsCheck", { name: "_sip._tcp.example.com", recordType: "SRV" }],
      ["file.read", { path: "/etc/nginx/conf.d/a+b@c.conf" }],
      ["network.portCheck", { host: "2001:db8::1", port: 65535, timeoutSec: 30 }],
    ];
    for (const [op, args] of calls) await run(requestFor(op, args)).catch(() => undefined);
    const i = sent().length;
    expect(i).toBe(calls.length);
    for (const input of sent()) {
      const doc = ZENITH_SSM_DOCUMENTS[Object.entries(OPERATION_DOCUMENTS).find(([, s]) => `Zenith-${s}` === input.DocumentName)![1]];
      const flat = Object.fromEntries(Object.entries(input.Parameters!).map(([k, v]) => [k, v[0]]));
      expect(checkDocumentParameters(doc, flat), input.DocumentName).toEqual([]);
    }
  });

  it("honours a custom document prefix and validates against the document as specialized for the environment", async () => {
    succeed(OUT.fileRead("x", 1, false, "/home/app/a.txt"));
    const { run } = setup({ documentPrefix: "Acme-", fileReadPrefixes: ["/home/app/"] });
    // /home/app/ is not in the shipped default document; the environment's specialized document allows it
    await expect(run(requestFor("file.read", { path: "/home/app/a.txt" }))).resolves.toMatchObject({ ok: true });
    expect(sent()[0]).toMatchObject({ DocumentName: "Acme-FileRead", Parameters: { path: ["/home/app/a.txt"] } });
    // and the default allowlist no longer applies
    await expect(run(requestFor("file.read", { path: "/var/log/a.log" }))).rejects.toMatchObject({ code: "denied" });
  });

  it("a restart allowlist on the environment's document is enforced locally too", async () => {
    succeed(OUT.serviceRestart);
    const { run } = setup({ restartAllow: ["nginx.service"] });
    await expect(run(requestFor("machine.service.restart", { unit: "nginx.service" }))).resolves.toMatchObject({ ok: true });
    await expect(run(requestFor("machine.service.restart", { unit: "postgresql.service" }))).rejects.toMatchObject({ code: "invalid_args", detail: { issues: ["unit: does not match the document's allowedPattern"] } });
    expect(sent()).toHaveLength(1);
  });

  it("a value that passes argument validation but not the document's own pattern is refused locally, not by SSM", async () => {
    const { run } = setup();
    // 1005 characters after /var/log/ is a valid path for args (<= 1024) but longer than the document's pattern allows
    const path = `/var/log/${"a".repeat(1005)}`;
    await expect(run(requestFor("file.read", { path }))).rejects.toMatchObject({ code: "invalid_args" });
    expect(ssm.calls()).toHaveLength(0);
  });
});

describe("refusals happen before any AWS call", () => {
  const calls = () => ssm.calls().length;

  it("hostile arguments never reach SSM", async () => {
    const { run } = setup();
    const evil: [Parameters<typeof requestFor>[0], Record<string, unknown>][] = [
      ["service.status", { unit: "nginx.service; id" }],
      ["machine.service.restart", { unit: "sshd.service" }],
      ["file.read", { path: "/var/log/../../etc/shadow" }],
      ["network.portCheck", { host: "169.254.169.254", port: 80 }],
      ["machine.exec", { argv: ["a\0b"], timeoutSec: 5 }],
      ["system.logs", { since: "8d" }],
    ];
    for (const [op, args] of evil) {
      await expect(run(requestFor(op, args)), op).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls()).toBe(0);
  });

  it("file.read outside the allowlist or on a secret-like name is denied locally", async () => {
    const { run } = setup();
    await expect(run(requestFor("file.read", { path: "/etc/passwd" }))).rejects.toMatchObject({ code: "denied" });
    await expect(run(requestFor("file.read", { path: "/var/log/server.key" }))).rejects.toMatchObject({ code: "denied" });
    await expect(run(requestFor("file.read", { path: "/srv/app/.env" }))).rejects.toMatchObject({ code: "denied" });
    expect(calls()).toBe(0);
  });

  it("requires a container for Docker-backed operations and refuses the Kubernetes-only selector", async () => {
    const { run } = setup();
    await expect(run(requestFor("container.inspect", {}))).rejects.toMatchObject({ code: "invalid_args" });
    await expect(run(requestFor("container.logs", {}))).rejects.toMatchObject({ code: "invalid_args" });
    await expect(run(requestFor("container.list", { labelSelector: "app=web" }))).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls()).toBe(0);
  });

  it("refuses non-AWS sessions, bad instance ids and unsupported operations", async () => {
    const { driver } = setup();
    const req = requestFor("machine.inspect", {});
    await expect(driver.execute(req, { provider: "gcp" }, new AbortController().signal)).rejects.toMatchObject({ code: "transport_error" });
    await expect(driver.execute(req, undefined, new AbortController().signal)).rejects.toMatchObject({ code: "transport_error" });
    await expect(driver.execute(requestFor("machine.inspect", {}, { targetId: "web-1; id" }), awsSession(), new AbortController().signal)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(driver.execute(requestFor("container.exec", { argv: ["ls"], timeoutSec: 5 }), awsSession(), new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
    await expect(driver.execute(requestFor("file.write", {}), awsSession(), new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(driver.supports).not.toContain("container.exec");
    expect(driver.unsupported?.["container.exec"]).toMatch(/machine\.exec/);
    expect(calls()).toBe(0);
  });
});

describe("polling GetCommandInvocation", () => {
  it("waits with capped exponential backoff and tolerates the invocation not existing yet", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm
      .on(GetCommandInvocationCommand)
      .rejectsOnce(awsError("InvocationDoesNotExist"))
      .rejectsOnce(awsError("InvocationDoesNotExist"))
      .resolvesOnce({ Status: "Pending" })
      .resolvesOnce({ Status: "InProgress" })
      .resolvesOnce({ Status: "InProgress" })
      .resolvesOnce({ Status: "Delayed" })
      .resolvesOnce({ Status: "InProgress" })
      .resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: OUT.serviceStatus, StandardErrorContent: "" });
    const { run, clock } = setup();
    const res = await run(requestFor("service.status", { unit: "nginx.service" }));
    expect(res.ok).toBe(true);
    // 500 · 1.6ⁿ, capped at 5000, with jitter pinned to 1.0
    expect(clock.sleeps).toEqual([500, 800, 1280, 2048, 3277, 5000, 5000, 5000]);
    const polls = ssm.commandCalls(GetCommandInvocationCommand).map((c) => c.args[0].input);
    expect(polls).toHaveLength(8);
    expect(polls.every((p) => p.CommandId === COMMAND_ID && p.InstanceId === INSTANCE)).toBe(true);
  });

  it("treats throttling of the poll as transient, but fails on other errors with the command id attached", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm
      .on(GetCommandInvocationCommand)
      .rejectsOnce(awsError("ThrottlingException"))
      .resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: OUT.inspect, StandardErrorContent: "" });
    const { run } = setup();
    await expect(run(requestFor("machine.inspect", {}))).resolves.toMatchObject({ ok: true });

    ssm.reset();
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).rejects(awsError("AccessDeniedException"));
    const err = await run(requestFor("machine.inspect", {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MachineOperationError);
    expect(err).toMatchObject({ code: "transport_error", transportRef: COMMAND_ID, message: expect.stringContaining("AWS denied the SSM call") });
    // a non-transient poll error stops the loop at once instead of retrying until the deadline
    expect(ssm.commandCalls(GetCommandInvocationCommand)).toHaveLength(1);
  });

  it("read-only request past its deadline: ok:false timeout, and the command is cancelled", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "InProgress" });
    ssm.on(CancelCommandCommand).resolves({});
    const { run, clock } = setup();
    const res = await run(requestFor("system.metrics", {}, { timeoutSec: 10 }));
    expect(res).toMatchObject({ ok: false, data: { error: "timeout", timedOut: true }, transportRef: COMMAND_ID });
    // deadline = timeoutSec + delivery timeout (60) + grace (15)
    expect(clock.now() - Date.UTC(2026, 8, 30, 12, 0, 0)).toBeGreaterThanOrEqual(85_000);
    expect(ssm.commandCalls(CancelCommandCommand)[0].args[0].input).toEqual({ CommandId: COMMAND_ID, InstanceIds: [INSTANCE] });
  });

  it("a MUTATING request past its deadline is uncertain, carries the command id and is never cancelled", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "InProgress" });
    const { run } = setup();
    const err = await run(requestFor("machine.service.restart", { unit: "nginx.service" }, { timeoutSec: 5 })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "uncertain", transportRef: COMMAND_ID });
    expect(ssm.commandCalls(CancelCommandCommand)).toHaveLength(0);
  });

  it("abort while waiting: aborted for reads, uncertain for mutations", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "InProgress" });
    const ac = new AbortController();
    const clock = fakeClock();
    const driver = createAwsSsmMachineDriver({
      now: clock.now,
      random: () => 0.5,
      sleep: async (ms, signal) => {
        clock.advance(ms);
        ac.abort();
        signal.throwIfAborted();
      },
    });
    const read = await driver.execute(requestFor("machine.inspect", {}), awsSession(), ac.signal).catch((e: unknown) => e);
    expect(read).toMatchObject({ code: "aborted" });

    const ac2 = new AbortController();
    const driver2 = createAwsSsmMachineDriver({ now: clock.now, sleep: async (_ms, signal) => { ac2.abort(); signal.throwIfAborted(); } });
    const write = await driver2.execute(requestFor("machine.service.restart", { unit: "nginx.service" }), awsSession(), ac2.signal).catch((e: unknown) => e);
    expect(write).toMatchObject({ code: "uncertain", transportRef: COMMAND_ID });
  });

  it("an already-aborted signal stops before sending anything", async () => {
    const ac = new AbortController();
    ac.abort();
    const { run } = setup();
    await expect(run(requestFor("machine.inspect", {}), ac.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(sent()).toHaveLength(0);
  });
});

describe("status mapping", () => {
  const fail = async (inv: Record<string, unknown>, op: "service.status" | "machine.inspect" = "machine.inspect"): Promise<MachineResult> => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves(inv);
    const { run } = setup();
    return run(requestFor(op, op === "service.status" ? { unit: "nginx.service" } : {}));
  };

  it.each([
    [64, "invalid_parameters"],
    [65, "refused"],
    [66, "not_found"],
    [69, "unavailable"],
    [1, "command_failed"],
    [127, "command_failed"],
  ])("Failed with exit code %s -> %s (reason from stderr, never stdout)", async (code, error) => {
    const res = await fail({ Status: "Failed", StatusDetails: "Failed", ResponseCode: code, StandardOutputContent: "SECRET-IN-STDOUT", StandardErrorContent: "reason line\nsecond line" });
    expect(res).toMatchObject({ ok: false, data: { error, reason: "reason line", exitCode: code, status: "Failed" } });
    expect(JSON.stringify(res)).not.toContain("SECRET-IN-STDOUT");
  });

  it("TimedOut: delivery timeout vs execution timeout are different facts", async () => {
    expect(await fail({ Status: "TimedOut", StatusDetails: "DeliveryTimedOut", ResponseCode: -1, StandardOutputContent: "", StandardErrorContent: "" })).toMatchObject({ ok: false, data: { error: "delivery_failed", timedOut: true } });
    expect(await fail({ Status: "TimedOut", StatusDetails: "ExecutionTimedOut", ResponseCode: -1, StandardOutputContent: "", StandardErrorContent: "" })).toMatchObject({ ok: false, data: { error: "timeout", timedOut: true } });
  });

  it("Cancelled and never-started Failed", async () => {
    expect(await fail({ Status: "Cancelled", StatusDetails: "Cancelled", ResponseCode: -1, StandardOutputContent: "", StandardErrorContent: "" })).toMatchObject({ ok: false, data: { error: "cancelled" } });
    expect(await fail({ Status: "Failed", StatusDetails: "Undeliverable", ResponseCode: -1, StandardOutputContent: "", StandardErrorContent: "" })).toMatchObject({ ok: false, data: { error: "delivery_failed" } });
  });

  it("Success with output that does not match the document is unexpected_output, not data", async () => {
    const res = await fail({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: "hello from a rogue script\n", StandardErrorContent: "" });
    expect(res).toMatchObject({ ok: false, data: { error: "unexpected_output" } });
  });

  it("output at the 24,000-character SSM cap is reported honestly, never parsed as complete", async () => {
    const res = await fail({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: OUT.inspect + "x".repeat(24000 - OUT.inspect.length), StandardErrorContent: "" });
    expect(res).toMatchObject({ ok: false, data: { error: "unexpected_output" } });
    expect(String(res.data.reason)).toContain("24,000");
  });
});

describe("idempotency: Comment and duplicate avoidance", () => {
  const req = () => requestFor("machine.service.restart", { unit: "nginx.service" });
  const comment = () => ssmCommentFor(req());

  it("Comment encodes the operation id and a request hash, within SSM's 100 characters", () => {
    expect(comment()).toMatch(/^zenith:op-1:[0-9a-f]{12}$/);
    const long = requestFor("machine.inspect", {}, { operationId: "o".repeat(128) });
    expect(ssmCommentFor(long).length).toBeLessThanOrEqual(100);
    expect(ssmCommentFor(long)).toMatch(/^zenith:h[0-9a-f]{24}:[0-9a-f]{12}$/);
    expect(ssmCommentFor(long)).toBe(ssmCommentFor(long));
  });

  it("two different requests under one operation id never share a Comment", () => {
    const a = ssmCommentFor(requestFor("service.status", { unit: "a.service" }));
    const b = ssmCommentFor(requestFor("service.status", { unit: "b.service" }));
    const c = ssmCommentFor(requestFor("service.status", { unit: "a.service" }, { targetId: "i-0fedcba9876543210" }));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("a retry whose Comment already exists polls the existing command instead of sending another", async () => {
    ssm.on(ListCommandsCommand).resolves({
      Commands: [
        { CommandId: "99999999-0000-0000-0000-000000000000", Comment: "zenith:other-op:aaaaaaaaaaaa", DocumentName: "Zenith-ServiceRestart" },
        { CommandId: COMMAND_ID, Comment: comment(), DocumentName: "Zenith-ServiceRestart", RequestedDateTime: new Date(2026, 8, 30) },
      ],
    });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: OUT.serviceRestart, StandardErrorContent: "" });
    const { run } = setup();
    const res = await run(req());
    expect(sent()).toHaveLength(0);
    expect(res).toMatchObject({ ok: true, transportRef: COMMAND_ID });
    const list = ssm.commandCalls(ListCommandsCommand)[0].args[0].input;
    expect(list.InstanceId).toBe(INSTANCE);
    expect(list.Filters).toEqual([
      { key: "DocumentName", value: "Zenith-ServiceRestart" },
      { key: "InvokedAfter", value: new Date(Date.UTC(2026, 8, 30, 12, 0, 0) - 6 * 3600_000).toISOString() },
    ]);
  });

  it("finds the match on a later page, and picks the earliest when several exist", async () => {
    ssm
      .on(ListCommandsCommand)
      .resolvesOnce({ Commands: [{ CommandId: "a".repeat(8), Comment: "nope" }], NextToken: "t1" })
      .resolvesOnce({
        Commands: [
          { CommandId: "22222222-0000-0000-0000-000000000000", Comment: comment(), RequestedDateTime: new Date(2026, 8, 30, 11, 0, 5) },
          { CommandId: COMMAND_ID, Comment: comment(), RequestedDateTime: new Date(2026, 8, 30, 11, 0, 1) },
        ],
      });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: OUT.serviceRestart, StandardErrorContent: "" });
    const { run } = setup();
    const res = await run(req());
    expect(res.transportRef).toBe(COMMAND_ID);
    expect(ssm.commandCalls(ListCommandsCommand)[1].args[0].input.NextToken).toBe("t1");
    expect(sent()).toHaveLength(0);
  });

  it("a different request (other args) does not match and sends a new command", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [{ CommandId: "x".repeat(36), Comment: ssmCommentFor(requestFor("machine.service.restart", { unit: "other.service" })) }] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: OUT.serviceRestart, StandardErrorContent: "" });
    const { run } = setup();
    await run(req());
    expect(sent()).toHaveLength(1);
  });

  it("the duplicate lookup is bounded to a few pages", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [], NextToken: "more" });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: OUT.inspect, StandardErrorContent: "" });
    const { run } = setup();
    await run(requestFor("machine.inspect", {}));
    expect(ssm.commandCalls(ListCommandsCommand)).toHaveLength(4);
  });

  it("a previously failed command is reported as it was, never silently re-sent", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [{ CommandId: COMMAND_ID, Comment: comment() }] });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Failed", StatusDetails: "Failed", ResponseCode: 1, StandardOutputContent: "", StandardErrorContent: "boom" });
    const { run } = setup();
    const res = await run(req());
    expect(res).toMatchObject({ ok: false, data: { error: "command_failed", reason: "boom" } });
    expect(sent()).toHaveLength(0);
  });
});

describe("AWS error mapping", () => {
  const send = async (err: Error, op: Parameters<typeof requestFor>[0] = "machine.inspect", args: Record<string, unknown> = {}) => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).rejects(err);
    const { run } = setup();
    return run(requestFor(op, args)).catch((e: unknown) => e);
  };

  it.each([
    ["InvalidInstanceId", "target_unreachable", false],
    ["InvalidParameters", "invalid_args", false],
    ["InvalidDocument", "transport_error", false],
    ["UnsupportedPlatformType", "unsupported_operation", false],
    ["ThrottlingException", "transport_error", true],
    ["AccessDeniedException", "transport_error", false],
    ["InternalServerError", "transport_error", false],
  ])("SendCommand %s -> %s (retryable %s)", async (name, code, retryable) => {
    const err = await send(awsError(name));
    expect(err).toBeInstanceOf(MachineOperationError);
    expect(err).toMatchObject({ code });
    expect((err as MachineOperationError).retryable).toBe(retryable);
  });

  it("the error message redacts credential-shaped text from AWS messages", async () => {
    const err = (await send(awsError("SomethingWeird", "failed with token AKIAABCDEFGHIJKLMNOP and password=hunter2hunter2"))) as MachineOperationError;
    expect(err.message).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(err.message).not.toContain("hunter2hunter2");
  });

  it("a SendCommand failure is NOT uncertain (nothing was sent); a poll failure after send is, for mutations", async () => {
    const before = await send(awsError("InvalidInstanceId"), "machine.service.restart", { unit: "nginx.service" });
    expect(before).toMatchObject({ code: "target_unreachable" });

    ssm.reset();
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).rejects(awsError("InternalServerError"));
    const { run } = setup();
    const after = await run(requestFor("machine.service.restart", { unit: "nginx.service" })).catch((e: unknown) => e);
    expect(after).toMatchObject({ code: "uncertain", transportRef: COMMAND_ID });
    const readOnly = await run(requestFor("machine.inspect", {})).catch((e: unknown) => e);
    expect(readOnly).toMatchObject({ code: "transport_error", transportRef: COMMAND_ID });
  });

  it("SendCommand without a command id is a protocol violation", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({});
    const { run } = setup();
    await expect(run(requestFor("machine.inspect", {}))).rejects.toMatchObject({ code: "protocol_violation" });
  });
});

describe("machine.exec through AWS-RunShellScript", () => {
  const exec = (argv: string[], extra: Record<string, unknown> = {}) => requestFor("machine.exec", { argv, timeoutSec: 20, ...extra });

  it("golden quoting: every element single-quoted, embedded quotes as '\\'' and nothing else escaped", () => {
    const golden: [string[], string][] = [
      [["echo", "hello"], `'echo' 'hello'`],
      [["echo", "a b", "c;d"], `'echo' 'a b' 'c;d'`],
      [["echo", "it's"], `'echo' 'it'\\''s'`],
      [["echo", "'"], `'echo' ''\\'''`],
      [["echo", "''"], `'echo' ''\\'''\\'''`],
      [["echo", "$(id)", "`id`", "$HOME", "${X}", "&&", "|", ">", "*", "?", "\\"], `'echo' '$(id)' '\`id\`' '$HOME' '\${X}' '&&' '|' '>' '*' '?' '\\'`],
      [["echo", ""], `'echo' ''`],
      [["printf", "%s", "line1\nline2"], `'printf' '%s' 'line1\nline2'`],
      [["echo", "ünïcödé ☃"], `'echo' 'ünïcödé ☃'`],
      [["/usr/bin/env", "A=b c"], `'/usr/bin/env' 'A=b c'`],
    ];
    for (const [argv, line] of golden) expect(argvToCommandLine(argv), JSON.stringify(argv)).toBe(line);
  });

  it("a shell reading the quoted line recovers exactly the original argv (real sh, hostile elements)", () => {
    const sh = findSh();
    if (!sh) return;
    const argv = ["echo", "it's", "$(touch /tmp/zenith-pwned)", "`id`", "a b;c|d&e", "line1\nline2", "", "'", "''", "\\", '"', "$HOME", "${X}", "*", "~", "!x", "#c", "{a,b}", "tab\there"];
    const r = sh(`set -- ${argvToCommandLine(argv)}\nprintf '%s\\n' "$#"\nfor a in "$@"; do printf '[%s]\\n' "$a"; done\ntest ! -e /tmp/zenith-pwned && echo clean`);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout.split("\n");
    expect(out[0]).toBe(String(argv.length));
    // element boundaries survive, including newlines inside an element
    expect(out.slice(1).join("\n")).toBe(argv.map((a) => `[${a}]`).join("\n") + "\nclean\n");
  });

  it("sends one quoted command line, the working directory and the command's own timeout", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: "ok\n", StandardErrorContent: "" });
    const { run } = setup();
    const res = await run(exec(["echo", "it's $HOME", "a;b"], { cwd: "/srv//app/" }));
    expect(sent()[0]).toEqual({
      InstanceIds: [INSTANCE],
      DocumentName: "AWS-RunShellScript",
      DocumentVersion: "$DEFAULT",
      Parameters: { commands: [`'echo' 'it'\\''s $HOME' 'a;b'`], executionTimeout: ["20"], workingDirectory: ["/srv/app"] },
      TimeoutSeconds: 60,
      Comment: ssmCommentFor(exec(["echo", "it's $HOME", "a;b"], { cwd: "/srv//app/" })),
    });
    expect(res).toMatchObject({ ok: true, data: { exitCode: 0 }, output: { stdout: "ok\n", stderr: "", exitCode: 0, truncated: false } });
  });

  it("refuses any element that would let SSM interpolate {{ }} (Parameter Store reads) before the shell runs", async () => {
    const { run } = setup();
    await expect(run(exec(["echo", "{{ssm:/prod/db/password}}"]))).rejects.toMatchObject({ code: "invalid_args" });
    await expect(run(exec(["echo", "x{{ y }}"]))).rejects.toMatchObject({ code: "invalid_args" });
    expect(ssm.calls()).toHaveLength(0);
    // a lone brace is fine
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: "", StandardErrorContent: "" });
    await expect(run(exec(["echo", "{", "}", "{x}"]))).resolves.toMatchObject({ ok: true });
  });

  it("non-zero exit is ok:false with stdout and stderr and the exit code; truncation is flagged", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Failed", StatusDetails: "Failed", ResponseCode: 3, StandardOutputContent: "out", StandardErrorContent: "x".repeat(8000) });
    const { run } = setup();
    const res = await run(exec(["false"]));
    expect(res.ok).toBe(false);
    expect(res.data).toEqual({ exitCode: 3 });
    expect(res.output).toMatchObject({ stdout: "out", exitCode: 3, truncated: true }); // stderr hit SSM's 8,000-character cap
  });

  it("bounds captured output by the request's maxOutputBytes", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "Success", StatusDetails: "Success", ResponseCode: 0, StandardOutputContent: "é".repeat(1000), StandardErrorContent: "" });
    const { run } = setup();
    const res = await run({ ...exec(["cat", "/x"]), maxOutputBytes: 101 });
    expect(Buffer.byteLength(res.output!.stdout)).toBeLessThanOrEqual(101);
    expect(res.output!.stdout.endsWith("é")).toBe(true); // cut on a code-point boundary
    expect(res.output!.truncated).toBe(true);
  });

  it("an execution timeout is ok:false with timedOut, not an error", async () => {
    ssm.on(ListCommandsCommand).resolves({ Commands: [] });
    ssm.on(SendCommandCommand).resolves({ Command: { CommandId: COMMAND_ID } });
    ssm.on(GetCommandInvocationCommand).resolves({ Status: "TimedOut", StatusDetails: "ExecutionTimedOut", ResponseCode: -1, StandardOutputContent: "partial", StandardErrorContent: "" });
    const { run } = setup();
    const res = await run(exec(["sleep", "999"]));
    expect(res).toMatchObject({ ok: false, data: { exitCode: null, timedOut: true }, output: { stdout: "partial", exitCode: null } });
  });
});
