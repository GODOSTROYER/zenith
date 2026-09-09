/**
 * `e2b` — the platform recipe in a disposable remote sandbox.
 *
 * The sequence is fixed and observable: create a sandbox with a timeout, upload
 * the materialized source plus the recipe worker, install the pinned toolchain
 * **inside the sandbox** (never on this host, and never from the submission),
 * run the worker, download `dist/` back, and kill the sandbox in a `finally`
 * whatever happened.
 *
 * The E2B API surface this uses is narrowed to `RecipeSandbox` so tests can
 * inject a double and assert the whole sequence, including teardown on failure.
 * The default factory loads the real SDK lazily, so importing this module does
 * not pull the SDK into a process that will never build.
 *
 * Honest limitation: nothing here has been run against the live service from
 * this repository. Network egress policy, sandbox teardown and artifact
 * extraction are provider behaviours, and they are **unverified live**.
 *
 * Workstream W2 (hosted R3).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Availability, BuildLogLine, BuildRequest, BuildResult, BuildRunner, BuildRunnerId } from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { log } from "@/lib/log";
import { RECIPE_INSTALL_ARGS, recipeWorkerPath, type RecipeWorkerResult } from "./recipe";
import { removeMaterialized } from "@/lib/hosted/source";
import { LogSink, buildResult } from "./runner-support";

/** Where the recipe lives inside the sandbox. Absolute, so no cwd assumption. */
export const SANDBOX_ROOT = "/home/user/zenith";
export const SANDBOX_SOURCE = `${SANDBOX_ROOT}/source`;
export const SANDBOX_OUT = `${SANDBOX_ROOT}/dist`;

/** The slice of the E2B `Sandbox` this runner uses. Kept small so a double is honest. */
export interface RecipeSandbox {
  sandboxId: string;
  files: {
    write(files: { path: string; data: string | ArrayBuffer }[]): Promise<unknown>;
    read(path: string, opts: { format: "bytes" }): Promise<Uint8Array>;
    list(path: string, opts?: { depth?: number }): Promise<{ name: string; path: string; type?: string }[]>;
  };
  commands: {
    run(
      cmd: string,
      opts?: { cwd?: string; timeoutMs?: number; onStdout?: (d: string) => void; onStderr?: (d: string) => void }
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  kill(): Promise<boolean>;
}

/** How a sandbox is obtained. The default asks the real SDK; tests pass a double. */
export type SandboxFactory = (opts: { apiKey: string; timeoutMs: number }) => Promise<RecipeSandbox>;

/**
 * The real factory: `Sandbox.create` from the `e2b` SDK, imported at call time.
 * `allowInternetAccess` stays on because `npm install` of the pinned toolchain
 * happens inside the sandbox; restricting egress to the registry is a provider
 * configuration this repository has not been able to verify live.
 */
export const defaultSandboxFactory: SandboxFactory = async ({ apiKey, timeoutMs }) => {
  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.create({ apiKey, timeoutMs });
  return sandbox as unknown as RecipeSandbox;
};

export interface E2bOptions {
  createSandbox?: SandboxFactory;
  /** absolute path of the worker script uploaded into the sandbox */
  workerPath?: string;
  /** absolute path of the config module the worker imports */
  configPath?: string;
}

const toArrayBuffer = (bytes: Buffer): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export class E2bRunner implements BuildRunner {
  readonly id: BuildRunnerId = "e2b";
  readonly label = "Platform recipe in an E2B sandbox";
  readonly boundary =
    "Runs the platform's Vite recipe inside a disposable remote E2B sandbox, created for this build and killed when it ends. No submitted script or config is executed. The sandbox's network egress policy and its teardown are provider behaviours and are unverified live in this repository.";

  private readonly createSandbox: SandboxFactory;
  private readonly workerPath: string;
  private readonly configPath: string;

  constructor(options: E2bOptions = {}) {
    this.createSandbox = options.createSandbox ?? defaultSandboxFactory;
    this.workerPath = options.workerPath ?? recipeWorkerPath();
    this.configPath = options.configPath ?? path.join(path.dirname(this.workerPath), "recipe-config.mjs");
  }

  async availability(): Promise<Availability> {
    const selected = hostedConfig().ZENITH_BUILD_RUNNER;
    if (selected !== "e2b")
      return {
        available: false,
        reason: `ZENITH_BUILD_RUNNER is "${selected}", so builds are not sent to E2B.`,
        fix: "Set ZENITH_BUILD_RUNNER=e2b to build in a disposable remote sandbox.",
      };
    const key = process.env.E2B_API_KEY;
    if (!key || key.trim() === "")
      return {
        available: false,
        reason: "E2B_API_KEY is not set, so no sandbox can be created.",
        fix: "Put an E2B API key in E2B_API_KEY in .env.local and restart the server, or choose another runner with ZENITH_BUILD_RUNNER.",
      };
    if (!fs.existsSync(this.workerPath) || !fs.existsSync(this.configPath))
      return {
        available: false,
        reason: `The recipe worker or its config module is not on disk (${this.workerPath}).`,
        fix: "Ship src/lib/hosted/build/recipe-worker.mjs and recipe-config.mjs beside the server.",
      };
    return { available: true };
  }

  async run(req: BuildRequest, signal: AbortSignal): Promise<BuildResult> {
    const started = Date.now();
    const sink = new LogSink(req.limits.maxLogBytes);
    const note = (stream: BuildLogLine["stream"], text: string): void => sink.push(stream, `${text}\n`);
    const done = buildResult(sink, this.id, this.boundary, started);

    const availability = await this.availability();
    if (!availability.available)
      return done({ ok: false, error: `${availability.reason} ${availability.fix ?? ""}`.trim() });

    const outDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-dist-"));
    let keepOutput = false;
    let sandbox: RecipeSandbox | undefined;
    try {
      sandbox = await this.createSandbox({
        apiKey: process.env.E2B_API_KEY ?? "",
        timeoutMs: req.limits.timeoutMs,
      });
      note("info", `Sandbox ${sandbox.sandboxId} created for job ${req.jobId}.`);
      if (signal.aborted) return done({ ok: false, error: "The build was cancelled before the sandbox was used." });

      const job = {
        root: SANDBOX_SOURCE,
        outDir: SANDBOX_OUT,
        cacheDir: `${SANDBOX_ROOT}/cache`,
        platformRoot: SANDBOX_ROOT,
        recipe: req.recipe,
      };
      await sandbox.files.write([
        ...req.source.files.map((file) => ({
          path: path.posix.join(SANDBOX_SOURCE, file.path),
          data: toArrayBuffer(file.bytes),
        })),
        { path: `${SANDBOX_ROOT}/recipe-worker.mjs`, data: fs.readFileSync(this.workerPath, "utf8") },
        { path: `${SANDBOX_ROOT}/recipe-config.mjs`, data: fs.readFileSync(this.configPath, "utf8") },
        { path: `${SANDBOX_ROOT}/job.json`, data: JSON.stringify(job) },
      ]);
      note("info", `Uploaded ${req.source.files.length} source files and the recipe worker.`);

      const install = await sandbox.commands.run(`npm ${RECIPE_INSTALL_ARGS.join(" ")}`, {
        cwd: SANDBOX_ROOT,
        timeoutMs: req.limits.timeoutMs,
        onStdout: (d) => note("stdout", d),
        onStderr: (d) => note("stderr", d),
      });
      if (install.exitCode !== 0)
        return done({
          ok: false,
          error: `Installing the pinned toolchain in the sandbox failed with exit code ${install.exitCode}. This is the platform recipe, not the submission's dependencies.`,
        });

      const worker = await sandbox.commands.run(
        `node ${SANDBOX_ROOT}/recipe-worker.mjs ${SANDBOX_ROOT}/job.json ${SANDBOX_ROOT}/result.json`,
        {
          cwd: SANDBOX_ROOT,
          timeoutMs: req.limits.timeoutMs,
          onStdout: (d) => note("stdout", d),
          onStderr: (d) => note("stderr", d),
        }
      );

      let result: RecipeWorkerResult | undefined;
      try {
        const raw = await sandbox.files.read(`${SANDBOX_ROOT}/result.json`, { format: "bytes" });
        result = JSON.parse(Buffer.from(raw).toString("utf8")) as RecipeWorkerResult;
      } catch {
        result = undefined;
      }
      if (!result)
        return done({
          ok: false,
          error: `The recipe worker exited with code ${worker.exitCode} without writing a result in the sandbox.`,
        });
      if (!result.ok) return done({ ok: false, error: result.error ?? "The build failed without naming a reason." });

      const entries = await sandbox.files.list(SANDBOX_OUT, { depth: 20 });
      let files = 0;
      for (const entry of entries) {
        if (entry.type === "dir") continue;
        const relative = entry.path.startsWith(`${SANDBOX_OUT}/`) ? entry.path.slice(SANDBOX_OUT.length + 1) : entry.name;
        if (relative.includes("..") || relative.startsWith("/")) continue;
        const bytes = await sandbox.files.read(entry.path, { format: "bytes" });
        const target = path.join(outDir, ...relative.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(bytes));
        files += 1;
      }
      note("info", `Downloaded ${files} output files from the sandbox.`);
      if (!fs.existsSync(path.join(outDir, "index.html")))
        return done({ ok: false, error: "The sandbox build produced no index.html. The artifact was not stored." });

      keepOutput = true;
      return done({ ok: true, outputDir: outDir });
    } catch (err) {
      log.warn("hosted build failed", { runner: this.id, jobId: req.jobId, err });
      return done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (sandbox) {
        try {
          await sandbox.kill();
        } catch (err) {
          log.warn("hosted build sandbox was not torn down", { runner: this.id, jobId: req.jobId, err });
        }
      }
      if (!keepOutput) removeMaterialized(outDir);
    }
  }
}
