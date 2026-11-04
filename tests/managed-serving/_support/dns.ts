/**
 * A real, local DNS server over UDP for the domain-proof tests: the production resolver code (`node:dns` through
 * `systemDomainDns({ servers })`) talks to it over the wire, so the TXT lookup, the NXDOMAIN and the timeout paths are the real
 * ones. It is a test double of the INTERNET'S DNS, not of the resolver. TXT only, one question per packet.
 */
import dgram from "node:dgram";
import type { AddressInfo } from "node:net";

export type DnsAnswer = { kind: "txt"; values: string[][] } | { kind: "nxdomain" } | { kind: "nodata" } | { kind: "servfail" } | { kind: "drop" };

export interface LocalDns {
  /** `127.0.0.1:<port>` for `Resolver.setServers` */
  server: string;
  set(name: string, answer: DnsAnswer): void;
  clear(): void;
  queries: string[];
  close(): Promise<void>;
}

function readName(buf: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let i = offset;
  for (;;) {
    const len = buf[i];
    if (len === 0) { i += 1; break; }
    labels.push(buf.subarray(i + 1, i + 1 + len).toString("ascii"));
    i += 1 + len;
  }
  return { name: labels.join(".").toLowerCase(), end: i };
}

function encodeTxt(chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.concat([Buffer.from([Buffer.byteLength(c)]), Buffer.from(c)])));
}

export async function startLocalDns(): Promise<LocalDns> {
  const socket = dgram.createSocket("udp4");
  const answers = new Map<string, DnsAnswer>();
  const queries: string[] = [];
  socket.on("message", (msg, rinfo) => {
    const { name, end } = readName(msg, 12);
    const qtype = msg.readUInt16BE(end);
    queries.push(name);
    const answer = answers.get(name) ?? { kind: "nxdomain" as const };
    if (answer.kind === "drop") return;
    const question = msg.subarray(12, end + 4);
    const rcode = answer.kind === "nxdomain" ? 3 : answer.kind === "servfail" ? 2 : 0;
    const records = answer.kind === "txt" && qtype === 16 ? answer.values.map((chunks) => {
      const rdata = encodeTxt(chunks);
      const head = Buffer.alloc(12);
      head.writeUInt16BE(0xc00c, 0); // pointer to the question name
      head.writeUInt16BE(16, 2); // TXT
      head.writeUInt16BE(1, 4); // IN
      head.writeUInt32BE(30, 6); // ttl
      head.writeUInt16BE(rdata.length, 10);
      return Buffer.concat([head, rdata]);
    }) : [];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(msg.readUInt16BE(0), 0);
    header.writeUInt16BE(0x8180 | rcode, 2); // response, recursion desired + available
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(records.length, 6);
    socket.send(Buffer.concat([header, question, ...records]), rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = (socket.address() as AddressInfo).port;
  return {
    server: `127.0.0.1:${port}`,
    set: (name, answer) => { answers.set(name.toLowerCase(), answer); },
    clear: () => { answers.clear(); queries.length = 0; },
    queries,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}
