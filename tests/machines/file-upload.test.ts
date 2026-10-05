/** Modeled signed-boundary/transport custody. Linux bytes belong to the Go lane. */
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/controlplane/digest";
import { validateMachineArgs, ZENITHD_OPERATIONS } from "@/lib/runners/payloads";
import { parseMachineArgs } from "@/lib/machines/args";
import { MachineResultDataSchemas, FileWriteFailureDataSchema } from "@/lib/machines/results";
import { executeMachineOperation } from "@/lib/machines/service";
import { evidenceForResult } from "@/lib/machines/evidence";
import { createZenithdMachineDriver } from "@/lib/machines/transports/zenithd";
import { createSimulatedMachineDriver } from "@/lib/machines/transports/simulated";
import { createAwsSsmMachineDriver } from "@/lib/machines/transports/aws-ssm";
import { createKubernetesMachineDriver } from "@/lib/machines/transports/kubernetes";
import type { MachineDispatchOutcome, MachineRequestDispatcher, MachineResult } from "@/lib/machines/types";
import { grantFor, MemoryEvidence, requestFor, sessions, T0 } from "./_helpers";

type UploadArgs = { path: string; sourceRef: string; sourceVersion: string; expectedSha256: string | null };
const args: UploadArgs = { path: "/opt/customer/model.bin", sourceRef: "model", sourceVersion: "c".repeat(64), expectedSha256: null };
const token = `fw_${"a".repeat(32)}`;
const data = { path: args.path, sourceVersion: args.sourceVersion, changed: true, created: true, bytesWritten: 8, phase: "verified", effect: "committed", postcondition: "verified", transactionRef: token };
const request = (approvedArgs: UploadArgs = args) => requestFor("file.upload", approvedArgs, { transport: "zenithd", targetId: "mac_fixture" });

function harness(outcome: MachineDispatchOutcome = { status: "succeeded", result: data }, approvedArgs: UploadArgs = args) {
  const dispatcher: MachineRequestDispatcher = { enqueue: vi.fn(async () => "mreq_upload"), await: vi.fn(async () => outcome) };
  const driver = createZenithdMachineDriver({ dispatcher, now: () => T0 });
  const evidence = new MemoryEvidence();
  const scope = sessions({ grantJws: "inert-local-grant" });
  const run = (grant = grantFor("file.upload")) => executeMachineOperation(request(approvedArgs), { grant, drivers: { zenithd: driver }, sessions: scope, evidence, signal: new AbortController().signal, now: () => new Date(T0) });
  return { dispatcher, driver, evidence, scope, run };
}

describe("bounded local-source file.upload custody", () => {
  it("admits explicit absence or exact prior digest before signed envelope construction", () => {
    expect(ZENITHD_OPERATIONS).toContain("file.upload");
    expect(ZENITHD_OPERATIONS).toContain("package.install");
    expect(validateMachineArgs("file.upload", args)).toEqual(args);
    expect(() => validateMachineArgs("file.upload", { ...args, bytes: "x".repeat(65537) })).toThrow(/args are larger than 65536 bytes/);
    expect(validateMachineArgs("file.upload", { ...args, expectedSha256: "b".repeat(64) })).toEqual({ ...args, expectedSha256: "b".repeat(64) });
    for (const candidate of [{ ...args, expectedSha256: undefined }, { ...args, expectedSha256: "*" }, { ...args, bytes: "inert-upload-marker" }, { ...args, url: "https://example.invalid/model" }, { ...args, sourcePath: "/private/model.bin" }, { ...args, mode: "0777" }]) {
      expect(() => validateMachineArgs("file.upload", candidate)).toThrow(/strict local-source/);
      try { validateMachineArgs("file.upload", candidate); } catch (error) { expect(String(error)).not.toContain("inert-upload-marker"); }
    }
  });

  it("refuses cross-purpose refs and noncanonical target or version without values in errors", () => {
    expect(parseMachineArgs("file.upload", args)).toEqual({ ok: true, args });
    for (const candidate of [{ path: args.path, contentRef: "model", contentVersion: args.sourceVersion, expectedSha256: null }, { ...args, sourceRef: "https://example.invalid/model" }, { ...args, sourceRef: "../model" }, { ...args, sourceVersion: "v1" }, { ...args, sourceVersion: `${args.sourceVersion}\n` }, { ...args, path: "/opt//customer/model.bin" }, { ...args, path: "/etc/customer/model.bin" }, { ...args, path: "/opt/customer/config.yaml" }, { ...args, bytes: "inert-upload-marker" }]) {
      const parsed = parseMachineArgs("file.upload", candidate);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain("inert-upload-marker");
    }
    expect(parseMachineArgs("file.write", args).ok).toBe(false);
  });

  it("pins purpose-separated canonical metadata without source contents", () => {
    const metadata = { path: "/opt/customer/model.bin", sourceRef: "model", sourcePath: "/opt/customer/sources/model.bin", sha256: "a".repeat(64), mode: "0600", maxBytes: 1024, backupDir: "/opt/customer/backups", maxBackupBytes: 4096, maxBackups: 4 };
    const version = sha256Hex(`zenith.file.upload.profile/v1\0${JSON.stringify(metadata)}`);
    expect(version).toBe("3bb0a75afec194631fef7a4827441ba9fa7a2264804a8a910758ee1979c9a63e");
    expect(version).not.toBe(sha256Hex(`zenith.file.write.profile/v1\0${JSON.stringify(metadata)}`));
    expect(parseMachineArgs("file.upload", { ...args, sourceVersion: version }).ok).toBe(true);
  });

  it("intersects exact operation tenant resource and signed path scope before dispatch", async () => {
    for (const grant of [grantFor("file.write"), grantFor("file.upload", { op: "foreign" }), grantFor("file.upload", { ws: "foreign" }), grantFor("file.upload", { env: "foreign" }), grantFor("file.upload", { res: "foreign" }), grantFor("file.upload", { res: undefined })]) {
      const h = harness();
      await expect(h.run(grant)).rejects.toMatchObject({ code: "grant_mismatch" });
      expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
    const h = harness();
    await expect(h.run(grantFor("file.upload", { constraints: { pathPrefixes: ["/opt/customer"] } }))).resolves.toMatchObject({ ok: true, data });
    expect(h.dispatcher.enqueue).toHaveBeenCalledWith(request(), "inert-local-grant");
  });

  it("refuses unknown constraints malformed prefixes and inadequate metadata budgets", async () => {
    for (const constraints of [{ pathPrefixes: ["/opt/customer-other"] }, { pathPrefixes: ["/opt//customer"] }, { sourceURL: "https://example.invalid/model" }, { maxLines: 1 }, { desiredMode: "0600" }, { maxOutputBytes: 1024 }, { maxTimeoutSec: 1.5 }]) {
      const h = harness();
      await expect(h.run(grantFor("file.upload", { constraints }))).rejects.toBeDefined();
      expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
  });

  it("requires exact destination and source version in a consistent success receipt", async () => {
    expect(MachineResultDataSchemas["file.upload"].parse({ ...data, bytes: "inert-upload-marker", sourcePath: "/private/model.bin" })).toEqual(data);
    for (const receipt of [{ ...data, sourceVersion: "b".repeat(64) }, { ...data, path: "/opt/customer/foreign.bin" }, { ...data, transactionRef: undefined }, { ...data, created: false, backupRef: undefined }, { ...data, effect: "none" }, { ...data, created: false, backupRef: token }, { ...data, sourceVersion: undefined, contentVersion: args.sourceVersion }]) {
      const h = harness({ status: "succeeded", result: receipt });
      await expect(h.run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
      expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    }
  });

  it("permits verified noop and replacement metadata without inventing contents", async () => {
    for (const receipt of [{ ...data, changed: false, created: false, effect: "none", bytesWritten: 0, transactionRef: undefined }, { ...data, created: false, backupRef: token }]) {
      const h = harness({ status: "succeeded", result: receipt }, { ...args, expectedSha256: "b".repeat(64) });
      await expect(h.run()).resolves.toMatchObject({ ok: true, data: receipt });
      expect(h.evidence.records).toHaveLength(1);
    }
  });

  it("retains uncertain phase and intent custody without arbitrary text or output", async () => {
    const failed = { error: "mutation_uncertain", phase: "rename", effect: "unknown", postcondition: "unverified", transactionRef: token, backupRef: token };
    const h = harness({ status: "failed", result: { ...failed, status: "inert-upload-marker", reason: "inert-upload-marker", bytes: "inert-upload-marker" }, output: { stdout: "inert-upload-marker", stderr: "inert-upload-marker" } });
    const error: unknown = await h.run().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "uncertain", retryable: false, transportRef: "mreq_upload", detail: { result: { ok: false, data: failed, evidenceId: "ev-1" } } });
    expect(h.evidence.records[0].summary.outcome).toBe("uncertain");
    expect(JSON.stringify(error)).not.toContain("inert-upload-marker");
    expect(JSON.stringify(h.evidence.records)).not.toContain("inert-upload-marker");
    expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses absent failed and timed-out custody without retry or exec fallback", async () => {
    for (const outcome of [{ status: "timed_out" }, { status: "failed", error: "inert-upload-marker" }, { status: "succeeded" }] satisfies MachineDispatchOutcome[]) {
      const h = harness(outcome);
      await expect(h.run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
      expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.evidence.records)).not.toContain("inert-upload-marker");
    }
  });

  it("reclassifies a retained uncertain result without dispatching again through the modeled runOnce contract", async () => {
    const h = harness({ status: "failed", result: { error: "mutation_uncertain", phase: "rename", effect: "unknown", postcondition: "unverified", transactionRef: token } });
    let saved: Promise<MachineResult> | undefined;
    const evidence = { record: h.evidence.record.bind(h.evidence), runOnce: vi.fn(async (_request: unknown, execute: () => Promise<MachineResult>) => {
      saved ??= execute();
      return saved;
    }) };
    const run = () => executeMachineOperation(request(), { grant: grantFor("file.upload"), drivers: { zenithd: h.driver }, sessions: h.scope, evidence, signal: new AbortController().signal, now: () => new Date(T0) });
    await expect(run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
    await expect(run()).rejects.toMatchObject({ code: "uncertain", retryable: false });
    expect(evidence.runOnce).toHaveBeenCalledTimes(2);
    expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(h.evidence.records).toHaveLength(1);
  });

  it("accepts definite local refusal without promoting it to verified success", async () => {
    const h = harness({ status: "rejected", error: "inert-upload-marker" });
    await expect(h.run()).resolves.toMatchObject({ ok: false, data: { error: "refused", phase: "guard", effect: "none", postcondition: "unverified" } });
    expect(FileWriteFailureDataSchema.safeParse({ error: "refused", phase: "rename", effect: "none", postcondition: "unverified" }).success).toBe(false);
    expect(JSON.stringify(h.evidence.records)).not.toContain("inert-upload-marker");
  });

  it("keeps binary bytes source paths and prior hashes out of evidence", async () => {
    const h = harness();
    const result = await h.run();
    const evidence = evidenceForResult(request(), { ...args, bytes: "inert-upload-marker", sourcePath: "/private/model.bin", expectedSha256: "b".repeat(64) }, { ...result, data: { ...data, bytes: "inert-upload-marker" } });
    expect(evidence.blob).toBeUndefined();
    for (const value of ["inert-upload-marker", "/private/model.bin", "b".repeat(64)]) expect(JSON.stringify(evidence)).not.toContain(value);
    expect(evidence.summary.args).toEqual({ path: args.path, sourceRef: args.sourceRef, sourceVersion: args.sourceVersion });
  });

  it("cloud transports refuse upload before any modeled client or namespace API effect", async () => {
    const client = vi.fn(() => { throw new Error("unexpected modeled cloud client"); });
    const aws = createAwsSsmMachineDriver();
    expect(aws.supports).not.toContain("file.upload");
    expect(aws.unsupported?.["file.upload"]).toMatch(/local binary profile/);
    await expect(aws.execute(requestFor("file.upload", args), { provider: "aws", client }, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(client).not.toHaveBeenCalled();
    const factory = vi.fn(() => { throw new Error("unexpected modeled namespace API"); });
    const kubernetes = createKubernetesMachineDriver({ clientFactory: factory });
    expect(kubernetes.supports).not.toContain("file.upload");
    await expect(kubernetes.execute(requestFor("file.upload", args, { transport: "kubernetes", targetId: "pods/team/web" }), { provider: "kubernetes", namespaces: ["team"], kubeConfig: () => ({}) }, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("simulation refuses upload rather than fabricating native filesystem evidence", async () => {
    const driver = createSimulatedMachineDriver("zenithd");
    expect(driver.supports).not.toContain("file.upload");
    await expect(driver.execute(request(), undefined, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
  });
});
