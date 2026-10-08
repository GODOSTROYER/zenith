/** Offline contracts only. Runtime-generated hashes are synthetic evidence parser fixtures. */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DRIVER_CHECKS, DRIVER_READBACKS, OwnedCleanup, driverPlan, operatedReceipt, observerBinding, OperatedReceiptSchema, type DriverScenario } from "../../scripts/release/drivers/operated-contract";
import { driftRepairDriver } from "../../scripts/release/drivers/drift-repair";
import { crashPartitionDriver } from "../../scripts/release/drivers/crash-partition";
import { verifyOperatedEvidence } from "../../scripts/release/drivers/verify";
import { LOCAL_TARGETS, localTargetLane, requiredChecks, validateLocalReceipt, localEnvironment } from "../../scripts/release/local-targets";
import { SCENARIOS } from "../../scripts/release/scenarios";
import { manifestFor, requirementsFor } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "../ci/assert-lane-report.mjs";
import { runAcceptance, type Exec } from "../../scripts/release/acceptance-orchestrator";
import { memoryStore } from "../../scripts/release/checkpoint";

const scenarios: DriverScenario[] = ["drift-repair", "crash-partition"];
const hash = (bytes = 32) => randomBytes(bytes).toString("hex");
function fixture(scenarioId: DriverScenario) {
  return { scenarioId, runId: "drv2-contract", sourceCommit: hash(20), sourceDigest: hash(), dirty: true,
    checks: DRIVER_CHECKS[scenarioId].map(id => ({ id, status: "passed" as const })),
    readbacks: Object.fromEntries(DRIVER_READBACKS[scenarioId].map(target => [target, hash()])) };
}

describe("DRV-2 offline planner and receipts", () => {
  it.each(scenarios)("%s requires the actual stack, journey and dedicated gate", scenario => {
    expect(driverPlan(scenario, {}).missing).toHaveLength(9);
    expect(driverPlan(scenario, {}).checks).toEqual(requiredChecks(scenario));
    expect(driverPlan(scenario, { ZENITH_TEST_DRV2_OPERATED: "true" }).missing).toContain("ZENITH_TEST_DRV2_OPERATED");
  });
  it("declines both drivers before reading files or touching engines without explicit opt-in", async () => {
    const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    expect(await driftRepairDriver("/never-read/receipt", env)).toBe(2);
    expect(await crashPartitionDriver("/never-read/receipt", env)).toBe(2);
  });
  it.each(scenarios)("%s accepts only complete source/run-bound operated receipts", scenario => {
    const input = fixture(scenario), receipt = operatedReceipt(input);
    expect(validateLocalReceipt(receipt, input)).toEqual(receipt);
    expect(() => validateLocalReceipt(receipt, { ...input, sourceCommit: hash(20) })).toThrow("mismatch");
    expect(() => validateLocalReceipt(receipt, { ...input, runId: "wrong-run" })).toThrow("mismatch");
    expect(() => validateLocalReceipt({ ...receipt, evidenceLabel: "local_rehearsal" }, input)).toThrow();
    expect(() => validateLocalReceipt({ ...receipt, evidenceLabel: "live_sandbox" }, input)).toThrow();
    // A generic receipt cannot bypass source/readback custody by copying the label.
    const generic = { schema: receipt.schema, evidenceLabel: receipt.evidenceLabel,
      scenarioId: receipt.scenarioId, runId: receipt.runId, sourceCommit: receipt.sourceCommit,
      checks: receipt.checks, limits: receipt.limits };
    expect(() => validateLocalReceipt(generic, input)).toThrow();
  });
  it.each(scenarios)("%s refuses missing/duplicate checks, absent readback, and diagnostic leakage", scenario => {
    const receipt = operatedReceipt(fixture(scenario));
    for (const bad of [
      { ...receipt, checks: receipt.checks.slice(1) },
      { ...receipt, checks: [...receipt.checks.slice(1), receipt.checks[1]] },
      { ...receipt, readbacks: receipt.readbacks.slice(1) },
      { ...receipt, readbacks: [...receipt.readbacks, receipt.readbacks[0]] },
      { ...receipt, readbacks: [{ target: "unknown", sha256: hash() }] },
      { ...receipt, limits: [hash()] }, { ...receipt, stdout: hash() },
    ]) expect(() => OperatedReceiptSchema.parse(bad)).toThrow();
  });
  it("preserves failure/skipped facts and never fills missing cleanup with a pass", () => {
    const input = fixture("drift-repair");
    const result = operatedReceipt({ ...input, checks: [{ id: "prerequisites", status: "passed" }, { id: "approved-workload", status: "failed" }], readbacks: {} });
    expect(result.checks.filter(check => check.status === "passed")).toHaveLength(1);
    expect(result.checks.filter(check => check.status === "failed")).toHaveLength(1);
    expect(result.checks.at(-1)).toEqual({ id: "cleanup", status: "skipped" });
    expect(result.readbacks).toEqual([]);
  });
  it("projects hashes and closed vocabulary without copying incidental secrets", () => {
    const secret = hash();
    const input = { ...fixture("drift-repair"), stderr: secret, headers: { authorization: secret } };
    const result = JSON.stringify(operatedReceipt(input));
    expect(result).not.toContain(secret);
    expect(result).not.toContain("authorization");
  });
  it("requires the observer to use inline credentials, the exact CA and literal loopback", () => {
    const ca = hash(), credentials = { "client-certificate-data": hash(), "client-key-data": hash() };
    const config = { "current-context": "kind-zenith-j2", contexts: [{ name: "kind-zenith-j2", context: { cluster: "owned", user: "owned" } }], clusters: [{ name: "owned", cluster: { server: "https://127.0.0.1:12345", "certificate-authority-data": ca } }], users: [{ name: "owned", user: credentials }] };
    expect(observerBinding(config, ca)).toBe(JSON.stringify(config));
    for (const server of ["https://cloud.invalid:443", "https://localhost:12345", "http://127.0.0.1:12345"]) expect(() => observerBinding({ ...config, clusters: [{ ...config.clusters[0], cluster: { ...config.clusters[0].cluster, server } }] }, ca)).toThrow();
    expect(() => observerBinding(config, hash())).toThrow();
    expect(() => observerBinding({ ...config, users: [{ name: "owned", user: { ...credentials, exec: { command: "foreign" } } }] }, ca)).toThrow();
    expect(() => observerBinding({ ...config, clusters: [{ ...config.clusters[0], cluster: { ...config.clusters[0].cluster, "insecure-skip-tls-verify": true } }] }, ca)).toThrow();
  });
  it("tries restoration, target deletion, identity cleanup and stack teardown despite earlier failures", async () => {
    const trace: string[] = [], cleanup = new OwnedCleanup();
    for (const name of ["restore", "target", "identity", "stack"]) cleanup.add(async () => { trace.push(name); if (["restore", "identity"].includes(name)) throw new Error(hash()); });
    await expect(cleanup.run()).rejects.toThrow("Owned cleanup incomplete");
    expect(trace).toEqual(["restore", "target", "identity", "stack"]);
  });
  it.each(scenarios)("%s is dispatched to its dedicated driver and strict gated lane", scenarioId => {
    expect(LOCAL_TARGETS[scenarioId]).toMatchObject({ driver: `scripts/release/drivers/${scenarioId}.ts`, owner: "DRV-2" });
    const scenario = SCENARIOS.find(value => value.id === scenarioId)!;
    expect(scenario.lanes.some(lane => lane.files.includes("tests/release/drivers-d2.test.ts"))).toBe(true);
    const lane = localTargetLane(scenario);
    expect(lane.evidenceLabel).toBe("local_operated_rehearsal");
    expect(lane.gates).toContain("ZENITH_TEST_DRV2_OPERATED=1");
    const manifest = manifestFor("drv2-" + scenarioId);
    expect(manifest.env.ZENITH_TEST_DRV2_OPERATED).toBe("1");
    expect(manifest.files).toEqual([`tests/acceptance/${scenarioId}.operated.test.ts`]);
    const requirements = requirementsFor("drv2-" + scenarioId, process.cwd());
    expect(requirements).toHaveLength(1);
    expect(reportFailures(requirements, { testResults: [] }, process.cwd()).length).toBeGreaterThan(0);
  });
  it("strips cloud authority and admits only the derived J1 public CA into child startup", () => {
    const env = localEnvironment({ ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: process.cwd(), NODE_EXTRA_CA_CERTS: "/foreign", AWS_ACCESS_KEY_ID: hash(), ZENITH_LIVE_AWS: "1" });
    expect(env.NODE_EXTRA_CA_CERTS).toContain("tls");
    expect(env.NODE_EXTRA_CA_CERTS).not.toBe("/foreign");
    expect(env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(env).not.toHaveProperty("ZENITH_LIVE_AWS");
  });
  it("the scenario runner retains operated provenance and rejects a downgraded label", async () => {
    const input = fixture("drift-repair"), receipt = operatedReceipt(input);
    const root = mkdtempSync(path.join(os.tmpdir(), "drv2-contract-"));
    const env = { ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_DEFAULT_JOURNEY: "1", ZENITH_TEST_DRV2_OPERATED: "1", ZENITH_LOCAL_RUN_ID: input.runId, ZENITH_LOCAL_ROOT: root, ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: root, ZENITH_LOCAL_JOURNEY_CONFIG_FILE: path.join(root, "not-read.json") };
    const exec: Exec = async argv => ({ code: 0, stdout: argv[0] === "git" ? input.sourceCommit : "", stderr: "" });
    const options = { root, outDir: root, runId: input.runId, includeLive: false, localTargets: true, scenarios: [{ ...SCENARIOS.find(scenario => scenario.id === input.scenarioId)!, lanes: [] }] };
    const report = await runAcceptance(options, { exec, env, store: memoryStore(), readFile: () => JSON.stringify(receipt) });
    expect(report.scenarios[0].lanes[0]).toMatchObject({ status: "passed", evidenceLabel: "local_operated_rehearsal", counts: { passed: 8, failed: 0, skipped: 0 } });
    const bad = await runAcceptance(options, { exec, env, store: memoryStore(), readFile: () => JSON.stringify({ ...receipt, evidenceLabel: "local_rehearsal" }) });
    expect(bad.scenarios[0].status).toBe("failed");
  });
  it.each(scenarios)("%s strict Mac verifier refuses skipped identities and stale or incomplete source evidence", scenarioId => {
    const input = fixture(scenarioId), receipt = operatedReceipt(input);
    const required = requirementsFor("drv2-" + scenarioId, process.cwd())[0];
    const assertion = { title: required.test, fullName: required.suite + " " + required.test, ancestorTitles: [required.suite], status: "passed" };
    const report = { success: true, numTotalTests: 1, numFailedTests: 0, testResults: [{ name: path.resolve(required.file), status: "passed", assertionResults: [assertion] }] };
    const expected = { scenarioId, runId: input.runId, source: { head: input.sourceCommit, contentSha256: input.sourceDigest, dirty: input.dirty } };
    expect(verifyOperatedEvidence(receipt, report, expected).passed).toBe(DRIVER_CHECKS[scenarioId].length);
    expect(() => verifyOperatedEvidence(receipt, report, { ...expected, source: { ...expected.source, contentSha256: hash() } })).toThrow();
    expect(() => verifyOperatedEvidence(receipt, { testResults: [] }, expected)).toThrow();
    expect(() => verifyOperatedEvidence(receipt, { ...report, testResults: [{ ...report.testResults[0], assertionResults: [{ ...assertion, status: "pending" }] }] }, expected)).toThrow();
    expect(() => verifyOperatedEvidence({ ...receipt, checks: receipt.checks.map(check => check.id === "cleanup" ? { ...check, status: "failed" } : check) }, report, expected)).toThrow();
  });
});
