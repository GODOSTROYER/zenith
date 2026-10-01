/** Production construction paths with intercepted transport/startup; no real server. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPayloadConverter, type DataConverter } from "@temporalio/common";
import { type WorkerOptions } from "@temporalio/worker";
import { temporalConfigFromEnv } from "@/lib/workflows/config";
import { closeWorkflowClients, workflowClient } from "@/lib/workflows/client";
import { TemporalCodecError, TemporalPayloadCodec } from "@/lib/workflows/codec";

const CURRENT = "11".repeat(32);
const PREVIOUS = "22".repeat(32);
const intercepted = vi.hoisted(() => ({
  client: vi.fn(), connect: vi.fn(), nativeConnect: vi.fn(), createWorker: vi.fn(),
  health: vi.fn(), validate: vi.fn(),
}));

vi.mock("@temporalio/client", async (original) => {
  const sdk = await original<typeof import("@temporalio/client")>();
  return {
    ...sdk,
    Connection: { connect: intercepted.connect },
    Client: class { constructor(options: unknown) { intercepted.client(options); } },
  };
});
vi.mock("@temporalio/worker", async (original) => {
  const sdk = await original<typeof import("@temporalio/worker")>();
  return { ...sdk, NativeConnection: { connect: intercepted.nativeConnect }, Worker: { create: intercepted.createWorker }, Runtime: { install: vi.fn() } };
});
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), mkdir: vi.fn() }));
vi.mock("@/lib/platform/app", () => ({ ensurePlatformApp: vi.fn(async () => true) }));
vi.mock("@/lib/policy", () => ({ loadPolicyEngine: vi.fn() }));
vi.mock("@/lib/execution/plan-janitor", () => ({ planMaxAgeFromEnv: () => 1000, startPlanJanitor: () => ({ stop: vi.fn() }) }));
vi.mock("@/lib/workflows/activities", () => ({ createActivities: () => ({}) }));
vi.mock("../../workers/execution/lifecycle", () => ({ installShutdownHandlers: () => () => false }));
vi.mock("../../workers/execution/startup", () => ({
  ExecutionStartupError: class extends Error {},
  validateExecutionConfiguration: intercepted.validate,
  openExecutionStore: async () => ({ query: vi.fn() }),
}));
vi.mock("../../workers/execution/health", () => ({ healthPortFromEnv: () => 9464, startHealthServer: intercepted.health, HEALTH_CHECK_TIMEOUT_MS: 2000 }));
vi.mock("../../workers/execution/run", async (original) => ({
  ...await original<typeof import("../../workers/execution/run")>(),
  workflowSource: async () => ({ workflowBundle: { code: "intercepted-bundle" }, origin: "prebuilt-bundle" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ZENITH_SECRET_KEY", CURRENT);
  vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", undefined);
  intercepted.connect.mockResolvedValue({ close: vi.fn() });
});
afterEach(async () => {
  await closeWorkflowClients();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("workflow client codec wiring", () => {
  const config = temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "codec-test.invalid:7233" });

  it("passes the codec to the SDK and shares connections for identical encryption config", async () => {
    const first = await workflowClient(config);
    expect(await workflowClient({ ...config })).toBe(first);
    expect(intercepted.connect).toHaveBeenCalledOnce();
    const options = intercepted.client.mock.calls[0][0] as { dataConverter: DataConverter };
    const codec = options.dataConverter.payloadCodecs![0];
    const payload = defaultPayloadConverter.toPayload("synthetic-canary");
    expect(defaultPayloadConverter.fromPayload((await codec.decode(await codec.encode([payload])))[0])).toBe("synthetic-canary");
  });

  it.each([undefined, "", "invalid-test-key"])("refuses production key #%# before connection", async (key) => {
    vi.stubEnv("ZENITH_SECRET_KEY", key);
    await expect(workflowClient(config)).rejects.toBeInstanceOf(TemporalCodecError);
    expect(intercepted.connect).not.toHaveBeenCalled();
    expect(intercepted.client).not.toHaveBeenCalled();
  });

  it("revalidates keys even if an encrypted client is already cached", async () => {
    await workflowClient(config);
    vi.stubEnv("ZENITH_SECRET_KEY", undefined);
    await expect(workflowClient(config)).rejects.toBeInstanceOf(TemporalCodecError);
    expect(intercepted.connect).toHaveBeenCalledOnce();
  });

  it("rebuilds the converter after a key rotation or retained-key change", async () => {
    const first = await workflowClient(config);
    vi.stubEnv("ZENITH_SECRET_KEY", PREVIOUS);
    const second = await workflowClient(config);
    expect(second).not.toBe(first);
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", JSON.stringify([CURRENT]));
    const third = await workflowClient(config);
    expect(third).not.toBe(second);
    const converter = intercepted.client.mock.calls[2][0].dataConverter as DataConverter;
    const payload = await new TemporalPayloadCodec(CURRENT).encode([defaultPayloadConverter.toPayload("old history")]);
    expect(defaultPayloadConverter.fromPayload((await converter.payloadCodecs![0].decode(payload))[0])).toBe("old history");
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", JSON.stringify([CURRENT, CURRENT]));
    expect(await workflowClient(config)).toBe(third);
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", undefined);
    expect(await workflowClient(config)).toBe(second);
    expect(intercepted.connect).toHaveBeenCalledTimes(3);
  });

  it("does not reuse a plaintext development client after encryption is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ZENITH_SECRET_KEY", undefined);
    const plaintext = await workflowClient(config);
    expect(intercepted.client.mock.calls[0][0].dataConverter.payloadCodecs).toEqual([]);
    vi.stubEnv("ZENITH_SECRET_KEY", CURRENT);
    expect(await workflowClient(config)).not.toBe(plaintext);
    expect(intercepted.connect).toHaveBeenCalledTimes(2);
  });
});

describe("execution worker process codec wiring", () => {
  function interceptProcess() {
    vi.resetModules();
    vi.stubEnv("ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS", "0");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    intercepted.health.mockResolvedValue({ port: 9464, close: vi.fn() });
    intercepted.nativeConnect.mockResolvedValue({ close: vi.fn() });
    intercepted.createWorker.mockResolvedValue({ run: vi.fn(), getState: () => "RUNNING" });
    return { exit, stdout };
  }

  it("attaches the same decrypt-compatible codec to Worker.create without changing other options", async () => {
    const { exit, stdout } = interceptProcess();
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", JSON.stringify([PREVIOUS]));
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(intercepted.validate).toHaveBeenCalledOnce();
    const options = intercepted.createWorker.mock.calls[0][0] as WorkerOptions;
    expect(options).toMatchObject({ taskQueue: "zenith-execution", maxConcurrentActivityTaskExecutions: 8, workflowBundle: { code: "intercepted-bundle" } });
    const codec = options.dataConverter!.payloadCodecs![0];
    const oldPayload = await new TemporalPayloadCodec(PREVIOUS).encode([defaultPayloadConverter.toPayload("old history")]);
    expect(defaultPayloadConverter.fromPayload((await codec.decode(oldPayload))[0])).toBe("old history");
    const newPayload = await codec.encode([defaultPayloadConverter.toPayload("current")]);
    expect(defaultPayloadConverter.fromPayload((await new TemporalPayloadCodec(CURRENT).decode(newPayload))[0])).toBe("current");
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(CURRENT);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(PREVIOUS);
  });

  it.each([undefined, "", "invalid-test-key"])("rejects production key #%# before startup side effects", async (key) => {
    const { exit, stdout } = interceptProcess();
    vi.stubEnv("ZENITH_SECRET_KEY", key);
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(intercepted.health).not.toHaveBeenCalled();
    expect(intercepted.validate).not.toHaveBeenCalled();
    expect(intercepted.nativeConnect).not.toHaveBeenCalled();
    expect(intercepted.createWorker).not.toHaveBeenCalled();
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("invalid-test-key");
  });
});
