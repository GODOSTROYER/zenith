/**
 * `recipe-local` — the platform recipe in a child process on the control host.
 *
 * This is a **process boundary, not a hostile-code sandbox**, and the class says
 * so in its own `boundary` string so no screen can imply otherwise. What it does
 * give is real and worth having: the build runs in a separate process with an
 * environment built from an allowlist (no platform secret can be read), a
 * wall-clock timeout enforced with SIGKILL, a V8 heap cap, a bounded log, and a
 * module-origin check that fails the build if anything outside the source root
 * and the pinned toolchain reached the bundle.
 *
 * It is allowed to run only when `ZENITH_BUILD_RUNNER=recipe-local`; otherwise
 * `availability()` names the variable and points at the isolated runners.
 *
 * Workstream W2 (hosted R3).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Availability, BuildRequest, BuildResult, BuildRunner, BuildRunnerId } from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { materializeSource, removeMaterialized } from "@/lib/hosted/source";
import { log } from "@/lib/log";
import { missingRecipePackages, platformRoot, recipeJob, recipeWorkerPath, type RecipeWorkerResult } from "./recipe";
import { LogSink, buildResult } from "./runner-support";

/**
 * Environment name prefixes that must never reach a build. The runner checks
 * what it passes; the build tests check what the child actually received, using
 * this same list, so the two cannot drift apart.
 */
export const FORBIDDEN_ENV_PREFIXES = ["ORRERY_", "SUPABASE_", "NEXT_PUBLIC_", "ZENITH_", "E2B_", "AWS_"] as const;

/** Which of `keys` a build must never see. Empty means the environment is clean. */
export const secretEnvKeys = (keys: readonly string[]): string[] =>
  keys.filter((key) => FORBIDDEN_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix)));

/**
 * The child's environment: `PATH` so `node` can find the executables esbuild
 * spawns, and an empty `NODE_OPTIONS` so an inherited `--require` cannot inject
 * code. Nothing else is passed.
 *
 * ponytail: Windows' `CreateProcess` adds `SYSTEMROOT`, `TEMP`, `USERPROFILE`
 * and friends whatever the parent supplies, so the child's own view of its
 * environment is a little wider than this object on that platform. None of
 * those names can carry a platform secret, and the build tests assert the
 * forbidden prefixes are absent from what the child actually sees.
 */
export function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NODE_OPTIONS: "" };
  const leaked = secretEnvKeys(Object.keys(env));
  if (leaked.length > 0)
    throw new Error(`The build environment would carry ${leaked.join(", ")}. Fix: remove them from buildChildEnv().`);
  return env;
}

/** Kill the worker and anything it started. SIGKILL first; Windows needs the tree. */
export function killTree(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
        "error",
        () => {
          // taskkill missing is not a reason to fail the build result
        }
      );
    } catch {
      // ditto
    }
  }
}

/** Construction options; the defaults are what production uses. */
export interface RecipeLocalOptions {
  /** absolute path of the worker script — tests point this at a double */
  workerPath?: string;
  /** the directory whose node_modules holds the pinned toolchain */
  platformRoot?: string;
}

export class RecipeLocalRunner implements BuildRunner {
  readonly id: BuildRunnerId = "recipe-local";
  readonly label = "Platform recipe, child process on this host";
  readonly boundary =
    "Runs the platform's Vite recipe in a separate child process on the control host with an empty environment, a wall-clock timeout and a memory cap. No submitted script or config is executed. This is a process boundary, not a hostile-code sandbox.";

  private readonly platformRoot: string;
  private readonly workerPath: string;

  constructor(options: RecipeLocalOptions = {}) {
    this.platformRoot = options.platformRoot ?? platformRoot();
    this.workerPath = options.workerPath ?? recipeWorkerPath(this.platformRoot);
  }

  async availability(): Promise<Availability> {
    const selected = hostedConfig().ZENITH_BUILD_RUNNER;
    if (selected !== "recipe-local")
      return {
        available: false,
        reason: `ZENITH_BUILD_RUNNER is "${selected}", so building on the control host is not permitted.`,
        fix: "Set ZENITH_BUILD_RUNNER=recipe-local to accept a same-host process boundary, or choose an isolated runner: ZENITH_BUILD_RUNNER=e2b (needs E2B_API_KEY) or ZENITH_BUILD_RUNNER=docker (needs a running daemon and the zenith-recipe:v1 image).",
      };
    if (!fs.existsSync(this.workerPath))
      return {
        available: false,
        reason: `The recipe worker is not on disk at ${this.workerPath}.`,
        fix: "Ship src/lib/hosted/build/recipe-worker.mjs and recipe-config.mjs beside the server, or construct RecipeLocalRunner with an explicit workerPath.",
      };
    const missing = missingRecipePackages(this.platformRoot);
    if (missing.length > 0)
      return {
        available: false,
        reason: `The pinned toolchain is not installed under ${this.platformRoot}: ${missing.join(", ")} cannot be resolved.`,
        fix: "Install the platform dependencies in that directory, or construct RecipeLocalRunner with the platformRoot that owns node_modules.",
      };
    return { available: true };
  }

  async run(req: BuildRequest, signal: AbortSignal): Promise<BuildResult> {
    const started = Date.now();
    const sink = new LogSink(req.limits.maxLogBytes);
    const done = buildResult(sink, this.id, this.boundary, started);

    const availability = await this.availability();
    if (!availability.available)
      return done({ ok: false, error: `${availability.reason} ${availability.fix ?? ""}`.trim() });

    const tmp = fs.realpathSync(os.tmpdir());
    const work = fs.mkdtempSync(path.join(tmp, "zenith-build-"));
    const outDir = fs.mkdtempSync(path.join(tmp, "zenith-dist-"));
    let root: string | undefined;
    // The caller owns `outDir` only when the build succeeded; a failed build
    // must not leave a half-written tree behind for someone to publish.
    let keepOutput = false;

    try {
      root = materializeSource(req.source);
      const job = recipeJob({
        root,
        outDir,
        cacheDir: path.join(work, "vite-cache"),
        platformRoot: this.platformRoot,
        recipe: req.recipe,
      });
      const jobFile = path.join(work, "job.json");
      const resultFile = path.join(work, "result.json");
      fs.writeFileSync(jobFile, JSON.stringify(job));
      sink.line("info", `Recipe ${req.recipe.id}: vite ${req.recipe.vite}, @vitejs/plugin-react ${req.recipe.pluginReact}, react ${req.recipe.react}.`);
      sink.line("info", `Build job ${req.jobId} for app ${req.appId}; source digest ${req.source.digest}.`);

      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${req.limits.memoryMb}`, this.workerPath, jobFile, resultFile],
        {
          // Cast because Next augments `ProcessEnv` with a required NODE_ENV;
          // the whole point here is that the child gets nothing but these two.
          env: buildChildEnv() as NodeJS.ProcessEnv,
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }
      );

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => sink.push("stdout", chunk));
      child.stderr?.on("data", (chunk: string) => sink.push("stderr", chunk));

      // A box rather than a `let`, so the value the callbacks write is the value
      // read after `await` (narrowing a captured `let` would hide it).
      const stopped: { reason: "timeout" | "cancelled" | null } = { reason: null };
      const timer = setTimeout(() => {
        stopped.reason = "timeout";
        killTree(child);
      }, req.limits.timeoutMs);
      const onAbort = (): void => {
        stopped.reason = "cancelled";
        killTree(child);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });

      const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.on("error", (error) => resolve({ code: null, error }));
        child.on("close", (code) => resolve({ code }));
      });
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      sink.end();

      if (stopped.reason === "timeout")
        return done({
          ok: false,
          error: `The build did not finish within the ${req.limits.timeoutMs} ms timeout and was killed. Reduce the size of the source, or raise the build timeout in the hosted limits.`,
        });
      if (stopped.reason === "cancelled")
        return done({ ok: false, error: "The build was cancelled before it finished; the worker was killed." });
      if (exit.error)
        return done({ ok: false, error: `The build worker could not be started: ${exit.error.message}` });

      let result: RecipeWorkerResult | undefined;
      try {
        result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as RecipeWorkerResult;
      } catch {
        result = undefined;
      }
      if (!result)
        return done({
          ok: false,
          error: `The build worker exited with code ${exit.code ?? "unknown"} without writing a result. The captured log is the only evidence of what happened.`,
        });
      if (!result.ok) return done({ ok: false, error: result.error ?? "The build failed without naming a reason." });
      if (!fs.existsSync(path.join(outDir, "index.html")))
        return done({ ok: false, error: "The build reported success but the output has no index.html. The artifact was not stored." });

      sink.line("info", `Build succeeded: ${result.modules ?? 0} modules, output in ${path.basename(outDir)}.`);
      keepOutput = true;
      return done({ ok: true, outputDir: outDir });
    } catch (err) {
      sink.end();
      log.warn("hosted build failed", { runner: this.id, jobId: req.jobId, err });
      return done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (root) removeMaterialized(root);
      removeMaterialized(work);
      if (!keepOutput) removeMaterialized(outDir);
    }
  }
}
