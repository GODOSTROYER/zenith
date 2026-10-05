/** Modeled signed-boundary/transport custody for typed convergent service configuration. The Linux bytes and systemd convergence belong to the Go lane. */
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/controlplane/digest";
import { capability } from "@/lib/capabilities/catalog";
import { validateMachineArgs, ZENITHD_OPERATIONS } from "@/lib/runners/payloads";
import { parseMachineArgs } from "@/lib/machines/args";
import { MachineResultDataSchemas, ServiceConfigureFailureDataSchema } from "@/lib/machines/results";
import { executeMachineOperation } from "@/lib/machines/service";
import { evidenceForResult } from "@/lib/machines/evidence";
import { createZenithdMachineDriver } from "@/lib/machines/transports/zenithd";
import { createSimulatedMachineDriver } from "@/lib/machines/transports/simulated";
import { createAwsSsmMachineDriver } from "@/lib/machines/transports/aws-ssm";
import { createKubernetesMachineDriver } from "@/lib/machines/transports/kubernetes";
import type { MachineDispatchOutcome, MachineRequestDispatcher, MachineResult } from "@/lib/machines/types";
import { grantFor, MemoryEvidence, requestFor, sessions, T0 } from "./_helpers";

type ConfigureArgs = { unit: string; profileRef: string; profileVersion: string; expectedSha256: string | null };
const args: ConfigureArgs = { unit: "app.service", profileRef: "app-config", profileVersion: "c".repeat(64), expectedSha256: null };
const token = `fw_${"a".repeat(32)}`;
const data = { unit: args.unit, profileRef: args.profileRef, profileVersion: args.profileVersion, changed: true, created: true, bytesWritten: 24, action: "restart", activeState: "active", phase: "verified", effect: "committed", postcondition: "verified", transactionRef: token };
const request = (approvedArgs: ConfigureArgs = args) => requestFor("service.configure", approvedArgs, { transport: "zenithd", targetId: "mac_fixture" });

function harness(outcome: MachineDispatchOutcome = { status: "succeeded", result: data }, approvedArgs: ConfigureArgs = args) {
  const dispatcher: MachineRequestDispatcher = { enqueue: vi.fn(async () => "mreq_configure"), await: vi.fn(async () => outcome) };
  const driver = createZenithdMachineDriver({ dispatcher, now: () => T0 });
  const evidence = new MemoryEvidence();
  const scope = sessions({ grantJws: "inert-local-grant" });
  const run = (grant = grantFor("service.configure")) => executeMachineOperation(request(approvedArgs), { grant, drivers: { zenithd: driver }, sessions: scope, evidence, signal: new AbortController().signal, now: () => new Date(T0) });
  return { dispatcher, driver, evidence, scope, run };
}

describe("typed service configuration admission", () => {
  it("is a high-risk mutating resource-scoped capability, never an escape hatch", () => {
    expect(capability("service.configure")).toMatchObject({ mutates: true, risk: "high", defaultAutonomy: 5, scopeLevel: "resource" });
    expect(capability("service.configure")).not.toHaveProperty("escapeHatch");
    expect(ZENITHD_OPERATIONS).toContain("service.configure");
  });

  it("admits only unit, opaque profile ref/version and an explicit prior digest or null", () => {
    expect(validateMachineArgs("service.configure", args)).toEqual(args);
    expect(validateMachineArgs("service.configure", { ...args, expectedSha256: "b".repeat(64) })).toEqual({ ...args, expectedSha256: "b".repeat(64) });
    for (const candidate of [
      { ...args, expectedSha256: undefined },
      { ...args, expectedSha256: "*" },
      { ...args, path: "/opt/customer/app.conf" },
      { ...args, content: "inert-config-marker" },
      { ...args, command: "systemctl restart app.service" },
      { ...args, action: "restart" },
      { ...args, profileRef: "../escape" },
      { ...args, profileVersion: "v1" },
    ]) {
      expect(() => validateMachineArgs("service.configure", candidate)).toThrow(/strict pinned service configuration/);
      try { validateMachineArgs("service.configure", candidate); } catch (error) { expect(String(error)).not.toContain("inert-config-marker"); }
    }
  });

  it("refuses non-service, protected and option-shaped units without echoing values", () => {
    for (const unit of ["app.socket", "app.timer", "sshd.service", "zenithd.service", "zenith-runner.service", "systemd-resolved.service", "amazon-ssm-agent.service", "dbus.service", "-app.service", "app.service; id", "app", "a b.service"]) {
      const parsed = parseMachineArgs("service.configure", { ...args, unit });
      expect(parsed.ok, unit).toBe(false);
    }
    expect(parseMachineArgs("file.write", args).ok).toBe(false);
    expect(parseMachineArgs("machine.service.restart", args).ok).toBe(false);
  });

  it("pins a purpose-separated profile version domain that no other mutation can reuse", () => {
    const body = { unit: "app.service", profileRef: "app-config" };
    expect(sha256Hex(`zenith.service.configure.profile/v1\0${JSON.stringify(body)}`)).not.toBe(sha256Hex(`zenith.file.write.profile/v1\0${JSON.stringify(body)}`));
  });

  it("intersects exact operation tenant and resource scope before dispatch", async () => {
    for (const grant of [grantFor("machine.service.restart"), grantFor("file.write"), grantFor("service.configure", { op: "foreign" }), grantFor("service.configure", { ws: "foreign" }), grantFor("service.configure", { env: "foreign" }), grantFor("service.configure", { res: "foreign" }), grantFor("service.configure", { res: undefined })]) {
      const h = harness();
      await expect(h.run(grant)).rejects.toMatchObject({ code: "grant_mismatch" });
      expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
    const h = harness();
    await expect(h.run()).resolves.toMatchObject({ ok: true, data });
    expect(h.dispatcher.enqueue).toHaveBeenCalledWith(request(), "inert-local-grant");
  });

  it("refuses constraints the guest cannot enforce and inadequate metadata budgets", async () => {
    for (const constraints of [{ pathPrefixes: ["/opt/customer"] }, { maxLines: 1 }, { unitPrefix: "app" }, { maxOutputBytes: 1024 }, { maxTimeoutSec: 0 }]) {
      const h = harness();
      await expect(h.run(grantFor("service.configure", { constraints }))).rejects.toBeDefined();
      expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
    const h = harness();
    await expect(h.run(grantFor("service.configure", { constraints: { maxTimeoutSec: 60, maxOutputBytes: 4096 } }))).resolves.toMatchObject({ ok: true });
  });
});

describe("service configuration receipts", () => {
  it("roundtrips the longest accepted service unit and refuses overlimit or malformed units", async () => {
    const unit = `${"a".repeat(128)}.service`;
    const approved = { ...args, unit };
    const receipt = { ...data, unit };
    expect(unit).toHaveLength(136);
    expect(validateMachineArgs("service.configure", approved)).toEqual(approved);
    expect(MachineResultDataSchemas["service.configure"].parse(receipt)).toEqual(receipt);
    const h = harness({ status: "succeeded", result: receipt }, approved);
    await expect(h.run()).resolves.toMatchObject({ ok: true, data: receipt });
    expect(h.dispatcher.enqueue).toHaveBeenCalledWith(request(approved), "inert-local-grant");
    for (const invalid of [`${"a".repeat(129)}.service`, "appXservice", "app.socket", "app.service\n", "-app.service"]) {
      expect(parseMachineArgs("service.configure", { ...args, unit: invalid }).ok).toBe(false);
      expect(MachineResultDataSchemas["service.configure"].safeParse({ ...data, unit: invalid }).success).toBe(false);
    }
  });

  it("requires the exact unit, profile and consistent create/replace/converge receipt", async () => {
    expect(MachineResultDataSchemas["service.configure"].parse({ ...data, bytes: "inert-config-marker", path: "/opt/customer/app.conf" })).toEqual(data);
    for (const receipt of [
      { ...data, unit: "other.service" },
      { ...data, profileRef: "other" },
      { ...data, profileVersion: "b".repeat(64) },
      { ...data, transactionRef: undefined },
      { ...data, created: false, backupRef: undefined },
      { ...data, created: true, backupRef: token },
      { ...data, effect: "none" },
      { ...data, activeState: "failed" },
      { ...data, action: "stop" },
      { ...data, changed: false, created: true, bytesWritten: 0, effect: "none", action: "none", transactionRef: undefined },
    ]) {
      const h = harness({ status: "succeeded", result: receipt });
      await expect(h.run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
      expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    }
  });

  it("permits a verified converge noop, a converge-only restart and a replacement", async () => {
    const prior = { ...args, expectedSha256: "b".repeat(64) };
    const noop = { ...data, changed: false, created: false, bytesWritten: 0, action: "none", effect: "none", transactionRef: undefined };
    const convergeOnly = { ...noop, action: "restart", effect: "committed" };
    const replaced = { ...data, created: false, action: "reload", backupRef: token };
    for (const receipt of [noop, convergeOnly, replaced]) {
      const h = harness({ status: "succeeded", result: receipt }, prior);
      await expect(h.run()).resolves.toMatchObject({ ok: true, data: receipt });
      expect(h.evidence.records).toHaveLength(1);
    }
  });

  it("returns a definite retained failure when the unit does not verify healthy after the commit", async () => {
    const failed = { error: "service_failed", phase: "service_postcondition", effect: "committed", postcondition: "unverified", transactionRef: token, backupRef: token };
    const h = harness({ status: "failed", result: { ...failed, status: "inert-config-marker", reason: "inert-config-marker" }, output: { stdout: "inert-config-marker", stderr: "inert-config-marker" } });
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, data: failed, evidenceId: "ev-1" });
    expect(h.evidence.records[0].summary).toMatchObject({ outcome: "failed", ok: false, result: { error: "service_failed", effect: "committed" } });
    expect(JSON.stringify(h.evidence.records)).not.toContain("inert-config-marker");
    expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
  });

  it("retains unknown outcomes as uncertain custody and never dispatches again", async () => {
    const failed = { error: "mutation_uncertain", phase: "service_action", effect: "unknown", postcondition: "unverified", transactionRef: token, backupRef: token };
    const h = harness({ status: "failed", result: failed, output: { stdout: "inert-config-marker", stderr: "" } });
    const error: unknown = await h.run().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "uncertain", retryable: false, transportRef: "mreq_configure", detail: { result: { ok: false, data: failed, evidenceId: "ev-1" } } });
    expect(h.evidence.records[0].summary.outcome).toBe("uncertain");
    expect(JSON.stringify(error)).not.toContain("inert-config-marker");
    expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
  });

  it("reclassifies a retained uncertain result without dispatching again through the modeled runOnce contract", async () => {
    const h = harness({ status: "failed", result: { error: "mutation_uncertain", phase: "service_action", effect: "unknown", postcondition: "unverified", transactionRef: token } });
    let saved: Promise<MachineResult> | undefined;
    const evidence = { record: h.evidence.record.bind(h.evidence), runOnce: vi.fn(async (_request: unknown, execute: () => Promise<MachineResult>) => { saved ??= execute(); return saved; }) };
    const run = () => executeMachineOperation(request(), { grant: grantFor("service.configure"), drivers: { zenithd: h.driver }, sessions: h.scope, evidence, signal: new AbortController().signal, now: () => new Date(T0) });
    await expect(run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
    await expect(run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
    expect(evidence.runOnce).toHaveBeenCalledTimes(2);
    expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(h.evidence.records).toHaveLength(1);
  });

  it("refuses absent, timed-out and arbitrary-text custody as uncertain", async () => {
    for (const outcome of [{ status: "timed_out" }, { status: "failed", error: "inert-config-marker" }, { status: "succeeded" }, { status: "failed", result: { error: "service_failed", phase: "guard", effect: "committed", postcondition: "unverified" } }] satisfies MachineDispatchOutcome[]) {
      const h = harness(outcome);
      await expect(h.run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
      expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.evidence.records)).not.toContain("inert-config-marker");
    }
  });

  it("accepts a definite local refusal without promoting it to success", async () => {
    const h = harness({ status: "rejected", error: "inert-config-marker" });
    await expect(h.run()).resolves.toMatchObject({ ok: false, data: { error: "refused", phase: "guard", effect: "none", postcondition: "unverified" } });
    expect(JSON.stringify(h.evidence.records)).not.toContain("inert-config-marker");
  });

  it("keeps the failure effect receipt internally consistent", () => {
    const ok = (d: object) => ServiceConfigureFailureDataSchema.safeParse({ postcondition: "unverified", ...d }).success;
    expect(ok({ error: "refused", phase: "guard", effect: "none" })).toBe(true);
    expect(ok({ error: "service_failed", phase: "service_action", effect: "committed" })).toBe(true);
    expect(ok({ error: "mutation_uncertain", phase: "rename", effect: "unknown" })).toBe(true);
    expect(ok({ error: "refused", phase: "rename", effect: "none" })).toBe(false);
    expect(ok({ error: "service_failed", phase: "commit", effect: "committed" })).toBe(false);
    expect(ok({ error: "service_failed", phase: "service_action", effect: "none" })).toBe(false);
    expect(ok({ error: "mutation_uncertain", phase: "service_action", effect: "committed" })).toBe(false);
  });

  it("keeps file bytes, local paths and prior hashes out of evidence", async () => {
    const h = harness();
    const result = await h.run();
    const evidence = evidenceForResult(request(), { ...args, content: "inert-config-marker", path: "/opt/customer/app.conf", expectedSha256: "b".repeat(64) }, { ...result, data: { ...data, content: "inert-config-marker" } });
    expect(evidence.blob).toBeUndefined();
    for (const value of ["inert-config-marker", "/opt/customer/app.conf", "b".repeat(64)]) expect(JSON.stringify(evidence)).not.toContain(value);
    expect(evidence.summary.args).toEqual({ unit: args.unit, profileRef: args.profileRef, profileVersion: args.profileVersion });
  });
});

describe("transports that cannot custody service configuration", () => {
  it("cloud transports refuse before any modeled client or namespace API effect", async () => {
    const client = vi.fn(() => { throw new Error("unexpected modeled cloud client"); });
    const aws = createAwsSsmMachineDriver();
    expect(aws.supports).not.toContain("service.configure");
    expect(aws.unsupported?.["service.configure"]).toMatch(/local service profile/);
    await expect(aws.execute(requestFor("service.configure", args), { provider: "aws", client }, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(client).not.toHaveBeenCalled();
    const factory = vi.fn(() => { throw new Error("unexpected modeled namespace API"); });
    const kubernetes = createKubernetesMachineDriver({ clientFactory: factory });
    expect(kubernetes.supports).not.toContain("service.configure");
    await expect(kubernetes.execute(requestFor("service.configure", args, { transport: "kubernetes", targetId: "pods/team/web" }), { provider: "kubernetes", namespaces: ["team"], kubeConfig: () => ({}) }, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("simulation refuses rather than fabricating native filesystem and systemd evidence", async () => {
    const driver = createSimulatedMachineDriver("zenithd");
    expect(driver.supports).not.toContain("service.configure");
    await expect(driver.execute(request(), undefined, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
  });
});
