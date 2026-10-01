/**
 * `WorkerController`: stop and start the execution worker, for Demo E (restart
 * recovery). The scenario kills the worker in the middle of an apply and checks
 * that the operation ends `uncertain` or completes durably, and that nothing is
 * ever replayed unsafely.
 *
 * Three strategies, chosen by `ZENITH_LIVE_WORKER_CONTROL`:
 *
 *   docker:<container>   `docker kill <container>` (SIGKILL, no graceful drain)
 *                        then `docker start <container>`
 *   process:<pidfile>    kill the pid written in the file; starting is the
 *                        operator's (the pidfile names a process supervised
 *                        elsewhere), so `start` is a no-op that reports it
 *   manual               the operator kills and restarts the worker; the harness
 *                        waits for the confirmations
 *
 * `kill` deliberately uses SIGKILL: the point is an ungraceful crash, which
 * gives the worker no chance to release its lease or mark the operation.
 *
 * The container name and pidfile come from the operator's environment, never
 * from a scenario's external data, and are passed to `spawn` as arguments (no
 * shell).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { redactCredentials } from "@/lib/credentials/redact";

export interface WorkerController {
  readonly kind: "docker" | "process" | "manual";
  describe(): string;
  /** Crash the worker now. Resolves when the kill was issued (or, for `manual`, confirmed). */
  kill(): Promise<{ done: boolean; detail: string }>;
  /** Bring it back. Resolves when the start was issued (or confirmed). */
  start(): Promise<{ done: boolean; detail: string }>;
}

/** The only variables a helper CLI (docker) inherits: how to find itself and its daemon, nothing else. */
const CHILD_ENV_ALLOWLIST = ["PATH", "SystemRoot", "HOME", "USERPROFILE", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"] as const;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

function run(file: string, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: childEnv() as NodeJS.ProcessEnv });
    child.stdin.end();
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8").slice(0, 2000)));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8").slice(0, 2000)));
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out: "could not start the command" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: redactCredentials(out.trim()).slice(0, 400) });
    });
  });
}

export function createWorkerController(spec: string | undefined, hooks: { confirm?: (what: string) => Promise<void> } = {}): WorkerController {
  if (spec === undefined || spec === "manual") {
    const confirm = hooks.confirm ?? (async () => { throw new Error("Manual worker control requires an explicit operator confirmation hook; no kill or restart was observed."); });
    return {
      kind: "manual",
      describe: () => "manual: the operator kills and restarts the execution worker",
      async kill() {
        await confirm("Kill the execution worker now (SIGKILL, not a graceful stop), then confirm.");
        return { done: true, detail: "operator confirmed the worker was killed" };
      },
      async start() {
        await confirm("Start the execution worker again, then confirm.");
        return { done: true, detail: "operator confirmed the worker was restarted" };
      },
    };
  }
  if (spec.startsWith("docker:")) {
    const name = spec.slice("docker:".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name) || name.startsWith("ssc-")) throw new Error("Invalid or reserved docker container name in ZENITH_LIVE_WORKER_CONTROL.");
    return {
      kind: "docker",
      describe: () => `docker container ${name}`,
      async kill() {
        const r = await run("docker", ["kill", "--signal", "KILL", name]);
        return { done: r.code === 0, detail: r.code === 0 ? `docker kill ${name}` : `docker kill failed: ${r.out}` };
      },
      async start() {
        const r = await run("docker", ["start", name]);
        return { done: r.code === 0, detail: r.code === 0 ? `docker start ${name}` : `docker start failed: ${r.out}` };
      },
    };
  }
  if (spec.startsWith("process:")) {
    const pidFile = spec.slice("process:".length);
    if (!pidFile || pidFile.length > 400 || pidFile.includes("\0")) throw new Error("Invalid worker pidfile.");
    let killedPid: number | undefined;
    return {
      kind: "process",
      describe: () => `process from ${pidFile}`,
      async kill() {
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return { done: false, detail: "the pidfile does not hold a usable worker pid" };
        try {
          process.kill(pid, "SIGKILL");
          killedPid = pid;
          return { done: true, detail: `killed pid ${pid}` };
        } catch (err) {
          return { done: false, detail: `could not kill pid ${pid}: ${err instanceof Error ? err.name : "error"}` };
        }
      },
      async start() {
        if (!hooks.confirm) return { done: false, detail: "a process-controlled worker needs explicit supervisor/operator restart confirmation" };
        await hooks.confirm("Restart the dedicated worker through its supervisor and update its pidfile, then confirm.");
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        if (!Number.isInteger(pid) || pid <= 1 || pid === killedPid || pid === process.pid) return { done: false, detail: "no new worker pid was recorded after restart" };
        try { process.kill(pid, 0); return { done: true, detail: "operator confirmed restart and the new pid is alive" }; }
        catch { return { done: false, detail: "restarted worker pid is not alive or cannot be verified" }; }
      },
    };
  }
  throw new Error('ZENITH_LIVE_WORKER_CONTROL must be "manual", "docker:<container>" or "process:<pidfile>".');
}

/** CLI manual mode must receive an actual typed acknowledgement. No TTY means
 * no confirmation; an automated run cannot fabricate operator action. */
export async function confirmWorkerChange(message: string, runId: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("Worker confirmation requires an interactive terminal.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { const answer = await input.question(`${message}\nType ${runId} to confirm: `); if (answer.trim() !== runId) throw new Error("Worker action was not confirmed."); }
  finally { input.close(); }
}
