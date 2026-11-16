/**
 * The Kubernetes transport through the REAL `@kubernetes/client-node` v2
 * clients (`CoreV1Api`, `Exec`) against a small local fake API server: HTTP
 * for pod list/read/log and a hand-rolled WebSocket endpoint speaking the
 * `v4.channel.k8s.io` exec protocol. It proves the wiring (paths, query
 * parameters, auth header, channel framing, status parsing) — not Kubernetes
 * itself, which is not reachable from here.
 */
import { KubeConfig } from "@kubernetes/client-node";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKubernetesMachineDriver, type MachineRequest } from "@/lib/machines";
import { k8sSession, requestFor } from "./_helpers";

const SECRET = "hunter2-db-password";
const TOKEN = "fake-test-token-not-a-credential";

const podJson = {
  kind: "Pod",
  apiVersion: "v1",
  metadata: { name: "web-1", namespace: "prod" },
  spec: {
    nodeName: "node-a",
    containers: [
      { name: "app", image: "img:1", env: [{ name: "DB_PASSWORD", value: SECRET }] },
      { name: "sidecar", image: "envoy:1" },
    ],
  },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "True" }],
    containerStatuses: [
      { name: "app", image: "img:1", imageID: "x", ready: true, restartCount: 1, state: { running: { startedAt: "2026-09-30T09:00:00Z" } } },
      { name: "sidecar", image: "envoy:1", imageID: "y", ready: true, restartCount: 0, state: { running: { startedAt: "2026-09-30T09:00:01Z" } } },
    ],
  },
};

interface ExecChannel {
  stdout(data: string | Buffer): void;
  stderr(data: string | Buffer): void;
  status(status: object): void;
  end(): void;
}
type ExecHandler = (command: string[], ch: ExecChannel, url: URL) => void;

let server: http.Server;
let base = "";
const sockets = new Set<Socket>();
const seen: { method: string; url: URL; auth?: string }[] = [];
let listStatus = 200;
let podStatus = 200;
let logBody = "a\nb\nc\n";
let execUpgradeStatus = 101;
let execHandler: ExecHandler = () => undefined;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function frame(payload: Buffer): Buffer {
  const n = payload.length;
  const header = n < 126 ? Buffer.from([0x82, n]) : n < 65536 ? Buffer.from([0x82, 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x82, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([header, payload]);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method ?? "", url, auth: req.headers.authorization });
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v1/namespaces/prod/pods") {
      if (listStatus !== 200) return json(listStatus, { kind: "Status", apiVersion: "v1", status: "Failure", message: "forbidden", reason: "Forbidden", code: listStatus });
      return json(200, { kind: "PodList", apiVersion: "v1", metadata: {}, items: [podJson, { ...podJson, metadata: { name: "web-2", namespace: "prod" } }] });
    }
    if (url.pathname === "/api/v1/namespaces/prod/pods/web-1") {
      if (podStatus !== 200) return json(podStatus, { kind: "Status", apiVersion: "v1", status: "Failure", message: "not found", reason: "NotFound", code: podStatus });
      return json(200, podJson);
    }
    if (url.pathname === "/api/v1/namespaces/prod/pods/web-1/log") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(logBody);
    }
    json(404, { kind: "Status", apiVersion: "v1", status: "Failure", reason: "NotFound", code: 404 });
  });

  server.on("upgrade", (req, socket: Socket) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ method: "UPGRADE", url, auth: req.headers.authorization });
    if (execUpgradeStatus !== 101) {
      socket.write(`HTTP/1.1 ${execUpgradeStatus} Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return socket.destroy();
    }
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: v4.channel.k8s.io\r\n\r\n`);
    const send = (channel: number, data: string | Buffer) => {
      if (!socket.destroyed) socket.write(frame(Buffer.concat([Buffer.from([channel]), Buffer.from(data)])));
    };
    socket.on("data", () => undefined); // the client's close frame
    socket.on("error", () => undefined);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    execHandler(url.searchParams.getAll("command"), { stdout: (d) => send(1, d), stderr: (d) => send(2, d), status: (s) => send(3, JSON.stringify(s)), end: () => socket.end() }, url);
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  listStatus = 200;
  podStatus = 200;
  logBody = "a\nb\nc\n";
  execUpgradeStatus = 101;
  execHandler = () => undefined;
});

function session(namespaces = ["prod"]) {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "c", server: base, skipTLSVerify: true }],
    users: [{ name: "u", token: TOKEN }],
    contexts: [{ name: "x", cluster: "c", user: "u" }],
    currentContext: "x",
  });
  return k8sSession(namespaces, kc);
}

// the default client factory: real CoreV1Api + Exec
const driver = createKubernetesMachineDriver();
const run = (op: Parameters<typeof requestFor>[0], args: Record<string, unknown> = {}, targetId = "prod/web-1", over: Partial<MachineRequest> = {}) =>
  driver.execute(requestFor(op, args, { transport: "kubernetes", targetId, ...over }), session(), new AbortController().signal);

const okStatus = { metadata: {}, status: "Success" };
const nonZero = (code: number) => ({ metadata: {}, status: "Failure", reason: "NonZeroExitCode", message: `command terminated with non-zero exit code: ${code}`, details: { causes: [{ reason: "ExitCode", message: String(code) }] } });

describe("HTTP paths with the real CoreV1Api", () => {
  it("lists pods with the selector, sends the bearer token, and maps containers", async () => {
    const res = await run("container.list", { labelSelector: "app=web", all: true }, "prod");
    expect(res.ok).toBe(true);
    expect((res.data.containers as { id: string }[]).map((c) => c.id)).toEqual(["prod/web-1/app", "prod/web-1/sidecar", "prod/web-2/app", "prod/web-2/sidecar"]);
    const call = seen.find((s) => s.url.pathname === "/api/v1/namespaces/prod/pods")!;
    expect(call.url.searchParams.get("labelSelector")).toBe("app=web");
    expect(call.url.searchParams.get("limit")).toBe("200");
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("inspects a pod: dates deserialize, env never leaves the pod spec", async () => {
    const res = await run("container.inspect", { container: "app" });
    expect(res.data).toMatchObject({ id: "prod/web-1/app", state: "running", startedAt: "2026-09-30T09:00:00.000Z", restartCount: 1, node: "node-a" });
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("reads logs with the tail/since/bytes parameters", async () => {
    const res = await run("container.logs", { container: "app", lines: 25, since: "1h", timestamps: true }, "prod/web-1", { maxOutputBytes: 4096 });
    expect(res.data).toMatchObject({ content: "a\nb\nc\n", lines: 3, truncated: false });
    const q = seen.find((s) => s.url.pathname.endsWith("/log"))!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ container: "app", tailLines: "25", sinceSeconds: "3600", limitBytes: "8192", timestamps: "true" });
  });

  it("maps HTTP errors: 404 pod is a result, 403 is denied", async () => {
    podStatus = 404;
    expect(await run("container.inspect", { container: "app" })).toMatchObject({ ok: false, data: { error: "not_found" } });
    listStatus = 403;
    await expect(run("container.list", {}, "prod")).rejects.toMatchObject({ code: "denied" });
  });

  it("the namespace allowlist stops a request before it reaches the server", async () => {
    await expect(driver.execute(requestFor("container.list", {}, { transport: "kubernetes", targetId: "prod" }), session(["staging"]), new AbortController().signal)).rejects.toMatchObject({ code: "denied" });
    expect(seen).toHaveLength(0);
  });
});

describe("exec over the real WebSocket client", () => {
  it("sends argv as repeated command parameters (no shell) and streams stdout and stderr", async () => {
    const argv = ["sh", "-c", "echo $(id); rm -rf /", "it's", "a b&c", "line1\nline2", "%2F..%2F", ""];
    execHandler = (_command, ch) => {
      ch.stdout("hello ");
      ch.stdout("world\n");
      ch.stderr("warn\n");
      ch.status(okStatus);
    };
    const res = await run("container.exec", { container: "app", argv, timeoutSec: 10 }, "prod/web-1", { timeoutSec: 10 });
    expect(res).toMatchObject({ ok: true, data: { exitCode: 0 }, output: { stdout: "hello world\n", stderr: "warn\n", exitCode: 0, truncated: false } });
    const up = seen.find((s) => s.method === "UPGRADE")!;
    expect(up.url.pathname).toBe("/api/v1/namespaces/prod/pods/web-1/exec");
    expect(up.url.searchParams.getAll("command")).toEqual(argv);
    expect(up.url.searchParams.get("container")).toBe("app");
    expect(up.url.searchParams.get("stdin")).toBe("false");
    expect(up.url.searchParams.get("tty")).toBe("false");
    expect(up.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("returns the exit code of a failing command", async () => {
    execHandler = (_c, ch) => {
      ch.stderr("nope\n");
      ch.status(nonZero(3));
    };
    const res = await run("container.exec", { container: "app", argv: ["false"], timeoutSec: 10 }, "prod/web-1", { timeoutSec: 10 });
    expect(res).toMatchObject({ ok: false, data: { exitCode: 3 }, output: { stderr: "nope\n", exitCode: 3 } });
  });

  it("bounds captured output and reports truncation", async () => {
    execHandler = (_c, ch) => {
      ch.stdout(Buffer.alloc(5000, "x"));
      ch.status(okStatus);
    };
    const res = await run("container.exec", { container: "app", argv: ["yes"], timeoutSec: 10 }, "prod/web-1", { timeoutSec: 10, maxOutputBytes: 200 });
    expect(res.output!.stdout).toHaveLength(200);
    expect(res.output!.truncated).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("a command that never reports is cut at its timeout and is uncertain (mutating)", async () => {
    execHandler = () => undefined; // connection stays open, no status
    const t0 = Date.now();
    const err = await run("container.exec", { container: "app", argv: ["sleep", "999"], timeoutSec: 1 }, "prod/web-1", { timeoutSec: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "uncertain" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("a server that refuses the upgrade (RBAC) is denied", async () => {
    execUpgradeStatus = 403;
    await expect(run("container.exec", { container: "app", argv: ["id"], timeoutSec: 5 }, "prod/web-1", { timeoutSec: 5 })).rejects.toMatchObject({ code: "denied" });
  });

  it("process.list and file.read run through the same path with fixed argv", async () => {
    execHandler = (command, ch) => {
      if (command[0] === "ps") ch.stdout("  PID COMMAND %CPU %MEM\n    1 nginx 1.0 2.0\n");
      else if (command[0] === "readlink") ch.stdout("/var/log/app.log\n");
      else if (command[0] === "head") ch.stdout("log line\n");
      ch.status(okStatus);
    };
    const ps = await run("process.list", {}, "prod/web-1/app");
    expect(ps.data).toEqual({ processes: [{ pid: 1, command: "nginx", cpuPct: 1, memPct: 2 }], truncated: false });
    const file = await run("file.read", { path: "/var/log/app.log" }, "prod/web-1/app");
    expect(file.data).toMatchObject({ path: "/var/log/app.log", content: "log line\n", truncated: false });
    const cmds = seen.filter((s) => s.method === "UPGRADE").map((s) => s.url.searchParams.getAll("command"));
    expect(cmds).toEqual([["ps", "-eo", "pid,comm,pcpu,pmem"], ["readlink", "-f", "--", "/var/log/app.log"], ["head", "-c", "65537", "--", "/var/log/app.log"]]);
  });
});
