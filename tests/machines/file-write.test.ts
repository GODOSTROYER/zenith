/** Typed custody tests; actual mutation proof belongs to the Linux Go suite. */
import { validateMachineArgs, ZENITHD_OPERATIONS } from "@/lib/runners/payloads";
import { sha256Hex } from "@/lib/controlplane/digest";
import { describe, expect, it, vi } from "vitest";
import { createZenithdMachineDriver } from "@/lib/machines/transports/zenithd";
import { createSimulatedMachineDriver } from "@/lib/machines/transports/simulated";
import { parseMachineArgs } from "@/lib/machines/args";
import { MachineResultDataSchemas, MachineFailureDataSchema } from "@/lib/machines/results";
import { executeMachineOperation } from "@/lib/machines/service";
import { MachineOperationError } from "@/lib/machines/errors";
import { evidenceForResult } from "@/lib/machines/evidence";
import type { MachineDispatchOutcome, MachineRequestDispatcher } from "@/lib/machines/types";
import { grantFor, MemoryEvidence, requestFor, sessions, T0 } from "./_helpers";

const args = { path: "/opt/customer/settings.txt", contentRef: "settings", contentVersion: "c".repeat(64), expectedSha256: null };
const token = `fw_${"a".repeat(32)}`;
const data = { path: args.path, contentVersion: "c".repeat(64), changed: true, created: true, bytesWritten: 24, phase: "verified", effect: "committed", postcondition: "verified", transactionRef: token };
const req = () => requestFor("file.write", args, { transport: "zenithd", targetId: "mac_fixture" });
function harness(outcome: MachineDispatchOutcome = { status: "succeeded", result: data }) {
  const dispatcher: MachineRequestDispatcher = { enqueue: vi.fn(async () => "mreq_fixture"), await: vi.fn(async () => outcome) };
  const driver = createZenithdMachineDriver({ dispatcher, now: () => T0 });
  const evidence = new MemoryEvidence();
  const scope = sessions({ grantJws: "inert-local-grant" });
  return { driver, dispatcher, evidence, scope, run: (grant = grantFor("file.write")) => executeMachineOperation(req(), { grant, drivers: { zenithd: driver }, sessions: scope, evidence, signal: new AbortController().signal, now: () => new Date(T0) }) };
}

describe("bounded file.write contract", () => {
  it("preserves exact approved paths and opaque immutable refs", () => {
    expect(parseMachineArgs("file.write", args)).toEqual({ ok: true, args });
    for (const candidate of [
      { ...args, content: "inert-plaintext-marker" }, { ...args, url: "https://example.invalid/a" },
      { ...args, contentRef: "https://example.invalid/a" }, { ...args, contentRef: "../template" },
      { ...args, contentVersion: "$(id)" }, { ...args, contentRef: "settings\n" }, { ...args, contentVersion: "v1\r" }, { ...args, path: "/opt/customer/settings.txt\n" }, { ...args, expectedSha256: `${"a".repeat(64)}\n` }, { ...args, path: "/opt//customer/settings.txt" },
      { ...args, path: "/etc/app/settings.txt" }, { ...args, path: "/opt/customer/config.yaml" },
      { ...args, expectedSha256: "a".repeat(63) }, { ...args, mode: "0777" },
      { path: args.path, contentRef: "settings", contentVersion: "c".repeat(64) },
    ]) {
      const parsed = parseMachineArgs("file.write", candidate);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain("inert-plaintext-marker");
    }
  });
  it("admits metadata only, preserves uncertainty and refuses inconsistent success", () => {
    expect(MachineResultDataSchemas["file.write"].parse({ ...data, content: "inert-plaintext-marker", sourcePath: "/private/template" })).toEqual(data);
    expect(MachineResultDataSchemas["file.write"].safeParse({ ...data, transactionRef: undefined }).success).toBe(false);
    expect(MachineResultDataSchemas["file.write"].safeParse({ ...data, changed: false }).success).toBe(false);
    expect(MachineFailureDataSchema.parse({ error: "mutation_uncertain", phase: "rename", effect: "unknown", postcondition: "unverified", backupRef: token })).toMatchObject({ effect: "unknown", backupRef: token });
  });
  it("intersects signed scope, rejects unknown write constraints and exact-binding mismatches before dispatch", async () => {
    for (const constraints of [{ pathPrefixes: ["/opt/customer-other"] }, { pathPrefixes: ["/opt//customer"] }, { maxLines: 1 }, { desiredMode: "0600" }, { maxOutputBytes: 1024 }]) {
      const h = harness();
      await expect(h.run(grantFor("file.write", { constraints }))).rejects.toBeDefined();
      expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
    for (const grant of [grantFor("file.write", { op: "other" }), grantFor("file.write", { ws: "other" }), grantFor("file.write", { res: "other" }), grantFor("file.write", { res: undefined })]) {
      const h = harness();await expect(h.run(grant)).rejects.toMatchObject({ code: "grant_mismatch" });expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
    const h = harness();await expect(h.run(grantFor("file.write", { constraints: { pathPrefixes: ["/opt/customer"] } }))).resolves.toMatchObject({ ok: true, data });
    expect(h.dispatcher.enqueue).toHaveBeenCalledWith(req(), "inert-local-grant");
  });
  it("preserves agent phase/backup receipts without replay or fallback", async () => {
    const failed = { error: "mutation_uncertain", phase: "rename", effect: "unknown", postcondition: "unverified", backupRef: token, transactionRef: token };
    const h = harness({ status: "failed", result: failed });
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MachineOperationError);
    expect(error).toMatchObject({ code: "uncertain", retryable: false, transportRef: "mreq_fixture", detail: { result: { ok: false, data: failed, evidenceId: "ev-1" } } });
    expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(h.evidence.records[0].summary.result).toMatchObject(failed);
    for (const outcome of [{ status: "timed_out" }, { status: "failed", error: "inert-plaintext-marker" }, { status: "succeeded", result: { ...data, contentVersion: "v2" } }] as MachineDispatchOutcome[]) {
      const unknown = harness(outcome);await expect(unknown.run()).rejects.toMatchObject({ code: "uncertain", retryable: false });expect(unknown.dispatcher.enqueue).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(unknown.evidence.records)).not.toContain("inert-plaintext-marker");
    }
  });
  it("keeps customer bytes and prior hashes out of evidence summaries", async () => {
    const h = harness();const result = await h.run();
    const evidence = evidenceForResult(req(), { ...args, content: "inert-plaintext-marker", expectedSha256: "b".repeat(64) }, { ...result, data: { ...data, content: "inert-plaintext-marker" } });
    expect(evidence.blob).toBeUndefined();expect(JSON.stringify(evidence.summary)).not.toContain("inert-plaintext-marker");expect(JSON.stringify(evidence.summary)).not.toContain("b".repeat(64));
  });
  it("sandbox refuses the capability without fabricating a mutation", async () => {
    const driver = createSimulatedMachineDriver("zenithd");expect(driver.supports).not.toContain("file.write");await expect(driver.execute(req(), undefined, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
  });
});

it("write failure receipts cannot carry arbitrary status, reason or stdout text", async () => {
  const h = harness({ status: "failed", result: { error: "mutation_uncertain", phase: "rename", effect: "unknown", postcondition: "unverified", status: "inert-plaintext-marker", reason: "inert-plaintext-marker", content: "inert-plaintext-marker", backupRef: token }, output: { stdout: "inert-plaintext-marker", stderr: "inert-plaintext-marker" } });
  const error = await h.run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MachineOperationError);
  expect(error).toMatchObject({ code: "uncertain", retryable: false, detail: { result: { ok: false, data: { effect: "unknown" } } } });
  const result = (error as MachineOperationError).detail.result!;
  expect(result.output).toBeUndefined();expect(JSON.stringify(result)).not.toContain("inert-plaintext-marker");expect(h.evidence.records[0].summary.outcome).toBe("uncertain");expect(JSON.stringify(h.evidence.records)).not.toContain("inert-plaintext-marker");
  expect(h.evidence.records).toHaveLength(1);
  expect((error as Error).message).toBe("the machine write's durable outcome is unknown; it must never be re-dispatched");
});

it("shares the Go immutable profile version grammar and canonical metadata domain", () => {
  const metadata = { path: "/opt/customer/settings.txt", contentRef: "settings", sourcePath: "/opt/customer/templates/settings.txt", sha256: "a".repeat(64), mode: "0600", maxBytes: 1024, backupDir: "/opt/customer/backups", maxBackupBytes: 4096, maxBackups: 4 };
  const version = sha256Hex(`zenith.file.write.profile/v1\0${JSON.stringify(metadata)}`);
  expect(version).toBe("35151291277ab8b765fd6cd5495149778c3fa28673d82ac6d2b295aff74a9c82");
  expect(parseMachineArgs("file.write", { ...args, contentVersion: version }).ok).toBe(true);
  expect(parseMachineArgs("file.write", { ...args, contentVersion: "v1" }).ok).toBe(false);
});

describe("machine file.write payload admission", () => {
  it("admits each local mutation through its own strict typed metadata contract", () => {
    const upload = { path: args.path, sourceRef: "settings", sourceVersion: args.contentVersion, expectedSha256: null };
    const packageArgs = { profileRef: "app-package", profileVersion: args.contentVersion, expectedInstalledVersion: null };
    expect(ZENITHD_OPERATIONS).toContain("file.write");expect(ZENITHD_OPERATIONS).toContain("file.upload");expect(ZENITHD_OPERATIONS).toContain("package.install");
    expect(validateMachineArgs("file.write", args)).toEqual(args);
    expect(validateMachineArgs("file.upload", upload)).toEqual(upload);
    expect(validateMachineArgs("package.install", packageArgs)).toEqual(packageArgs);
    for (const [operation, foreignArgs] of [
      ["file.write", upload], ["file.write", packageArgs],
      ["file.upload", args], ["file.upload", packageArgs],
      ["package.install", args], ["package.install", upload],
    ] as const) expect(() => validateMachineArgs(operation, foreignArgs)).toThrow(/strict/);
    expect(validateMachineArgs("service.status", { unit: "fixture.service" })).toEqual({ unit: "fixture.service" });
  });
  it("rejects hostile contents and noncanonical paths before an envelope is signed", () => {
    for (const hostile of [{ ...args, content: "inert-plaintext-marker" }, { ...args, contentRef: "https://example.invalid/template" }, { ...args, path: "/opt//customer/settings.txt" }, { ...args, mode: "0777" }, { ...args, expectedSha256: undefined }]) {
      expect(() => validateMachineArgs("file.write", hostile)).toThrow(/strict local-template/);
      try { validateMachineArgs("file.write", hostile); } catch (e) { expect(String(e)).not.toContain("inert-plaintext-marker"); }
    }
  });
});
