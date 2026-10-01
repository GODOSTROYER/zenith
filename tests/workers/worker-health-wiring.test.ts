/** Process-entry wiring with synthetic Temporal, stores and lifecycle; no real worker is claimed. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ReadinessChecks } from "../../workers/execution/health";

const fake = vi.hoisted(() => ({
  checks: undefined as ReadinessChecks | undefined,
  state: "CREATED", stopping: false,
  store: { query: vi.fn(async () => [{}]) },
  endpointClose: vi.fn(async () => undefined), janitorStop: vi.fn(async () => undefined),
  temporalCheck: vi.fn(async () => ({})), connectionClose: vi.fn(async () => undefined),
  policy: vi.fn(async () => ({})), createWorker: vi.fn(), run: vi.fn(),
  validate: vi.fn(async () => undefined),
  dataConverter: { payloadCodecs: [{ synthetic: "codec" }] },
}));
vi.mock("@temporalio/worker", () => ({ DefaultLogger: class {}, Runtime: { install: vi.fn() }, Worker: { create: fake.createWorker }, NativeConnection: { connect: async () => ({ workflowService: { getSystemInfo: fake.temporalCheck }, withDeadline: (_: unknown, fn: () => unknown) => fn(), close: fake.connectionClose }) } }));
vi.mock("@temporalio/activity", () => ({ Context: { current: vi.fn() } }));
vi.mock("node:fs/promises", () => ({ mkdir: async () => undefined }));
vi.mock("@/lib/platform/app", () => ({ ensurePlatformApp: async () => true }));
vi.mock("@/lib/workflows/activities", () => ({ createActivities: () => ({}) }));
vi.mock("@/lib/drivers/types", () => ({ listDrivers: () => ["aws", "kubernetes", "zenith", "gcp", "azure", "oci"].map((provider) => ({ provider })) }));
vi.mock("@/lib/policy", () => ({ loadPolicyEngine: fake.policy }));
vi.mock("@/lib/execution/plan-janitor", () => ({ planMaxAgeFromEnv: () => 86400_000, startPlanJanitor: () => ({ stop: fake.janitorStop }) }));
vi.mock("../../workers/execution/startup", () => ({ ExecutionStartupError: class extends Error {}, validateExecutionConfiguration: fake.validate, openExecutionStore: async () => fake.store }));
vi.mock("../../workers/execution/config", () => ({ executionWorkerConfigFromEnv: () => ({ temporal: {}, identity: "synthetic-worker", healthLogIntervalMs: 0 }) }));
vi.mock("@/lib/workflows/config", () => ({ connectionOptionsFor: () => ({}), describeTemporalConfig: () => ({}) }));
vi.mock("../../workers/execution/lifecycle", () => ({ installShutdownHandlers: () => () => fake.stopping }));
vi.mock("../../workers/execution/run", () => ({ workflowSource: async () => ({ origin: "synthetic" }), workerOptions: (options: object) => options }));
vi.mock("@/lib/workflows/codec", () => ({ temporalDataConverterFromEnv: () => fake.dataConverter }));
vi.mock("../../workers/execution/health", async (original) => ({ ...await original<typeof import("../../workers/execution/health")>(), startHealthServer: async ({ checks }: { checks: ReadinessChecks }) => { fake.checks = checks; return { port: 9464, close: fake.endpointClose }; } }));
import { readinessProbe } from "../../workers/execution/health";

let finish: ReturnType<typeof Promise.withResolvers<void>>;
let exited: MockInstance<typeof process.exit>;
let output: MockInstance<typeof process.stdout.write>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); fake.checks = undefined; fake.state = "CREATED"; fake.stopping = false;
  fake.policy.mockResolvedValue({}); fake.temporalCheck.mockResolvedValue({});
  finish = Promise.withResolvers<void>();
  fake.run.mockImplementation(() => { fake.state = "RUNNING"; return finish.promise; });
  fake.createWorker.mockResolvedValue({ getState: () => fake.state, run: fake.run });
  exited = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("worker health lifecycle wiring", () => {
  it("stays unready until polling with a loaded policy, probes live connections, drains unready and closes resources", async () => {
    const loaded = Promise.withResolvers<object>(); fake.policy.mockImplementation(() => loaded.promise);
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(fake.policy).toHaveBeenCalledOnce());
    const probe = readinessProbe(fake.checks!);
    expect(await probe()).toMatchObject({ ready: false, checks: { temporal: "unknown", policy: "unavailable" } });
    loaded.resolve({}); await vi.waitFor(() => expect(fake.run).toHaveBeenCalledOnce());
    expect(fake.createWorker).toHaveBeenCalledWith(expect.objectContaining({ dataConverter: fake.dataConverter })); // payloads are encrypted
    expect(await probe()).toMatchObject({ ready: true }); expect(fake.temporalCheck).toHaveBeenCalledOnce();
    fake.temporalCheck.mockRejectedValue(new Error("synthetic-temporal-secret"));
    expect(await probe()).toMatchObject({ ready: false, checks: { temporal: "unavailable" } });
    fake.temporalCheck.mockResolvedValue({}); fake.stopping = true;
    expect(await probe()).toMatchObject({ ready: false, checks: { temporal: "unavailable" } });
    finish.resolve(); await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(0));
    expect(fake.endpointClose).toHaveBeenCalledOnce(); expect(fake.janitorStop).toHaveBeenCalledOnce(); expect(fake.connectionClose).toHaveBeenCalledOnce();
  });

  it("refuses polling with an unloaded policy and closes health without logging the failed bundle input", async () => {
    fake.policy.mockRejectedValue(new Error("synthetic-policy-secret"));
    await import("../../workers/execution/worker"); await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(1));
    expect(fake.createWorker).not.toHaveBeenCalled(); expect(fake.endpointClose).toHaveBeenCalledOnce();
    expect(output.mock.calls.map(([text]) => String(text)).join("")).not.toContain("synthetic-policy-secret");
  });

  it("closes the Temporal connection and health listener if worker construction fails", async () => {
    fake.createWorker.mockRejectedValue(new Error("synthetic-worker-secret"));
    await import("../../workers/execution/worker"); await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(1));
    expect(fake.endpointClose).toHaveBeenCalledOnce(); expect(fake.connectionClose).toHaveBeenCalledOnce();
    expect(output.mock.calls.map(([text]) => String(text)).join("")).not.toContain("synthetic-worker-secret");
  });
});
