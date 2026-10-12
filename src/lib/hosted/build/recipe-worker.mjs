/**
 * The process that actually compiles a submission.
 *
 * Plain ESM JavaScript so `node` can run it directly: on the control host it is
 * spawned as a child with an empty environment, in a container it is the image
 * entrypoint, in an E2B sandbox it is uploaded and run there. Same file, same
 * behaviour, wherever the boundary is drawn.
 *
 *   node recipe-worker.mjs <job.json> <result.json>
 *
 * It reads the job, resolves the pinned toolchain from the platform's own
 * `node_modules`, runs `build()` with `recipeInlineConfig`, checks that every
 * module the bundle drew from came from the source root or that toolchain, and
 * writes a small JSON result. Exit 0 when the build succeeded, 1 otherwise.
 *
 * It never loads a submitted `vite.config`, never runs a submitted script,
 * never installs anything, and reads no environment variable of its own.
 */
import fs from "node:fs";
import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { foreignModules, recipeAliases, recipeInlineConfig } from "./recipe-config.mjs";

const CHILD_PROCESS_CHANNEL = "child_process";
const DEFAULT_MAX_CHILDREN = 32;
const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_GRACE_MS = 5_000;

/**
 * Observe actual direct ChildProcess objects created by this worker. The
 * diagnostic callback runs at construction time, so listeners are attached
 * before Node starts the native child. Nothing is inferred from process-table
 * snapshots or PID strings.
 */
export function createChildSettlementTracker({
  maxChildren = DEFAULT_MAX_CHILDREN,
  spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
  stopGraceMs = DEFAULT_STOP_GRACE_MS,
} = {}) {
  maxChildren = Number.isSafeInteger(maxChildren) ? Math.min(Math.max(maxChildren, 1), DEFAULT_MAX_CHILDREN) : DEFAULT_MAX_CHILDREN;
  spawnTimeoutMs = Number.isFinite(spawnTimeoutMs) ? Math.min(Math.max(spawnTimeoutMs, 1), DEFAULT_SPAWN_TIMEOUT_MS) : DEFAULT_SPAWN_TIMEOUT_MS;
  stopGraceMs = Number.isFinite(stopGraceMs) ? Math.min(Math.max(stopGraceMs, 1), DEFAULT_STOP_GRACE_MS) : DEFAULT_STOP_GRACE_MS;
  const childChannel = channel(CHILD_PROCESS_CHANNEL);
  const records = new Set();
  const liveRecords = new Set();
  let serviceRecord = null;
  let subscribed = false;
  let uncertain = false;
  let observed = 0;
  let spawned = 0;
  let closed = 0;
  let overflowLive = 0;
  let overflowSaturated = false;
  let serviceSpawned = 0;
  let expectedVersion = null;
  let changeVersion = 0;
  let changeWaiters = [];
  let guard = null;
  let finalizationPromise = null;
  let proofLost = false;
  let joinCompleted = false;
  let sealed = false;

  const notifyChange = () => {
    changeVersion += 1;
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const resolve of waiters) resolve(changeVersion);
  };

  const keepAlive = () => {
    if (!guard) guard = setInterval(() => {}, 1_000);
  };

  const maybeReleaseGuard = () => {
    if (joinCompleted && !proofLost && liveRecords.size === 0 && overflowLive === 0 && guard) {
      clearInterval(guard);
      guard = null;
    }
  };

  const waitForChange = (since, timeoutMs) => new Promise((resolve) => {
    if (changeVersion !== since) {
      resolve(true);
      return;
    }
    let timer;
    const done = (changed) => {
      const index = changeWaiters.indexOf(onChange);
      if (index >= 0) changeWaiters.splice(index, 1);
      if (timer) clearTimeout(timer);
      resolve(changed);
    };
    const onChange = () => done(true);
    changeWaiters.push(onChange);
    timer = setTimeout(() => done(false), timeoutMs);
  });

  const markUncertain = () => {
    uncertain = true;
    keepAlive();
    notifyChange();
  };

  const onChildProcess = (message) => {
    // diagnostics_channel callbacks must never throw into the child creator.
    try {
      keepAlive();
      if (joinCompleted || sealed) proofLost = true;
      if (!message || !(message.process instanceof ChildProcess)) {
        proofLost = true;
        markUncertain();
        return;
      }

      const child = message.process;
      observed = Math.min(observed + 1, maxChildren + 1);
      if (observed > maxChildren) {
        proofLost = true;
        markUncertain();
      }

      // Even when the bounded summary set is full, attach a minimal close
      // listener so the worker cannot mistake an overflow child for settlement.
      if (records.size >= maxChildren) {
        proofLost = true;
        markUncertain();
        if (overflowLive < maxChildren + 1) overflowLive += 1;
        else overflowSaturated = true;
        if (overflowLive === maxChildren + 1) overflowSaturated = true;
        let sawSpawn = false;
        child.once("spawn", () => {
          sawSpawn = true;
          spawned = Math.min(spawned + 1, maxChildren + 1);
          notifyChange();
        });
        child.once("error", () => notifyChange());
        child.once("close", () => {
          if (!sawSpawn) uncertain = true;
          if (!overflowSaturated) overflowLive = Math.max(0, overflowLive - 1);
          closed = Math.min(closed + 1, maxChildren + 1);
          notifyChange();
          maybeReleaseGuard();
        });
        return;
      }

      let resolveClosed;
      const record = {
        child,
        spawned: false,
        closed: false,
        service: false,
        closePromise: new Promise((resolve) => { resolveClosed = resolve; }),
      };
      records.add(record);
      liveRecords.add(record);
      child.once("spawn", () => {
        record.spawned = true;
        spawned = Math.min(spawned + 1, maxChildren + 1);
        const args = Array.isArray(child.spawnargs) ? child.spawnargs : [];
        const expectedServiceArgument = expectedVersion && `--service=${expectedVersion}`;
        const serviceArgument = args.find((arg) => typeof arg === "string" && arg.startsWith("--service="));
        if (serviceArgument && (!expectedServiceArgument || serviceArgument !== expectedServiceArgument || !args.includes("--ping"))) {
          markUncertain();
        } else if (expectedServiceArgument && serviceArgument === expectedServiceArgument && args.includes("--ping")) {
          record.service = true;
          if (serviceSpawned === 0) {
            serviceSpawned = 1;
            serviceRecord = record;
          } else {
            serviceSpawned = 2;
            markUncertain();
          }
        }
        notifyChange();
      });
      child.once("error", () => notifyChange());
      child.once("close", () => {
        if (record.closed) return;
        if (!record.spawned) uncertain = true;
        record.closed = true;
        resolveClosed();
        closed = Math.min(closed + 1, maxChildren + 1);
        records.delete(record);
        liveRecords.delete(record);
        notifyChange();
        maybeReleaseGuard();
      });
      notifyChange();
    } catch {
      proofLost = true;
      markUncertain();
    }
  };

  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    childChannel.subscribe(onChildProcess);
  };

  const expectService = (version) => {
    if (typeof version !== "string" || version.length === 0 || expectedVersion !== null) {
      markUncertain();
      return false;
    }
    expectedVersion = version;
    return true;
  };

  const waitForService = async () => {
    const deadline = Date.now() + spawnTimeoutMs;
    while (serviceSpawned === 0 && !uncertain) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const since = changeVersion;
      if (!await waitForChange(since, remaining)) break;
    }
    return !uncertain && serviceSpawned === 1;
  };

  const joinAll = async () => {
    for (;;) {
      if (liveRecords.size === 0 && overflowLive === 0) {
        const since = changeVersion;
        // Drain already-queued lifecycle callbacks. The worker's later
        // beforeExit seal catches any child created after this turn boundary.
        await new Promise((resolve) => setImmediate(resolve));
        if (liveRecords.size === 0 && overflowLive === 0 && changeVersion === since) break;
        continue;
      }
      const since = changeVersion;
      await waitForChange(since, 60_000);
    }
  };

  const stopAndJoin = (esbuild) => {
    if (finalizationPromise) return finalizationPromise;
    keepAlive();
    finalizationPromise = (async () => {
      let stopFailed = false;
      let stopTimer;
      const stopPromise = Promise.resolve().then(() => esbuild.stop()).then(
          () => ({ settled: true }),
          () => ({ settled: true, failed: true })
        );
      const stopResult = await Promise.race([
        stopPromise,
        new Promise((resolve) => { stopTimer = setTimeout(() => resolve({ settled: false }), stopGraceMs); }),
      ]);
      if (stopTimer) clearTimeout(stopTimer);
      if (!stopResult.settled || stopResult.failed) {
        stopFailed = true;
        markUncertain();
      }

      const service = serviceRecord && !serviceRecord.closed ? serviceRecord : null;
      if (service && liveRecords.has(service)) {
        let timer;
        const closedDuringGrace = await Promise.race([
          service.closePromise.then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), stopGraceMs); }),
        ]);
        if (timer) clearTimeout(timer);
        if (!closedDuringGrace && !service.closed) {
          stopFailed = true;
          markUncertain();
          // Escalation is limited to the exact service ChildProcess captured
          // above. A kill acknowledgement is not treated as close proof.
          try {
            service.child.kill("SIGKILL");
          } catch {
            markUncertain();
          }
        }
      }

      if (expectedVersion !== null && serviceSpawned === 0 && observed === 0) {
        // An empty diagnostic set cannot prove that initialize did not create
        // an unobserved native service.
        proofLost = true;
        keepAlive();
      }

      // A timed-out stop may still create children later. Keep observing until
      // the operation itself settles, then drain any children it created.
      if (!stopResult.settled) {
        const eventualStop = await stopPromise;
        if (eventualStop.failed) {
          stopFailed = true;
          markUncertain();
        }
      }

      // Non-service children are never signaled here. Every observed child must
      // settle through its actual close event; the outer runner owns its timeout.
      await joinAll();
      joinCompleted = true;
      if (proofLost) await new Promise(() => {});
      maybeReleaseGuard();
      return !uncertain && !stopFailed && serviceSpawned === 1;
    })();
    return finalizationPromise;
  };

  const snapshot = () => ({
    observed,
    spawned,
    closed,
    live: liveRecords.size + overflowLive,
    serviceSpawned,
    uncertain,
    proofLost,
  });

  const seal = () => {
    if (!joinCompleted || proofLost || liveRecords.size !== 0 || overflowLive !== 0) {
      proofLost = true;
      keepAlive();
      return false;
    }
    // This worker is a dedicated short-lived process. Keep observing through
    // its terminal exit boundary: a later beforeExit listener can still create
    // a child after this seal, which must latch proof loss and retain the guard.
    sealed = true;
    maybeReleaseGuard();
    return true;
  };

  return { subscribe, expectService, waitForService, stopAndJoin, snapshot, seal };
}

/** Resolve esbuild in Vite's package context and return that exact CJS module. */
export function resolveViteEsbuild(viteEntry) {
  const viteRequire = createRequire(viteEntry);
  const esbuildPath = viteRequire.resolve("esbuild");
  const esbuild = viteRequire("esbuild");
  // Vite's pinned Node entry imports esbuild from this bundled config chunk.
  // Resolve from that precise context too, then compare both path and object
  // identity so shutdown cannot target a merely same-version duplicate.
  const viteConfigChunk = path.join(path.dirname(viteEntry), "chunks", "config.js");
  if (!fs.existsSync(viteConfigChunk)) {
    throw new Error("The Vite config chunk needed to verify esbuild identity was not found.");
  }
  const chunkRequire = createRequire(viteConfigChunk);
  const chunkEsbuildPath = chunkRequire.resolve("esbuild");
  if (fs.realpathSync(chunkEsbuildPath) !== fs.realpathSync(esbuildPath) || chunkRequire("esbuild") !== esbuild) {
    throw new Error("The Vite config chunk resolves a different esbuild module.");
  }
  if (!esbuild || typeof esbuild.initialize !== "function" || typeof esbuild.stop !== "function") {
    throw new Error("The Vite-resolved esbuild module does not expose initialize() and stop().");
  }
  if (typeof esbuild.version !== "string" || esbuild.version.length === 0) {
    throw new Error("The Vite-resolved esbuild module has no verifiable version.");
  }
  return { esbuild, esbuildPath };
}

function writeResult(result, resultFile) {
  const body = JSON.stringify(result);
  if (resultFile) {
    try {
      fs.writeFileSync(resultFile, body);
    } catch (err) {
      process.stderr.write(`recipe: could not write the result file: ${err && err.message}\n`);
    }
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function errorMessage(err) {
  return err && err.message ? String(err.message) : String(err);
}

async function runWorker(jobFile, resultFile) {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch (err) {
    writeResult({ ok: false, error: `The build job file could not be read: ${errorMessage(err)}` }, resultFile);
    process.exitCode = 1;
    return;
  }

  const tracker = createChildSettlementTracker();
  let esbuild;
  let outcome;
  try {
    tracker.subscribe();
    const platform = job.platformRoot;
    const resolver = createRequire(path.join(platform, "noop.js"));
    const viteEntry = resolver.resolve("vite");
    ({ esbuild } = resolveViteEsbuild(viteEntry));
    if (!tracker.expectService(esbuild.version)) {
      throw new Error("The build worker could not register the expected esbuild service version.");
    }
    await esbuild.initialize();
    if (!await tracker.waitForService()) {
      throw new Error("The build worker could not verify its Vite esbuild service child.");
    }

    const viteUrl = pathToFileURL(viteEntry).href;
    const { build } = await import(viteUrl);
    const pluginUrl = pathToFileURL(resolver.resolve("@vitejs/plugin-react")).href;
    const pluginModule = await import(pluginUrl);
    const react = typeof pluginModule.default === "function" ? pluginModule.default : pluginModule;
    if (typeof react !== "function") throw new Error("@vitejs/plugin-react did not export a plugin factory.");

    const modules = path.join(platform, "node_modules");
    const allow = [fs.realpathSync(modules)];
    const config = recipeInlineConfig({
      root: job.root,
      outDir: job.outDir,
      cacheDir: job.cacheDir,
      reactPlugin: react(),
      aliases: recipeAliases((specifier) => resolver.resolve(specifier)),
      allow,
    });

    const output = await build(config);
    const bundles = Array.isArray(output) ? output : [output];
    const moduleIds = new Set();
    for (const bundle of bundles) {
      for (const chunk of bundle && bundle.output ? bundle.output : []) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules || {})) moduleIds.add(id);
      }
    }

    // `server.fs.allow` only guards a dev server, so the claim that the build read
    // nothing outside the source root is checked here, against what was bundled.
    const foreign = foreignModules([...moduleIds], { root: job.root, allow });
    if (foreign.length > 0) {
      outcome = {
        ok: false,
        modules: moduleIds.size,
        foreign,
        error: `The build pulled ${foreign.length} module(s) from outside the source root and the platform toolchain. The artifact was discarded.`,
      };
    } else if (!fs.existsSync(path.join(job.outDir, "index.html"))) {
      outcome = { ok: false, modules: moduleIds.size, error: "The build finished without producing index.html in the output." };
    } else {
      outcome = { ok: true, outDir: job.outDir, modules: moduleIds.size, foreign: [] };
    }
  } catch (err) {
    outcome = { ok: false, error: errorMessage(err) };
  }

  if (esbuild) {
    let settled = false;
    try {
      settled = await tracker.stopAndJoin(esbuild);
    } catch {
      settled = false;
    }
    if (!settled) {
      outcome = {
        ok: false,
        error: "The build worker could not confirm that every toolchain child closed; the artifact was discarded.",
      };
    }
  } else {
    // Startup failed before esbuild was resolved. Any children observed during
    // that attempt still need actual close proof before an outcome is emitted.
    let settled = false;
    try {
      settled = await tracker.stopAndJoin({ stop: async () => {} });
    } catch {
      settled = false;
    }
    if (!settled) outcome = { ok: false, error: "The build worker could not confirm toolchain child settlement." };
  }

  const finalOutcome = outcome || { ok: false, error: "The build worker ended without an outcome." };
  // Publish only at the event-loop exit boundary. The channel stays subscribed
  // through this point, so delayed stop work cannot create an unjoined child
  // after an earlier one-turn quiet check and already-published result.
  process.once("beforeExit", () => {
    if (!tracker.seal()) return;
    writeResult(finalOutcome, resultFile);
    process.exitCode = finalOutcome.ok ? 0 : 1;
  });
}

function isDirectInvocation() {
  const argvEntry = process.argv[1];
  if (!argvEntry) return false;
  try {
    return fs.realpathSync(argvEntry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const [jobFile, resultFile] = process.argv.slice(2);
  if (!jobFile || !resultFile) {
    process.stderr.write("recipe: usage: node recipe-worker.mjs <job.json> <result.json>\n");
    process.exitCode = 1;
  } else {
    runWorker(jobFile, resultFile).catch((err) => {
      process.stderr.write(`recipe: worker failed: ${errorMessage(err)}\n`);
      process.exitCode = 1;
    });
  }
}
