import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveViteEsbuild } from "../../../src/lib/hosted/build/recipe-worker.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHILD_FIXTURE = path.join(ROOT, "tests/fixtures/recipe-child-compatibility/child.js");
const tempRoots = new Set<string>();
const FIXTURE_WATCHDOG_MS = 15_000;

function withWatchdog<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), FIXTURE_WATCHDOG_MS);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function viteFixture({ splitEsbuild = false }: { splitEsbuild?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zenith-worker-compat-"));
  tempRoots.add(root);
  const viteNode = path.join(root, "node_modules", "vite", "dist", "node");
  const entry = path.join(viteNode, "index.js");
  const config = path.join(viteNode, "chunks", "config.js");
  const rootEsbuild = path.join(root, "node_modules", "esbuild");
  const chunkEsbuild = splitEsbuild
    ? path.join(path.dirname(config), "node_modules", "esbuild")
    : rootEsbuild;

  mkdirSync(path.dirname(entry), { recursive: true });
  mkdirSync(path.dirname(config), { recursive: true });
  mkdirSync(rootEsbuild, { recursive: true });
  mkdirSync(chunkEsbuild, { recursive: true });
  writeFileSync(entry, "module.exports = {};\n");
  writeFileSync(config, "module.exports = {};\n");
  writeFileSync(path.join(rootEsbuild, "index.js"), 'exports.version="1.0.0"; exports.initialize=async()=>{}; exports.stop=async()=>{};\n');
  if (splitEsbuild) {
    writeFileSync(path.join(chunkEsbuild, "index.js"), 'exports.version="1.0.0"; exports.initialize=async()=>{}; exports.stop=async()=>{};\n');
  }
  return { root, entry };
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

describe("recipe worker runtime compatibility gates", () => {
  it("records compatibility only on the pinned Node 22.23.3 runtime", () => {
    expect(process.versions.node).toBe("22.23.3");
  });

  it("does not treat an empty observed-child set as service settlement", async () => {
    const workerUrl = pathToFileURL(path.join(ROOT, "src/lib/hosted/build/recipe-worker.mjs")).href;
    const source = `
      import { createChildSettlementTracker } from ${JSON.stringify(workerUrl)};
      const tracker = createChildSettlementTracker();
      tracker.subscribe();
      tracker.expectService("expected-version");
      let settled = false;
      const finalizing = tracker.stopAndJoin({ stop: async () => {} }).then(() => { settled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write("COMPAT_ZERO:" + JSON.stringify({ pending: !settled, snapshot: tracker.snapshot() }) + "\\n");
      await finalizing;
    `;
    const worker = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    const output = createInterface({ input: worker.stdout! });
    worker.stderr!.resume();
    const line = new Promise<string>((resolve, reject) => {
      const onLine = (value: string) => {
        if (value.startsWith("COMPAT_ZERO:")) {
          output.off("line", onLine);
          worker.off("close", onClose);
          resolve(value.slice("COMPAT_ZERO:".length));
        }
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        output.off("line", onLine);
        reject(new Error(`Zero-observation fixture closed before checkpoint (code=${code}, signal=${signal})`));
      };
      output.on("line", onLine);
      worker.once("close", onClose);
      worker.once("error", reject);
    });
    const workerClosed = once(worker, "close");
    try {
      const report = JSON.parse(await withWatchdog(line, "zero-observation checkpoint")) as { pending: boolean; snapshot: Record<string, unknown> };
      expect(report.pending).toBe(true);
      expect(report.snapshot).toMatchObject({ observed: 0, spawned: 0, closed: 0, live: 0, serviceSpawned: 0, proofLost: true });
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
      try {
        await withWatchdog(workerClosed, "zero-observation fixture close");
      } catch (error) {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await withWatchdog(workerClosed, "zero-observation fixture close after forced cleanup");
        throw error;
      }
      output.close();
    }
  }, 60_000);

  it("refuses a child whose observed service argument has a different version, then joins actual close", async () => {
    const workerUrl = pathToFileURL(path.join(ROOT, "src/lib/hosted/build/recipe-worker.mjs")).href;
    const source = `
      import { spawn } from "node:child_process";
      import { createInterface } from "node:readline";
      import { createChildSettlementTracker } from ${JSON.stringify(workerUrl)};
      (async () => {
      const input = createInterface({ input: process.stdin });
      const tracker = createChildSettlementTracker({ spawnTimeoutMs: 5_000 });
      tracker.subscribe();
      tracker.expectService("expected-version");
      let releaseRequested = false;
      let cancelRequested = false;
      let helperSpawned = false;
      let helperClosed = false;
      let helper;
      const releaseHelper = () => {
        if (helperSpawned && !helperClosed && helper.stdin && !helper.stdin.destroyed) helper.stdin.end("release\\n");
      };
      input.on("line", (line) => {
        if (line === "RELEASE") releaseRequested = true;
        if (line === "CANCEL") cancelRequested = true;
        if (releaseRequested) releaseHelper();
        if (cancelRequested && helperSpawned && !helperClosed) helper.kill("SIGTERM");
      });
      helper = spawn(process.execPath, [${JSON.stringify(CHILD_FIXTURE)}, "--service=other-version", "--ping"], { stdio: ["pipe", "ignore", "ignore"] });
      const spawnOrError = new Promise((resolve) => {
        helper.once("spawn", () => {
          helperSpawned = true;
          process.stdout.write("COMPAT_CHILD_SPAWNED\\n");
          if (releaseRequested) releaseHelper();
          if (cancelRequested) helper.kill("SIGTERM");
          resolve(true);
        });
        helper.once("error", () => resolve(false));
      });
      const helperClosedSignal = new Promise((resolve) => helper.once("close", (code, signal) => {
        helperClosed = true;
        process.stdout.write("COMPAT_CHILD_CLOSED:" + JSON.stringify({ spawned: helperSpawned, code, signal }) + "\\n");
        resolve({ code, signal });
      }));
      if (!await spawnOrError) {
        const { code } = await helperClosedSignal;
        const result = await tracker.stopAndJoin({ stop: async () => {} });
        const sealed = tracker.seal();
        process.stdout.write("COMPAT_SETTLED:" + JSON.stringify({ result, code, sealed, snapshot: tracker.snapshot() }) + "\\n");
        return;
      }
      const recognized = await tracker.waitForService();
      let settled = false;
      let resolveStop;
      const stopCalled = new Promise((resolve) => { resolveStop = resolve; });
      const finalizing = tracker.stopAndJoin({ stop: async () => { resolveStop(); } }).then((result) => { settled = true; return result; });
      await stopCalled;
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write("COMPAT_STARTED:" + JSON.stringify({ recognized, settled, snapshot: tracker.snapshot() }) + "\\n");
      const { code } = await helperClosedSignal;
      const result = await finalizing;
      const sealed = tracker.seal();
      process.stdout.write("COMPAT_SETTLED:" + JSON.stringify({ result, code, sealed, snapshot: tracker.snapshot() }) + "\\n");
      })().catch((error) => {
        process.stderr.write(String(error && error.stack || error) + "\\n");
        process.exitCode = 1;
      });
    `;
    const worker = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
    const output = createInterface({ input: worker.stdout! });
    let workerStderr = "";
    worker.stderr!.setEncoding("utf8");
    worker.stderr!.on("data", (chunk: string) => { workerStderr = (workerStderr + chunk).slice(-8_192); });
    const readMessage = (name: string) => new Promise<string>((resolve, reject) => {
      const onLine = (value: string) => {
        if (value.startsWith(`${name}:`)) {
          output.off("line", onLine);
          worker.off("close", onClose);
          resolve(value.slice(name.length + 1));
        }
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        output.off("line", onLine);
        reject(new Error(`Compatibility worker closed before ${name} (code=${code}, signal=${signal})${workerStderr ? `; stderr: ${workerStderr}` : ""}`));
      };
      output.on("line", onLine);
      worker.once("close", onClose);
      worker.once("error", reject);
    });
    let nestedCloseReport: { spawned: boolean; code: number | null; signal: string | null } | undefined;
    let resolveNestedClose!: (value: typeof nestedCloseReport) => void;
    const nestedClosed = new Promise<typeof nestedCloseReport>((resolve) => { resolveNestedClose = resolve; });
    output.on("line", (value) => {
      if (value.startsWith("COMPAT_CHILD_CLOSED:")) {
        nestedCloseReport = JSON.parse(value.slice("COMPAT_CHILD_CLOSED:".length)) as typeof nestedCloseReport;
        resolveNestedClose(nestedCloseReport);
      }
    });
    const started = readMessage("COMPAT_STARTED");
    const completed = readMessage("COMPAT_SETTLED");
    void completed.catch(() => undefined);
    const workerClosed = once(worker, "close");
    try {
      const held = JSON.parse(await withWatchdog(started, "wrong-version start checkpoint")) as { recognized: boolean; settled: boolean; snapshot: Record<string, unknown> };
      expect(held.recognized).toBe(false);
      expect(held.settled).toBe(false);
      expect(held.snapshot).toMatchObject({ spawned: 1, serviceSpawned: 0, live: 1, uncertain: true });

      // Release is event-controlled: the isolated worker cannot publish
      // settlement until this real child emits its actual close event.
      worker.stdin!.write("RELEASE\n");
      const report = JSON.parse(await withWatchdog(completed, "wrong-version child settlement")) as { result: boolean; code: number | null; sealed: boolean; snapshot: Record<string, unknown> };
      expect(report).toMatchObject({ result: false, code: 0, sealed: true });
      expect(report.snapshot).toMatchObject({ spawned: 1, closed: 1, live: 0, serviceSpawned: 0, uncertain: true });
      expect(nestedCloseReport).toMatchObject({ spawned: true, code: 0, signal: null });
      worker.stdin!.end("RELEASE\n");
      const [code] = await withWatchdog(workerClosed, "compatibility worker close") as [number | null, NodeJS.Signals | null];
      expect(code).toBe(0);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.stdin?.write("RELEASE\n");
      }
      if (worker.exitCode === null && worker.signalCode === null && !nestedCloseReport) {
        try {
          nestedCloseReport = await withWatchdog(nestedClosed, "actual nested child close during cleanup");
        } catch {
          worker.stdin?.write("CANCEL\n");
          nestedCloseReport = await withWatchdog(nestedClosed, "actual nested child close after owned-child cancellation");
        }
      }
      if (nestedCloseReport && worker.exitCode === null && worker.signalCode === null) {
        try {
          await withWatchdog(completed, "tracker settlement after nested close");
        } catch {
          // The nested child close is now explicit; only now can fixture
          // cleanup terminate its parent without risking an orphan.
          if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
        }
      }
      if (nestedCloseReport && worker.exitCode === null && worker.signalCode === null && !worker.stdin!.writableEnded) {
        worker.stdin!.end("RELEASE\n");
      }
      try {
        await withWatchdog(workerClosed, "compatibility worker close");
      } catch (error) {
        if (nestedCloseReport && worker.exitCode === null && worker.signalCode === null) {
          worker.kill("SIGKILL");
          await withWatchdog(workerClosed, "compatibility worker close after verified nested close");
        }
        throw error;
      }
      output.close();
    }
  }, 90_000);

  it("accepts one Vite/esbuild module identity and refuses a different config-chunk copy", () => {
    const same = viteFixture();
    const selected = resolveViteEsbuild(same.entry);
    expect(selected.esbuild.version).toBe("1.0.0");
    expect(selected.esbuildPath).toBe(createRequire(same.entry).resolve("esbuild"));

    const split = viteFixture({ splitEsbuild: true });
    expect(() => resolveViteEsbuild(split.entry)).toThrow(/different esbuild module/i);
  });

  it("resolves the repository's Vite-owned esbuild API without substituting another package copy", () => {
    const viteEntry = createRequire(path.join(ROOT, "package.json")).resolve("vite");
    const resolved = resolveViteEsbuild(viteEntry);
    expect(resolved.esbuild).toBe(createRequire(viteEntry)("esbuild"));
    expect(typeof resolved.esbuild.initialize).toBe("function");
    expect(typeof resolved.esbuild.stop).toBe("function");
  });
});
