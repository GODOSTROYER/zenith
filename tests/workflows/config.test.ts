/**
 * Connection and worker configuration: parsed from an explicit environment
 * object (never the real one, never localhost:7233), validated, and free of the
 * Temporal API key in anything printable.
 */

import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NativeConnection } from "@temporalio/worker";
import { connectionOptionsFor, describeTemporalConfig, temporalConfigFromEnv, TemporalConfigError } from "@/lib/workflows/config";
import { createActivities } from "@/lib/workflows/activities";
import { TASK_QUEUE } from "@/lib/workflows/types";
import { executionWorkerConfigFromEnv, WorkerConfigError } from "../../workers/execution/config";
import { workerOptions, workflowSource } from "../../workers/execution/run";

const KEY = "tmprl-key-9f8e7d6c5b4a-do-not-print";

describe("temporalConfigFromEnv", () => {
  it("defaults to a local, plaintext, default-namespace connection", () => {
    expect(temporalConfigFromEnv({})).toEqual({ address: "localhost:7233", namespace: "default", tls: false });
  });

  it("reads the address and namespace", () => {
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "temporal.internal:7233", ZENITH_TEMPORAL_NAMESPACE: "zenith-prod" })).toEqual({
      address: "temporal.internal:7233",
      namespace: "zenith-prod",
      tls: false,
    });
  });

  it("treats blank values as unset", () => {
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "  ", ZENITH_TEMPORAL_NAMESPACE: "", ZENITH_TEMPORAL_API_KEY: " " })).toEqual({
      address: "localhost:7233",
      namespace: "default",
      tls: false,
    });
  });

  it("an API key forces TLS on, and an explicit TLS flag works without one", () => {
    const withKey = temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "ns.acct.tmprl.cloud:7233", ZENITH_TEMPORAL_NAMESPACE: "ns.acct", ZENITH_TEMPORAL_API_KEY: KEY, ZENITH_TEMPORAL_TLS: "false" });
    expect(withKey.tls).toBe(true);
    expect(withKey.apiKey).toBe(KEY);
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS: "true" }).tls).toBe(true);
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS: "1" }).tls).toBe(true);
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_TLS: "0" }).tls).toBe(false);
  });

  it.each([
    ["an address with a scheme", { ZENITH_TEMPORAL_ADDRESS: "https://temporal.example.com:7233" }],
    ["an address with a path", { ZENITH_TEMPORAL_ADDRESS: "temporal.example.com:7233/api" }],
    ["an address with spaces", { ZENITH_TEMPORAL_ADDRESS: "temporal example:7233" }],
    ["a namespace with a slash", { ZENITH_TEMPORAL_NAMESPACE: "zenith/prod" }],
    ["a bad TLS flag", { ZENITH_TEMPORAL_TLS: "maybe" }],
  ])("rejects %s", (_name, env) => {
    expect(() => temporalConfigFromEnv(env)).toThrow(TemporalConfigError);
  });

  it("accepts an IPv6 literal address", () => {
    expect(temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "[::1]:7233" }).address).toBe("[::1]:7233");
  });

  it("never puts the API key in a validation error", () => {
    try {
      temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "bad address", ZENITH_TEMPORAL_API_KEY: KEY });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it("does not read process.env when given an environment", () => {
    const before = process.env.ZENITH_TEMPORAL_ADDRESS;
    process.env.ZENITH_TEMPORAL_ADDRESS = "leaky.example:1";
    try {
      expect(temporalConfigFromEnv({}).address).toBe("localhost:7233");
    } finally {
      if (before === undefined) delete process.env.ZENITH_TEMPORAL_ADDRESS;
      else process.env.ZENITH_TEMPORAL_ADDRESS = before;
    }
  });
});

describe("describeTemporalConfig / connectionOptionsFor", () => {
  const config = temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "ns.acct.tmprl.cloud:7233", ZENITH_TEMPORAL_NAMESPACE: "ns.acct", ZENITH_TEMPORAL_API_KEY: KEY });

  it("hides the key: it only says whether one is set", () => {
    const described = describeTemporalConfig(config);
    expect(described).toEqual({ address: "ns.acct.tmprl.cloud:7233", namespace: "ns.acct", tls: true, apiKey: "set" });
    expect(JSON.stringify(described)).not.toContain(KEY);
    expect(describeTemporalConfig(temporalConfigFromEnv({})).apiKey).toBe("unset");
  });

  it("passes the key and TLS to the connection, and nothing else", () => {
    expect(connectionOptionsFor(config)).toEqual({ address: "ns.acct.tmprl.cloud:7233", tls: true, apiKey: KEY });
    expect(connectionOptionsFor(temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "127.0.0.1:9999" }))).toEqual({ address: "127.0.0.1:9999" });
  });

  it("adds the namespace metadata only for a regional Temporal Cloud endpoint with an API key", () => {
    const regional = temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "us-east-1.aws.api.temporal.io:7233", ZENITH_TEMPORAL_NAMESPACE: "ns.acct", ZENITH_TEMPORAL_API_KEY: KEY });
    expect(connectionOptionsFor(regional).metadata).toEqual({ "temporal-namespace": "ns.acct" });
    expect(connectionOptionsFor(config).metadata).toBeUndefined();
  });
});

describe("executionWorkerConfigFromEnv", () => {
  it("has safe defaults", () => {
    const c = executionWorkerConfigFromEnv({});
    expect(c).toMatchObject({
      taskQueue: TASK_QUEUE,
      maxConcurrentActivities: 8,
      maxConcurrentWorkflowTasks: 40,
      shutdownGraceMs: 600_000,
      heartbeatThrottleMs: 10_000,
      logLevel: "INFO",
      healthLogIntervalMs: 60_000,
      temporal: { address: "localhost:7233", namespace: "default", tls: false },
    });
    expect(c.workflowBundlePath).toBeUndefined();
    expect(c.identity).toMatch(/^zenith-exec:.+:\d+$/);
  });

  it("reads overrides", () => {
    const c = executionWorkerConfigFromEnv({
      ZENITH_WORKER_TASK_QUEUE: "zenith-exec-eu",
      ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES: "16",
      ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS: "100",
      ZENITH_WORKER_SHUTDOWN_GRACE_MS: "1200000",
      ZENITH_WORKER_HEARTBEAT_THROTTLE_MS: "5000",
      ZENITH_WORKER_WORKFLOW_BUNDLE: "/app/dist/execution/workflow-bundle.js",
      ZENITH_WORKER_LOG_LEVEL: "debug",
      ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS: "0",
      ZENITH_WORKER_IDENTITY: "worker-a",
    });
    expect(c).toMatchObject({
      taskQueue: "zenith-exec-eu",
      maxConcurrentActivities: 16,
      maxConcurrentWorkflowTasks: 100,
      shutdownGraceMs: 1_200_000,
      heartbeatThrottleMs: 5000,
      workflowBundlePath: "/app/dist/execution/workflow-bundle.js",
      logLevel: "DEBUG",
      healthLogIntervalMs: 0,
      identity: "worker-a",
    });
  });

  it.each([
    ["a non-numeric limit", { ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES: "many" }],
    ["a zero concurrency", { ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES: "0" }],
    ["an absurd concurrency", { ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS: "100000" }],
    ["a negative grace", { ZENITH_WORKER_SHUTDOWN_GRACE_MS: "-5" }],
    ["a throttle below 100 ms", { ZENITH_WORKER_HEARTBEAT_THROTTLE_MS: "10" }],
    ["an unknown log level", { ZENITH_WORKER_LOG_LEVEL: "chatty" }],
    ["a task queue with spaces", { ZENITH_WORKER_TASK_QUEUE: "zenith exec" }],
  ])("rejects %s", (_name, env) => {
    expect(() => executionWorkerConfigFromEnv(env)).toThrow(WorkerConfigError);
  });
});

describe("workerOptions", () => {
  const connection = {} as NativeConnection;
  const activities = createActivities({ workerIdentity: "test" });

  it("maps the config onto the Temporal worker options", () => {
    const config = executionWorkerConfigFromEnv({
      ZENITH_TEMPORAL_ADDRESS: "127.0.0.1:59999",
      ZENITH_TEMPORAL_NAMESPACE: "zenith-test",
      ZENITH_WORKER_TASK_QUEUE: "tq-x",
      ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES: "3",
      ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS: "7",
      ZENITH_WORKER_SHUTDOWN_GRACE_MS: "4000",
      ZENITH_WORKER_HEARTBEAT_THROTTLE_MS: "2500",
      ZENITH_WORKER_IDENTITY: "worker-x",
    });
    const options = workerOptions({ config, connection, activities, workflows: { workflowBundle: { codePath: "/tmp/bundle.js" }, origin: "prebuilt-bundle" } });
    expect(options).toMatchObject({
      namespace: "zenith-test",
      taskQueue: "tq-x",
      identity: "worker-x",
      maxConcurrentActivityTaskExecutions: 3,
      maxConcurrentWorkflowTaskExecutions: 7,
      shutdownGraceTime: 4000,
      maxHeartbeatThrottleInterval: 2500,
      defaultHeartbeatThrottleInterval: 2500,
      workflowBundle: { codePath: "/tmp/bundle.js" },
    });
    expect(options.connection).toBe(connection);
    expect(Object.keys(options.activities as object).length).toBe(Object.keys(activities).length);
    // The API key (if any) is a connection concern; it must not ride along in the worker options.
    expect(JSON.stringify({ ...options, connection: undefined })).not.toMatch(/apiKey/i);
  });

  it("uses a prebuilt bundle when one is configured, without bundling anything", async () => {
    const file = path.join(os.tmpdir(), `zenith-config-test-${process.pid}.js`);
    writeFileSync(file, "// bundle");
    try {
      expect(await workflowSource({ workflowBundlePath: file })).toEqual({ workflowBundle: { codePath: file }, origin: "prebuilt-bundle" });
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("says what to do when neither a bundle nor the sources are there", async () => {
    await expect(workflowSource({ workflowBundlePath: "/definitely/not/here.js" })).rejects.toThrow(/does not exist/);
    await expect(workflowSource({}, "/definitely/not/here/index.ts")).rejects.toThrow(/set ZENITH_WORKER_WORKFLOW_BUNDLE/);
  });
});
