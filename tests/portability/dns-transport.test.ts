import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertConnectableHost, classifyAddress, resolveConnectableHost } from "@/lib/portability/net";
import { openPostgres } from "@/lib/portability/connect";
import { S3ObjectStore } from "@/lib/portability/engines/s3";
import { testTlsIdentity } from "./tls-support";

const hostname = "service.example.test";
const publicAddress = "93.184.216.34";
const creds = { region: "us-east-1", bucket: "tenant-bucket", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });

async function listen(server: net.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return (server.address() as net.AddressInfo).port;
}

function trust(cert: Buffer) {
  const connect = tls.connect.bind(tls);
  return vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) => connect({ ...options, ca: cert })) as typeof tls.connect);
}

function frame(type: string, payload = Buffer.alloc(0)) {
  const out = Buffer.alloc(5 + payload.length); out[0] = type.charCodeAt(0); out.writeInt32BE(payload.length + 4, 1); payload.copy(out, 5); return out;
}

/** Small real wire peer: TLS negotiation, authentication and extended query frames. */
async function pgPeer(identity: ReturnType<typeof testTlsIdentity>) {
  let accepts = 0;
  let sni: string | undefined;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((raw) => {
    accepts++; sockets.add(raw); raw.on("close", () => sockets.delete(raw)); raw.on("error", () => undefined);
    raw.once("data", () => {
      raw.write("S");
      const socket = new tls.TLSSocket(raw, { isServer: true, secureContext: tls.createSecureContext(identity) });
      socket.on("error", () => socket.destroy());
      socket.on("secure", () => { sni = typeof socket.servername === "string" ? socket.servername : undefined; });
      let startup = true; let buffer = Buffer.alloc(0);
      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);
        if (startup && buffer.length >= 4 && buffer.length >= buffer.readInt32BE(0)) {
          buffer = buffer.subarray(buffer.readInt32BE(0)); startup = false;
          socket.write(Buffer.concat([frame("R", Buffer.alloc(4)), frame("Z", Buffer.from("I"))]));
        }
        while (!startup && buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
          const type = String.fromCharCode(buffer[0]!); buffer = buffer.subarray(1 + buffer.readInt32BE(1));
          if (type === "P") socket.write(frame("1"));
          if (type === "B") socket.write(frame("2"));
          if (type === "D") socket.write(frame("n"));
          if (type === "E") socket.write(frame("C", Buffer.from("SELECT 0\0")));
          if (type === "S") socket.write(frame("Z", Buffer.from("I")));
          if (type === "Q") socket.write(Buffer.concat([frame("C", Buffer.from("SELECT 0\0")), frame("Z", Buffer.from("I"))]));
          if (type === "X") socket.end();
        }
      });
    });
  });
  const port = await listen(server);
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); });
  return { port, accepts: () => accepts, sni: () => sni, drop: async () => { await Promise.all([...sockets].map((socket) => new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); }))); } };
}

describe("validated DNS transport", () => {
  it.each(["::ffff:7f00:1", "0:0:0:0:0:ffff:a00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0"])("classifies equivalent forbidden literal %s", async (address) => {
    expect(classifyAddress(address)).not.toBe("public");
    await expect(resolveConnectableHost(hostname, { allowPrivate: false, lookup: async () => [publicAddress, address] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns validated literals and refuses all answers if one is forbidden without exposing resolver values", async () => {
    expect(await resolveConnectableHost(hostname, { lookup: async () => [publicAddress] })).toEqual([{ address: publicAddress, family: 4 }]);
    await expect(resolveConnectableHost(hostname, { lookup: async () => { throw new Error("secret-address-token"); } })).rejects.toThrow("The service host did not resolve.");
    await expect(resolveConnectableHost(hostname, { lookup: async () => [publicAddress, "169.254.169.254"], allowPrivate: true })).rejects.toThrow("The service host is not one the worker may connect to");
  });

  it("Postgres refuses a private connect answer after a public preflight, without opening a socket", async () => {
    const peer = await pgPeer(testTlsIdentity());
    const lookup = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue(["127.0.0.1"]);
    const binding = await openPostgres(`postgres://fixture:secret@${hostname}:${peer.port}/fixture`, { lookup, allowPrivate: false });
    try { await expect(binding.binding.kind === "postgres" && binding.binding.sql.query("select 1")).rejects.toMatchObject({ code: "invalid_input" }); }
    finally { await binding.close(); }
    expect(peer.accepts()).toBe(0); expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("Postgres connects to the opt-in validated IP while verifying the original hostname and SNI", async () => {
    const identity = testTlsIdentity(); const peer = await pgPeer(identity); const connect = trust(identity.cert);
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const binding = await openPostgres(`postgres://fixture:secret@${hostname}:${peer.port}/fixture`, { lookup, allowPrivate: true });
    try { await expect(binding.binding.kind === "postgres" && binding.binding.sql.query("select 1")).resolves.toEqual([]); }
    finally { await binding.close(); }
    expect(peer.accepts()).toBe(1); expect(peer.sni()).toBe(hostname);
    expect(connect.mock.calls[0]?.[0]).toMatchObject({ rejectUnauthorized: true, servername: hostname });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("Postgres reconnect revalidates changed DNS before creating a replacement socket", async () => {
    const identity = testTlsIdentity(); trust(identity.cert); const peer = await pgPeer(identity);
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const binding = await openPostgres(`postgres://fixture:secret@${hostname}:${peer.port}/fixture`, { lookup, allowPrivate: true });
    if (binding.binding.kind !== "postgres") throw new Error("fixture kind");
    try {
      await binding.binding.sql.query("select 1");
      lookup.mockResolvedValue(["::ffff:a9fe:a9fe"]);
      await peer.drop();
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      await expect(binding.binding.sql.query("select 1")).rejects.toMatchObject({ code: "invalid_input" });
      expect(peer.accepts()).toBe(1); expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally { await binding.close(); }
  });

  it("Postgres rejects a trusted certificate for a different hostname", async () => {
    const identity = testTlsIdentity("wrong.example.test"); trust(identity.cert); const peer = await pgPeer(identity);
    const binding = await openPostgres(`postgres://fixture:fixture-secret@${hostname}:${peer.port}/fixture`, { lookup: async () => ["127.0.0.1"], allowPrivate: true });
    try { await expect(binding.binding.kind === "postgres" && binding.binding.sql.query("select 1")).rejects.toThrow("A Postgres statement failed"); }
    finally { await binding.close(); }
    expect(peer.accepts()).toBe(1);
  });

  it("Postgres never downgrades TLS when the server refuses negotiation", async () => {
    const sockets = new Set<net.Socket>(); let bytes = Buffer.alloc(0);
    const server = net.createServer((socket) => {
      sockets.add(socket); socket.on("error", () => undefined); socket.on("close", () => sockets.delete(socket));
      socket.once("data", () => { socket.write("N"); socket.on("data", (data) => { bytes = Buffer.concat([bytes, data]); socket.destroy(); }); });
    });
    const port = await listen(server); cleanups.push(async () => { for (const socket of sockets) socket.destroy(); });
    const binding = await openPostgres(`postgres://fixture:fixture-secret@${hostname}:${port}/fixture`, { lookup: async () => ["127.0.0.1"], allowPrivate: true });
    try { await expect(binding.binding.kind === "postgres" && binding.binding.sql.query("select 1")).rejects.toMatchObject({ code: "verification_failed" }); }
    finally { await binding.close(); }
    expect(bytes.includes(Buffer.from("fixture-secret"))).toBe(false); expect(bytes[0]).toBe(22);
  });

  it.each([true, false])("Postgres literal-IP TLS verifies IP SAN (matching: %s)", async (matches) => {
    const identity = testTlsIdentity(matches ? "127.0.0.1" : hostname); trust(identity.cert); const peer = await pgPeer(identity);
    const binding = await openPostgres(`postgres://fixture:secret@127.0.0.1:${peer.port}/fixture`, { allowPrivate: true });
    try {
      const query = binding.binding.kind === "postgres" && binding.binding.sql.query("select 1");
      if (matches) await expect(query).resolves.toEqual([]);
      else await expect(query).rejects.toMatchObject({ code: "verification_failed" });
    } finally { await binding.close(); }
  });

  it.each([true, false])("S3 literal-IP TLS verifies IP SAN (matching: %s)", async (matches) => {
    const identity = testTlsIdentity(matches ? "127.0.0.1" : hostname); trust(identity.cert); let requests = 0;
    const server = https.createServer(identity, (_req, res) => { requests++; res.end(); }); const port = await listen(server);
    const store = new S3ObjectStore({ ...creds, endpoint: `https://127.0.0.1:${port}` }, { allowPrivate: true });
    if (matches) { await store.put("key", Buffer.from("fixture")); expect(requests).toBe(1); }
    else { await expect(store.put("key", Buffer.from("fixture"))).rejects.toMatchObject({ code: "unavailable" }); expect(requests).toBe(0); }
  });

  it("S3 refuses a private connect answer after its public preflight with no request or value leakage", async () => {
    let requests = 0; const server = http.createServer((_req, res) => { requests++; res.end(); }); const port = await listen(server);
    const lookup = vi.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValue(["127.0.0.1"]);
    const store = new S3ObjectStore({ ...creds, endpoint: `http://${hostname}:${port}` }, { lookup, allowPrivate: false });
    await expect(store.put("key", Buffer.from("fixture"))).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toBe(0); expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("S3 TLS uses the validated IP and preserves signed Host and original-host certificate identity", async () => {
    const identity = testTlsIdentity(); const connect = trust(identity.cert); let host: string | undefined; let sni: string | undefined; let auth = "";
    const server = https.createServer(identity, (req, res) => { host = req.headers.host; auth = req.headers.authorization ?? ""; const name = (req.socket as tls.TLSSocket).servername; sni = typeof name === "string" ? name : undefined; res.statusCode = 200; res.end(); });
    const port = await listen(server); const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    const store = new S3ObjectStore({ ...creds, endpoint: `https://${hostname}:${port}` }, { lookup, allowPrivate: true });
    await store.put("key", Buffer.from("fixture"));
    expect(host).toBe(`${hostname}:${port}`); expect(sni).toBe(hostname); expect(auth).toContain("SignedHeaders=");
    expect(connect.mock.calls[0]?.[0]).toMatchObject({ host: "127.0.0.1", servername: hostname, rejectUnauthorized: true });
  });

  it("S3 rejects a trusted certificate for a different hostname", async () => {
    const identity = testTlsIdentity("wrong.example.test"); trust(identity.cert); let requests = 0;
    const server = https.createServer(identity, (_req, res) => { requests++; res.end(); }); const port = await listen(server);
    const store = new S3ObjectStore({ ...creds, endpoint: `https://${hostname}:${port}` }, { lookup: async () => ["127.0.0.1"], allowPrivate: true });
    await expect(store.put("key", Buffer.from("fixture"))).rejects.toThrow("The storage service could not be reached"); expect(requests).toBe(0);
  });

  it("S3 retry revalidates changed DNS and never opens a second socket to a forbidden answer", async () => {
    let requests = 0; const server = http.createServer((_req, res) => { requests++; res.setHeader("Connection", "close"); res.statusCode = 503; res.end("<Error><Code>SlowDown</Code></Error>"); }); const port = await listen(server);
    const lookup = vi.fn().mockResolvedValueOnce(["127.0.0.1"]).mockResolvedValueOnce(["127.0.0.1"]).mockResolvedValue(["::ffff:a9fe:a9fe"]);
    const store = new S3ObjectStore({ ...creds, endpoint: `http://${hostname}:${port}` }, { lookup, allowPrivate: true });
    await expect(store.put("key", Buffer.from("fixture"))).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toBe(1); expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("S3 does not follow an HTTP redirect to another authority", async () => {
    let forbiddenRequests = 0;
    const forbidden = http.createServer((_req, res) => { forbiddenRequests++; res.end(); }); const forbiddenPort = await listen(forbidden);
    const server = http.createServer((_req, res) => { res.statusCode = 302; res.setHeader("Location", `http://127.0.0.1:${forbiddenPort}/secret-address-token`); res.end(); }); const port = await listen(server);
    const store = new S3ObjectStore({ ...creds, endpoint: `http://${hostname}:${port}` }, { allowPrivate: true, lookup: async () => ["127.0.0.1"] });
    await expect(store.put("key", Buffer.from("fixture"))).rejects.toThrow("The storage service could not be reached");
    expect(forbiddenRequests).toBe(0);
  });

  it("private opt-in never allows metadata, including hexadecimal mapped IPv6", async () => {
    await expect(assertConnectableHost("::ffff:a9fe:a9fe", { allowPrivate: true })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
