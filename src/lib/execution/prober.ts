/**
 * SafeProber — the HTTP probe behind `verifyApplication`, hardened against SSRF.
 *
 * What it is asked to do is narrow: GET `https://<host><path>` of a host that is
 * one of the graph's own `dns_record` nodes and report status, latency, TLS
 * expiry and a digest of the first bytes. Hosts come from a manifest, which is
 * external data, so the prober treats every host as hostile until proven
 * otherwise:
 *
 *   - ONLY hosts in `allowedHosts` (the graph's dns_record hosts) are probed;
 *     anything else is refused before any DNS query;
 *   - https only, port 443 only: there is no URL, scheme or port input at all;
 *     the path is a bare absolute path of unreserved characters, no query string;
 *   - IP literals are refused as hosts; the hostname must be a plain DNS name;
 *   - the name is resolved ONCE. Every returned address must be public (not
 *     loopback, private, link-local — which includes the cloud metadata
 *     addresses 169.254.169.254 and fd00:ec2::254 —, CGNAT, multicast, reserved,
 *     documentation, NAT64, 6to4 or IPv4-mapped forms of any of those). One
 *     non-public address among the answers refuses the whole host: a record that
 *     mixes public and private answers is an attack or a misconfiguration, and
 *     either way is not probed;
 *   - the connection is made to THAT resolved address with SNI and the Host
 *     header set to the hostname, and the certificate is verified against the
 *     hostname. The transport never resolves the name again, so a DNS answer that
 *     changes between the check and the connect (rebinding) cannot redirect the
 *     request;
 *   - redirects are never followed (a redirect is a status, not a destination);
 *   - 10 s for the whole probe (resolve + connect + TLS + response headers),
 *     at most 64 KiB of body read, then the connection is destroyed. The body is
 *     hashed and discarded: it is untrusted data and is never returned or logged.
 *
 * `refused` (a safety rule said no) is deliberately distinct from `unreachable`:
 * a refusal says nothing about the application, so `verifyApplication` reports it
 * as `unknown`, not as a failed deployment.
 *
 * Limits: a single resolver answer is validated, not the path the packets take
 * (a public address that routes into a private network is out of reach for this
 * check); the probe runs from the worker's network, so it shows reachability from
 * there, not from the user's browser; IPv6 is probed only when the resolver
 * returns it.
 */
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import type { TLSSocket } from "node:tls";
import type { ProberPort, ProbeRequest, ProbeResult } from "./ports";

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MAX_BODY_BYTES = 64 * 1024;

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PATH = /^\/[A-Za-z0-9\-._~/]{0,511}$/;

/* ---------------------------- address policy ----------------------------- */

const BLOCKED = new net.BlockList();
for (const [net4, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. the metadata service
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const)
  BLOCKED.addSubnet(net4, bits, "ipv4");
for (const [net6, bits] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0:0", 96], // IPv4-translated (SIIT)
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, Teredo, benchmarking, ORCHID
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
  ["fc00::", 7], // unique local, incl. fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const)
  BLOCKED.addSubnet(net6, bits, "ipv6");

/** True only for a globally routable unicast address. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  if (address.includes("%")) return false; // a zone id makes an address interface-local
  if (net.isIPv4(address)) return !BLOCKED.check(address, "ipv4");
  if (net.isIPv6(address)) {
    // `BlockList.check` treats an IPv4-mapped address as its IPv4 form, so ::ffff:10.0.0.1 is caught by 10/8.
    return !BLOCKED.check(address, "ipv6");
  }
  return false;
}

/* -------------------------------- transport ------------------------------- */

export interface RawResponse {
  status: number;
  latencyMs: number;
  bytes: number;
  truncated: boolean;
  bodyDigest: string;
  tlsExpiresAt?: string;
}

export class ProbeTransportError extends Error {
  constructor(
    readonly kind: "timeout" | "connect" | "tls" | "protocol",
    readonly code?: string
  ) {
    super(`probe transport ${kind}${code ? ` (${code})` : ""}`);
  }
}

export interface TransportRequest {
  /** the address DNS returned and the policy accepted; the ONLY thing connected to */
  ip: string;
  family: 4 | 6;
  host: string;
  path: string;
  timeoutMs: number;
  maxBodyBytes: number;
}

export type ProbeTransport = (req: TransportRequest) => Promise<RawResponse>;

const CODE = /^[A-Z][A-Z0-9_]{2,60}$/;
const safeCode = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && CODE.test(code) ? code : undefined;
};

/**
 * The real transport: `https.request` with a `lookup` pinned to the validated address.
 * `ca` and `port` exist so tests can talk to a local TLS server with its own certificate;
 * production wiring passes neither (system trust store, port 443).
 */
export function httpsTransport(opts: { ca?: string | Buffer | (string | Buffer)[]; port?: number } = {}): ProbeTransport {
  return ({ ip, family, host, path, timeoutMs, maxBodyBytes }) =>
    new Promise<RawResponse>((resolve, reject) => {
      const started = performance.now();
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      const req = https.request({
        host,
        port: opts.port ?? 443,
        method: "GET",
        path,
        agent: false,
        servername: host,
        headers: { Host: host, "User-Agent": "zenith-verify/1", Accept: "*/*", "Accept-Encoding": "identity", Connection: "close" },
        // Never resolve again: the address was resolved and validated once, before this call.
        lookup: (_hostname, options, callback) => {
          if ((options as { all?: boolean } | undefined)?.all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: ip, family }]);
          else (callback as unknown as (e: null, a: string, f: number) => void)(null, ip, family);
        },
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(opts.ca ? { ca: opts.ca } : {}),
      });
      const deadline = setTimeout(() => {
        req.destroy(new ProbeTransportError("timeout"));
      }, timeoutMs);
      (deadline as unknown as { unref?: () => void }).unref?.();

      req.on("response", (res) => {
        const latencyMs = performance.now() - started;
        let tlsExpiresAt: string | undefined;
        try {
          const cert = (res.socket as TLSSocket).getPeerCertificate?.();
          if (cert?.valid_to) {
            const ms = Date.parse(cert.valid_to);
            if (!Number.isNaN(ms)) tlsExpiresAt = new Date(ms).toISOString();
          }
        } catch {
          /* no certificate details: the verification above already passed or the request would have failed */
        }
        const hash = createHash("sha256");
        let bytes = 0;
        let truncated = false;
        const finish = (): void =>
          settle(() => resolve({ status: res.statusCode ?? 0, latencyMs, bytes, truncated, bodyDigest: hash.digest("hex"), ...(tlsExpiresAt ? { tlsExpiresAt } : {}) }));
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          const room = maxBodyBytes - bytes;
          if (chunk.length > room) {
            if (room > 0) {
              hash.update(chunk.subarray(0, room));
              bytes += room;
            }
            truncated = true;
            finish();
            req.destroy();
            return;
          }
          hash.update(chunk);
          bytes += chunk.length;
        });
        res.on("end", finish);
        res.on("error", (err) => settle(() => reject(new ProbeTransportError("protocol", safeCode(err)))));
      });
      req.on("error", (err) => {
        if (err instanceof ProbeTransportError) return settle(() => reject(err));
        const code = safeCode(err);
        const tls = code !== undefined && /CERT|TLS|SSL|ALTNAME|SELF_SIGNED|EPROTO|HANDSHAKE/.test(code);
        settle(() => reject(new ProbeTransportError(tls ? "tls" : "connect", code)));
      });
      req.end();
    });
}

/* --------------------------------- prober --------------------------------- */

export interface SafeProberOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** default: `dns.lookup(host, { all: true, verbatim: true })` */
  resolve?: (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  /** default: `httpsTransport()` */
  transport?: ProbeTransport;
  /** default: `isPublicAddress`. A weaker policy exists for tests that talk to a local TLS server; never set it in production wiring. */
  isAllowedAddress?: (address: string) => boolean;
}

const refused = (req: ProbeRequest, reason: string): ProbeResult => ({ host: String(req.host).slice(0, 253), path: String(req.path).slice(0, 512), outcome: "refused", reason });

async function defaultResolve(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

export function createSafeProber(options: SafeProberOptions = {}): ProberPort {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? PROBE_MAX_BODY_BYTES;
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? httpsTransport();
  const allowed = options.isAllowedAddress ?? isPublicAddress;

  return {
    async probe(req) {
      const host = typeof req.host === "string" ? req.host : "";
      const path = typeof req.path === "string" ? req.path : "";
      if (host !== host.toLowerCase() || !HOSTNAME.test(host) || net.isIP(host) !== 0) return refused(req, "the host is not a plain DNS name");
      if (!req.allowedHosts.has(host)) return refused(req, "the host is not one of this environment's DNS records");
      if (!PATH.test(path)) return refused(req, "the path must be an absolute path of unreserved characters, without a query string");

      const started = performance.now();
      const remaining = (): number => Math.max(1, Math.round(timeoutMs - (performance.now() - started)));

      let answers: { address: string; family: 4 | 6 }[];
      try {
        answers = await withDeadline(resolve(host), timeoutMs);
      } catch (err) {
        return { host, path, outcome: "unreachable", reason: err instanceof ProbeTransportError ? "dns timeout" : `dns error${safeCode(err) ? ` (${safeCode(err)})` : ""}` };
      }
      if (answers.length === 0) return { host, path, outcome: "unreachable", reason: "the name has no address" };
      if (!answers.every((a) => allowed(a.address))) return refused(req, "the name resolves to a private, loopback, link-local or otherwise non-public address");

      let last: ProbeTransportError | undefined;
      for (const answer of answers) {
        if (remaining() <= 1) break;
        try {
          const raw = await transport({ ip: answer.address, family: answer.family, host, path, timeoutMs: remaining(), maxBodyBytes });
          return {
            host,
            path,
            outcome: "responded",
            status: raw.status,
            latencyMs: raw.latencyMs,
            bytes: raw.bytes,
            truncated: raw.truncated,
            bodyDigest: raw.bodyDigest,
            ...(raw.tlsExpiresAt ? { tlsExpiresAt: raw.tlsExpiresAt } : {}),
            address: answer.address,
          };
        } catch (err) {
          last = err instanceof ProbeTransportError ? err : new ProbeTransportError("connect", safeCode(err));
          if (last.kind === "tls" || last.kind === "timeout") break; // another address will not fix a certificate or burn more of the budget
        }
      }
      return { host, path, outcome: "unreachable", reason: last ? `${last.kind}${last.code ? ` (${last.code})` : ""}` : "timeout" };
    },
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTransportError("timeout")), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
