/** Real Node processes and loopback HTTP/TCP; no Docker or cloud needed. */
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseDatabaseUrl, tcpCheck } from "../../fixtures/acceptance-app/server.mjs";

async function freePort(): Promise<number> {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
async function withApp(url: string | undefined, fn: (base: string, logs: () => string) => Promise<void>) {
  const port = await freePort(); const allowed = ["PATH", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP"];
  const env: Record<string, string> = Object.fromEntries(allowed.flatMap((k) => process.env[k] ? [[k, process.env[k]!]] : []));
  Object.assign(env, { PORT: String(port), HOST: "127.0.0.1", DB_CONNECT_TIMEOUT_MS: "300", DB_CHECK_INTERVAL_MS: "0", ...(url ? { DATABASE_URL: url } : {}) });
  const child = spawn(process.execPath, ["fixtures/acceptance-app/server.mjs"], { env: env as NodeJS.ProcessEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", (d: Buffer) => { logs += d.toString("utf8"); }); child.stderr.on("data", (d: Buffer) => { logs += d.toString("utf8"); });
  const ended = once(child, "exit");
  try {
    for (let i = 0; i < 200; i++) { if (logs.includes('"event":"listening"')) break; if (child.exitCode !== null) throw new Error("fixture exited early"); await new Promise((r) => setTimeout(r, 10)); }
    expect(logs).toContain('"event":"listening"'); await fn(`http://127.0.0.1:${port}`, () => logs);
  } finally { child.kill(); await ended; }
}
describe("acceptance fixture real Node HTTP app", () => {
  it.skipIf(process.env.ZENITH_TEST_NETWORK !== "1")("real non-routable TCP: /db times out and /health remains 200 (network opt-in required)", async () => {
    await withApp("postgres://u:secretpw@10.255.255.1:5432/x", async (base, logs) => {
      expect((await fetch(`${base}/health`)).status).toBe(200); const start = Date.now(); const r = await fetch(`${base}/db`); const body = await r.text();
      expect(r.status).toBe(503); expect(JSON.parse(body).reason).toBe("timeout"); expect(Date.now() - start).toBeLessThan(3_000); expect(body).not.toContain("secretpw"); expect(logs()).not.toContain("secretpw");
    });
  });
  it("a simulated socket timeout resolves once, destroys the socket and never exposes credentials", async () => {
    // Sandbox networking can reject non-loopback connections before a timeout.
    // This is deliberately labelled simulated; it verifies timeout handling,
    // while the opted-in test above verifies the real TCP deadline.
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
    const connect = vi.spyOn(net, "connect").mockReturnValue(socket as unknown as net.Socket);
    try {
      const result = tcpCheck("10.255.255.1", 5432, 300);
      expect(socket.setTimeout).toHaveBeenCalledWith(300); socket.emit("timeout"); socket.emit("connect");
      expect(await result).toEqual({ ok: false, reason: "timeout" }); expect(socket.destroy).toHaveBeenCalledOnce();
    } finally { connect.mockRestore(); }
  });
  it("a closed loopback port reports refused", async () => { await withApp(`postgres://u:secretpw@127.0.0.1:${await freePort()}/x`, async (base, logs) => { const r = await fetch(`${base}/db`); expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ reason: "refused" }); expect(logs()).not.toContain("secretpw"); }); });
  it("unset DATABASE_URL reports not_configured", async () => { await withApp(undefined, async (base) => { const r = await fetch(`${base}/db`); expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ reason: "not_configured" }); }); });
  it("parses URL host and port, discards credentials, rejects malformed inputs", async () => {
    const m = await import("../../fixtures/acceptance-app/server.mjs"); expect(m.parseDatabaseUrl("postgresql://u:secretpw@[::1]/db")).toEqual({ host: "::1", port: 5432 });
    expect(parseDatabaseUrl("postgres://u:p@localhost:1234/x")).toEqual({ host: "localhost", port: 1234 });
    for (const raw of ["http://localhost:5432", "not a url", "postgres://localhost:0/x"]) expect(parseDatabaseUrl(raw)).toMatchObject({ error: "invalid_url" }); expect(parseDatabaseUrl(undefined)).toMatchObject({ error: "not_configured" });
  });
});
