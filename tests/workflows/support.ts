/**
 * Shared test support for the workflow suite.
 *
 * Test servers: never localhost:7233 (another project's Temporal may be
 * listening there). Every server here is one the suite starts itself, on its
 * own port, and `startTestServer` refuses to hand back an environment whose
 * address is the default port.
 *
 * `startTestServer("local")` tries, in order:
 *   1. TestWorkflowEnvironment.createLocal() using the installed `temporal` CLI
 *      (no download);
 *   2. createLocal() with the SDK's own cached download;
 *   3. `temporal server start-dev --headless` spawned here on a random port and
 *      attached with createFromExistingServer.
 * `startTestServer("time-skipping")` uses createTimeSkipping() (the SDK's cached
 * or downloaded test server); there is no equivalent fallback, so a suite that
 * needs time skipping skips itself with the reason when it is unavailable.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { Connection } from "@temporalio/client";
import { DefaultLogger, Runtime, makeTelemetryFilterString } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { Client, WorkflowHandle } from "@temporalio/client";
import { createFakeActivities, type FakeActivities } from "@/lib/workflows/activities/fake";
import { QUERIES, type DeployWorkflowInput, type WorkflowProgress } from "@/lib/workflows/types";
import { bundleDefinitions } from "../../workers/execution/bundle";
import { executionWorkerConfigFromEnv } from "../../workers/execution/config";
import { createExecutionWorker } from "../../workers/execution/run";

const ROOT = path.resolve(__dirname, "../..");
export const DEFINITIONS_DIR = path.join(ROOT, "src/lib/workflows/definitions");
export const DEFINITIONS_ENTRY = path.join(DEFINITIONS_DIR, "index.ts");

export type ServerMode = "time-skipping" | "local-cli" | "local-download" | "spawned-cli";

export interface TestServer {
  env: TestWorkflowEnvironment;
  mode: ServerMode;
  timeSkipping: boolean;
  teardown(): Promise<void>;
}

export interface StartResult {
  server?: TestServer;
  /** why no server could be started (every attempt listed) */
  skipReason?: string;
}

/* ------------------------------- find the CLI ------------------------------ */

export function findTemporalCli(): string | undefined {
  const fromEnv = process.env.ZENITH_TEST_TEMPORAL_CLI;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `temporal${ext.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

function refuseDefaultPort(env: TestWorkflowEnvironment): void {
  if (/:7233$/.test(env.address)) throw new Error(`refusing to use ${env.address}: the test suite must not talk to the default Temporal port`);
}

async function spawnDevServer(cli: string): Promise<{ env: TestWorkflowEnvironment; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(cli, ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(port), "--http-port", String(await freePort()), "--metrics-port", String(await freePort())], {
    stdio: "ignore",
    windowsHide: true,
  });
  const address = `127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const probe = await Connection.connect({ address, connectTimeout: 1_000 });
      await probe.close();
      break;
    } catch (err) {
      if (Date.now() > deadline || child.exitCode !== null) {
        child.kill();
        throw new Error(`spawned temporal dev server did not come up on ${address}: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const env = await TestWorkflowEnvironment.createFromExistingServer({ address, namespace: "default" });
  return { env, child };
}

let quieted = false;
/** Keep the SDK's own INFO/WARN chatter out of test output; errors still show. */
function quietRuntime(): void {
  if (quieted) return;
  quieted = true;
  try {
    Runtime.install({
      logger: new DefaultLogger("ERROR"),
      telemetryOptions: { logging: { filter: makeTelemetryFilterString({ core: "ERROR", other: "ERROR" }), forward: {} } },
    });
  } catch {
    // a runtime already exists in this process; keep it
  }
}

export async function startTestServer(kind: "local" | "time-skipping"): Promise<StartResult> {
  quietRuntime();
  const attempts: string[] = [];
  const done = (env: TestWorkflowEnvironment, mode: ServerMode, extra?: () => Promise<void>): StartResult => {
    refuseDefaultPort(env);
    return {
      server: {
        env,
        mode,
        timeSkipping: env.supportsTimeSkipping,
        teardown: async () => {
          await env.teardown().catch(() => undefined);
          await extra?.();
        },
      },
    };
  };

  if (kind === "time-skipping") {
    try {
      return done(await TestWorkflowEnvironment.createTimeSkipping(), "time-skipping");
    } catch (err) {
      return { skipReason: `createTimeSkipping failed: ${(err as Error).message}` };
    }
  }

  const cli = findTemporalCli();
  if (cli) {
    try {
      const env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: "existing-path", path: cli } } });
      return done(env, "local-cli");
    } catch (err) {
      attempts.push(`createLocal(existing CLI ${cli}): ${(err as Error).message}`);
    }
  } else {
    attempts.push("no `temporal` CLI on PATH (set ZENITH_TEST_TEMPORAL_CLI)");
  }
  try {
    return done(await TestWorkflowEnvironment.createLocal(), "local-download");
  } catch (err) {
    attempts.push(`createLocal(download): ${(err as Error).message}`);
  }
  if (cli) {
    try {
      const { env, child } = await spawnDevServer(cli);
      return done(env, "spawned-cli", async () => {
        child.kill();
      });
    } catch (err) {
      attempts.push(`spawned dev server: ${(err as Error).message}`);
    }
  }
  return { skipReason: `no Temporal test server could be started:\n  ${attempts.join("\n  ")}` };
}

/* ---------------------------- workflow bundle cache --------------------------- */

function sourceFingerprint(): string {
  const files = [
    ...readdirSync(DEFINITIONS_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(DEFINITIONS_DIR, f)),
    path.join(ROOT, "src/lib/workflows/types.ts"),
  ].sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

/**
 * The bundled workflow code, cached in the OS temp dir keyed by a hash of the
 * sources, so each test file does not pay for its own webpack run.
 */
export async function workflowBundlePath(entry: string = DEFINITIONS_ENTRY, extraKey = ""): Promise<string> {
  const key = entry === DEFINITIONS_ENTRY ? sourceFingerprint() : createHash("sha256").update(readFileSync(entry)).update(extraKey).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "zenith-workflow-test-bundles");
  mkdirSync(dir, { recursive: true });
  for (const bundler of ["swc", "esbuild"] as const) {
    const cached = path.join(dir, `bundle-${key}-${bundler}.js`);
    if (existsSync(cached) && statSync(cached).size > 0) return cached;
  }
  // swc first; on a host where its native addon cannot load, esbuild (see workers/execution/bundle.ts).
  const { code, bundler } = await bundleDefinitions(entry);
  const target = path.join(dir, `bundle-${key}-${bundler}.js`);
  const tmp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(tmp, code, "utf8");
  renameSync(tmp, target);
  return target;
}

/* ------------------------------ running workflows ---------------------------- */

export interface Harness {
  server: TestServer;
  client: Client;
  fake: FakeActivities;
  taskQueue: string;
  bundle: string;
  /** run `body` while a worker with the fake activities polls this harness's task queue */
  run<T>(body: () => Promise<T>): Promise<T>;
}

export function makeHarness(server: TestServer, bundle: string, fake: FakeActivities = createFakeActivities()): Harness {
  const taskQueue = `tq-${randomUUID()}`;
  return {
    server,
    client: server.env.client,
    fake,
    taskQueue,
    bundle,
    async run(body) {
      // Built through the production config/options path, so it is exercised too.
      const config = executionWorkerConfigFromEnv({
        ZENITH_TEMPORAL_ADDRESS: server.env.address,
        ZENITH_TEMPORAL_NAMESPACE: server.env.namespace ?? "default",
        ZENITH_WORKER_TASK_QUEUE: taskQueue,
        ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000",
        ZENITH_WORKER_HEARTBEAT_THROTTLE_MS: "300",
      });
      const worker = await createExecutionWorker({
        config,
        connection: server.env.nativeConnection,
        activities: fake.activities,
        workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" },
      });
      return worker.runUntil(body());
    },
  };
}

let counter = 0;
export const uniqueId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}-${++counter}`;

export function deployInput(overrides: Partial<DeployWorkflowInput> = {}): DeployWorkflowInput {
  const operationId = overrides.operationId ?? uniqueId("opx");
  return {
    operationId,
    workspaceId: "ws-1",
    projectId: "proj-1",
    environmentId: "env-1",
    revisionId: "rev-1",
    deploymentId: "dep-1",
    connectionId: "conn-1",
    preApproved: false,
    build: true,
    ...overrides,
  };
}

/** Poll until `check` is truthy; throws with `what` after the deadline. */
export async function waitFor<T>(what: string, check: () => Promise<T | false | undefined> | T | false | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const progressOf = (handle: WorkflowHandle): Promise<WorkflowProgress> => handle.query<WorkflowProgress>(QUERIES.progress);

export const waitForStatus = (handle: WorkflowHandle, status: WorkflowProgress["status"]): Promise<WorkflowProgress> =>
  waitFor(`workflow status ${status}`, async () => {
    const p = await progressOf(handle).catch(() => undefined);
    return p && p.status === status ? p : undefined;
  });

/* ------------------------------- secret hygiene ------------------------------ */

const CREDENTIAL_KEY = /(secret|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|session[_-]?token|authorization|bearer|\btoken\b)/i;
/** Keys that look credential-like but are not: the lease fence. */
const ALLOWED_KEYS = new Set(["fenceToken"]);

/** Every key path in `value` whose name looks like a credential. */
export function findCredentialKeys(value: unknown, at = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findCredentialKeys(v, `${at}[${i}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(CREDENTIAL_KEY.test(k) && !ALLOWED_KEYS.has(k) ? [`${at}.${k}`] : []),
    ...findCredentialKeys(v, `${at}.${k}`),
  ]);
}

/* ------------------------------ suite plumbing ------------------------------- */

export type ScenarioBody = (h: Harness) => Promise<void>;

/**
 * Start a test server for this file (beforeAll), tear it down (afterAll), and
 * return `scenario(name, body)`: a test that gets a fresh fake + worker + task
 * queue, or skips with the reason when no server could be started.
 *
 * `concurrent: true` runs the file's scenarios in parallel (vitest's default
 * cap of 5): safe on a real dev server, where scenarios share nothing. Do not
 * use it with the time-skipping server, whose clock is global.
 */
export function serverSuite(kind: "local" | "time-skipping", opts: { concurrent?: boolean } = {}): {
  scenario: (name: string, body: ScenarioBody, timeoutMs?: number) => void;
  server: () => TestServer;
} {
  let server: TestServer | undefined;
  let skipReason: string | undefined;
  let bundle = "";

  beforeAll(async () => {
    const started = await startTestServer(kind);
    server = started.server;
    skipReason = started.skipReason;
    if (server) bundle = await workflowBundlePath();
  }, 240_000);

  afterAll(async () => {
    await server?.teardown();
  });

  const register = opts.concurrent ? it.concurrent : it;
  return {
    server: () => {
      if (!server) throw new Error(skipReason ?? "no temporal test server");
      return server;
    },
    scenario(name, body, timeoutMs = 60_000) {
      register(
        name,
        async (ctx) => {
          if (!server) return ctx.skip(skipReason ?? "no temporal test server");
          await body(makeHarness(server, bundle, createFakeActivities()));
        },
        timeoutMs
      );
    },
  };
}
