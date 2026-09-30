/**
 * Kubernetes transport against injected fake clients: namespace allowlist,
 * target parsing, what is (and is not) copied out of a pod, bounded logs and
 * exec, and the file.read guards. The fake-API-server test in
 * `kubernetes-server.test.ts` covers the real client wiring.
 */
import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { createKubernetesMachineDriver, MachineOperationError, type K8sClients, type MachineRequest, type MachineResult } from "@/lib/machines";
import type { ExecClient } from "@/lib/machines/transports/kubernetes-exec";
import { k8sSession, requestFor } from "./_helpers";

const SECRET = "hunter2-db-password";

const pod = (over: Partial<V1Pod> = {}): V1Pod => ({
  metadata: { name: "web-1", namespace: "prod" },
  spec: {
    nodeName: "node-a",
    containers: [
      { name: "app", image: "img:1", env: [{ name: "DB_PASSWORD", value: SECRET }], args: [`--token=${SECRET}`] },
      { name: "sidecar", image: "envoy:1" },
    ],
  },
  status: {
    phase: "Running",
    conditions: [
      { type: "Ready", status: "True" },
      { type: "ContainersReady", status: "False", reason: "ContainersNotReady" },
    ],
    containerStatuses: [
      { name: "app", image: "img:1", imageID: "x", ready: true, restartCount: 2, state: { running: { startedAt: new Date("2026-09-30T09:00:00Z") } }, lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } } },
      { name: "sidecar", image: "envoy:1", imageID: "y", ready: false, restartCount: 0, state: { terminated: { exitCode: 1, reason: "Error", startedAt: new Date("2026-09-30T09:00:00Z"), finishedAt: new Date("2026-09-30T09:05:00Z") } } },
    ],
  },
  ...over,
});

type ExecImpl = (argv: string[], out: NodeJS.WritableStream, err: NodeJS.WritableStream, done: (status: object) => void) => void | Promise<void>;

function fake(opts: { pod?: V1Pod | Error; logs?: string | Error; pods?: V1Pod[]; exec?: ExecImpl } = {}) {
  const execCalls: { ns: string; pod: string; container: string; argv: string[] }[] = [];
  const core = {
    listNamespacedPod: vi.fn(async (p: object) => ({ items: opts.pods ?? [pod()], metadata: {}, ...(p ? {} : {}) })),
    readNamespacedPod: vi.fn(async () => {
      if (opts.pod instanceof Error) throw opts.pod;
      return opts.pod ?? pod();
    }),
    readNamespacedPodLog: vi.fn(async () => {
      if (opts.logs instanceof Error) throw opts.logs;
      return opts.logs ?? "line1\nline2\n";
    }),
  };
  const exec: ExecClient = {
    exec: vi.fn(async (ns, podName, container, argv, out, err, _in, _tty, cb) => {
      execCalls.push({ ns, pod: podName, container, argv });
      const close = vi.fn();
      await opts.exec?.(argv, out!, err!, (s) => cb?.(s as never));
      return { close };
    }),
  };
  const clients: K8sClients = { core: core as never, exec };
  const driver = createKubernetesMachineDriver({ clientFactory: async () => clients });
  const run = (req: MachineRequest, namespaces = ["prod"], signal = new AbortController().signal): Promise<MachineResult> => driver.execute(req, k8sSession(namespaces), signal);
  return { core, exec, execCalls, driver, run };
}

const req = (op: Parameters<typeof requestFor>[0], args: Record<string, unknown> = {}, targetId = "prod/web-1", over: Partial<MachineRequest> = {}) =>
  requestFor(op, args, { transport: "kubernetes", targetId, ...over });

const success = (stdout = "", stderr = "") => ((_argv, out, err, done) => {
  out.write(Buffer.from(stdout));
  if (stderr) err.write(Buffer.from(stderr));
  done({ status: "Success" });
}) as ExecImpl;
const exit = (code: number, stdout = "", stderr = "") => ((_argv, out, err, done) => {
  out.write(Buffer.from(stdout));
  err.write(Buffer.from(stderr));
  done({ status: "Failure", reason: "NonZeroExitCode", message: "command terminated with non-zero exit code", details: { causes: [{ reason: "ExitCode", message: String(code) }] } });
}) as ExecImpl;

describe("namespace allowlist and target parsing", () => {
  it("refuses any namespace that is not allowlisted, before calling the API", async () => {
    const f = fake();
    await expect(f.run(req("container.inspect", {}, "kube-system/web-1"))).rejects.toMatchObject({ code: "denied" });
    await expect(f.run(req("container.list", {}, "kube-system"))).rejects.toMatchObject({ code: "denied" });
    await expect(f.run(req("container.logs", {}, "prod-2/web-1"), ["prod"])).rejects.toMatchObject({ code: "denied" });
    expect(f.core.readNamespacedPod).not.toHaveBeenCalled();
    expect(f.core.listNamespacedPod).not.toHaveBeenCalled();
    expect(f.exec.exec).not.toHaveBeenCalled();
  });

  it("an empty allowlist refuses everything (fail closed)", async () => {
    const f = fake();
    await expect(f.run(req("container.list", {}, "prod"), [])).rejects.toMatchObject({ code: "denied" });
  });

  it("the allowlist applies to exec and file reads too", async () => {
    const f = fake({ exec: success("x") });
    await expect(f.run(req("container.exec", { argv: ["id"], timeoutSec: 5 }, "other/web-1", {}))).rejects.toMatchObject({ code: "denied" });
    await expect(f.run(req("file.read", { path: "/var/log/a" }, "other/web-1"))).rejects.toMatchObject({ code: "denied" });
    expect(f.exec.exec).not.toHaveBeenCalled();
  });

  it.each(["", "prod/", "/web-1", "prod/web-1/app/extra", "Prod/web-1", "prod/Web_1", "prod/web-1/App", "pr od/web-1", "../web-1", "prod/../web-1", "prod/web-1/..", "prod/web-1;id", "prod/web-1?x=1", "prod/web-1#f", "-prod/web-1", "a".repeat(64) + "/web-1"])("refuses target %j", async (targetId) => {
    const f = fake();
    await expect(f.run(req("container.inspect", {}, targetId), ["prod", "a".repeat(64), "-prod", ""])).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.core.readNamespacedPod).not.toHaveBeenCalled();
  });

  it("requires a pod for pod-scoped operations", async () => {
    const f = fake();
    await expect(f.run(req("container.logs", {}, "prod"))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.run(req("container.exec", { argv: ["id"], timeoutSec: 5 }, "prod"))).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refuses a non-Kubernetes session and unsupported operations with an explanation", async () => {
    const f = fake();
    await expect(f.driver.execute(req("container.list"), { provider: "aws" }, new AbortController().signal)).rejects.toMatchObject({ code: "transport_error" });
    await expect(f.driver.execute(req("container.list"), { provider: "kubernetes", kubeConfig: () => ({}) }, new AbortController().signal)).rejects.toMatchObject({ code: "transport_error" });
    for (const op of ["network.portCheck", "network.dnsCheck", "machine.exec", "service.status", "machine.inspect"] as const) {
      expect(f.driver.supports).not.toContain(op);
      await expect(f.run(req(op, op === "network.portCheck" ? { host: "a.com", port: 80 } : op === "network.dnsCheck" ? { name: "a.com" } : op === "machine.exec" ? { argv: ["id"], timeoutSec: 5 } : op === "service.status" ? { unit: "a.service" } : {}))).rejects.toMatchObject({ code: "unsupported_operation" });
    }
    expect(f.driver.unsupported?.["network.portCheck"]).toMatch(/probe/);
    expect(f.driver.unsupported?.["network.dnsCheck"]).toMatch(/probe/);
  });
});

describe("container.list and container.inspect", () => {
  it("lists containers of the pods in the namespace, honouring the selector and limits", async () => {
    const f = fake({ pods: [pod(), pod({ metadata: { name: "web-2" } })] });
    const res = await f.run(req("container.list", { labelSelector: "app=web", limit: 3, all: true }, "prod"));
    expect(f.core.listNamespacedPod).toHaveBeenCalledWith({ namespace: "prod", limit: 200, labelSelector: "app=web" });
    expect(res.ok).toBe(true);
    const containers = res.data.containers as { id: string; state: string }[];
    // four containers across two pods, limited to three
    expect(containers.map((c) => c.id)).toEqual(["prod/web-1/app", "prod/web-1/sidecar", "prod/web-2/app"]);
    expect(res.data.truncated).toBe(true);
  });

  it("all=false hides terminated containers; all=true shows them", async () => {
    const f = fake();
    const running = await f.run(req("container.list", { all: false }, "prod"));
    expect((running.data.containers as { name: string }[]).map((c) => c.name)).toEqual(["app"]);
    const all = await f.run(req("container.list", { all: true }, "prod"));
    expect((all.data.containers as { name: string; state: string }[]).map((c) => `${c.name}:${c.state}`)).toEqual(["app:running", "sidecar:terminated"]);
  });

  it("a pod target restricts the listing to that pod by field selector", async () => {
    const f = fake();
    await f.run(req("container.list", {}, "prod/web-1"));
    expect(f.core.listNamespacedPod).toHaveBeenCalledWith({ namespace: "prod", limit: 200, fieldSelector: "metadata.name=web-1" });
  });

  it("inspect returns status facts and never env, args or the spec", async () => {
    const f = fake();
    const res = await f.run(req("container.inspect", { container: "app" }));
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      id: "prod/web-1/app",
      name: "app",
      image: "img:1",
      state: "running",
      running: true,
      startedAt: "2026-09-30T09:00:00.000Z",
      restartCount: 2,
      health: "ready",
      oomKilled: true, // from lastState
      namespace: "prod",
      pod: "web-1",
      node: "node-a",
      phase: "Running",
    });
    expect(res.data.conditions).toEqual([{ type: "Ready", status: "True" }, { type: "ContainersReady", status: "False", reason: "ContainersNotReady" }]);
    expect((res.data.containerStatuses as unknown[]).length).toBe(2);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain("DB_PASSWORD");
  });

  it("the container comes from the target, the args, the only container, or the default-container annotation; ambiguity is refused", async () => {
    const two = pod();
    const single = pod({ spec: { containers: [{ name: "only", image: "i" }] } });
    const annotated = pod({ metadata: { name: "web-1", annotations: { "kubectl.kubernetes.io/default-container": "sidecar" } } });
    expect((await fake({ pod: two }).run(req("container.inspect", {}, "prod/web-1/sidecar"))).data.name).toBe("sidecar");
    expect((await fake({ pod: two }).run(req("container.inspect", { container: "sidecar" }))).data.name).toBe("sidecar");
    expect((await fake({ pod: single }).run(req("container.inspect", {}))).data.name).toBe("only");
    expect((await fake({ pod: annotated }).run(req("container.inspect", {}))).data.name).toBe("sidecar");
    await expect(fake({ pod: two }).run(req("container.inspect", {}))).rejects.toMatchObject({ code: "invalid_args" });
    await expect(fake({ pod: two }).run(req("container.inspect", { container: "nope" }))).rejects.toMatchObject({ code: "invalid_args" });
    await expect(fake({ pod: two }).run(req("container.inspect", { container: "app" }, "prod/web-1/sidecar"))).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("maps API failures: 404 is a result, 403 is denied, 5xx is retryable", async () => {
    const api = (code: number) => Object.assign(new Error("api"), { code });
    const nf = await fake({ pod: api(404) }).run(req("container.inspect", { container: "app" }));
    expect(nf).toMatchObject({ ok: false, data: { error: "not_found" } });
    await expect(fake({ pod: api(403) }).run(req("container.inspect", { container: "app" }))).rejects.toMatchObject({ code: "denied" });
    await expect(fake({ pod: api(401) }).run(req("container.inspect", { container: "app" }))).rejects.toMatchObject({ code: "transport_error" });
    const e = (await fake({ pod: api(503) }).run(req("container.inspect", { container: "app" })).catch((x: unknown) => x)) as MachineOperationError;
    expect(e).toMatchObject({ code: "transport_error" });
    expect(e.retryable).toBe(true);
  });
});

describe("container.logs", () => {
  it("passes tail, since, timestamps and a byte bound to the API", async () => {
    const f = fake();
    await f.run(req("container.logs", { container: "app", lines: 50, since: "15m", timestamps: true }, "prod/web-1", { maxOutputBytes: 1000 }));
    expect(f.core.readNamespacedPodLog).toHaveBeenCalledWith({ name: "web-1", namespace: "prod", container: "app", tailLines: 50, sinceSeconds: 900, limitBytes: 2000, timestamps: true });
  });

  it("keeps the newest bytes within the budget and says it truncated", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}`).join("\n") + "\n";
    const f = fake({ logs: lines });
    const res = await f.run(req("container.logs", { container: "app" }, "prod/web-1", { maxOutputBytes: 50 }));
    const content = res.data.content as string;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50);
    expect(content.endsWith("line-099\n")).toBe(true);
    expect(res.data.truncated).toBe(true);
  });

  it("small logs come back whole with a line count", async () => {
    const res = await fake({ logs: "a\nb\nc\n" }).run(req("container.logs", { container: "app" }));
    expect(res.data).toEqual({ container: "app", lines: 3, content: "a\nb\nc\n", truncated: false });
  });
});

describe("container.exec: argv, never a shell; bounded", () => {
  it("passes the argv vector to the API verbatim, hostile elements included", async () => {
    const argv = ["sh", "-c", "echo $(id); rm -rf /", "it's", "a b", "line1\nline2", ""];
    const f = fake({ exec: success("ok") });
    const res = await f.run(req("container.exec", { container: "app", argv, timeoutSec: 10 }));
    expect(f.execCalls).toEqual([{ ns: "prod", pod: "web-1", container: "app", argv }]);
    expect(res).toMatchObject({ ok: true, data: { exitCode: 0 }, output: { stdout: "ok", stderr: "", exitCode: 0, truncated: false } });
  });

  it("reports the exit code of a failing command as ok:false with its output", async () => {
    const res = await fake({ exec: exit(3, "partial", "bad thing") }).run(req("container.exec", { container: "app", argv: ["false"], timeoutSec: 10 }));
    expect(res).toMatchObject({ ok: false, data: { exitCode: 3 }, output: { stdout: "partial", stderr: "bad thing", exitCode: 3 } });
  });

  it("caps each stream at maxOutputBytes and reports truncation", async () => {
    const f = fake({ exec: success("x".repeat(5000), "y".repeat(10)) });
    const res = await f.run(req("container.exec", { container: "app", argv: ["yes"], timeoutSec: 10 }, "prod/web-1", { maxOutputBytes: 100 }));
    expect(res.output!.stdout).toHaveLength(100);
    expect(res.output!.stderr).toHaveLength(10);
    expect(res.output!.truncated).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("a runaway producer is cut off, and the mutating outcome is uncertain", async () => {
    const f = fake({
      exec: (_argv, out) => {
        for (let i = 0; i < 40; i++) out.write(Buffer.alloc(10_000, "x"));
      },
    });
    const err = await f.run(req("container.exec", { container: "app", argv: ["yes"], timeoutSec: 10 }, "prod/web-1", { maxOutputBytes: 100 })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "uncertain" });
  });

  it("a command that outlives its timeout is uncertain (closing the socket does not prove the process stopped)", async () => {
    vi.useFakeTimers();
    try {
      const f = fake({ exec: () => undefined }); // never reports a status
      const p = f.run(req("container.exec", { container: "app", argv: ["sleep", "999"], timeoutSec: 2 }, "prod/web-1", { timeoutSec: 2 })).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2100);
      expect(await p).toMatchObject({ code: "uncertain" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the command's timeout is the smaller of args.timeoutSec and the request's", async () => {
    vi.useFakeTimers();
    try {
      const f = fake({ exec: () => undefined });
      const p = f.run(req("container.exec", { container: "app", argv: ["sleep", "999"], timeoutSec: 100 }, "prod/web-1", { timeoutSec: 3 })).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(3100);
      expect(await p).toMatchObject({ code: "uncertain" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("abort during exec: uncertain, and the socket is closed", async () => {
    const ac = new AbortController();
    const close = vi.fn();
    const exec: ExecClient = { exec: async () => ({ close }) };
    const driver = createKubernetesMachineDriver({ clientFactory: async () => ({ core: fake().core as never, exec }) });
    const p = driver.execute(req("container.exec", { container: "app", argv: ["sleep", "9"], timeoutSec: 30 }, "prod/web-1", { timeoutSec: 30 }), k8sSession(["prod"]), ac.signal).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    expect(await p).toMatchObject({ code: "uncertain" });
    expect(close).toHaveBeenCalled();
  });

  it("a connection that ends without an exit status is uncertain for exec", async () => {
    const f = fake({ exec: (_a, _o, _e, _d) => undefined });
    const close = vi.fn();
    const exec: ExecClient = {
      exec: async (_ns, _p, _c, _argv, _out, _err, _in, _tty, _cb) => {
        const listeners: Record<string, () => void> = {};
        setTimeout(() => listeners.close?.(), 5);
        return { close, on: (ev, cb) => void (listeners[ev] = cb as () => void) };
      },
    };
    const driver = createKubernetesMachineDriver({ clientFactory: async () => ({ core: f.core as never, exec }) });
    const err = await driver.execute(req("container.exec", { container: "app", argv: ["id"], timeoutSec: 30 }, "prod/web-1", { timeoutSec: 30 }), k8sSession(["prod"]), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "uncertain" });
  });

  it("a command that cannot start (executable not found) is a definite failure, not uncertain", async () => {
    const impl: ExecImpl = (_a, _o, _e, done) => done({ status: "Failure", reason: "InternalError", message: 'OCI runtime exec failed: exec: "nope": executable file not found in $PATH' });
    const res = await fake({ exec: impl }).run(req("container.exec", { container: "app", argv: ["nope"], timeoutSec: 10 }));
    expect(res).toMatchObject({ ok: false, data: { error: "unavailable" } });
  });

  it("an exec the API refuses (403 on upgrade) is denied", async () => {
    const exec: ExecClient = { exec: async () => { throw new Error("Unexpected server response: 403"); } };
    const driver = createKubernetesMachineDriver({ clientFactory: async () => ({ core: fake().core as never, exec }) });
    await expect(driver.execute(req("container.exec", { container: "app", argv: ["id"], timeoutSec: 5 }, "prod/web-1", { timeoutSec: 5 }), k8sSession(["prod"]), new AbortController().signal)).rejects.toMatchObject({ code: "denied" });
  });
});

describe("process.list", () => {
  const PS = "  PID COMMAND         %CPU %MEM\n    1 nginx            0.5  1.2\n   42 node main.js     55.0  9.9\n  100 sh                0.0  0.0\ngarbage line\n";

  it("execs ps with argv and returns processes sorted and limited", async () => {
    const f = fake({ exec: success(PS) });
    const res = await f.run(req("process.list", { limit: 2, sortBy: "cpu" }, "prod/web-1/app"));
    expect(f.execCalls[0].argv).toEqual(["ps", "-eo", "pid,comm,pcpu,pmem"]);
    expect(res.data).toEqual({
      processes: [
        { pid: 42, command: "node main.js", cpuPct: 55, memPct: 9.9 },
        { pid: 1, command: "nginx", cpuPct: 0.5, memPct: 1.2 },
      ],
      truncated: true,
    });
    const byMem = await fake({ exec: success(PS) }).run(req("process.list", { limit: 1, sortBy: "memory" }, "prod/web-1/app"));
    expect((byMem.data.processes as { pid: number }[])[0].pid).toBe(42);
  });

  it("an image without ps is reported as unavailable, honestly (distroless)", async () => {
    const a = await fake({ exec: exit(127, "", "ps: not found") }).run(req("process.list", {}, "prod/web-1/app"));
    expect(a).toMatchObject({ ok: false, data: { error: "unavailable" } });
    expect(String(a.data.reason)).toMatch(/distroless|minimal/);
    const impl: ExecImpl = (_a, _o, _e, done) => done({ status: "Failure", reason: "InternalError", message: 'exec: "ps": executable file not found in $PATH' });
    const b = await fake({ exec: impl }).run(req("process.list", {}, "prod/web-1/app"));
    expect(b).toMatchObject({ ok: false, data: { error: "unavailable" } });
  });

  it("a timeout on a read-only exec is ok:false, not an error", async () => {
    vi.useFakeTimers();
    try {
      const f = fake({ exec: () => undefined });
      const p = f.run(req("process.list", {}, "prod/web-1/app", { timeoutSec: 2 }));
      await vi.advanceTimersByTimeAsync(2100);
      expect(await p).toMatchObject({ ok: false, data: { error: "timeout", timedOut: true } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("file.read", () => {
  /** readlink answers with `resolved`, head answers with `content` */
  const files = (resolved: string, content: string, opts: { readlinkExit?: number; headExit?: number } = {}): ExecImpl => (argv, out, err, done) => {
    if (argv[0] === "readlink") {
      if (opts.readlinkExit) return exit(opts.readlinkExit, "", "readlink: not found")(argv, out, err, done);
      out.write(Buffer.from(`${resolved}\n`));
      return done({ status: "Success" });
    }
    if (opts.headExit) return exit(opts.headExit, "", "head: cannot open")(argv, out, err, done);
    out.write(Buffer.from(content));
    return done({ status: "Success" });
  };
  const read = (f: ReturnType<typeof fake>, path: string, extra: Record<string, unknown> = {}, over: Partial<MachineRequest> = {}) => f.run(req("file.read", { path, ...extra }, "prod/web-1/app", over));

  it("resolves the path first, then reads with head -c (argv), and returns text with facts", async () => {
    const f = fake({ exec: files("/var/log/app.log", "hello\n") });
    const res = await read(f, "/var/log/app.log", { maxBytes: 100 });
    expect(f.execCalls.map((c) => c.argv)).toEqual([
      ["readlink", "-f", "--", "/var/log/app.log"],
      ["head", "-c", "101", "--", "/var/log/app.log"],
    ]);
    expect(res).toMatchObject({ ok: true, data: { path: "/var/log/app.log", sizeBytes: 6, bytesRead: 6, truncated: false, encoding: "utf8", content: "hello\n" } });
    expect(res.data.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads the RESOLVED path, so a symlink cannot be swapped between check and read", async () => {
    const f = fake({ exec: files("/var/log/real/app.log", "x") });
    await read(f, "/var/log/link.log");
    expect(f.execCalls[1].argv).toEqual(["head", "-c", "65537", "--", "/var/log/real/app.log"]);
  });

  it("refuses a symlink that resolves outside the allowlist or to a secret, without reading it", async () => {
    for (const resolved of ["/etc/shadow", "/var/lib/secret.txt", "/root/.ssh/id_rsa", "/proc/1/environ", "/var/log/../../etc/passwd", "relative/path", "/var/log/a b"]) {
      const f = fake({ exec: files(resolved, "TOP-SECRET") });
      await expect(read(f, "/var/log/link.log"), resolved).rejects.toMatchObject({ code: "denied" });
      expect(f.execCalls.every((c) => c.argv[0] !== "head")).toBe(true);
    }
  });

  it("refuses paths outside the allowlist or with secret-like names before any exec", async () => {
    const f = fake({ exec: files("/x", "x") });
    for (const p of ["/etc/passwd", "/var/log/server.key", "/var/log/app.env", "/opt/app/.env.production", "/srv/credentials.json", "/var/log/id_rsa"]) {
      await expect(read(f, p), p).rejects.toMatchObject({ code: "denied" });
    }
    expect(f.exec.exec).not.toHaveBeenCalled();
  });

  it("fails closed when readlink is unavailable in the image (no symlink check, no read)", async () => {
    const f = fake({ exec: files("", "", { readlinkExit: 127 }) });
    const res = await read(f, "/var/log/app.log");
    expect(res).toMatchObject({ ok: false, data: { error: "unavailable" } });
    expect(f.execCalls).toHaveLength(1);
  });

  it("reports a missing file, truncation, and binary content", async () => {
    const missing = await read(fake({ exec: files("", "", { readlinkExit: 1 }) }), "/var/log/none.log");
    expect(missing).toMatchObject({ ok: false, data: { error: "not_found" } });

    const big = await read(fake({ exec: files("/var/log/a", "x".repeat(101)) }), "/var/log/a", { maxBytes: 100 });
    expect(big.data).toMatchObject({ bytesRead: 100, truncated: true });
    expect(big.data.sizeBytes).toBeUndefined(); // size is unknown when truncated; never guessed

    const bin = await read(fake({ exec: files("/var/log/a", "ab\0cd") }), "/var/log/a");
    expect(bin.data).toMatchObject({ binary: true, content: "", bytesRead: 5 });

    const dir = await read(fake({ exec: files("/var/log/a", "", { headExit: 1 }) }), "/var/log/a");
    expect(dir).toMatchObject({ ok: false, data: { error: "command_failed" } });
  });

  it("honours the request's output budget as well as maxBytes", async () => {
    const f = fake({ exec: files("/var/log/a", "x".repeat(50)) });
    const res = await read(f, "/var/log/a", { maxBytes: 100000 }, { maxOutputBytes: 10 });
    expect(f.execCalls[1].argv[2]).toBe("11");
    expect(res.data).toMatchObject({ bytesRead: 10, truncated: true });
  });
});
