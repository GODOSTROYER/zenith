import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = path.join(ROOT, "tests/fixtures/recipe-child-lifecycle/driver.mjs");

type Checkpoint = { event: string; [key: string]: unknown };
type FixtureProcess = {
  child: ChildProcess;
  checkpoints: Checkpoint[];
  stderrTail: string;
  exitSummary: string;
  next(event: string): Promise<Checkpoint>;
  send(event: string): void;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

const active = new Set<FixtureProcess>();
const CHECKPOINT_DIAGNOSTIC_TIMEOUT_MS = 10_000;

function launch(mode: string): FixtureProcess {
  // The fixture imports the production tracker and creates only EventEmitter
  // ChildProcess facades. It never starts a nested OS child.
  const child = spawn(process.execPath, [FIXTURE, mode], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const reader = createInterface({ input: child.stdout! });
  const checkpoints: Checkpoint[] = [];
  let stderrTail = "";
  let exitSummary = "still running";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2_048);
  });
  child.once("exit", (code, signal) => {
    exitSummary = `code=${String(code)} signal=${String(signal)}`;
  });
  child.stderr?.resume();
  const waiters = new Map<string, Array<(checkpoint: Checkpoint) => void>>();
  reader.on("line", (line) => {
    const checkpoint = JSON.parse(line) as Checkpoint;
    checkpoints.push(checkpoint);
    const waiter = waiters.get(checkpoint.event)?.shift();
    waiter?.(checkpoint);
  });
  child.stdout?.resume();

  const state: FixtureProcess = {
    child,
    checkpoints,
    get stderrTail() { return stderrTail; },
    get exitSummary() { return exitSummary; },
    next(event) {
      const previous = checkpoints.find((item) => item.event === event && !(item as Checkpoint & { used?: boolean }).used);
      if (previous) {
        (previous as Checkpoint & { used?: boolean }).used = true;
        return Promise.resolve(previous);
      }
      return new Promise((resolve, reject) => {
        const onCheckpoint = (item: Checkpoint) => {
          clearTimeout(timer);
          (item as Checkpoint & { used?: boolean }).used = true;
          resolve(item);
        };
        const entries = waiters.get(event) ?? [];
        entries.push(onCheckpoint);
        waiters.set(event, entries);
        // This timer only reports a missing checkpoint; proof still comes
        // from controlled events and actual close, never elapsed time.
        const timer = setTimeout(() => {
          const queued = waiters.get(event) ?? [];
          const index = queued.indexOf(onCheckpoint);
          if (index >= 0) queued.splice(index, 1);
          if (queued.length === 0) waiters.delete(event);
          const observed = checkpoints.slice(-12).map((item) => {
            const details = item.snapshot ? ` ${JSON.stringify(item.snapshot)}` : "";
            return `${item.event}${details}`;
          }).join(" -> ").slice(-2_048) || "none";
          reject(new Error(`Timed out waiting for ${event}; observed checkpoints: ${observed}; fixture ${exitSummary}; stderr: ${stderrTail || "(empty)"}`));
        }, CHECKPOINT_DIAGNOSTIC_TIMEOUT_MS);
      });
    },
    send(event) {
      child.stdin?.write(`${event}\n`);
    },
    closed: new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
  };
  active.add(state);
  return state;
}

async function finish(state: FixtureProcess) {
  const closed = await state.closed;
  active.delete(state);
  return closed;
}

async function killAndJoinOwnedFixture(state: FixtureProcess) {
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill("SIGKILL");
  }
  return finish(state);
}

afterEach(async () => {
  for (const state of active) {
    // Each fixture is this test's exact child handle and has no descendants.
    // Always join its actual close event, including when an assertion failed.
    if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGKILL");
    await state.closed;
  }
  active.clear();
});

describe("production recipe worker child settlement lifecycle", () => {
  it("attaches on constructor publication before PID and treats only close as settlement", async () => {
    const state = launch("close-only");
    const ready = await state.next("CONSTRUCTOR_READY");
    expect(ready).toMatchObject({ pid: null, spawnListeners: 1, errorListeners: 1, closeListeners: 1 });
    state.send("SPAWN_SERVICE");

    const spawned = await state.next("SERVICE_SPAWNED");
    expect(spawned.serviceReady).toBe(true);
    const stillLive = await state.next("STILL_LIVE");
    expect(stillLive.snapshot).toMatchObject({ spawned: 1, closed: 0, live: 1, serviceSpawned: 1, uncertain: false });
    expect(stillLive.errorObserved).toBe(true);
    expect(stillLive.exitObserved).toBe(true);
    expect(stillLive.killAccepted).toBe(true);
    expect(stillLive.killCalls).toBe(1);

    state.send("CLOSE_SERVICE");
    const settled = await state.next("SETTLED");
    expect(settled).toMatchObject({ result: true, sealed: true });
    expect(settled.snapshot).toMatchObject({ spawned: 1, closed: 1, live: 0, serviceSpawned: 1, uncertain: false });
    expect(settled.listenerCounts).toEqual({ spawn: 0, error: 0, close: 0 });
    expect((await finish(state)).code).toBe(0);
  });

  it("joins a child created from stop before returning its result", async () => {
    const state = launch("late-during-stop");
    await state.next("CONSTRUCTOR_READY");
    state.send("SPAWN_SERVICE");
    expect((await state.next("SERVICE_SPAWNED")).serviceReady).toBe(true);

    const late = await state.next("LATE_CHILD_SPAWNED");
    expect(late.snapshot).toMatchObject({ observed: 2, spawned: 2, closed: 0, live: 2, proofLost: false });
    state.send("CLOSE_SERVICE");
    expect((await state.next("LATE_CHILD_STILL_JOINED")).snapshot).toMatchObject({ closed: 1, live: 1 });
    state.send("CLOSE_LATE");

    const settled = await state.next("SETTLED");
    expect(settled).toMatchObject({ result: true, sealed: true });
    expect(settled.snapshot).toMatchObject({ observed: 2, spawned: 2, closed: 2, live: 0, proofLost: false });
    expect((await finish(state)).code).toBe(0);
  });

  it("escalates only the captured service after grace, then still refuses after actual close", async () => {
    const state = launch("grace-expiry");
    expect(await state.next("CONSTRUCTOR_READY")).toMatchObject({ pid: null, closeListeners: 1 });
    state.send("SPAWN_SERVICE");
    expect((await state.next("SERVICE_SPAWNED")).serviceReady).toBe(true);

    const kill = await state.next("SIGKILL_REQUESTED");
    expect(kill).toMatchObject({ target: "captured-service", signal: "SIGKILL", killAccepted: true, closeSeen: false });
    expect(state.child.exitCode).toBeNull();
    state.send("CLOSE_AFTER_KILL");

    const settled = await state.next("SETTLED");
    expect(settled).toMatchObject({ result: false, sealed: true });
    expect(settled.snapshot).toMatchObject({ spawned: 1, closed: 1, live: 0, serviceSpawned: 1, uncertain: true });
    // This path never emits error, so its once(error) observer remains attached.
    expect(settled.listenerCounts).toEqual({ spawn: 0, error: 1, close: 0 });
    expect((await finish(state)).code).toBe(0);
  });

  it("keeps joining the service close after stop throws", async () => {
    const state = launch("stop-throws");
    await state.next("CONSTRUCTOR_READY");
    state.send("SPAWN_SERVICE");
    expect((await state.next("SERVICE_SPAWNED")).serviceReady).toBe(true);
    expect((await state.next("STOP_THROWN_WAITING_FOR_CLOSE")).snapshot).toMatchObject({ closed: 0, live: 1, uncertain: true });
    state.send("CLOSE_SERVICE");
    const settled = await state.next("SETTLED");
    expect(settled).toMatchObject({ result: false, sealed: true });
    expect(settled.snapshot).toMatchObject({ closed: 1, live: 0, uncertain: true, proofLost: false });
    expect((await finish(state)).code).toBe(0);
  });

  it("shares reentrant finalization and keeps both callers pending until close", async () => {
    const state = launch("reentrant-finalize");
    await state.next("CONSTRUCTOR_READY");
    state.send("SPAWN_SERVICE");
    expect((await state.next("SERVICE_SPAWNED")).serviceReady).toBe(true);
    const pending = await state.next("REENTRANT_PENDING");
    expect(pending).toMatchObject({ firstDone: false, secondDone: false, stopCalls: 1, snapshot: { live: 1, closed: 0 } });
    expect(state.child.exitCode).toBeNull();
    state.send("CLOSE_SERVICE");
    expect(await state.next("SETTLED")).toMatchObject({ firstResult: true, secondResult: true, sealed: true, stopCalls: 1 });
    expect((await finish(state)).code).toBe(0);
  });

  it("keeps malformed diagnostics proof loss pending instead of returning even a refusal result", async () => {
    const state = launch("malformed-pending");
    const pending = await state.next("PROOF_LOSS_PENDING");
    expect(pending).toMatchObject({ pending: true, resultPublished: false });
    expect(pending.snapshot).toMatchObject({ observed: 0, spawned: 0, closed: 0, live: 0, uncertain: true, proofLost: true });
    expect(state.checkpoints.some((item) => item.event === "SETTLED")).toBe(false);
    expect(state.child.exitCode).toBeNull();

    // afterEach kills and joins only this owned fixture process.
  });

  it("keeps overflow proof loss pending after every synthetic child actually closes", async () => {
    const state = launch("overflow-pending");
    const pending = await state.next("PROOF_LOSS_PENDING");
    expect(pending).toMatchObject({ pending: true, resultPublished: false });
    expect(pending.snapshot).toMatchObject({ observed: 2, spawned: 2, closed: 2, live: 0, uncertain: true, proofLost: true });
    expect(state.checkpoints.some((item) => item.event === "SETTLED")).toBe(false);
    expect(state.child.exitCode).toBeNull();
  });

  it("keeps observing after seal and retains the worker for a late child", async () => {
    const state = launch("late-after-quiet");
    expect(await state.next("CONSTRUCTOR_READY")).toMatchObject({ pid: null, spawnListeners: 1, errorListeners: 1, closeListeners: 1 });
    state.send("SPAWN_SERVICE");
    expect((await state.next("SERVICE_SPAWNED")).serviceReady).toBe(true);
    expect(await state.next("SEALED_AFTER_QUIET")).toMatchObject({ joinedBeforeSeal: true, stagedResult: true, sealed: true });
    const checkpoint = await state.next("LATE_AFTER_QUIET");
    expect(checkpoint).toMatchObject({ joinedAndSealedBeforeLateSpawn: true, firstSeal: true });
    expect(checkpoint.snapshot).toMatchObject({ observed: 2, spawned: 2, closed: 1, live: 1, proofLost: true });
    expect(state.child.exitCode).toBeNull();

    state.send("CLOSE_LATE");
    expect((await state.next("LATE_CLOSED_STILL_REFUSED")).snapshot).toMatchObject({ closed: 2, live: 0, proofLost: true });
    expect(state.child.exitCode).toBeNull();
    // Production intentionally keeps the proof-loss guard referenced forever.
    // End only this isolated fixture process after observing the sticky refusal.
    expect((await killAndJoinOwnedFixture(state)).signal).toBe("SIGKILL");
  });
});
