/**
 * One object that wires every fake into `createExecutionActivities`, the way the
 * worker wires the real ports. Tests reach into the pieces to script behaviour
 * and to assert on what the activities asked for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutionActivities, type ExecutionWorkerActivities } from "@/lib/execution/activities";
import type { CostPort, ExecutionDeps, ExecutionLimits } from "@/lib/execution/ports";
import type { LeaseRef } from "@/lib/workflows/types";
import { FakeBroker, FakeCredentialBroker } from "./broker";
import { genericDrivers, type DriverScript } from "./drivers";
import { ENV, OP } from "./fixtures";
import { FakeProduct } from "./product";
import { FakeBuild, FakeMigrations, FakeProber, FakeSourceBundle, FakeWorkloads } from "./release";
import { FakeConnections, FakeEvents, FakeEvidence, FakeLeases, FakeOps, FakeResources } from "./store";
import { FakeTofu } from "./tofu";

export const FINGERPRINT_KEY = "test-fingerprint-key-0123456789abcdef";
export const NOW = "2026-09-30T12:00:00.000Z";

export interface WorldOptions {
  script?: DriverScript;
  overrides?: Record<string, DriverScript>;
  missingDrivers?: string[];
  limits?: Partial<ExecutionLimits>;
  cost?: CostPort;
  /** Temporal's cancellation signal for the activity */
  signal?: AbortSignal;
  /** omit the build/workload/migration/bundle ports (a worker without them) */
  withoutRelease?: boolean;
  /** seed the operation (default: an approved deployment.deploy) */
  op?: Parameters<FakeOps["seed"]>[0];
}

export interface World {
  ops: FakeOps;
  leases: FakeLeases;
  events: FakeEvents;
  evidence: FakeEvidence;
  resources: FakeResources;
  connections: FakeConnections;
  product: FakeProduct;
  broker: FakeBroker;
  credentials: FakeCredentialBroker;
  tofu: FakeTofu;
  prober: FakeProber;
  sourceBundle: FakeSourceBundle;
  build: FakeBuild;
  workloads: FakeWorkloads;
  migrations: FakeMigrations;
  drivers: ReturnType<typeof genericDrivers>;
  heartbeats: unknown[];
  logs: { level: string; message: string; data?: Record<string, unknown> }[];
  planDir: string;
  deps: ExecutionDeps;
  activities: ExecutionWorkerActivities;
  /** acquire the environment lease for the seeded operation, through the real activity */
  lease(): Promise<LeaseRef>;
  /** everything the activities persisted, as one string, for canary scans */
  stored(): string;
  dispose(): void;
}

export function createWorld(opts: WorldOptions = {}): World {
  const events = new FakeEvents();
  const ops = new FakeOps(events);
  ops.seed(opts.op);
  const leases = new FakeLeases();
  const evidence = new FakeEvidence();
  const resources = new FakeResources();
  const connections = new FakeConnections();
  const product = new FakeProduct();
  const broker = new FakeBroker(ops);
  const credentials = new FakeCredentialBroker();
  const tofu = new FakeTofu();
  const prober = new FakeProber();
  const sourceBundle = new FakeSourceBundle();
  const build = new FakeBuild();
  const workloads = new FakeWorkloads();
  const migrations = new FakeMigrations();
  const drivers = genericDrivers({ script: opts.script, overrides: opts.overrides, missing: opts.missingDrivers });
  const heartbeats: unknown[] = [];
  const logs: World["logs"] = [];
  const planDir = mkdtempSync(path.join(os.tmpdir(), "zenith-act-plans-"));

  const deps: ExecutionDeps = {
    ops,
    leases,
    events,
    evidence,
    resources,
    connections,
    product,
    broker,
    credentials,
    drivers,
    tofu,
    fingerprintKey: FINGERPRINT_KEY,
    // no catalog dependence by default: "no estimate" (the default cost port is tested on its own)
    cost: opts.cost ?? { estimate: async () => null },
    prober,
    ...(opts.withoutRelease ? {} : { sourceBundle, build, workloads, migrations }),
    heartbeat: (detail) => heartbeats.push(detail),
    ...(opts.signal ? { activitySignal: () => opts.signal } : {}),
    clock: () => new Date(NOW),
    ids: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    sleep: async () => undefined,
    workerId: "test-worker",
    planDir,
    limits: { heartbeatIntervalMs: 5, probeIntervalMs: 0, ...opts.limits },
    log: (level, message, data) => logs.push({ level, message, ...(data ? { data } : {}) }),
  };
  const activities = createExecutionActivities(deps);

  return {
    ops,
    leases,
    events,
    evidence,
    resources,
    connections,
    product,
    broker,
    credentials,
    tofu,
    prober,
    sourceBundle,
    build,
    workloads,
    migrations,
    drivers,
    heartbeats,
    logs,
    planDir,
    deps,
    activities,
    lease: () => activities.acquireLease({ operationId: OP, scope: `env:${ENV}`, ttlMs: 300_000 }),
    stored: () =>
      JSON.stringify({
        events: events.events,
        evidence: evidence.rows,
        resources: [...resources.rows.values()],
        observations: resources.observations,
        runtime: [...resources.runtime.values()],
        reports: resources.reports,
        ops: [...ops.ops.values()],
        product: { steps: product.steps, statuses: product.statuses, outcomes: product.outcomes, outputs: product.outputs },
      }),
    dispose: () => rmSync(planDir, { recursive: true, force: true, maxRetries: 3 }),
  };
}
