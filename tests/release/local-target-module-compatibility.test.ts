import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import path from "node:path";

const root = process.cwd();
const node = process.execPath;
const runner = path.join(root, "scripts/release/local-target-runner.ts");
const readiness = path.join(root, "scripts/acceptance/default-stack/readiness.mjs");
const envModule = path.join(root, "scripts/acceptance/default-stack/env.mjs");
const j4 = path.join(root, "scripts/acceptance/default-stack/j4.mjs");

function run(argv: string[], timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", NO_COLOR: "1" };
    if (process.platform === "win32" && process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;
    const child = spawn(node, argv, {
      cwd: root,
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let childClosed = false;
    let failureStarted = false;
    let termination: Promise<string[]> | undefined;
    const waitForClose = (target: ChildProcess, until: number): Promise<{ closed: boolean; code?: number | null; error?: string }> => {
      return new Promise(resolveClose => {
        let done = false;
        const finish = (result: { closed: boolean; code?: number | null; error?: string }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          target.removeListener("close", onClose);
          target.removeListener("error", onError);
          resolveClose(result);
        };
        const onClose = (code: number | null) => finish({ closed: true, code });
        const onError = (error: Error) => finish({ closed: false, error: error.message });
        target.once("close", onClose);
        target.once("error", onError);
        const timer = setTimeout(() => finish({ closed: false }), Math.max(0, until - Date.now()));
      });
    };
    const killOwnedTree = (): Promise<string[]> => {
      if (termination) return termination;
      termination = (async () => {
        const errors: string[] = [];
        const pid = child.pid;
        if (!pid) return ["target-pid-unavailable"];
        if (process.platform === "win32") {
          const systemRoot = process.env.SystemRoot;
          if (!systemRoot) errors.push("SystemRoot-unavailable-for-taskkill");
          else {
            let taskkill: ChildProcess | undefined;
            try {
              taskkill = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
                env: { NODE_ENV: "test", SystemRoot: systemRoot }, stdio: "ignore", windowsHide: true,
              });
            } catch (error) { errors.push(`taskkill-spawn:${error instanceof Error ? error.message : String(error)}`); }
            if (taskkill) {
              const taskkillResult = await waitForClose(taskkill, Date.now() + 4_000);
              if (!taskkillResult.closed) {
                errors.push(`taskkill-unsettled:${taskkillResult.error ?? "timeout"}`);
                try { if (!taskkill.kill("SIGKILL")) errors.push("taskkill-stop-not-sent"); }
                catch (error) { errors.push(`taskkill-stop:${error instanceof Error ? error.message : String(error)}`); }
                const stopped = await waitForClose(taskkill, Date.now() + 1_000);
                if (!stopped.closed) errors.push(`taskkill-close-unconfirmed:${stopped.error ?? "timeout"}`);
              } else if (taskkillResult.code !== 0) errors.push(`taskkill-exit:${taskkillResult.code}`);
            }
          }
          if (!childClosed) {
            try { if (!child.kill("SIGKILL")) errors.push("target-fallback-stop-not-sent"); }
            catch (error) { errors.push(`target-fallback-stop:${error instanceof Error ? error.message : String(error)}`); }
          }
          return errors;
        }
        try { process.kill(-pid, "SIGKILL"); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ESRCH" || !childClosed) errors.push(`process-group-stop:${code ?? (error instanceof Error ? error.message : String(error))}`);
          if (!childClosed) {
            try { if (!child.kill("SIGKILL")) errors.push("target-fallback-stop-not-sent"); }
            catch (fallback) { errors.push(`target-fallback-stop:${fallback instanceof Error ? fallback.message : String(fallback)}`); }
          }
        }
        return errors;
      })();
      return termination;
    };
    const failAndSettle = (reason: string) => {
      if (failureStarted) return;
      failureStarted = true;
      clearTimeout(timer);
      const pid = child.pid ?? "unavailable";
      void (async () => {
        const errors: string[] = [];
        let settled = childClosed;
        try {
          const deadline = Date.now() + 5_000;
          errors.push(...await killOwnedTree());
          const close = childClosed ? { closed: true } : await waitForClose(child, deadline);
          settled = childClosed || close.closed;
          if (!close.closed) errors.push(`target-close-unconfirmed:${close.error ?? "timeout"}`);
        } catch (error) {
          errors.push(`cleanup-exception:${error instanceof Error ? error.message : String(error)}`);
        }
        reject(new Error(`CLI subprocess ${reason}; pid=${pid}; settled=${settled}; cleanup=${errors.join(",") || "no-errors"}`));
      })();
    };
    const timer = setTimeout(() => failAndSettle("timeout"), timeoutMs);
    const append = (target: Buffer[], chunk: Buffer) => {
      if (failureStarted) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        failAndSettle("output-cap-exceeded");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", error => failAndSettle(`spawn-error:${error.message}`));
    child.once("close", code => {
      childClosed = true;
      clearTimeout(timer);
      if (failureStarted) return;
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

describe("local target TSX module compatibility", () => {
  it("loads the actual runner before refusing an absent local-engine gate", async () => {
    const result = await run(["--import", "tsx", runner, "run", "--scenario", "machine-schedules"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Local target refused or failed.");
    expect(result.stderr).not.toContain("Top-level await is currently not supported");
    expect(result.stderr).not.toContain("ERR_REQUIRE_ASYNC_MODULE");
  }, 25_000);

  it("preserves direct MJS CLI guard error and skip behavior", async () => {
    const readinessResult = await run([readiness]);
    expect(readinessResult.code).toBe(1);
    expect(readinessResult.stderr).toContain("default-stack:usage");

    for (const modulePath of [envModule, j4]) {
      const result = await run([modulePath]);
      expect(result.code).toBe(77);
      expect(result.stdout).toContain('"status":"not-run"');
      expect(result.stdout).toContain('"reason":"default-stack:requires-ZENITH_ACCEPTANCE_DEFAULT_STACK"');
    }
  }, 70_000);
});
