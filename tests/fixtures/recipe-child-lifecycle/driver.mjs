import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { createInterface } from "node:readline";
import { createChildSettlementTracker } from "../../../src/lib/hosted/build/recipe-worker.mjs";

const childProcessChannel = channel("child_process");
const commands = createInterface({ input: process.stdin });
const waiting = new Map();
const buffered = [];

function send(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function completeFixture() {
  commands.close();
  process.stdin.pause();
}

function waitForCommand(name) {
  const index = buffered.findIndex((command) => command === name);
  if (index >= 0) {
    buffered.splice(index, 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const entries = waiting.get(name) ?? [];
    entries.push(resolve);
    waiting.set(name, entries);
  });
}

commands.on("line", (line) => {
  const command = waiting.get(line)?.shift();
  if (command) command();
  else buffered.push(line);
});

function controlledChild(name) {
  const child = new EventEmitter();
  Object.setPrototypeOf(child, ChildProcess.prototype);
  let killCalls = 0;
  Object.defineProperty(child, "kill", {
    configurable: true,
    value: (signal) => {
      killCalls += 1;
      if (signal === "SIGKILL") {
        send("SIGKILL_REQUESTED", { target: name, signal, killAccepted: true, closeSeen: false, killCalls });
      }
      return true;
    },
  });
  return {
    child,
    publish() {
      childProcessChannel.publish({ process: child });
    },
    spawn(args) {
      child.spawnargs = args;
      child.pid = 45678;
      child.emit("spawn");
    },
    error() {
      child.emit("error", new Error("controlled error; close is still pending"));
    },
    exit() {
      child.emit("exit", 0, null);
    },
    close() {
      child.emit("close", 0, null);
    },
    killCalls: () => killCalls,
  };
}

async function announceConstructor(child) {
  send("CONSTRUCTOR_READY", {
    pid: Number.isInteger(child.child.pid) ? child.child.pid : null,
    spawnListeners: child.child.listenerCount("spawn"),
    errorListeners: child.child.listenerCount("error"),
    closeListeners: child.child.listenerCount("close"),
  });
}

async function initializeService(tracker) {
  tracker.subscribe();
  tracker.expectService("0.25.0");
  const service = controlledChild("captured-service");
  service.publish();
  await announceConstructor(service);
  await waitForCommand("SPAWN_SERVICE");
  service.spawn(["esbuild", "--service=0.25.0", "--ping"]);
  const serviceReady = await tracker.waitForService();
  send("SERVICE_SPAWNED", { serviceReady, snapshot: tracker.snapshot() });
  return service;
}

async function closeOnly() {
  const tracker = createChildSettlementTracker();
  const service = await initializeService(tracker);
  service.error();
  service.exit();
  const killAccepted = service.child.kill("SIGTERM");
  send("STILL_LIVE", {
    snapshot: tracker.snapshot(),
    errorObserved: true,
    exitObserved: true,
    killAccepted,
    killCalls: service.killCalls(),
  });
  await waitForCommand("CLOSE_SERVICE");
  service.close();
  const result = await tracker.stopAndJoin({ stop: async () => {} });
  const sealed = tracker.seal();
  send("SETTLED", {
    result,
    sealed,
    snapshot: tracker.snapshot(),
    listenerCounts: {
      spawn: service.child.listenerCount("spawn"),
      error: service.child.listenerCount("error"),
      close: service.child.listenerCount("close"),
    },
  });
  completeFixture();
}

async function lateDuringStop() {
  const tracker = createChildSettlementTracker();
  const service = await initializeService(tracker);
  let late;
  const finalizing = tracker.stopAndJoin({
    stop: async () => {
      late = controlledChild("late-during-stop");
      late.publish();
      late.spawn(["late-helper"]);
      send("LATE_CHILD_SPAWNED", { snapshot: tracker.snapshot() });
    },
  });

  await waitForCommand("CLOSE_SERVICE");
  service.close();
  send("LATE_CHILD_STILL_JOINED", { snapshot: tracker.snapshot() });
  await waitForCommand("CLOSE_LATE");
  late.close();
  const result = await finalizing;
  const sealed = tracker.seal();
  send("SETTLED", { result, sealed, snapshot: tracker.snapshot() });
  completeFixture();
}

async function graceExpiry() {
  const tracker = createChildSettlementTracker({ stopGraceMs: 15 });
  const service = await initializeService(tracker);
  let releaseStop;
  const stop = new Promise((resolve) => { releaseStop = resolve; });
  const finalizing = tracker.stopAndJoin({ stop: () => stop });
  await waitForCommand("CLOSE_AFTER_KILL");
  service.close();
  releaseStop();
  const result = await finalizing;
  const sealed = tracker.seal();
  send("SETTLED", {
    result,
    sealed,
    snapshot: tracker.snapshot(),
    killCalls: service.killCalls(),
    listenerCounts: {
      spawn: service.child.listenerCount("spawn"),
      error: service.child.listenerCount("error"),
      close: service.child.listenerCount("close"),
    },
  });
  completeFixture();
}

async function stopThrows() {
  const tracker = createChildSettlementTracker({ stopGraceMs: 5_000 });
  const service = await initializeService(tracker);
  const finalizing = tracker.stopAndJoin({
    stop: async () => {
      send("STOP_THROW_REQUESTED");
      throw new Error("controlled stop failure");
    },
  });
  // Let the rejected stop promise reach the production tracker before the
  // checkpoint; this is a turn barrier, not elapsed-time evidence.
  await new Promise((resolve) => setImmediate(resolve));
  send("STOP_THROWN_WAITING_FOR_CLOSE", { snapshot: tracker.snapshot() });
  await waitForCommand("CLOSE_SERVICE");
  service.close();
  const result = await finalizing;
  const sealed = tracker.seal();
  send("SETTLED", { result, sealed, snapshot: tracker.snapshot() });
  completeFixture();
}

async function reentrantFinalize() {
  const tracker = createChildSettlementTracker();
  const service = await initializeService(tracker);
  let releaseStop;
  let stopCalls = 0;
  let firstDone = false;
  let secondDone = false;
  let stopStartedResolve;
  const stopStarted = new Promise((resolve) => { stopStartedResolve = resolve; });
  const stop = () => {
    stopCalls += 1;
    send("STOP_STARTED");
    stopStartedResolve();
    return new Promise((resolve) => { releaseStop = resolve; });
  };
  const first = tracker.stopAndJoin({ stop }).then((result) => {
    firstDone = true;
    return result;
  });
  await stopStarted;
  const second = tracker.stopAndJoin({ stop }).then((result) => {
    secondDone = true;
    return result;
  });
  send("REENTRANT_PENDING", { firstDone, secondDone, stopCalls, snapshot: tracker.snapshot() });
  await waitForCommand("CLOSE_SERVICE");
  service.close();
  releaseStop();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  const sealed = tracker.seal();
  send("SETTLED", { firstResult, secondResult, sealed, stopCalls, snapshot: tracker.snapshot() });
  completeFixture();
}

async function pendingAfterProofLoss(tracker) {
  let settled = false;
  const finalizing = tracker.stopAndJoin({ stop: async () => {} }).then((result) => {
    settled = true;
    send("SETTLED", { result, snapshot: tracker.snapshot() });
  });
  // Let the production quiet-turn join complete; proof loss must keep its
  // finalization promise unresolved and the worker lifetime referenced.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  send("PROOF_LOSS_PENDING", { pending: !settled, resultPublished: false, snapshot: tracker.snapshot() });
  await finalizing;
}

async function malformedPending() {
  const tracker = createChildSettlementTracker();
  tracker.subscribe();
  childProcessChannel.publish({ process: {} });
  await pendingAfterProofLoss(tracker);
}

async function overflowPending() {
  const tracker = createChildSettlementTracker({ maxChildren: 1 });
  tracker.subscribe();
  const first = controlledChild("first-facade");
  const overflow = controlledChild("overflow-facade");
  first.publish();
  first.spawn(["first"]);
  overflow.publish();
  overflow.spawn(["overflow"]);
  first.close();
  overflow.close();
  await pendingAfterProofLoss(tracker);
}

async function lateAfterQuiet() {
  const tracker = createChildSettlementTracker();
  const service = await initializeService(tracker);
  service.close();
  const stagedResult = await tracker.stopAndJoin({ stop: async () => {} });

  // stopAndJoin has crossed its quiet-turn check. Seal successfully, then
  // publish a later child to prove the subscriber remains active for life.
  await new Promise((resolve) => setImmediate(resolve));
  const sealedBeforeLate = tracker.seal();
  send("SEALED_AFTER_QUIET", { joinedBeforeSeal: true, stagedResult, sealed: sealedBeforeLate });
  await new Promise((resolve) => setImmediate(resolve));
  const late = controlledChild("late-facade");
  late.publish();
  late.spawn(["late-helper"]);
  send("LATE_AFTER_QUIET", {
    joinedAndSealedBeforeLateSpawn: true,
    resultPublished: false,
    firstSeal: sealedBeforeLate,
    snapshot: tracker.snapshot(),
  });
  await waitForCommand("CLOSE_LATE");
  late.close();
  send("LATE_CLOSED_STILL_REFUSED", { snapshot: tracker.snapshot() });
  await new Promise(() => {});
}

async function main() {
  const mode = process.argv[2];
  if (mode === "close-only") return closeOnly();
  if (mode === "late-during-stop") return lateDuringStop();
  if (mode === "grace-expiry") return graceExpiry();
  if (mode === "stop-throws") return stopThrows();
  if (mode === "reentrant-finalize") return reentrantFinalize();
  if (mode === "malformed-pending") return malformedPending();
  if (mode === "overflow-pending") return overflowPending();
  if (mode === "late-after-quiet") return lateAfterQuiet();
  throw new Error("Unknown lifecycle fixture mode.");
}

main().catch((error) => {
  send("FIXTURE_ERROR", { message: String(error?.message ?? error) });
  process.exitCode = 1;
});
