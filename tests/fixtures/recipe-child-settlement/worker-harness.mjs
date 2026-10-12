/**
 * Child-process harness for the production recipe-worker settlement tracker.
 * This file is launched as a separate Node process by the focused Vitest suite.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createChildSettlementTracker, resolveViteEsbuild } from "../../../src/lib/hosted/build/recipe-worker.mjs";

const mode = process.argv[2];
const cjsRequire = createRequire(import.meta.url);
const spawnIdentity = cjsRequire("node:child_process").spawn;
const send = (event, detail = {}) => process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
let cleanupRequested = false;
let releaseRequested = false;
let activeChild;
let activeEsbuild;
let esbuildInitialized = false;
let esbuildStopRequested = false;
let esbuildStopPromise;
let activeTracker;
let checkpoint;
let fixtureStage = "startup";
let fixtureTraceCount = 0;
let boundaryTraceCount = 0;
let childStdoutEvents = 0;

function activeResourceSummary() {
  try {
    if (typeof process.getActiveResourcesInfo !== "function") return { total: 0, types: [] };
    const counts = new Map();
    for (const type of process.getActiveResourcesInfo()) counts.set(type, (counts.get(type) || 0) + 1);
    return {
      total: [...counts.values()].reduce((sum, count) => sum + count, 0),
      types: [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, 16).map(([type, count]) => ({ type, count })),
    };
  } catch {
    return { total: -1, types: [] };
  }
}

function traceFixture(stage, tracker = activeTracker) {
  if (fixtureTraceCount >= 32) return;
  fixtureTraceCount += 1;
  let snapshot = null;
  try {
    snapshot = tracker?.snapshot() || null;
  } catch {
    // Trace output is best effort and must not alter fixture behavior.
  }
  try {
    send("FIXTURE_TRACE", {
      stage,
      sequence: fixtureTraceCount,
      snapshot,
      childStdoutEvents,
      stdin: { ended: process.stdin.readableEnded, destroyed: process.stdin.destroyed },
      ipcConnected: process.connected,
      resources: activeResourceSummary(),
    });
  } catch {
    // Trace output is best effort and must not alter fixture behavior.
  }
}

function writeBoundaryTrace(event, code) {
  if (boundaryTraceCount >= 4) return;
  boundaryTraceCount += 1;
  try {
    const row = JSON.stringify({
      event,
      code,
      sequence: boundaryTraceCount,
      stdin: { ended: process.stdin.readableEnded, destroyed: process.stdin.destroyed },
      ipcConnected: process.connected,
      resources: activeResourceSummary(),
    });
    writeSync(2, `[WSET_TRACE] ${row.slice(0, 800)}\n`);
  } catch {
    // Boundary traces are synchronous, bounded, and best effort.
  }
}

process.stdin.on("end", () => traceFixture("stdin-end"));
process.stdin.on("close", () => traceFixture("stdin-close"));
process.on("disconnect", () => traceFixture("ipc-disconnect"));
process.on("beforeExit", (code) => writeBoundaryTrace("FIXTURE_BEFORE_EXIT", code));
process.on("exit", (code) => writeBoundaryTrace("FIXTURE_EXIT", code));

function reportFixtureError(error) {
  try {
    const message = error && typeof error.message === "string"
      ? error.message
      : String(error);
    const boundedMessage = message.slice(0, 500);
    let snapshot = null;
    try {
      snapshot = activeTracker?.snapshot() || null;
    } catch {
      // Diagnostics must never replace the fixture failure or block cleanup.
    }
    send("FIXTURE_ERROR", { stage: fixtureStage, message: boundedMessage, snapshot });
  } catch {
    // Best-effort diagnostics must not change cleanup or failure behavior.
  }
}

const stopEsbuild = () => {
  if (!activeEsbuild) return Promise.resolve();
  if (!esbuildInitialized) {
    esbuildStopRequested = true;
    return Promise.resolve();
  }
  if (!esbuildStopPromise) esbuildStopPromise = Promise.resolve().then(() => activeEsbuild.stop());
  return esbuildStopPromise;
};

const releaseChild = () => {
  if (!activeChild) {
    releaseRequested = true;
    return;
  }
  if (!activeChild.stdin.destroyed && !activeChild.stdin.writableEnded) activeChild.stdin.end("RELEASE\n");
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const commands = chunk.split(/\r?\n/);
  if (commands.includes("CHECKPOINT")) checkpoint?.();
  if (commands.includes("RELEASE")) releaseChild();
  if (commands.includes("CLEANUP")) {
    cleanupRequested = true;
    releaseChild();
    void stopEsbuild().catch(() => {});
  }
});

async function startEsbuild(tracker) {
  fixtureStage = "resolve-esbuild";
  traceFixture(fixtureStage, tracker);
  const viteEntry = cjsRequire.resolve("vite");
  const resolved = resolveViteEsbuild(viteEntry);
  const esbuild = resolved.esbuild;
  activeEsbuild = esbuild;
  if (!tracker.expectService(esbuild.version)) throw new Error("could not register the pinned esbuild version");
  if (cleanupRequested) throw new Error("fixture cleanup requested before esbuild initialization");
  fixtureStage = "initialize-esbuild";
  traceFixture(fixtureStage, tracker);
  await esbuild.initialize();
  esbuildInitialized = true;
  if (esbuildStopRequested) void stopEsbuild().catch(() => {});
  if (cleanupRequested) throw new Error("fixture cleanup requested during esbuild initialization");
  fixtureStage = "observe-esbuild-service";
  traceFixture(fixtureStage, tracker);
  if (!await tracker.waitForService()) throw new Error("the pinned esbuild service child was not observed");
  if (cleanupRequested) throw new Error("fixture cleanup requested before TSX transform");
  fixtureStage = "transform-tsx";
  traceFixture(fixtureStage, tracker);
  const transformed = await esbuild.transform(
    "export const answer: number = 42; export const View = () => <div>TSX settlement</div>",
    { loader: "tsx" }
  );
  if (!transformed.code.includes("answer = 42") || !transformed.code.includes("TSX settlement") || transformed.code.includes("<div>")) {
    throw new Error("esbuild TSX transform output mismatch");
  }
  if (cleanupRequested) throw new Error("fixture cleanup requested after TSX transform");
  return { esbuild, transformed };
}

if (mode === "controlled-success" || mode === "controlled-rejection") {
  const tracker = createChildSettlementTracker({ maxChildren: 8 });
  activeTracker = tracker;
  tracker.subscribe();
  let settlementDone = false;
  let resultPublished = false;
  checkpoint = () => send("CHECKPOINT_RESULT", {
    settlementDone,
    resultPublished,
    workerAlive: process.exitCode === undefined,
    childAlive: activeChild?.exitCode === null,
    trackedLive: tracker.snapshot().live,
  });
  try {
    const { esbuild, transformed } = await startEsbuild(tracker);
    fixtureStage = "controlled-transform-check";
    let buildOk = true;
    if (mode === "controlled-rejection") {
      try {
        fixtureStage = "controlled-rejected-transform";
        traceFixture(fixtureStage, tracker);
        await esbuild.transform("export const broken: number = <div>", { loader: "tsx" });
        throw new Error("invalid TSX unexpectedly transformed");
      } catch (error) {
        if (error && error.message === "invalid TSX unexpectedly transformed") throw error;
        buildOk = false;
      }
    }
    if (cleanupRequested) throw new Error("fixture cleanup requested before controlled child spawn");
    fixtureStage = "controlled-child-spawn";
    traceFixture(fixtureStage, tracker);
    const childPath = fileURLToPath(new URL("./controlled-child.mjs", import.meta.url));
    const child = spawn(process.execPath, [childPath], { stdio: ["pipe", "pipe", "inherit"] });
    activeChild = child;
    child.stdout.setEncoding("utf8");
    let childBuffer = "";
    let readyResolve;
    const childReady = new Promise((resolve) => (readyResolve = resolve));
    child.stdout.on("data", (chunk) => {
      childBuffer += chunk;
      for (;;) {
        const newline = childBuffer.indexOf("\n");
        if (newline < 0) break;
        childStdoutEvents += 1;
        const line = childBuffer.slice(0, newline);
        childBuffer = childBuffer.slice(newline + 1);
        if (line === "READY") {
          send("CHILD_READY", { pid: child.pid });
          readyResolve();
        }
        if (line === "TERM_ACK") send("CHILD_TERM_ACK", { pid: child.pid, stillLive: child.exitCode === null });
      }
    });
    child.once("close", (code, signal) => send("CHILD_CLOSE", { code, signal }));
    if (releaseRequested || cleanupRequested) releaseChild();
    fixtureStage = "await-controlled-child-spawn";
    traceFixture(fixtureStage, tracker);
    await new Promise((resolve, reject) => {
      if (child.spawnfile && child.pid) resolve();
      else {
        child.once("spawn", resolve);
        child.once("error", reject);
      }
    });
    fixtureStage = "await-controlled-child-ready";
    traceFixture(fixtureStage, tracker);
    await childReady;
    fixtureStage = "publish-build-outcome";
    send("BUILD_OUTCOME", {
      ok: buildOk,
      esbuildVersion: esbuild.version,
      tsxTransformed: transformed.code.includes("TSX settlement"),
    });
    const stop = async () => {
      fixtureStage = "stop-esbuild-and-signal-helper";
      traceFixture(fixtureStage, tracker);
      await stopEsbuild();
      child.kill("SIGTERM");
      send("STOP_RETURNED", { killAccepted: child.killed });
    };
    fixtureStage = "join-controlled-children";
    traceFixture(fixtureStage, tracker);
    const joined = await tracker.stopAndJoin({ stop });
    settlementDone = true;
    fixtureStage = "seal-controlled-children";
    const sealed = tracker.seal();
    if (!sealed) throw new Error("tracker failed to seal its observed child set");
    if (cleanupRequested) {
      send("CLEANUP_COMPLETE", { joined, snapshot: tracker.snapshot() });
    } else {
      send("SETTLED", {
        joined,
        snapshot: tracker.snapshot(),
        spawnIdentityUnchanged: cjsRequire("node:child_process").spawn === spawnIdentity,
      });
      resultPublished = true;
      send("RESULT", { ok: buildOk });
    }
    process.exitCode = buildOk && !cleanupRequested ? 0 : 1;
  } catch (error) {
    reportFixtureError(error);
    fixtureStage = "controlled-error-cleanup";
    traceFixture(fixtureStage, tracker);
    releaseChild();
    const stop = async () => stopEsbuild();
    const joined = await tracker.stopAndJoin({ stop });
    settlementDone = true;
    const sealed = tracker.seal();
    if (sealed) send("CLEANUP_COMPLETE", { joined, snapshot: tracker.snapshot() });
    process.exitCode = 1;
  }
} else if (mode === "esbuild") {
  const tracker = createChildSettlementTracker({ maxChildren: 8 });
  activeTracker = tracker;
  tracker.subscribe();
  try {
    const { esbuild, transformed } = await startEsbuild(tracker);
    fixtureStage = "confirm-esbuild-service";
    traceFixture(fixtureStage, tracker);
    const service = await tracker.waitForService();
    fixtureStage = "join-esbuild-service";
    traceFixture(fixtureStage, tracker);
    const joined = await tracker.stopAndJoin(esbuild);
    fixtureStage = "seal-esbuild-service";
    const sealed = tracker.seal();
    const snapshot = tracker.snapshot();
    if (cleanupRequested) {
      if (sealed) send("CLEANUP_COMPLETE", { joined, snapshot });
    } else {
      send("ESBUILD_SETTLED", {
        version: esbuild.version,
        serviceObserved: Boolean(service),
        joined,
        spawned: snapshot.spawned,
        closed: snapshot.closed,
        live: snapshot.live,
        uncertain: snapshot.uncertain,
        spawnIdentityUnchanged: cjsRequire("node:child_process").spawn === spawnIdentity,
        codeContainsAnswer: transformed.code.includes("answer = 42"),
        codeContainsTsx: transformed.code.includes("TSX settlement"),
      });
    }
    process.exitCode = 0;
  } catch (error) {
    reportFixtureError(error);
    fixtureStage = "esbuild-error-cleanup";
    traceFixture(fixtureStage, tracker);
    const joined = await tracker.stopAndJoin({ stop: stopEsbuild });
    const sealed = tracker.seal();
    if (sealed) send("CLEANUP_COMPLETE", { joined, snapshot: tracker.snapshot() });
    process.exitCode = 1;
  }
} else {
  send("BAD_MODE");
  process.exitCode = 2;
}
