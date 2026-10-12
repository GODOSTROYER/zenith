import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HARNESS = path.join(ROOT, "tests/fixtures/recipe-child-settlement/worker-harness.mjs");
const PRELOAD = path.join(ROOT, "tests/fixtures/recipe-child-settlement/child-close-supervisor.mjs");
const WORKER = path.join(ROOT, "src/lib/hosted/build/recipe-worker.mjs");
const RECIPE_APP = path.join(ROOT, "tests/fixtures/recipe-child-settlement/recipe-app");

type EventRow = { event: string; [key: string]: unknown };
type Harness = {
  child: ChildProcessWithoutNullStreams;
  events: EventRow[];
  diagnostics: () => string;
  next: (event: string, timeoutMs?: number) => Promise<EventRow>;
  release: () => void;
  cleanup: () => void;
  finishInput: () => void;
  disconnect: () => void;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

const active = new Set<Harness>();
const activeProcesses = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();
const MAX_DIAGNOSTIC_BYTES = 4096;

function describeFixtureError(row: EventRow, events: EventRow[], stderr: string): string {
  const detail = {
    stage: row.stage,
    message: row.message,
    snapshot: row.snapshot,
  };
  const observed = events.map((event) => event.event).join(",");
  return `fixture failed at ${JSON.stringify(detail)}; observed ${observed}; stderr=${stderr.slice(0, MAX_DIAGNOSTIC_BYTES)}`;
}

function emitTrace(row: EventRow, sequence: number, stdoutBytes: number, stderrBytes: number): void {
  const safeRow: Record<string, unknown> = {
    sequence,
    event: row.event,
    stage: row.stage,
    stdoutBytes,
    stderrBytes,
  };
  for (const key of ["message", "snapshot", "code", "signal", "ok", "joined", "killAccepted", "stillLive", "tsxTransformed", "trackedLive", "settlementDone", "resultPublished", "workerAlive", "childAlive", "version", "serviceObserved", "spawned", "closed", "live", "uncertain", "childStdoutEvents", "stdin", "ipcConnected", "resources", "closeAfterExit", "exitObserved", "streams", "readableEnded", "writableEnded", "destroyed", "streamClosed", "childConnected"]) {
    if (row[key] !== undefined) safeRow[key] = key === "message" ? String(row[key]).slice(0, 500) : row[key];
  }
  try {
    console.error(`[WSET_TRACE] ${JSON.stringify(safeRow).slice(0, 1200)}`);
  } catch {
    // Diagnostics must never change the test outcome or cleanup path.
  }
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | "deadline"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForFile(file: string, milliseconds: number): Promise<void> {
  if (fs.existsSync(file)) return;
  await new Promise<void>((resolve, reject) => {
    function finish(error?: Error): void {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    }
    const watcher = fs.watch(path.dirname(file), (_event, filename) => {
      if (filename?.toString() === path.basename(file) && fs.existsSync(file)) finish();
    });
    const timer = setTimeout(() => finish(new Error(`worker did not publish its result within ${milliseconds}ms`)), milliseconds);
    watcher.once("error", (error) => finish(error));
    if (fs.existsSync(file)) finish();
  });
}

const CHILD_ENV = Object.fromEntries(
  ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]
    .flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key] as string]]))
);

function launch(mode: string): Harness {
  const child = spawn(process.execPath, ["--import", PRELOAD, HARNESS, mode], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: CHILD_ENV as NodeJS.ProcessEnv,
  });
  activeProcesses.add(child);
  const reader = createInterface({ input: child.stdout });
  const events: EventRow[] = [];
  let stderr = "";
  let stderrBytes = 0;
  let stderrRemainder = "";
  let stdoutBytes = 0;
  let traceSequence = 0;
  let observedExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderr.length < MAX_DIAGNOSTIC_BYTES) stderr += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - stderr.length);
    stderrRemainder += chunk;
    for (;;) {
      const newline = stderrRemainder.indexOf("\n");
      if (newline < 0) break;
      const line = stderrRemainder.slice(0, newline);
      stderrRemainder = stderrRemainder.slice(newline + 1);
      if (!line.startsWith("[WSET_TRACE] ")) continue;
      traceSequence += 1;
      if (traceSequence <= 64) {
        emitTrace({ event: "FIXTURE_BOUNDARY_TRACE", stage: "child-stderr", message: line.slice("[WSET_TRACE] ".length, "[WSET_TRACE] ".length + 500) }, traceSequence, stdoutBytes, stderrBytes);
      }
    }
    if (stderrRemainder.length > MAX_DIAGNOSTIC_BYTES) {
      stderrRemainder = stderrRemainder.slice(-MAX_DIAGNOSTIC_BYTES);
    }
  });
  const streamState = () => ({
    stdin: { writableEnded: child.stdin.writableEnded, destroyed: child.stdin.destroyed, closed: child.stdin.closed },
    stdout: { readableEnded: child.stdout.readableEnded, destroyed: child.stdout.destroyed, closed: child.stdout.closed },
    stderr: { readableEnded: child.stderr.readableEnded, destroyed: child.stderr.destroyed, closed: child.stderr.closed },
    connected: child.connected,
  });
  child.stdout.on("end", () => {
    traceSequence += 1;
    if (traceSequence <= 64) emitTrace({ event: "HARNESS_STDOUT_END", stage: "stdout-end", streams: streamState() }, traceSequence, stdoutBytes, stderrBytes);
  });
  child.stdout.on("close", () => {
    traceSequence += 1;
    if (traceSequence <= 64) emitTrace({ event: "HARNESS_STDOUT_CLOSE", stage: "stdout-close", streams: streamState() }, traceSequence, stdoutBytes, stderrBytes);
  });
  child.stderr.on("end", () => {
    traceSequence += 1;
    if (traceSequence <= 64) emitTrace({ event: "HARNESS_STDERR_END", stage: "stderr-end", streams: streamState() }, traceSequence, stdoutBytes, stderrBytes);
  });
  child.stderr.on("close", () => {
    traceSequence += 1;
    if (traceSequence <= 64) emitTrace({ event: "HARNESS_STDERR_CLOSE", stage: "stderr-close", streams: streamState() }, traceSequence, stdoutBytes, stderrBytes);
  });
  const waiters = new Map<string, Array<(row: EventRow) => void>>();
  child.once("exit", (code, signal) => {
    observedExit = { code, signal };
    traceSequence += 1;
    if (traceSequence <= 64) emitTrace({ event: "HARNESS_EXIT", code, signal, streams: streamState() }, traceSequence, stdoutBytes, stderrBytes);
  });
  reader.on("line", (line) => {
    const row = JSON.parse(line) as EventRow;
    stdoutBytes += Buffer.byteLength(line) + 1;
    traceSequence += 1;
    if (traceSequence <= 64) emitTrace(row, traceSequence, stdoutBytes, stderrBytes);
    events.push(row);
    if (row.event === "FIXTURE_ERROR") {
      const pending = [...waiters.values()].flat();
      waiters.clear();
      for (const resolve of pending) resolve(row);
      return;
    }
    const waiting = waiters.get(row.event);
    const resolve = waiting?.shift();
    if (resolve) resolve(row);
  });
  const state: Harness = {
    child,
    events,
    diagnostics() {
      const failure = [...events].reverse().find((row) => row.event === "FIXTURE_ERROR");
      return failure
        ? describeFixtureError(failure, events, stderr)
        : `observed ${events.map((row) => row.event).join(",")}; stderr=${stderr.slice(0, MAX_DIAGNOSTIC_BYTES)}`;
    },
    next(event, timeoutMs = 20_000) {
      const existing = events.find((row) => row.event === event && !((row as EventRow & { consumed?: boolean }).consumed));
      if (existing) {
        (existing as EventRow & { consumed?: boolean }).consumed = true;
        return Promise.resolve(existing);
      }
      const fixtureError = [...events].reverse().find((row) => row.event === "FIXTURE_ERROR");
      if (fixtureError) return Promise.reject(new Error(describeFixtureError(fixtureError, events, stderr)));
      return new Promise((resolve, reject) => {
        const entries = waiters.get(event) ?? [];
        const wrapped = (row: EventRow) => {
          if (timer) clearTimeout(timer);
          child.removeListener("close", onClose);
          (row as EventRow & { consumed?: boolean }).consumed = true;
          if (row.event === "FIXTURE_ERROR") reject(new Error(describeFixtureError(row, events, stderr)));
          else resolve(row);
        };
        const onClose = () => {
          if (timer) clearTimeout(timer);
          const pending = waiters.get(event) ?? [];
          const index = pending.indexOf(wrapped);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error(`child closed before ${event}; ${state.diagnostics()}`));
        };
        const timer = setTimeout(() => {
          child.removeListener("close", onClose);
          const pending = waiters.get(event) ?? [];
          const index = pending.indexOf(wrapped);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error(`timed out waiting for ${event}; ${state.diagnostics()}`));
        }, timeoutMs);
        entries.push(wrapped);
        waiters.set(event, entries);
        child.once("close", onClose);
      });
    },
    release() {
      if (child.exitCode === null && child.signalCode === null && !child.stdin.writableEnded) {
        child.stdin.end("RELEASE\n");
      }
    },
    cleanup() {
      if (child.connected) child.send({ type: "CLEANUP_OWNED_CHILDREN" });
      if (child.exitCode === null && child.signalCode === null && !child.stdin.writableEnded) {
        child.stdin.end("CLEANUP\n");
      }
    },
    finishInput() {
      if (!child.stdin.writableEnded) child.stdin.end();
    },
    disconnect() {
      if (child.connected) child.disconnect();
    },
    closed: new Promise((resolve) => {
      child.once("close", (code, signal) => {
        events.push({ event: "WORKER_CLOSE", code, signal });
        traceSequence += 1;
        if (traceSequence <= 64) {
          emitTrace({ event: "HARNESS_NATURAL_CLOSE", code, signal, closeAfterExit: observedExit !== null, exitObserved: observedExit, streams: streamState() }, traceSequence, stdoutBytes, stderrBytes);
        }
        activeProcesses.delete(child);
        resolve({ code, signal });
      });
    }),
  };
  active.add(state);
  return state;
}

async function finish(state: Harness) {
  const closed = await state.closed;
  active.delete(state);
  return closed;
}

afterEach(async () => {
  const failures: string[] = [];
  const harnessChildren = new Set<ChildProcess>();
  for (const state of active) {
    harnessChildren.add(state.child);
    state.cleanup();
    const harnessClose = await withDeadline(state.closed, 10_000);
    if (harnessClose === "deadline") {
      failures.push("harness did not close after bounded cleanup; parent remains held for outer custody");
      continue;
    }
    active.delete(state);
  }
  for (const child of activeProcesses) {
    // Harness children were already given their bounded close wait above.
    // Do not wait a second interval for the same exact ChildProcess object.
    if (harnessChildren.has(child)) continue;
    if (child.connected) child.send({ type: "CLEANUP_OWNED_CHILDREN" });
    const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
    if (await withDeadline(close, 10_000) === "deadline") {
      failures.push("worker did not close after bounded cleanup; parent remains held for outer custody");
    }
  }
  if (failures.length === 0) {
    active.clear();
    activeProcesses.clear();
    for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.clear();
  } else {
    throw new Error(failures.join("; "));
  }
});

describe("recipe worker actual-child settlement", () => {
  it.each(["controlled-success", "controlled-rejection"] as const)(
    "publishes %s only after the held child actually closes",
    async (mode) => {
      const state = launch(mode);
      await state.next("CHILD_READY");
      const buildOutcome = await state.next("BUILD_OUTCOME");
      expect(buildOutcome.tsxTransformed).toBe(true);
      expect(buildOutcome.esbuildVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(buildOutcome.ok).toBe(mode === "controlled-success");
      const stopReturned = await state.next("STOP_RETURNED");
      expect(stopReturned.killAccepted).toBe(true);
      const term = await state.next("CHILD_TERM_ACK");
      expect(term.stillLive).toBe(true);

      // Both acknowledgements are deterministic: stop() returned and the
      // helper acknowledged TERM, while explicit IPC release is still withheld.
      state.child.stdin.write("CHECKPOINT\n");
      const checkpoint = await state.next("CHECKPOINT_RESULT");
      expect(checkpoint).toMatchObject({
        settlementDone: false,
        resultPublished: false,
        workerAlive: true,
        childAlive: true,
      });
      expect(checkpoint.trackedLive).toBeGreaterThan(0);
      expect(state.child.exitCode).toBeNull();
      expect(state.events.some((row) => row.event === "SETTLED" || row.event === "RESULT")).toBe(false);

      state.release();
      const childClose = await state.next("CHILD_CLOSE");
      expect(childClose.code).toBe(0);
      const settled = await state.next("SETTLED");
      expect(settled.joined).toBe(true);
      expect(settled.spawnIdentityUnchanged).toBe(true);
      expect(settled.snapshot).toMatchObject({ spawned: 2, closed: 2, serviceSpawned: 1, live: 0, uncertain: false });
      const result = await state.next("RESULT");
      expect(result.ok).toBe(mode === "controlled-success");
      state.disconnect();
      const closed = await finish(state);
      expect(closed.code).toBe(mode === "controlled-success" ? 0 : 1);
      expect(state.events.findIndex((row) => row.event === "CHILD_CLOSE")).toBeLessThan(
        state.events.findIndex((row) => row.event === "SETTLED")
      );
      expect(state.events.findIndex((row) => row.event === "RESULT")).toBeLessThan(
        state.events.findIndex((row) => row.event === "WORKER_CLOSE")
      );
    },
    30_000
  );

  it("observes and joins the actual esbuild service resolved from Vite", async () => {
    const state = launch("esbuild");
    const settled = await state.next("ESBUILD_SETTLED");
    expect(settled.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(settled.serviceObserved).toBe(true);
    expect(settled.joined).toBe(true);
    expect(settled.codeContainsAnswer).toBe(true);
    expect(settled.codeContainsTsx).toBe(true);
    expect(settled.spawned).toBeGreaterThan(0);
    expect(settled.closed).toBe(settled.spawned);
    expect(settled.live).toBe(0);
    expect(settled.uncertain).toBe(false);
    expect(settled.spawnIdentityUnchanged).toBe(true);
    state.finishInput();
    state.disconnect();
    const closed = await finish(state);
    expect(closed.code).toBe(0);
  }, 30_000);

  it("builds a real React TSX recipe through the production worker", async () => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-child-settlement-recipe-"));
    temporaryDirectories.add(directory);
    const jobFile = path.join(directory, "job.json");
    const resultFile = path.join(directory, "result.json");
    fs.writeFileSync(jobFile, JSON.stringify({
      root: RECIPE_APP,
      outDir: path.join(directory, "dist"),
      cacheDir: path.join(directory, "cache"),
      platformRoot: ROOT,
    }));

    const worker = spawn(process.execPath, ["--import", PRELOAD, WORKER, jobFile, resultFile], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: CHILD_ENV as NodeJS.ProcessEnv,
    });
    activeProcesses.add(worker);
    const workerStdout = worker.stdout;
    const workerStderrStream = worker.stderr;
    if (!workerStdout || !workerStderrStream) {
      throw new Error("worker stdout/stderr pipes were not created");
    }
    let output = "";
    let workerStdoutBytes = 0;
    workerStdout.setEncoding("utf8").on("data", (chunk: string) => {
      workerStdoutBytes += Buffer.byteLength(chunk);
      if (output.length < MAX_DIAGNOSTIC_BYTES) output += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - output.length);
    });
    let workerStderr = "";
    let workerStderrBytes = 0;
    workerStderrStream.setEncoding("utf8").on("data", (chunk: string) => {
      workerStderrBytes += Buffer.byteLength(chunk);
      if (workerStderr.length < MAX_DIAGNOSTIC_BYTES) workerStderr += chunk.slice(0, MAX_DIAGNOSTIC_BYTES - workerStderr.length);
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code, signal) => {
        emitTrace({ event: "WORKER_EXIT", stage: "process-exit", code, signal, ipcConnected: worker.connected }, 5, workerStdoutBytes, workerStderrBytes);
      });
      worker.once("close", (code, signal) => {
        activeProcesses.delete(worker);
        emitTrace({ event: "WORKER_CLOSE", stage: "stdio-close", code, signal, ipcConnected: worker.connected }, 6, workerStdoutBytes, workerStderrBytes);
        resolve({ code, signal });
      });
    });
    emitTrace({ event: "WORKER_WAIT_RESULT_FILE", stage: "wait-result-file" }, 1, workerStdoutBytes, workerStderrBytes);
    try {
      await waitForFile(resultFile, 170_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; worker stderr=${workerStderr.slice(0, MAX_DIAGNOSTIC_BYTES)}`);
    }
    emitTrace({ event: "WORKER_RESULT_FILE_READY", stage: "result-file-ready" }, 2, workerStdoutBytes, workerStderrBytes);
    // The result is written synchronously at beforeExit; the worker may already have closed IPC before the watcher sees it.
    if (worker.connected) worker.disconnect();
    emitTrace({ event: "WORKER_WAIT_NATURAL_CLOSE", stage: "wait-natural-close" }, 3, workerStdoutBytes, workerStderrBytes);
    const workerClosed = await withDeadline(closed, 10_000);
    emitTrace({ event: "WORKER_NATURAL_CLOSE_RESULT", stage: "natural-close-result", code: workerClosed === "deadline" ? null : workerClosed.code, signal: workerClosed === "deadline" ? null : workerClosed.signal, ipcConnected: worker.connected }, 7, workerStdoutBytes, workerStderrBytes);
    expect(workerClosed, `worker did not naturally close; stdout=${output.slice(0, MAX_DIAGNOSTIC_BYTES)}; stderr=${workerStderr.slice(0, MAX_DIAGNOSTIC_BYTES)}`).not.toBe("deadline");
    expect((workerClosed as { code: number | null }).code, output).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as { ok: boolean; outDir: string; modules: number };
    expect(result.ok).toBe(true);
    expect(result.modules).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(result.outDir, "index.html"), "utf8")).toContain("assets/");
    const assets = fs.readdirSync(path.join(result.outDir, "assets"));
    const script = assets.find((file) => file.endsWith(".js"));
    expect(script).toBeTruthy();
    expect(fs.readFileSync(path.join(result.outDir, "assets", script as string), "utf8")).toContain(
      "Recipe child settlement TSX build"
    );
  }, 180_000);
});
