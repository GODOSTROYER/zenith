import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKER = path.join(REPO, "src/lib/hosted/build/recipe-worker.mjs");
const IMPORT_PROBE = path.join(REPO, "tests/fixtures/recipe-child-direct-entry/import-probe.mjs");
const APP_FIXTURE = path.join(REPO, "tests/fixtures/recipe-child-direct-entry/app");
const activeChildren = new Set<ChildProcess>();
const ownedDirectories = new Set<string>();

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function tempDirectory() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "zenith-worker-direct-entry-"));
  ownedDirectories.add(dir);
  return dir;
}

function runChild(args: string[], cwd: string, timeoutMs = 30_000): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: {} as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (timedOut) reject(new Error(`Owned worker child exceeded ${timeoutMs} ms and was stopped for cleanup.`));
      else resolve({ code, signal, stdout, stderr });
    });
  });
}

function makeValidJob(sandbox: string) {
  const root = path.join(sandbox, "source");
  const outDir = path.join(sandbox, "output");
  const cacheDir = path.join(sandbox, "cache");
  fs.cpSync(APP_FIXTURE, root, { recursive: true });
  fs.mkdirSync(outDir);
  fs.mkdirSync(cacheDir);
  const jobFile = path.join(sandbox, "job.json");
  const resultFile = path.join(sandbox, "result.json");
  fs.writeFileSync(jobFile, JSON.stringify({ root, outDir, cacheDir, platformRoot: REPO, recipe: { id: "direct-entry-fixture" } }));
  return { root, outDir, cacheDir, jobFile, resultFile };
}

function workerEntry(sandbox: string, mode: "canonical" | "symlink") {
  if (mode === "canonical") return WORKER;
  const link = path.join(sandbox, "worker-link.mjs");
  fs.symlinkSync(WORKER, link);
  return link;
}

afterEach(async () => {
  for (const child of activeChildren) child.kill("SIGKILL");
  await Promise.all([...activeChildren].map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))));
  activeChildren.clear();
  for (const dir of ownedDirectories) fs.rmSync(dir, { recursive: true, force: true });
  ownedDirectories.clear();
});

describe("recipe worker import and direct entry boundaries", () => {
  it("[WORKERIMPORT-01] imports without subscribing, parsing its argv, writing a result, or keeping the child alive", async () => {
    const sandbox = tempDirectory();
    const resultFile = path.join(sandbox, "must-not-exist.json");
    const run = await runChild([IMPORT_PROBE, WORKER], sandbox, 5_000);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const importEvent = JSON.parse(run.stdout.trim());
    expect(importEvent).toMatchObject({ event: "IMPORT_COMPLETE" });
    expect(importEvent.after).toBe(importEvent.before);
    expect(fs.existsSync(resultFile)).toBe(false);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  });

  it.each(["canonical", "symlink"] as const)(
    "[DIRECTENTRY-01] %s entry builds the same valid job and writes only inside its owned temp directory",
    async (mode) => {
      const sandbox = tempDirectory();
      const entry = workerEntry(sandbox, mode);
      const job = makeValidJob(sandbox);
      const run = await runChild([entry, job.jobFile, job.resultFile], sandbox, 60_000);

      expect(run.code).toBe(0);
      const result = JSON.parse(fs.readFileSync(job.resultFile, "utf8"));
      expect(result).toMatchObject({ ok: true, outDir: job.outDir, foreign: [] });
      expect(fs.readFileSync(path.join(job.outDir, "index.html"), "utf8")).toContain("Worker entry fixture");
      expect(fs.readdirSync(sandbox).sort()).toEqual(
        ["cache", "job.json", "output", "source", ...(mode === "symlink" ? ["worker-link.mjs"] : []), "result.json"].sort()
      );
    }
  );

  it.each(["canonical", "symlink"] as const)(
    "[DIRECTENTRY-02] %s entry applies the same malformed-job response and confines its result write",
    async (mode) => {
      const sandbox = tempDirectory();
      const entry = workerEntry(sandbox, mode);
      const jobFile = path.join(sandbox, "malformed-job.json");
      const resultFile = path.join(sandbox, "result.json");
      fs.writeFileSync(jobFile, "{not-json");
      const before = new Set(fs.readdirSync(sandbox));
      const run = await runChild([entry, jobFile, resultFile], sandbox);

      expect(run.code).toBe(1);
      expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toMatchObject({ ok: false, error: expect.stringContaining("build job file could not be read") });
      expect(new Set(fs.readdirSync(sandbox))).toEqual(new Set([...before, "result.json"]));
    }
  );

  it.each(["canonical", "symlink"] as const)(
    "[DIRECTENTRY-03] %s entry enforces usage validation without creating an unapproved file",
    async (mode) => {
      const sandbox = tempDirectory();
      const entry = workerEntry(sandbox, mode);
      const run = await runChild([entry], sandbox);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("usage: node recipe-worker.mjs <job.json> <result.json>");
      expect(run.stdout).toBe("");
      expect(fs.readdirSync(sandbox).sort()).toEqual(mode === "symlink" ? ["worker-link.mjs"] : []);
    }
  );
});
