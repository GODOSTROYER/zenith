/**
 * The two isolated runners, against doubles.
 *
 * Neither has been run live from this repository, so what is tested is what can
 * honestly be tested without a provider account: the exact sequence of calls the
 * E2B runner makes (including that the sandbox is killed even when the build
 * fails), the exact `docker run` argument vector (the flags *are* the boundary),
 * and the availability answers that keep either from pretending it can run.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, uuid } from "../_fixtures";

const DATA = isolatedDataDir("zenith-w2-runners-");
const FIXTURE = path.join(process.cwd(), "fixtures", "hosted", "minimal-app");

let build: typeof import("@/lib/hosted/build");
let source: typeof import("@/lib/hosted/source");
let contracts: typeof import("@/lib/hosted/contracts");

beforeAll(async () => {
  build = await import("@/lib/hosted/build");
  source = await import("@/lib/hosted/source");
  contracts = await import("@/lib/hosted/contracts");
});

afterEach(() => {
  delete process.env.ZENITH_BUILD_RUNNER;
  delete process.env.E2B_API_KEY;
});

afterAll(() => removeDir(DATA));

const request = () => ({
  jobId: uuid(),
  appId: "app-alpha",
  source: source.validateSource({ kind: "directory", path: FIXTURE }),
  recipe: contracts.RECIPE_V1,
  limits: { timeoutMs: 60_000, maxLogBytes: 32_000, memoryMb: 512 },
});

/* ----------------------------- the E2B double ----------------------------- */

interface Call {
  name: string;
  detail?: string;
}

function fakeSandbox(behaviour: { installExit?: number; workerExit?: number; result?: unknown; distFiles?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const written = new Map<string, string | ArrayBuffer>();
  const dist = behaviour.distFiles ?? {
    "index.html": "<!doctype html><title>Minimal app</title>",
    "assets/index-abc.js": "console.log('minimal app ok')",
  };
  const sandbox: import("@/lib/hosted/build").RecipeSandbox = {
    sandboxId: "sbx-test-1",
    files: {
      async write(files) {
        calls.push({ name: "files.write", detail: String(files.length) });
        for (const file of files) written.set(file.path, file.data);
        return files.map((f) => ({ path: f.path }));
      },
      async read(target) {
        calls.push({ name: "files.read", detail: target });
        if (target.endsWith("result.json"))
          return new TextEncoder().encode(
            JSON.stringify(behaviour.result ?? { ok: true, outDir: build.SANDBOX_OUT, modules: 27, foreign: [] })
          );
        const relative = target.slice(build.SANDBOX_OUT.length + 1);
        const body = dist[relative];
        if (body === undefined) throw new Error(`no such file ${target}`);
        return new TextEncoder().encode(body);
      },
      async list(dir) {
        calls.push({ name: "files.list", detail: dir });
        return Object.keys(dist).map((relative) => ({
          name: relative.split("/").pop() as string,
          path: `${build.SANDBOX_OUT}/${relative}`,
          type: "file",
        }));
      },
    },
    commands: {
      async run(cmd, opts) {
        calls.push({ name: "commands.run", detail: cmd });
        opts?.onStdout?.(`running ${cmd.slice(0, 20)}\n`);
        const isInstall = cmd.startsWith("npm install");
        const exitCode = isInstall ? behaviour.installExit ?? 0 : behaviour.workerExit ?? 0;
        return { exitCode, stdout: "", stderr: "" };
      },
    },
    async kill() {
      calls.push({ name: "kill" });
      return true;
    },
  };
  return { sandbox, calls, written };
}

describe("E2bRunner availability", () => {
  it("refuses when another runner is selected", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("ZENITH_BUILD_RUNNER");
    expect(availability.fix).toContain("ZENITH_BUILD_RUNNER=e2b");
  });

  it("refuses when E2B_API_KEY is absent, naming the variable", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    const availability = await new build.E2bRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("E2B_API_KEY");
    expect(availability.fix).toContain("E2B_API_KEY");
  });

  it("is available with both the selection and the key", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    expect(await new build.E2bRunner().availability()).toEqual({ available: true });
  });

  it("says its boundary is unverified live", () => {
    expect(new build.E2bRunner().boundary).toContain("unverified live");
    expect(new build.E2bRunner().boundary).toContain("disposable");
  });
});

describe("E2bRunner call sequence", () => {
  it("creates, uploads, installs the platform toolchain, runs the worker, downloads and kills", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    const { sandbox, calls, written } = fakeSandbox();
    const runner = new build.E2bRunner({ createSandbox: async () => sandbox });
    const result = await runner.run(request(), new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.runner).toBe("e2b");

    expect(calls.map((c) => c.name)).toEqual([
      "files.write",
      "commands.run",
      "commands.run",
      "files.read",
      "files.list",
      "files.read",
      "files.read",
      "kill",
    ]);

    const [install, worker] = calls.filter((c) => c.name === "commands.run");
    expect(install?.detail).toContain("npm install --no-audit --no-fund");
    expect(install?.detail).toContain(`vite@${contracts.RECIPE_V1.vite}`);
    expect(install?.detail).toContain(`react@${contracts.RECIPE_V1.react}`);
    expect(worker?.detail).toContain("recipe-worker.mjs");

    // The worker and its config module travel with the source; nothing from the
    // submission decides what runs.
    expect(written.has(`${build.SANDBOX_ROOT}/recipe-worker.mjs`)).toBe(true);
    expect(written.has(`${build.SANDBOX_ROOT}/recipe-config.mjs`)).toBe(true);
    const job = JSON.parse(written.get(`${build.SANDBOX_ROOT}/job.json`) as string);
    expect(job.root).toBe(build.SANDBOX_SOURCE);
    expect(job.outDir).toBe(build.SANDBOX_OUT);
    expect(written.has(`${build.SANDBOX_SOURCE}/src/main.tsx`)).toBe(true);

    const outputDir = result.outputDir as string;
    try {
      expect(fs.readFileSync(path.join(outputDir, "index.html"), "utf8")).toContain("Minimal app");
      expect(fs.existsSync(path.join(outputDir, "assets", "index-abc.js"))).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("kills the sandbox when the install fails", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    const { sandbox, calls } = fakeSandbox({ installExit: 1 });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("pinned toolchain");
    expect(calls.at(-1)?.name).toBe("kill");
  });

  it("kills the sandbox when the worker throws", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    const { sandbox, calls } = fakeSandbox();
    sandbox.commands.run = async () => {
      throw new Error("sandbox went away");
    };
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sandbox went away");
    expect(calls.at(-1)?.name).toBe("kill");
  });

  it("refuses a build whose sandbox result says it failed", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    const { sandbox } = fakeSandbox({ result: { ok: false, error: "esbuild: Unexpected token" } });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unexpected token");
  });

  it("refuses output that has no index.html", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    process.env.E2B_API_KEY = "e2b_test_key";
    const { sandbox } = fakeSandbox({ distFiles: { "assets/only.js": "x" } });
    const result = await new build.E2bRunner({ createSandbox: async () => sandbox }).run(
      request(),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("index.html");
  });
});

/* ---------------------------- the docker double --------------------------- */

/** A `spawn` double: records the argv and answers with a scripted exit code. */
function fakeSpawn(script: (command: string, args: readonly string[]) => { code: number; stdout?: string }) {
  const seen: { command: string; args: string[] }[] = [];
  const spawn: import("@/lib/hosted/build").SpawnFn = (command, args) => {
    seen.push({ command, args: [...args] });
    const answer = script(command, args);
    const child = new EventEmitter() as import("node:child_process").ChildProcess;
    Object.assign(child, {
      pid: 4242,
      stdout: Readable.from([answer.stdout ?? ""]),
      stderr: Readable.from([""]),
      kill: () => true,
    });
    setImmediate(() => child.emit("close", answer.code));
    return child;
  };
  return { spawn, seen };
}

describe("DockerRunner availability", () => {
  it("refuses when another runner is selected", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    const availability = await new build.DockerRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.fix).toContain("ZENITH_BUILD_RUNNER=docker");
  });

  it("reports a daemon that does not answer, with the fix", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    const { spawn } = fakeSpawn(() => ({ code: 1 }));
    const availability = await new build.DockerRunner({ spawn }).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("docker info");
    expect(availability.fix).toContain("Start Docker");
  });

  it("reports a missing image with the command that builds it", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    const { spawn, seen } = fakeSpawn((_c, args) => ({ code: args[0] === "info" ? 0 : 1 }));
    const availability = await new build.DockerRunner({ spawn }).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain(build.RECIPE_IMAGE);
    expect(availability.fix).toContain("docker/recipe/Dockerfile");
    expect(seen.map((s) => s.args[0])).toEqual(["info", "image"]);
  });

  it("is available when the daemon answers and the image is present", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    const { spawn } = fakeSpawn(() => ({ code: 0 }));
    expect(await new build.DockerRunner({ spawn }).availability()).toEqual({ available: true });
  });
});

describe("DockerRunner argument vector", () => {
  it("carries the whole boundary in the flags", () => {
    const args = build.dockerRunArgs({ memoryMb: 768, root: "/tmp/src-1", out: "/tmp/out-1" });
    expect(args).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--memory",
      "768m",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "-v",
      "/tmp/src-1:/src:ro",
      "-v",
      "/tmp/out-1:/out",
      "zenith-recipe:v1",
    ]);
  });

  it("mounts the source read-only and the output writable when it actually runs", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    const { spawn, seen } = fakeSpawn(() => ({ code: 0 }));
    const result = await new build.DockerRunner({ spawn }).run(request(), new AbortController().signal);

    const run = seen.find((s) => s.args[0] === "run");
    expect(run, "the runner must have issued a docker run").toBeTruthy();
    const argv = (run as { args: string[] }).args;
    expect(argv).toContain("--network");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv).toContain("--read-only");
    expect(argv.some((a) => a.endsWith(":/src:ro"))).toBe(true);
    expect(argv.some((a) => a.endsWith(":/out"))).toBe(true);
    expect(argv.at(-1)).toBe(build.RECIPE_IMAGE);

    // The double never wrote a result file, so the runner must say so rather
    // than claim a build it cannot see.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("without writing a result");
  });

  it("says its boundary is the daemon's and unproven here", () => {
    expect(new build.DockerRunner().boundary).toContain("no network");
    expect(new build.DockerRunner().boundary).toContain("no container has been run from this repository");
  });
});
