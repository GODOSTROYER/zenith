/**
 * Actual stock mysql TLS/auth/query sockets (literal IP) and the in-process mysql2 transport (DNS names) against a bounded owned protocol
 * fixture. This is not a MySQL engine or live provider acceptance test. Explicit
 * invocation is required and fails when the stock client/openssl is absent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { Duplex } from "node:stream";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { spawnMysqlCli, type CliResult } from "@/lib/portability/engines/mysql";

const REQUIRED = process.env.ZENITH_TEST_MYSQL_CLI_TLS === "1";
let cleanupUncertain = false;
const packet = (payload: Buffer, sequence: number): Buffer => {
  const header = Buffer.alloc(4); header.writeUIntLE(payload.length, 0, 3); header[3] = sequence;
  return Buffer.concat([header, payload]);
};
const text = (value: string): Buffer => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)]);

function greeting(tls: boolean): Buffer {
  const caps = 1 | 8 | 0x200 | 0x8000 | 0x80000 | (tls ? 0x800 : 0);
  const flags = Buffer.alloc(2); flags.writeUInt16LE(caps & 0xffff);
  const rest = Buffer.alloc(16); rest[0] = 45; rest.writeUInt16LE(2, 1); rest.writeUInt16LE(caps >>> 16, 3); rest[5] = 21;
  return packet(Buffer.concat([Buffer.from([10]), Buffer.from("8.4.0-fixture\0"), Buffer.from([1, 0, 0, 0]), Buffer.from("12345678"), Buffer.from([0]), flags, rest, Buffer.from("abcdefghijkl\0"), Buffer.from("caching_sha2_password\0")]), 0);
}

interface Fixture {
  port: number;
  connections: number;
  encryptedAuth: number;
  plaintextAuth: number;
  queries: number;
  versionComments: number;
  syntaxProbes: number;
  close(): Promise<void>;
}

async function fixture(key: Buffer, cert: Buffer, tls = true): Promise<Fixture> {
  const sockets = new Set<Socket>();
  const closedSockets = new WeakMap<Socket, Promise<void>>();
  const trackSocket = (socket: Socket): void => {
    sockets.add(socket);
    // Stream.closed may precede the close event; cleanup awaits that event for
    // both the TLS wrapper and its underlying raw socket.
    closedSockets.set(socket, new Promise<void>((resolve) => socket.once("close", () => { sockets.delete(socket); resolve(); })));
    socket.on("error", () => undefined);
  };
  const state = { connections: 0, encryptedAuth: 0, plaintextAuth: 0, queries: 0, versionComments: 0, syntaxProbes: 0 };
  const context = createSecureContext({ key, cert, minVersion: "TLSv1.2" });
  const server: Server = createServer((socket) => {
    state.connections++;
    trackSocket(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.write(greeting(tls));
    let bytes = Buffer.alloc(0);
    const first = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 4096) { socket.destroy(); return; }
      if (bytes.length < 4) return;
      const length = bytes.readUIntLE(0, 3);
      if (length > 4092) { socket.destroy(); return; }
      if (bytes.length < length + 4) return;
      socket.off("data", first);
      // SSLRequest is exactly32 bytes at sequence1, before credential material.
      if (!tls || length !== 32 || bytes[3] !== 1 || !(bytes.readUInt32LE(4) & 0x800)) {
        state.plaintextAuth++;
        socket.destroy(); return;
      }
      // SSLRequest and ClientHello may share a TCP chunk. Return only the TLS
      // bytes to the same socket before installing its TLS record parser.
      socket.pause();
      if (bytes.length > 36) socket.unshift(bytes.subarray(36));
      // A generic duplex feeds the unshifted ClientHello to TLS; wrapping the
      // native handle directly bypasses the raw socket's buffered tail.
      const transport = Duplex.from({ readable: socket, writable: socket });
      const secure = new TLSSocket(transport, { isServer: true, secureContext: context });
      trackSocket(secure);
      secure.setTimeout(5000, () => secure.destroy());
      let encrypted = Buffer.alloc(0);
      let authenticated = false;
      secure.on("data", (data: Buffer) => {
        encrypted = Buffer.concat([encrypted, data]);
        if (encrypted.length > 4096) { secure.destroy(); return; }
        while (encrypted.length >= 4) {
          const n = encrypted.readUIntLE(0, 3);
          if (n > 4092) { secure.destroy(); return; }
          if (encrypted.length < n + 4) return;
          const seq = encrypted[3]; const payload = encrypted.subarray(4, n + 4); encrypted = encrypted.subarray(n + 4);
          if (!authenticated) {
            if (seq !== 2 || payload.length < 33 || !(payload.readUInt32LE(0) & 0x800)) { secure.destroy(); return; }
            state.encryptedAuth++; authenticated = true;
            secure.write(packet(Buffer.from([0, 0, 0, 2, 0, 0, 0]), 3));
          } else if (seq === 0 && payload[0] === 3 && payload.subarray(1).toString().toLowerCase() === "select @@version_comment limit 1" && state.versionComments === 0) {
            // Stock mysql's server_version_string initialization read. It is
            // separate from the required user query and accepts no other SQL.
            state.versionComments++;
            const fixed = Buffer.from([12, 45, 0, 64, 0, 0, 0, 253, 0, 0, 0, 0, 0]);
            const column = Buffer.concat([text("def"), text(""), text(""), text(""), text("@@version_comment"), text(""), fixed]);
            secure.write(Buffer.concat([packet(Buffer.from([1]), 1), packet(column, 2), packet(Buffer.from([0xfe, 0, 0, 2, 0]), 3), packet(text("Owned MySQL TLS socket fixture"), 4), packet(Buffer.from([0xfe, 0, 0, 2, 0]), 5)]));
          } else if (seq === 0 && payload[0] === 3 && payload.subarray(1).toString() === "select $$" && state.syntaxProbes === 0) {
            // mysql9.6 probes dollar-quote support and expects ER_PARSE_ERROR
            // (1064). This fixed initialization error is not a data query.
            state.syntaxProbes++;
            secure.write(packet(Buffer.concat([Buffer.from([0xff, 0x28, 0x04]), Buffer.from("#42000Owned fixture syntax probe")]), 1));
          } else if (seq === 0 && payload[0] === 3 && payload.subarray(1).toString() === "select 1") {
            state.queries++;
            const fixed = Buffer.from([12, 45, 0, 11, 0, 0, 0, 3, 0, 0, 0, 0, 0]);
            const column = Buffer.concat([text("def"), text(""), text(""), text(""), text("answer"), text(""), fixed]);
            secure.write(Buffer.concat([packet(Buffer.from([1]), 1), packet(column, 2), packet(Buffer.from([0xfe, 0, 0, 2, 0]), 3), packet(text("1"), 4), packet(Buffer.from([0xfe, 0, 0, 2, 0]), 5)]));
          } else if (seq === 0 && payload[0] === 1) secure.end();
          else secure.destroy();
        }
      });
      socket.resume();
    };
    socket.on("data", first);
  });
  const close = async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned MySQL TLS listener cleanup was unconfirmed.")), 5000);
        const drained = [...sockets].map((s) => {
          const closed = closedSockets.get(s)!;
          s.destroy();
          return closed;
        });
        const stopped = new Promise<void>((done, fail) => server.close((err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") fail(new Error("Owned MySQL TLS listener cleanup failed."));
          else done();
        }));
        Promise.all([stopped, ...drained]).then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(new Error("Owned MySQL TLS listener cleanup failed.")); });
      });
      expect(server.listening).toBe(false); expect(sockets.size).toBe(0);
    } catch (error) { cleanupUncertain = true; throw error; }
  };
  const abort = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { abort.abort(); reject(new Error("Owned MySQL TLS listener setup exceeded its deadline.")); }, 5000);
      server.once("error", () => { clearTimeout(timer); reject(new Error("Owned MySQL TLS listener setup failed.")); });
      server.listen({ port: 0, host: "127.0.0.1", signal: abort.signal }, () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) { await close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned MySQL TLS listener has no TCP address.");
  return {
    port: address.port,
    get connections() { return state.connections; }, get encryptedAuth() { return state.encryptedAuth; }, get plaintextAuth() { return state.plaintextAuth; }, get queries() { return state.queries; }, get versionComments() { return state.versionComments; }, get syntaxProbes() { return state.syntaxProbes; },
    close,
  };
}

describe.skipIf(!REQUIRED)("stock MySQL authenticated TLS destination custody (explicit ZENITH_TEST_MYSQL_CLI_TLS=1)", () => {
  let dir: string;
  let identity: Awaited<ReturnType<typeof lstat>>;
  let ca: string;
  let valid: { key: Buffer; cert: Buffer };
  let wrong: { key: Buffer; cert: Buffer };
  const invoke = async (args: string[]) => new Promise<void>((resolve, reject) => {
    execFile("openssl", args, { timeout: 5000, maxBuffer: 4096 }, (error) => error ? reject(new Error("Owned MySQL TLS certificate setup failed.")) : resolve());
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "zenith-mysql-tls-")); identity = await lstat(dir);
    ca = join(dir, "ca.pem");
    await invoke(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Zenith owned MySQL TLS test CA", "-keyout", join(dir, "ca.key"), "-out", ca]);
    for (const [name, san] of [["valid", "IP:127.0.0.1"], ["wrong", "DNS:db.example.test"]]) {
      await invoke(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=owned-mysql-test", "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.csr`)]);
      await writeFile(join(dir, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
      await invoke(["x509", "-req", "-in", join(dir, `${name}.csr`), "-CA", ca, "-CAkey", join(dir, "ca.key"), "-CAcreateserial", "-out", join(dir, `${name}.pem`), "-days", "1", "-extfile", join(dir, `${name}.ext`)]);
      await chmod(join(dir, `${name}.key`), 0o600);
    }
    await chmod(join(dir, "ca.key"), 0o600);
    valid = { key: await readFile(join(dir, "valid.key")), cert: await readFile(join(dir, "valid.pem")) };
    wrong = { key: await readFile(join(dir, "wrong.key")), cert: await readFile(join(dir, "wrong.pem")) };
    // An explicitly selected lane must fail if the current stock client is absent.
    const probe = await spawnMysqlCli().run("mysql", ["--version"], { env: {}, maxBytes: 4096, timeoutMs: 5000 });
    expect(probe.code).toBe(0);
  }, 60_000);
  afterAll(async () => {
    if (!dir) return;
    if (cleanupUncertain) throw new Error("Owned MySQL TLS cleanup was unconfirmed; certificate files were retained.");
    const current = await lstat(dir);
    expect(current.isSymbolicLink()).toBe(false); expect(current.dev).toBe(identity.dev); expect(current.ino).toBe(identity.ino); expect(current.uid).toBe(identity.uid);
    await rm(dir, { recursive: true });
    await expect(lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  const run = (f: Fixture, host = "127.0.0.1", trusted = true): Promise<CliResult> => {
    const cli = spawnMysqlCli({ ...process.env, ZENITH_MYSQL_CA_FILE: trusted ? ca : undefined }, { allowPrivate: true, lookup: async () => ["127.0.0.1"] });
    return cli.run("mysql", [`--host=${host}`, `--port=${f.port}`, "--user=fixture", "--ssl-mode=REQUIRED", "--batch", "--skip-column-names", "-e", "select 1", "fixture"], { env: { MYSQL_PWD: "owned-protocol-fixture-password" }, maxBytes: 4096, timeoutMs: 5000 });
  };
  it("authenticates a CA-trusted literal IP SAN on the same real stock-client TLS socket before query", async () => {
    const f = await fixture(valid.key, valid.cert);
    try { const result = await run(f); expect(result.code).toBe(0); expect(result.stdout.toString()).toBe("1\n"); expect(result.stderr).toBe(""); expect(f.encryptedAuth).toBe(1); expect(f.plaintextAuth).toBe(0); expect(f.queries).toBe(1); expect(f.versionComments).toBeLessThanOrEqual(1); expect(f.syntaxProbes).toBeLessThanOrEqual(1); }
    finally { await f.close(); }
  });
  it("refuses a CA-valid certificate lacking the destination IP SAN before credential authentication", async () => {
    const f = await fixture(wrong.key, wrong.cert);
    try { const result = await run(f); expect(result.code).not.toBe(0); expect(result.stderr).toBe(""); expect(f.encryptedAuth).toBe(0); expect(f.plaintextAuth).toBe(0); expect(f.queries).toBe(0); }
    finally { await f.close(); }
  });
  it("refuses an untrusted CA on the real TLS socket before credential authentication", async () => {
    const f = await fixture(valid.key, valid.cert);
    try { const result = await run(f, "127.0.0.1", false); expect(result.code).not.toBe(0); expect(result.stderr).toBe(""); expect(f.encryptedAuth).toBe(0); expect(f.plaintextAuth).toBe(0); expect(f.queries).toBe(0); }
    finally { await f.close(); }
  });
  it("refuses a non-TLS greeting rather than downgrading or sending an authentication response", async () => {
    const f = await fixture(valid.key, valid.cert, false);
    try { const result = await run(f); expect(result.code).not.toBe(0); expect(f.encryptedAuth).toBe(0); expect(f.plaintextAuth).toBe(0); expect(f.queries).toBe(0); }
    finally { await f.close(); }
  });
  it("verifies a DNS TLS name against the certificate identity in-process (never the stock client) before credentials", async () => {
    const f = await fixture(wrong.key, wrong.cert);
    try { const result = await run(f, "db.example.test"); expect(result.code).toBe(0); expect(result.stdout.toString()).toBe("1\n"); expect(f.encryptedAuth).toBe(1); expect(f.plaintextAuth).toBe(0); expect(f.queries).toBe(1); }
    finally { await f.close(); }
  });
  it("refuses a DNS TLS name the certificate does not name, before credential authentication", async () => {
    const f = await fixture(wrong.key, wrong.cert);
    try { await expect(run(f, "other.example.test")).rejects.toMatchObject({ code: "unavailable" }); expect(f.encryptedAuth).toBe(0); expect(f.queries).toBe(0); }
    finally { await f.close(); }
  });
});
