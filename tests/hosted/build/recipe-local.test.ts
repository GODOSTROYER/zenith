/**
 * `recipe-local`: a real build, a real child process, a real kill.
 *
 * The happy path compiles `fixtures/hosted/minimal-app` with the platform
 * recipe and checks the output is a site, not a claim. The rest of the file
 * checks the things that make the runner honest: it refuses to run unless the
 * install said it may, it hands the child no platform secret, it kills a build
 * that overruns or is cancelled, and it bounds the log it keeps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, uuid } from "../_fixtures";

const DATA = isolatedDataDir("zenith-w2-build-");
const FIXTURE = path.join(process.cwd(), "fixtures", "hosted", "minimal-app");
const HERE = path.join(process.cwd(), "tests", "hosted", "build");

let build: typeof import("@/lib/hosted/build");
let source: typeof import("@/lib/hosted/source");
let contracts: typeof import("@/lib/hosted/contracts");

beforeAll(async () => {
  build = await import("@/lib/hosted/build");
  source = await import("@/lib/hosted/source");
  contracts = await import("@/lib/hosted/contracts");
});

afterEach(async () => {
  delete process.env.ZENITH_BUILD_RUNNER;
});

afterAll(() => removeDir(DATA));

const outputs: string[] = [];
afterAll(async () => {
  for (const dir of outputs) fs.rmSync(dir, { recursive: true, force: true });
});

function request(overrides: Partial<import("@/lib/hosted/contracts").BuildRequest> = {}) {
  return {
    jobId: uuid(),
    appId: "app-alpha",
    source: source.validateSource({ kind: "directory", path: FIXTURE }),
    recipe: contracts.RECIPE_V1,
    limits: { timeoutMs: 120_000, maxLogBytes: 64_000, memoryMb: 512 },
    ...overrides,
  };
}

describe("RecipeLocalRunner availability", () => {
  it("refuses when ZENITH_BUILD_RUNNER is unset, naming the variable and the isolated options", async () => {
    // CI's hosted job exports ZENITH_BUILD_RUNNER for the whole process, so
    // "unset" has to be made true here rather than assumed.
    const had = process.env.ZENITH_BUILD_RUNNER;
    delete process.env.ZENITH_BUILD_RUNNER;
    try {
      const availability = await new build.RecipeLocalRunner().availability();
      expect(availability.available).toBe(false);
      expect(availability.reason).toContain("ZENITH_BUILD_RUNNER");
      expect(availability.fix).toContain("ZENITH_BUILD_RUNNER=e2b");
      expect(availability.fix).toContain("ZENITH_BUILD_RUNNER=docker");
    } finally {
      if (had !== undefined) process.env.ZENITH_BUILD_RUNNER = had;
    }
  });

  it("refuses when another runner is selected", async () => {
    process.env.ZENITH_BUILD_RUNNER = "docker";
    const availability = await new build.RecipeLocalRunner().availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('"docker"');
  });

  it("refuses, without pretending, when the worker file is missing", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const runner = new build.RecipeLocalRunner({ workerPath: path.join(DATA, "not-here.mjs") });
    const availability = await runner.availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("not-here.mjs");
    expect(availability.fix).toContain("recipe-worker.mjs");
  });

  it("is available once the install has chosen it", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    expect(await new build.RecipeLocalRunner().availability()).toEqual({ available: true });
  });

  it("names the process boundary it does and does not provide", async () => {
    const runner = new build.RecipeLocalRunner();
    expect(runner.boundary).toContain("not a hostile-code sandbox");
    expect(runner.boundary).toContain("separate child process");
  });
});

describe("RecipeLocalRunner refusing to build", () => {
  it("answers ok:false with the availability reason rather than failing silently", async () => {
    const result = await new build.RecipeLocalRunner().run(request(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.outputDir).toBeUndefined();
    expect(result.error).toContain("ZENITH_BUILD_RUNNER");
    expect(result.runner).toBe("recipe-local");
  });
});

describe("RecipeLocalRunner building the minimal app for real", () => {
  it("compiles the fixture into a site", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const req = request();
    const result = await new build.RecipeLocalRunner().run(req, new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.runner).toBe("recipe-local");
    expect(result.boundary).toBe(new build.RecipeLocalRunner().boundary);
    expect(result.durationMs).toBeGreaterThan(0);

    const outputDir = result.outputDir as string;
    outputs.push(outputDir);
    expect(fs.existsSync(path.join(outputDir, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "favicon.svg"))).toBe(true);

    const assets = fs.readdirSync(path.join(outputDir, "assets"));
    expect(assets.some((f) => f.endsWith(".js"))).toBe(true);
    expect(assets.some((f) => f.endsWith(".css"))).toBe(true);
    expect(assets.some((f) => f.endsWith(".map"))).toBe(false);

    const html = fs.readFileSync(path.join(outputDir, "index.html"), "utf8");
    expect(html).toContain("Minimal app");
    const bundle = fs.readFileSync(path.join(outputDir, "assets", assets.find((f) => f.endsWith(".js")) as string), "utf8");
    expect(bundle).toContain("Minimal app OK");

    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.logs.every((line) => typeof line.ts === "string" && line.line.length > 0)).toBe(true);
    expect(result.logs.some((line) => line.line.includes(req.source.digest))).toBe(true);
    expect(result.logs.some((line) => line.stream === "stdout")).toBe(true);
  }, 180_000);

  it("leaves no materialized source behind", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    // Other test files materialize into the shared temp directory at the same
    // time, so count in a temp directory only this test owns: `os.tmpdir()`
    // follows TMPDIR (POSIX) and TEMP/TMP (Windows) at call time.
    const own = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-recipe-tmp-"));
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = own;
    process.env.TEMP = own;
    process.env.TMP = own;
    try {
      const result = await new build.RecipeLocalRunner().run(request(), new AbortController().signal);
      if (result.outputDir) outputs.push(result.outputDir);
      expect(result.ok).toBe(true);
      const left = fs.readdirSync(own).filter((name) => name.startsWith(source.MATERIALIZE_PREFIX));
      expect(left).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(own, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("RecipeLocalRunner isolation and limits", () => {
  it("hands the child no ZENITH_, SUPABASE_, NEXT_PUBLIC_, ZENITH_, E2B_ or AWS_ variable", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    // A structurally valid key, so `env()` accepts it and the only thing under
    // test is whether it travels into the child. It is not used to encrypt.
    process.env.ZENITH_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "also-must-not-travel";
    process.env.AWS_ACCESS_KEY_ID = "nor-this";
    try {
      const runner = new build.RecipeLocalRunner({ workerPath: path.join(HERE, "echo-env-worker.mjs") });
      const result = await runner.run(request(), new AbortController().signal);

      expect(result.ok).toBe(false);
      const echoed = result.logs.find((line) => line.line.startsWith("env-keys "));
      expect(echoed, "the debug worker must report the environment it received").toBeTruthy();
      const keys = (echoed as import("@/lib/hosted/contracts").BuildLogLine).line.slice("env-keys ".length).split(",");
      expect(keys).toContain("PATH");
      expect(await build.secretEnvKeys(keys)).toEqual([]);
      expect(keys).not.toContain("ZENITH_SECRET_KEY");
      expect(keys).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(keys).not.toContain("AWS_ACCESS_KEY_ID");
    } finally {
      delete process.env.ZENITH_SECRET_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.AWS_ACCESS_KEY_ID;
    }
  }, 60_000);

  it("passes the memory cap to the child", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const runner = new build.RecipeLocalRunner({ workerPath: path.join(HERE, "echo-env-worker.mjs") });
    const result = await runner.run(request({ limits: { timeoutMs: 30_000, maxLogBytes: 64_000, memoryMb: 321 } }), new AbortController().signal);
    expect(result.logs.some((line) => line.line.includes("--max-old-space-size=321"))).toBe(true);
  }, 60_000);

  it("kills a build that overruns its timeout and says so", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const runner = new build.RecipeLocalRunner({ workerPath: path.join(HERE, "slow-worker.mjs") });
    const started = Date.now();
    const result = await runner.run(
      request({ limits: { timeoutMs: 1500, maxLogBytes: 64_000, memoryMb: 512 } }),
      new AbortController().signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1500 ms timeout");
    expect(result.error).toContain("killed");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.logs.some((line) => line.line.includes("will not finish"))).toBe(true);
  }, 60_000);

  it("honours an abort signal", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const runner = new build.RecipeLocalRunner({ workerPath: path.join(HERE, "slow-worker.mjs") });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await runner.run(
      request({ limits: { timeoutMs: 120_000, maxLogBytes: 64_000, memoryMb: 512 } }),
      controller.signal
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");
  }, 60_000);

  it("refuses immediately when the signal is already aborted", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const runner = new build.RecipeLocalRunner({ workerPath: path.join(HERE, "slow-worker.mjs") });
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run(request(), controller.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");
  }, 60_000);

  it("caps the captured log and says it truncated", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const runner = new build.RecipeLocalRunner({ workerPath: path.join(HERE, "noisy-worker.mjs") });
    const result = await runner.run(
      request({ limits: { timeoutMs: 60_000, maxLogBytes: 4096, memoryMb: 512 } }),
      new AbortController().signal
    );
    const bytes = result.logs.reduce((sum, line) => sum + Buffer.byteLength(line.line, "utf8") + 1, 0);
    expect(bytes).toBeLessThan(4096 + 200);
    expect(result.logs.some((line) => line.line.includes("Log truncated at 4096 bytes"))).toBe(true);
  }, 60_000);

  it("reports a worker that writes no result, without inventing one", async () => {
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    const missing = path.join(DATA, "silent-worker.mjs");
    fs.writeFileSync(missing, "process.exit(3);\n");
    const runner = new build.RecipeLocalRunner({ workerPath: missing });
    const result = await runner.run(request(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("without writing a result");
    expect(result.error).toContain("3");
  }, 60_000);
});

describe("the recipe itself", () => {
  it("never loads a submitted config or env file, and pins react to the platform copy", async () => {
    const config = await build.recipeConfig(FIXTURE, path.join(DATA, "out"));
    expect(config.configFile).toBe(false);
    expect(config.envFile).toBe(false);
    expect(config.root).toBe(FIXTURE);
    expect(config.build?.sourcemap).toBe(false);
    expect(config.build?.target).toBe("es2022");
    expect(config.build?.emptyOutDir).toBe(true);
    expect(config.plugins?.length).toBe(1);
    expect(config.define).toEqual({});

    const alias = config.resolve?.alias as { find: RegExp; replacement: string }[];
    expect(alias.map((a) => a.find.source)).toEqual(
      build.RECIPE_ALIAS_SPECIFIERS.map((s) => `^${s.replace(/\//g, "\\/")}$`)
    );
    for (const entry of alias) expect(entry.replacement.includes("node_modules")).toBe(true);
  });

  it("recognises a module that came from outside the source root", async () => {
    const root = "/tmp/source";
    const allow = ["/platform/node_modules"];
    expect(
      await build.foreignModules(
        ["/tmp/source/src/main.tsx", "/platform/node_modules/react/index.js", "\u0000vite/modulepreload-polyfill.js"],
        { root, allow }
      )
    ).toEqual([]);
    expect(await build.foreignModules(["/etc/passwd", "/tmp/source/../other/x.tsx"], { root, allow })).toEqual([
      "/etc/passwd",
      "/tmp/source/../other/x.tsx",
    ]);
  });

  it("reproduces the pinned toolchain in one install line", async () => {
    expect(build.RECIPE_INSTALL_ARGS).toContain(`vite@${contracts.RECIPE_V1.vite}`);
    expect(build.RECIPE_INSTALL_ARGS).toContain(`@vitejs/plugin-react@${contracts.RECIPE_V1.pluginReact}`);
    expect(build.RECIPE_INSTALL_ARGS).toContain(`react@${contracts.RECIPE_V1.react}`);
    expect(build.RECIPE_INSTALL_ARGS).toContain("--no-audit");
  });
});

describe("the runner registry", () => {
  it("selects nothing when the install has not decided, and says why", async () => {
    expect(await build.selectedBuildRunner()).toBeNull();
    expect(build.NO_RUNNER_REASON).toContain("ZENITH_BUILD_RUNNER");
  });

  it("selects the configured runner", async () => {
    process.env.ZENITH_BUILD_RUNNER = "e2b";
    expect((await build.selectedBuildRunner())?.id).toBe("e2b");
    process.env.ZENITH_BUILD_RUNNER = "recipe-local";
    expect((await build.selectedBuildRunner())?.id).toBe("recipe-local");
  });

  it("reports every runner with its own boundary and availability", async () => {
    const status = await build.buildRunnerStatus();
    expect(status.map((row) => row.id).sort()).toEqual(["docker", "e2b", "recipe-local"]);
    for (const row of status) {
      expect(row.boundary.length).toBeGreaterThan(40);
      if (!row.availability.available) {
        expect(row.availability.reason).toBeTruthy();
        expect(row.availability.fix).toBeTruthy();
      }
    }
  }, 30_000);
});
