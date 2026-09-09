/**
 * `docker` — the platform recipe in a throwaway container.
 *
 * The container is the strongest boundary this repository can build without a
 * provider account: no network (`--network none`), a memory cap, one CPU, a
 * pid limit, a read-only root filesystem with only `/tmp` writable, the source
 * mounted read-only at `/src` and one writable mount at `/out`. The image
 * (`docker/recipe/Dockerfile`) already holds the pinned toolchain, so nothing
 * is installed at build time and nothing from the submission is ever run.
 *
 * `spawn` is injectable so the exact argument vector — the part that carries
 * the isolation — is asserted by a test without a daemon.
 *
 * Honest limitation: the image has not been built and no container has been run
 * from this repository. The argv, the mount modes and the availability probe are
 * tested; the runtime behaviour is **unverified live**.
 *
 * Workstream W2 (hosted R3).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Availability, BuildLogLine, BuildRequest, BuildResult, BuildRunner, BuildRunnerId } from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { materializeSource, removeMaterialized } from "@/lib/hosted/source";
import { log } from "@/lib/log";
import type { RecipeWorkerResult } from "./recipe";
import { LogSink, buildResult } from "./runner-support";

/** The image `docker/recipe/Dockerfile` produces. Tagged, never `latest`. */
export const RECIPE_IMAGE = "zenith-recipe:v1";

/** Paths inside the container. Fixed, so the image entrypoint needs no arguments. */
export const CONTAINER_SOURCE = "/src";
export const CONTAINER_OUT = "/out";

/** Same shape as `child_process.spawn`, so the real one is the default. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * The `docker run` argument vector.
 *
 * Exported and tested on its own because these flags *are* the boundary: drop
 * `--network none` and the build can reach the internet, drop `:ro` and it can
 * rewrite the source it was given.
 */
export function dockerRunArgs(input: { memoryMb: number; root: string; out: string; image?: string }): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--memory",
    `${input.memoryMb}m`,
    "--cpus",
    "1",
    "--pids-limit",
    "256",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "-v",
    `${input.root}:${CONTAINER_SOURCE}:ro`,
    "-v",
    `${input.out}:${CONTAINER_OUT}`,
    input.image ?? RECIPE_IMAGE,
  ];
}

export interface DockerOptions {
  spawn?: SpawnFn;
  image?: string;
  /** the `docker` executable, for a host that installs it under another name */
  docker?: string;
}

interface Capture {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  stopped?: "timeout" | "cancelled";
}

/**
 * Run one docker command to completion, killing it on the timeout or on the
 * caller's abort signal. `--rm` means a killed container takes itself away.
 */
function capture(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  opts: { onLine?: (stream: "stdout" | "stderr", chunk: string) => void; signal?: AbortSignal } = {}
): Promise<Capture> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const stopped: { reason: "timeout" | "cancelled" | undefined } = { reason: undefined };
    const stop = (reason: "timeout" | "cancelled"): void => {
      stopped.reason = reason;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
      opts.onLine?.("stdout", d);
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
      opts.onLine?.("stderr", d);
    });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = (): void => stop("cancelled");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (result: Capture): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, stopped: stopped.reason });
    };
    child.on("error", (error) => settle({ code: null, stdout, stderr, error }));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

export class DockerRunner implements BuildRunner {
  readonly id: BuildRunnerId = "docker";
  readonly label = "Platform recipe in a throwaway container";
  readonly boundary =
    "Runs the platform's Vite recipe in a throwaway container with no network, a read-only root filesystem, a memory and pid cap, the source mounted read-only and one writable output mount. No submitted script or config is executed. Container isolation is the Docker daemon's, and no container has been run from this repository.";

  private readonly spawnFn: SpawnFn;
  private readonly image: string;
  private readonly docker: string;

  constructor(options: DockerOptions = {}) {
    this.spawnFn = options.spawn ?? (nodeSpawn as SpawnFn);
    this.image = options.image ?? RECIPE_IMAGE;
    this.docker = options.docker ?? "docker";
  }

  async availability(): Promise<Availability> {
    const selected = hostedConfig().ZENITH_BUILD_RUNNER;
    if (selected !== "docker")
      return {
        available: false,
        reason: `ZENITH_BUILD_RUNNER is "${selected}", so builds are not sent to a container.`,
        fix: "Set ZENITH_BUILD_RUNNER=docker to build in a throwaway container.",
      };
    const info = await capture(this.spawnFn, this.docker, ["info", "--format", "{{.ServerVersion}}"], 2000);
    if (info.error || info.code !== 0)
      return {
        available: false,
        reason: "The Docker daemon did not answer `docker info` within 2 seconds.",
        fix: "Start Docker Desktop or the docker service on this host, then try the build again.",
      };
    const image = await capture(this.spawnFn, this.docker, ["image", "inspect", this.image], 5000);
    if (image.error || image.code !== 0)
      return {
        available: false,
        reason: `The build image ${this.image} is not present on this host.`,
        fix: `Build it once with: docker build -t ${this.image} -f docker/recipe/Dockerfile .`,
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

    const tmp = fs.realpathSync(os.tmpdir());
    const mount = fs.mkdtempSync(path.join(tmp, "zenith-out-"));
    const outDir = path.join(mount, "dist");
    let root: string | undefined;

    try {
      root = materializeSource(req.source);
      fs.mkdirSync(outDir, { recursive: true });
      // The job travels on the writable mount: `/src` is read-only by design.
      fs.writeFileSync(
        path.join(mount, "job.json"),
        JSON.stringify({
          root: CONTAINER_SOURCE,
          outDir: `${CONTAINER_OUT}/dist`,
          cacheDir: "/tmp/vite-cache",
          platformRoot: "/opt/zenith",
          recipe: req.recipe,
        })
      );

      const args = dockerRunArgs({ memoryMb: req.limits.memoryMb, root, out: mount, image: this.image });
      note("info", `${this.docker} ${args.join(" ")}`);
      const result = await capture(this.spawnFn, this.docker, args, req.limits.timeoutMs, { onLine: note, signal });

      if (result.stopped === "cancelled")
        return done({ ok: false, error: "The build was cancelled; the container was killed." });
      if (result.stopped === "timeout")
        return done({
          ok: false,
          error: `The container did not finish within the ${req.limits.timeoutMs} ms timeout and was killed. Reduce the size of the source, or raise the build timeout in the hosted limits.`,
        });
      if (result.error)
        return done({ ok: false, error: `The container could not be started: ${result.error.message}` });

      let worker: RecipeWorkerResult | undefined;
      try {
        worker = JSON.parse(fs.readFileSync(path.join(mount, "result.json"), "utf8")) as RecipeWorkerResult;
      } catch {
        worker = undefined;
      }
      if (!worker)
        return done({
          ok: false,
          error: `The container exited with code ${result.code ?? "unknown"} without writing a result. The captured log is the only evidence of what happened.`,
        });
      if (!worker.ok) return done({ ok: false, error: worker.error ?? "The build failed without naming a reason." });
      if (!fs.existsSync(path.join(outDir, "index.html")))
        return done({ ok: false, error: "The container build produced no index.html. The artifact was not stored." });

      // Hand the caller a standalone directory, the same as the other runners:
      // the mount also holds the job and the result, which are not the artifact.
      const holder = fs.mkdtempSync(path.join(tmp, "zenith-dist-"));
      fs.rmdirSync(holder);
      fs.renameSync(outDir, holder);
      return done({ ok: true, outputDir: holder });
    } catch (err) {
      log.warn("hosted build failed", { runner: this.id, jobId: req.jobId, err });
      return done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (root) removeMaterialized(root);
      // The mount is scratch either way: on success the output has already been
      // moved out of it, on failure there is nothing worth keeping.
      removeMaterialized(mount);
    }
  }
}
