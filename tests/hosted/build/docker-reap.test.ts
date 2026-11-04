/**
 * A timed-out or cancelled docker build must not leave its container running.
 *
 * The runner killed the *docker CLI* on a timeout or an abort — `child.kill
 * ("SIGKILL")` on the `docker run` process — but the CLI is only a client. The
 * daemon owns the container, and it carries on building after the client that
 * asked for it has gone, so a job the platform had already reported as timed out
 * or cancelled was still consuming a CPU and a memory cap on the host.
 *
 * Now the container has a deterministic name (`zenith-build-<jobId>`), and a
 * timeout or cancel follows the CLI kill with `docker kill <name>` and then
 * `docker rm -f <name>`, tolerating "no such container" (the ordinary case: the
 * container finished, or never started, and `--rm` already removed it). The
 * name is built only from the job id, sanitised, and every command is an argv —
 * no shell is involved anywhere.
 *
 * The docker CLI is a scripted double (the same approach as
 * runners-isolated.test.ts), so what is proven is the commands the runner issues
 * and how it reads their answers, not the daemon.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir, uuid } from "../_fixtures";

const DATA = isolatedDataDir("zenith-docker-reap-");
const FIXTURE = path.join(process.cwd(), "fixtures", "hosted", "minimal-app");
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;

// `buildContainerName` is imported from the runner's own module: the package
// index re-exports a fixed list and this packet does not own it.
let build: typeof import("@/lib/hosted/build/runner-docker");
let source: typeof import("@/lib/hosted/source");
let contracts: typeof import("@/lib/hosted/contracts");

beforeAll(async () => {
  build = await import("@/lib/hosted/build/runner-docker");
  source = await import("@/lib/hosted/source");
  contracts = await import("@/lib/hosted/contracts");
});

afterEach(() => {
  delete process.env.ZENITH_BUILD_RUNNER;
  delete process.env.ZENITH_RECIPE_IMAGE;
});

afterAll(() => removeDir(DATA));

const request = (jobId = uuid(), timeoutMs = 60_000) => ({
  jobId,
  appId: "app-alpha",
  source: source.validateSource({ kind: "directory", path: FIXTURE }),
  recipe: contracts.RECIPE_V1,
  limits: { timeoutMs, maxLogBytes: 32_000, memoryMb: 512 },
});

/* ------------------------------ the docker double ------------------------- */

interface Answer {
  code: number;
  stderr?: string;
  /** Never exits on its own: only a kill ends it, as a real `docker run` would. */
  hang?: boolean;
}

/**
 * A `spawn` that answers by argv. A hung child ends when it is killed, with a
 * null exit code, exactly as a SIGKILLed process does — so the runner's own
 * timeout and abort paths are what run.
 */
function scriptedSpawn(answer: (args: string[]) => Answer) {
  const seen: { args: string[]; at: number }[] = [];
  const spawn: import("@/lib/hosted/build/runner-docker").SpawnFn = (_command, args) => {
    const argv = [...args];
    seen.push({ args: argv, at: seen.length });
    const reply = answer(argv);
    const child = new EventEmitter() as ChildProcess;
    let closed = false;
    const close = (code: number | null): void => {
      if (closed) return;
      closed = true;
      child.emit("close", code);
    };
    Object.assign(child, {
      pid: 4242,
      stdout: Readable.from([""]),
      stderr: Readable.from([reply.stderr ?? ""]),
      kill: () => {
        setImmediate(() => close(null));
        return true;
      },
    });
    if (!reply.hang) setImmediate(() => close(reply.code));
    return child;
  };
  return { spawn, seen, commands: () => seen.map((s) => s.args.join(" ")) };
}

/** info and image inspect succeed; `docker run` hangs; kill and rm are scripted. */
function hangingBuild(overrides: { kill?: Answer; rm?: Answer } = {}) {
  return scriptedSpawn((args) => {
    if (args[0] === "run") return { code: 0, hang: true };
    if (args[0] === "kill") return overrides.kill ?? { code: 0 };
    if (args[0] === "rm") return overrides.rm ?? { code: 0 };
    return { code: 0 }; // info, image inspect
  });
}

const NO_SUCH = (name: string) => `Error response from daemon: No such container: ${name}`;

const configure = (): void => {
  process.env.ZENITH_BUILD_RUNNER = "docker";
  process.env.ZENITH_RECIPE_IMAGE = IMAGE_DIGEST;
};

/* ---------------------------------- tests --------------------------------- */

describe("the container's name", () => {
  it("is zenith-build- followed by the job id, and is what docker run is given", async () => {
    configure();
    const jobId = uuid();
    const { spawn, seen } = scriptedSpawn(() => ({ code: 0 }));
    await new build.DockerRunner({ spawn }).run(request(jobId), new AbortController().signal);

    const run = seen.find((s) => s.args[0] === "run")!.args;
    expect(build.buildContainerName(jobId)).toBe(`zenith-build-${jobId}`);
    expect(run[run.indexOf("--name") + 1]).toBe(`zenith-build-${jobId}`);
    // Deterministic: the same job is always the same container.
    expect(build.buildContainerName(jobId)).toBe(build.buildContainerName(jobId));
    // And it is part of the argv the isolation flags are read from, not appended after the image.
    expect(run.indexOf("--name")).toBeLessThan(run.length - 1);
    expect(run.at(-1)).toBe(IMAGE_DIGEST);
  });

  it("is a valid docker name whatever the job id contains", () => {
    for (const hostile of ["a b", "x;rm -rf /", "../../etc", "$(reboot)", "job\nid", "é", ""]) {
      const name = build.buildContainerName(hostile);
      expect(name, hostile).toMatch(/^zenith-build-[A-Za-z0-9_.-]*$/);
      expect(name).not.toMatch(/[\s;$()/\\]/);
    }
    expect(build.buildContainerName("x".repeat(500)).length).toBeLessThanOrEqual(128);
  });

  it("keeps different job ids apart", () => {
    expect(build.buildContainerName("job-a")).not.toBe(build.buildContainerName("job-b"));
  });
});

describe("a timed-out build", () => {
  it("kills the container by name and then removes it, after killing the CLI", async () => {
    configure();
    const jobId = uuid();
    const name = `zenith-build-${jobId}`;
    const { spawn, commands } = hangingBuild();
    const result = await new build.DockerRunner({ spawn }).run(request(jobId, 50), new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not finish within the 50 ms timeout");
    expect(result.error).toContain("was killed");

    const issued = commands().filter((c) => c.startsWith("kill") || c.startsWith("rm") || c.startsWith("run"));
    expect(issued[0]).toMatch(/^run /);
    expect(issued.slice(1)).toEqual([`kill ${name}`, `rm -f ${name}`]);
  });

  it("does not turn a container that is already gone into an error", async () => {
    configure();
    const jobId = uuid();
    const name = `zenith-build-${jobId}`;
    const { spawn, commands } = hangingBuild({
      kill: { code: 1, stderr: NO_SUCH(name) },
      rm: { code: 1, stderr: NO_SUCH(name) },
    });
    const result = await new build.DockerRunner({ spawn }).run(request(jobId, 50), new AbortController().signal);

    expect(result.error).toContain("did not finish within the 50 ms timeout");
    // Both were still attempted: a failed kill is not a reason to skip the remove.
    expect(commands()).toEqual(expect.arrayContaining([`kill ${name}`, `rm -f ${name}`]));
    // And "no such container" is the ordinary case, so it is not reported as a problem.
    expect(result.logs.some((l) => /could not|still be running/i.test(l.line))).toBe(false);
  });

  it("says so, with the command to run by hand, when the daemon refuses the kill", async () => {
    configure();
    const jobId = uuid();
    const name = `zenith-build-${jobId}`;
    const { spawn, commands } = hangingBuild({
      kill: { code: 1, stderr: "permission denied while trying to connect to the Docker daemon socket" },
    });
    const result = await new build.DockerRunner({ spawn }).run(request(jobId, 50), new AbortController().signal);

    // The outcome the platform reports is still the timeout.
    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not finish within the 50 ms timeout");
    // The operator is told the container may be alive, and how to remove it.
    const note = result.logs.find((l) => l.line.includes(name) && /still be running/i.test(l.line));
    expect(note, result.logs.map((l) => l.line).join("\n")).toBeTruthy();
    expect(note!.line).toContain(`docker rm -f ${name}`);
    // The remove is attempted anyway.
    expect(commands()).toContain(`rm -f ${name}`);
  });

  it("does not wait forever for a docker that will not answer the kill", async () => {
    configure();
    const jobId = uuid();
    const { spawn } = hangingBuild({ kill: { code: 0, hang: true }, rm: { code: 0, hang: true } });
    const started = Date.now();
    const result = await new build.DockerRunner({ spawn, reapTimeoutMs: 60 }).run(
      request(jobId, 50),
      new AbortController().signal
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.error).toContain("did not finish within the 50 ms timeout");
    expect(result.logs.some((l) => /still be running/i.test(l.line))).toBe(true);
  });
});

describe("a cancelled build", () => {
  it("kills the container by name and then removes it", async () => {
    configure();
    const jobId = uuid();
    const name = `zenith-build-${jobId}`;
    const controller = new AbortController();
    const { spawn, commands, seen } = hangingBuild();
    const running = new build.DockerRunner({ spawn }).run(request(jobId), controller.signal);
    // Wait until the container start has actually been requested, then cancel.
    while (!seen.some((s) => s.args[0] === "run")) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const result = await running;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cancelled");
    expect(commands().filter((c) => c.startsWith("kill") || c.startsWith("rm"))).toEqual([`kill ${name}`, `rm -f ${name}`]);
  });

  it("reaps a build that was cancelled before it started", async () => {
    configure();
    const jobId = uuid();
    const name = `zenith-build-${jobId}`;
    const controller = new AbortController();
    controller.abort();
    const { spawn, commands } = hangingBuild({ kill: { code: 1, stderr: NO_SUCH(name) }, rm: { code: 1, stderr: NO_SUCH(name) } });
    const result = await new build.DockerRunner({ spawn }).run(request(jobId), controller.signal);
    expect(result.error).toContain("cancelled");
    expect(commands()).toEqual(expect.arrayContaining([`kill ${name}`, `rm -f ${name}`]));
  });
});

describe("a build that finishes on its own", () => {
  it("issues no kill and no remove: --rm already took the container away", async () => {
    configure();
    const { spawn, commands } = scriptedSpawn(() => ({ code: 0 }));
    await new build.DockerRunner({ spawn }).run(request(), new AbortController().signal);
    expect(commands().some((c) => c.startsWith("kill") || c.startsWith("rm"))).toBe(false);
  });

  it("issues none when the container could not be started, either", async () => {
    configure();
    const { spawn, commands } = scriptedSpawn((args) => ({ code: args[0] === "run" ? 125 : 0 }));
    const result = await new build.DockerRunner({ spawn }).run(request(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(commands().some((c) => c.startsWith("kill") || c.startsWith("rm"))).toBe(false);
  });
});

describe("what is executed", () => {
  it("passes a hostile job id as inert argv, never through a shell", async () => {
    configure();
    const hostile = "x; touch /tmp/owned $(id)";
    const { spawn, seen } = hangingBuild();
    await new build.DockerRunner({ spawn }).run(request(hostile, 50), new AbortController().signal);

    const name = build.buildContainerName(hostile);
    const kill = seen.find((s) => s.args[0] === "kill")!.args;
    expect(kill).toEqual(["kill", name]);
    const rm = seen.find((s) => s.args[0] === "rm")!.args;
    expect(rm).toEqual(["rm", "-f", name]);
    expect(name).not.toMatch(/[\s;$()]/);
  });
});
