import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";

const codecMocks = vi.hoisted(() => ({ factory: vi.fn() }));
const runtimeMocks = vi.hoisted(() => ({
  openPlatformDb: vi.fn(),
  listScheduledJobs: vi.fn(),
  assignPlan: vi.fn(),
  connect: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  spawn: vi.fn(),
  readFile: vi.fn(),
  assertMaintenancePreconditions: vi.fn(),
}));

vi.mock("@/lib/workflows/codec", () => ({ temporalDataConverterFromEnv: codecMocks.factory }));
vi.mock("@temporalio/client", () => {
  class ScheduleNotFoundError extends Error {}
  type MockSchedule = {
    getHandle: (id: string) => {
      describe: () => Promise<{ info: { runningActions: never[] } }>;
      pause: () => Promise<void>;
      delete: () => Promise<void>;
    };
  };
  class Connection {
    static connect = runtimeMocks.connect;
  }
  class Client {
    schedule: MockSchedule;
    workflowService = { describeTaskQueue: vi.fn().mockResolvedValue({ pollers: [] }) };
    constructor(options: Record<string, unknown>) {
      runtimeMocks.clientOptions.push(options);
      this.schedule = {
        getHandle: (id: string) => ({
          describe: async () => {
            const state = scheduleState.get(id)!;
            if (!state.initialDescribe) {
              state.initialDescribe = true;
              throw new ScheduleNotFoundError();
            }
            if (state.deleted) throw new ScheduleNotFoundError();
            return { info: { runningActions: [] } };
          },
          pause: vi.fn().mockResolvedValue(undefined),
          delete: async () => { scheduleState.get(id)!.deleted = true; },
        }),
      };
    }
  }
  return { Client, Connection, ScheduleNotFoundError };
});
const scheduleState = new Map<string, { initialDescribe: boolean; deleted: boolean }>();
vi.mock("@/lib/controlplane/db", () => ({
  openPlatformDb: runtimeMocks.openPlatformDb,
  repos: { scheduledJobs: { listScheduledJobs: runtimeMocks.listScheduledJobs, getScheduledJob: vi.fn() } },
}));
vi.mock("@/lib/controlplane/leases", () => ({ withLease: vi.fn() }));
vi.mock("@/lib/billing/store", () => ({ assignPlan: runtimeMocks.assignPlan }));
vi.mock("node:child_process", () => ({ spawn: runtimeMocks.spawn }));
vi.mock("node:fs/promises", () => ({ readFile: runtimeMocks.readFile }));
vi.mock("../../scripts/acceptance/maintenance/preconditions", () => ({
  localUrl: vi.fn(), CORE_JOBS: ["engine", "alerts", "outbox", "housekeeping", "runner-reaper", "runbooks", "reconcile"],
  assertMaintenancePreconditions: runtimeMocks.assertMaintenancePreconditions,
  seededEpoch: vi.fn(),
}));

import { defaultMaintenanceAcceptance } from "../../scripts/acceptance/maintenance/default";

const ACTIVE = "11".repeat(32);
const primaryFailure = new Error("synthetic scheduled-job read failure");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  runtimeMocks.clientOptions.length = 0;
  scheduleState.clear();
});

describe("J4 default maintenance Temporal codec wiring", () => {
  it("reuses one converter for the main client and both cleanup clients after an early failure", async () => {
    const converter = { payloadCodecs: [{ encode: vi.fn(), decode: vi.fn() }] };
    codecMocks.factory.mockReturnValue(converter);
    runtimeMocks.openPlatformDb.mockResolvedValue({ query: vi.fn().mockResolvedValue([]), close: vi.fn().mockResolvedValue(undefined) });
    runtimeMocks.assertMaintenancePreconditions.mockResolvedValue(7);
    runtimeMocks.connect.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) });
    runtimeMocks.assignPlan.mockResolvedValue(undefined);
    runtimeMocks.readFile.mockResolvedValue("cron-secret\n");
    runtimeMocks.listScheduledJobs.mockRejectedValue(primaryFailure);

    const listeners = new Map<string, (...args: unknown[]) => void>();
    const child = {
      pid: 8123,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      once: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; },
      removeListener: (event: string) => { listeners.delete(event); return child; },
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal !== "SIGTERM") return false;
        queueMicrotask(() => listeners.get("close")?.(null, "SIGTERM"));
        return true;
      }),
    };
    runtimeMocks.spawn.mockReturnValue(child);
    runtimeMocks.clientOptions.length = 0;
    for (const id of ["zenith-critical-maintenance-v1", "zenith-reconcile-sweep-v1"]) scheduleState.set(id, { initialDescribe: false, deleted: false });
    vi.stubEnv("ZENITH_TEST_MAINTENANCE", "1");
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "postgres://127.0.0.1/zenith");
    vi.stubEnv("ZENITH_J4_API_ORIGIN", "http://127.0.0.1:3000");
    vi.stubEnv("ZENITH_TEMPORAL_ADDRESS", "127.0.0.1:7233");
    vi.stubEnv("ZENITH_TEMPORAL_NAMESPACE", "j4-codec-test");
    vi.stubEnv("ZENITH_J4_CRON_SECRET_FILE", "/synthetic/cron-secret");

    const failure = await defaultMaintenanceAcceptance().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(primaryFailure);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(String((failure as AggregateError).errors[0])).toContain("Owned worker closeout proof is incomplete.");

    expect(codecMocks.factory).toHaveBeenCalledOnce();
    expect(codecMocks.factory).toHaveBeenCalledWith(process.env);
    expect(runtimeMocks.clientOptions).toHaveLength(3);
    expect(runtimeMocks.clientOptions).toHaveLength(3);
    for (const options of runtimeMocks.clientOptions) expect(options.dataConverter).toBe(converter);
    expect(runtimeMocks.spawn).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("shows encrypted SDK payloads require the configured codec to decode", async () => {
    const { TemporalPayloadCodec, temporalDataConverterFromEnv } = await vi.importActual<typeof import("@/lib/workflows/codec")>("@/lib/workflows/codec");
    const plain = defaultPayloadConverter.toPayload({ maintenance: "natural-timer" });
    const [encrypted] = await new TemporalPayloadCodec(ACTIVE).encode([plain]);
    expect(() => defaultPayloadConverter.fromPayload(encrypted)).toThrow();

    const configured = temporalDataConverterFromEnv({ NODE_ENV: "test", ZENITH_SECRET_KEY: ACTIVE });
    const [decoded] = await configured.payloadCodecs[0].decode([encrypted]);
    expect(defaultPayloadConverter.fromPayload(decoded)).toEqual({ maintenance: "natural-timer" });
  });
});
