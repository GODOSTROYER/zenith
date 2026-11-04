/**
 * A small owned MySQL wire peer for contract tests of the in-process (mysql2)
 * transport: greeting, SSLRequest, a real TLS upgrade with a supplied identity,
 * handshake response, then COM_QUERY answered by a script. It is not a MySQL
 * engine; it exists to observe what the client does on the wire (which
 * address it dialed, which SNI it sent, whether credentials were sent over a
 * verified channel) before any real server is involved.
 */
import { createServer, type Server, type Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { Duplex } from "node:stream";

export const T = { LONG: 3, BLOB: 252, VAR_STRING: 253 } as const;

export interface FixtureField { name: string; type: number; charset?: number }
export interface FixtureAnswer {
  fields?: FixtureField[];
  rows?: (Buffer | string | null)[][];
  /** answer with a server error packet (errno 1064) */
  error?: boolean;
}

export interface WireStats {
  connections: number;
  /** handshake responses received over TLS */
  encryptedAuth: number;
  /** anything received in the clear after the greeting other than the SSLRequest */
  plaintextAuth: number;
  sni: string[];
  queries: string[];
}

export interface WireFixture {
  port: number;
  stats: WireStats;
  close(): Promise<void>;
}

const packet = (payload: Buffer, sequence: number): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence & 255;
  return Buffer.concat([header, payload]);
};
const lenenc = (n: number): Buffer => {
  if (n < 251) return Buffer.from([n]);
  if (n < 65536) return Buffer.from([0xfc, n & 255, n >> 8]);
  return Buffer.from([0xfd, n & 255, (n >> 8) & 255, n >> 16]);
};
const text = (value: string | Buffer): Buffer => {
  const b = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([lenenc(b.length), b]);
};
const EOF = Buffer.from([0xfe, 0, 0, 2, 0]);
const OK = Buffer.from([0, 0, 0, 2, 0, 0, 0]);

function greeting(tls: boolean): Buffer {
  const caps = 1 | 8 | 0x200 | 0x8000 | 0x80000 | (tls ? 0x800 : 0);
  const flags = Buffer.alloc(2);
  flags.writeUInt16LE(caps & 0xffff);
  const rest = Buffer.alloc(16);
  rest[0] = 45;
  rest.writeUInt16LE(2, 1);
  rest.writeUInt16LE(caps >>> 16, 3);
  rest[5] = 21;
  return packet(Buffer.concat([Buffer.from([10]), Buffer.from("8.4.0-fixture\0"), Buffer.from([1, 0, 0, 0]), Buffer.from("12345678"), Buffer.from([0]), flags, rest, Buffer.from("abcdefghijkl\0"), Buffer.from("caching_sha2_password\0")]), 0);
}

function columnDefinition(f: FixtureField): Buffer {
  const fixed = Buffer.alloc(13);
  fixed[0] = 12;
  fixed.writeUInt16LE(f.charset ?? 45, 1);
  fixed.writeUInt32LE(255, 3);
  fixed[7] = f.type;
  return Buffer.concat([text("def"), text(""), text(""), text(""), text(f.name), text(""), fixed]);
}

function encode(answer: FixtureAnswer): Buffer {
  if (answer.error) return packet(Buffer.concat([Buffer.from([0xff, 0x28, 0x04]), Buffer.from("#42000fixture error")]), 1);
  if (!answer.fields) return packet(OK, 1);
  let seq = 1;
  const out: Buffer[] = [packet(lenenc(answer.fields.length), seq++)];
  for (const f of answer.fields) out.push(packet(columnDefinition(f), seq++));
  out.push(packet(EOF, seq++));
  for (const row of answer.rows ?? []) {
    out.push(packet(Buffer.concat(row.map((v) => (v === null ? Buffer.from([0xfb]) : text(v)))), seq++));
  }
  out.push(packet(EOF, seq++));
  return Buffer.concat(out);
}

export async function mysqlWireFixture(opts: {
  identity?: { key: Buffer; cert: Buffer };
  /** advertise TLS (default true when an identity is given) */
  tls?: boolean;
  answer?: (sql: string) => FixtureAnswer | undefined;
  /** close the first N connections immediately, before the greeting */
  dropFirst?: number;
}): Promise<WireFixture> {
  const tls = opts.tls ?? opts.identity !== undefined;
  const stats: WireStats = { connections: 0, encryptedAuth: 0, plaintextAuth: 0, sni: [], queries: [] };
  const sockets = new Set<Socket>();
  const context = opts.identity ? createSecureContext({ ...opts.identity, minVersion: "TLSv1.2" }) : undefined;
  const server: Server = createServer((socket) => {
    stats.connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setTimeout(10_000, () => socket.destroy());
    if (stats.connections <= (opts.dropFirst ?? 0)) {
      socket.destroy();
      return;
    }
    socket.write(greeting(tls));
    let bytes = Buffer.alloc(0);
    const first = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUIntLE(0, 3);
      if (bytes.length < length + 4) return;
      socket.off("data", first);
      // SSLRequest: exactly 32 bytes at sequence 1, before any credential material.
      if (!tls || !context || length !== 32 || bytes[3] !== 1 || !(bytes.readUInt32LE(4) & 0x800)) {
        stats.plaintextAuth++;
        socket.destroy();
        return;
      }
      socket.pause();
      if (bytes.length > 36) socket.unshift(bytes.subarray(36));
      // A TLS ClientHello can share the SSLRequest data chunk. A generic duplex
      // preserves unshifted bytes; wrapping the native socket handle loses that buffered tail.
      const transport = Duplex.from({ readable: socket, writable: socket });
      const secure = new TLSSocket(transport, { isServer: true, secureContext: context });
      sockets.add(secure);
      secure.on("close", () => sockets.delete(secure));
      secure.on("error", () => undefined);
      secure.on("secure", () => { if (typeof secure.servername === "string") stats.sni.push(secure.servername); });
      let pending = Buffer.alloc(0);
      let authenticated = false;
      secure.on("data", (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        while (pending.length >= 4) {
          const n = pending.readUIntLE(0, 3);
          if (pending.length < n + 4) return;
          const seq = pending[3]!;
          const payload = pending.subarray(4, n + 4);
          pending = pending.subarray(n + 4);
          if (!authenticated) {
            if (seq !== 2 || payload.length < 33 || !(payload.readUInt32LE(0) & 0x800)) { secure.destroy(); return; }
            stats.encryptedAuth++;
            authenticated = true;
            secure.write(packet(OK, 3));
          } else if (payload[0] === 3) {
            const sql = payload.subarray(1).toString("utf8");
            stats.queries.push(sql);
            secure.write(encode(opts.answer?.(sql) ?? {}));
          } else if (payload[0] === 1) {
            secure.end();
          } else {
            secure.write(packet(OK, 1));
          }
        }
      });
      socket.resume();
    };
    socket.on("data", first);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The MySQL wire fixture has no TCP address.");
  return {
    port: address.port,
    stats,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
