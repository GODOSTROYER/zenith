/** Actual typed signing/transport contract models; native dpkg belongs to Go. */
import { describe, expect, it, vi } from "vitest";
import { validateMachineArgs } from "@/lib/runners/payloads";
import { parseMachineArgs } from "@/lib/machines/args";
import { MachineResultDataSchemas, PackageInstallFailureDataSchema } from "@/lib/machines/results";
import { executeMachineOperation } from "@/lib/machines/service";
import { createZenithdMachineDriver } from "@/lib/machines/transports/zenithd";
import { createSimulatedMachineDriver } from "@/lib/machines/transports/simulated";
import { createAwsSsmMachineDriver } from "@/lib/machines/transports/aws-ssm";
import { createKubernetesMachineDriver } from "@/lib/machines/transports/kubernetes";
import type { MachineDispatchOutcome } from "@/lib/machines/types";
import { grantFor, MemoryEvidence, requestFor, sessions, T0 } from "./_helpers";

const args = { profileRef: "bundle", profileVersion: "c".repeat(64), expectedInstalledVersion: null as string | null };
const ref = `pi_${"a".repeat(32)}`;
const receipt = { profileRef: args.profileRef, profileVersion: args.profileVersion, package: "zenith-data-bundle", version: "1.0", changed: true, phase: "verified", effect: "committed", postcondition: "verified", transactionRef: ref };
const request = (approvedArgs = args) => requestFor("package.install", approvedArgs, { transport: "zenithd", targetId: "mac_fixture" });
function harness(outcome: MachineDispatchOutcome = { status: "succeeded", result: receipt }, approvedArgs = args) {
  const dispatcher = { enqueue: vi.fn(async () => "mreq_package"), await: vi.fn(async () => outcome) };
  const driver = createZenithdMachineDriver({ dispatcher, now: () => T0 });
  const evidence = new MemoryEvidence();
  const run = (grant = grantFor("package.install")) => executeMachineOperation(request(approvedArgs), { grant, drivers: { zenithd: driver }, sessions: sessions({ grantJws: "inert-package-grant" }), evidence, signal: new AbortController().signal, now: () => new Date(T0) });
  return { dispatcher, driver, evidence, run };
}

describe("pinned local package.install custody models", () => {
  it("signer admits explicit absence or exact installed version with no archive data", () => {
    expect(validateMachineArgs("package.install", args)).toEqual(args);
    expect(parseMachineArgs("package.install", { ...args, expectedInstalledVersion: "1.0" }).ok).toBe(true);
    for (const value of [{ ...args, expectedInstalledVersion: undefined }, { ...args, expectedInstalledVersion: "*" }, { ...args, profileRef: "../bundle" }, { ...args, profileVersion: "v1" }, { ...args, bytes: "inert-package-marker" }, { ...args, sourcePath: "/private/bundle.deb" }, { ...args, url: "https://example.invalid/bundle" }, { ...args, argv: ["/bin/sh"] }, { ...args, force: true }]) {
      expect(() => validateMachineArgs("package.install", value)).toThrow(/strict pinned package/);
      expect(parseMachineArgs("package.install", value).ok).toBe(false);
    }
    expect(() => validateMachineArgs("package.install", { ...args, bytes: "x".repeat(65537) })).toThrow(/larger than 65536/);
  });
  it("intersects operation tenant resource expiry and capability before dispatch", async () => {
    for (const grant of [grantFor("machine.exec"), grantFor("package.install", { op: "foreign" }), grantFor("package.install", { ws: "foreign" }), grantFor("package.install", { env: "foreign" }), grantFor("package.install", { res: "foreign" }), grantFor("package.install", { res: undefined }), grantFor("package.install", { exp: Math.floor(T0 / 1000) })]) {
      const h = harness(); await expect(h.run(grant)).rejects.toBeDefined(); expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
  });
  it("refuses unenforced package restrictions before any signed queue request", async () => {
    for (const constraints of [{ pathPrefixes: ["/opt"] }, { packages: ["other"] }, { repository: "https://example.invalid" }, { maxLines: 1 }, { maxOutputBytes: 1024 }, { maxTimeoutSec: 1.5 }]) {
      const h = harness(); await expect(h.run(grantFor("package.install", { constraints }))).rejects.toBeDefined(); expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    }
  });
  it("requires exact profile and installed-state semantics in the successful effect receipt", async () => {
    for (const data of [{ ...receipt, profileRef: "other" }, { ...receipt, profileVersion: "d".repeat(64) }, { ...receipt, transactionRef: undefined }, { ...receipt, changed: false, effect: "none" }, { ...receipt, effect: "none" }, { ...receipt, transactionRef: "fw_" + "a".repeat(32) }]) {
      const h = harness({ status: "succeeded", result: data }); await expect(h.run()).rejects.toMatchObject({ code: "uncertain", retryable: false }); expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    }
    await expect(harness().run()).resolves.toMatchObject({ ok: true, data: receipt });
  });
  it("permits a full verified installed-state no-op and refuses an upgrade receipt", async () => {
    const prior = { ...args, expectedInstalledVersion: "1.0" };
    const data = { ...receipt, changed: false, effect: "none", transactionRef: undefined };
    await expect(harness({ status: "succeeded", result: data }, prior).run()).resolves.toMatchObject({ ok: true, data });
    await expect(harness({ status: "succeeded", result: { ...data, version: "2.0" } }, prior).run()).rejects.toMatchObject({ code: "uncertain" });
  });
  it("retains original uncertain intent and refuses arbitrary command output or errors", async () => {
    const data = { error: "mutation_uncertain", phase: "uncertain", effect: "unknown", postcondition: "unverified", transactionRef: ref };
    const h = harness({ status: "failed", result: { ...data, reason: "inert-package-marker", bytes: "inert-package-marker" }, output: { stdout: "inert-package-marker", stderr: "inert-package-marker" } });
    const error: unknown = await h.run().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "uncertain", retryable: false, detail: { result: { data, ok: false } } });
    expect(h.evidence.records[0].summary.outcome).toBe("uncertain");
    expect(JSON.stringify(error)).not.toContain("inert-package-marker"); expect(JSON.stringify(h.evidence.records)).not.toContain("inert-package-marker");
    expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
  });
  it("missing timeout and silent results cannot establish package nondelivery", async () => {
    for (const outcome of [{ status: "timed_out" }, { status: "failed" }, { status: "uncertain" }, { status: "succeeded" }] satisfies MachineDispatchOutcome[]) {
      const h = harness(outcome); await expect(h.run()).rejects.toMatchObject({ code: "uncertain", retryable: false }); expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    }
  });
  it("an explicit local refusal is neither verified installation nor uncertain provider proof", async () => {
    await expect(harness({ status: "rejected" }).run()).resolves.toMatchObject({ ok: false, data: { error: "refused", phase: "guard", effect: "none", postcondition: "unverified" } });
    expect(PackageInstallFailureDataSchema.safeParse({ error: "refused", phase: "uncertain", effect: "none", postcondition: "unverified" }).success).toBe(false);
  });
  it("result schema strips archive bytes paths raw logs and caller metadata", () => {
    expect(MachineResultDataSchemas["package.install"].parse({ ...receipt, bytes: "inert-package-marker", sourcePath: "/private/bundle.deb", stderr: "inert-package-marker" })).toEqual(receipt);
  });
  it("cloud namespace and simulation transports never fabricate a package result", async () => {
    const aws = createAwsSsmMachineDriver(); const factory = vi.fn(() => { throw new Error("unexpected namespace client"); });
    const kube = createKubernetesMachineDriver({ clientFactory: factory }); const simulated = createSimulatedMachineDriver("zenithd");
    for (const driver of [aws, kube, simulated]) expect(driver.supports).not.toContain("package.install");
    await expect(simulated.execute(request(), undefined, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(factory).not.toHaveBeenCalled();
  });
});
