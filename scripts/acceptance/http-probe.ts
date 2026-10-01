/**
 * HTTP, DNS and TLS probes for the deployed app.
 *
 * The URLs a probe visits come from a deployment (operation results, the DNS
 * zone the operator configured), so they are treated as data: http(s) only, no
 * embedded credentials, no redirects followed (a redirect is reported, not
 * chased), a hard timeout and a bounded body read. Nothing is sent but a GET.
 *
 * What a probe records is what it saw — status, latency, a short redacted body
 * snippet — never an interpretation. Whether that counts as a pass is the
 * scenario's call.
 */
import dns from "node:dns/promises";
import tls from "node:tls";

export interface ProbeResult {
  url: string;
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
  bodySnippet?: string;
}

export interface TlsInfo {
  host: string;
  /** the certificate chain validated against the system trust store and matched the host name */
  authorized: boolean;
  authorizationError?: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
  daysRemaining?: number;
  altNames?: string[];
}

export interface HttpProbe {
  /** One GET. `ok` means a response arrived with status in `expect` (default 200-299). */
  get(url: string, opts?: { timeoutMs?: number; expect?: (status: number) => boolean }): Promise<ProbeResult>;
  /** Repeat `get` until `accept` says yes or the deadline passes; returns the last result and whether it was accepted. */
  waitFor(url: string, opts: { accept: (r: ProbeResult) => boolean; timeoutMs: number; intervalMs?: number; requestTimeoutMs?: number }): Promise<{ accepted: boolean; last: ProbeResult; attempts: number }>;
  resolveDns(host: string): Promise<string[]>;
  tlsInfo(host: string, port?: number): Promise<TlsInfo>;
}

export interface HttpProbeDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  resolve?: (host: string) => Promise<string[]>;
  connectTls?: (host: string, port: number, timeoutMs: number) => Promise<TlsInfo>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const SNIPPET_CHARS = 300;

export function assertProbeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The probe URL is not a URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Probes speak http or https only.");
  if (url.username || url.password) throw new Error("A probe URL must not embed credentials.");
  return url;
}

async function readSnippet(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, SNIPPET_CHARS);
}

/** Node error codes that mean "the peer answered but its certificate is not acceptable", as opposed to "could not connect". */
const CERTIFICATE_ERROR = /^(?:CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|ERR_TLS_CERT_|HOSTNAME_MISMATCH|ERR_SSL_)/;

/**
 * Connect with full verification (system trust store and host name). A
 * certificate Node refuses is reported as `authorized: false` with the reason
 * code; a connection that cannot be made at all rejects.
 */
function defaultConnectTls(host: string, port: number, timeoutMs: number): Promise<TlsInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert && cert.valid_to ? new Date(cert.valid_to) : undefined;
      const info: TlsInfo = {
        host,
        authorized: socket.authorized,
        ...(socket.authorizationError ? { authorizationError: String(socket.authorizationError) } : {}),
        ...(cert?.subject?.CN ? { subject: String(cert.subject.CN) } : {}),
        ...(cert?.issuer?.O || cert?.issuer?.CN ? { issuer: String(cert.issuer.O ?? cert.issuer.CN) } : {}),
        ...(validTo && !Number.isNaN(validTo.getTime()) ? { validTo: validTo.toISOString(), daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86_400_000) } : {}),
        ...(cert?.subjectaltname ? { altNames: cert.subjectaltname.split(", ").map((s) => s.replace(/^DNS:/, "")) } : {}),
      };
      socket.end();
      resolve(info);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("TLS handshake timed out"));
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      if (CERTIFICATE_ERROR.test(code)) resolve({ host, authorized: false, authorizationError: code });
      else reject(err);
    });
  });
}

export function createHttpProbe(deps: HttpProbeDeps = {}): HttpProbe {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const resolve = deps.resolve ?? (async (host: string) => [...(await dns.resolve4(host).catch(() => [])), ...(await dns.resolve6(host).catch(() => []))]);
  const connectTls = deps.connectTls ?? defaultConnectTls;

  const get: HttpProbe["get"] = async (raw, opts = {}) => {
    const url = assertProbeUrl(raw);
    const expect = opts.expect ?? ((s: number) => s >= 200 && s < 300);
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await doFetch(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "zenith-live-acceptance", accept: "application/json, text/plain, */*" } });
      const body = await readSnippet(res);
      return { url: url.href, ok: expect(res.status), status: res.status, latencyMs: now() - started, bodySnippet: body };
    } catch (err) {
      const aborted = controller.signal.aborted;
      return { url: url.href, ok: false, latencyMs: now() - started, error: aborted ? "timeout" : err instanceof Error ? err.name || "error" : "error" };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get,
    async waitFor(url, opts) {
      const deadline = now() + opts.timeoutMs;
      let attempts = 0;
      let last: ProbeResult;
      for (;;) {
        attempts++;
        last = await get(url, { timeoutMs: opts.requestTimeoutMs, expect: () => true });
        if (opts.accept(last)) return { accepted: true, last, attempts };
        if (now() + (opts.intervalMs ?? 5_000) >= deadline) return { accepted: false, last, attempts };
        await sleep(opts.intervalMs ?? 5_000);
      }
    },
    resolveDns: (host) => resolve(host),
    tlsInfo: (host, port = 443) => connectTls(host, port, DEFAULT_TIMEOUT_MS),
  };
}
