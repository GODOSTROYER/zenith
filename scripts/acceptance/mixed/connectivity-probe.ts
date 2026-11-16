/**
 * Live probes of a deployed mixed run's protected endpoints (PROD-MIX-05). Read-only: it opens connections and sends
 * one HEAD request line; it creates, changes and deletes nothing. The endpoints it checks are read from the stored plan
 * (`GET /api/platform/v1/mixed/plans/:id` -> `connectivity.endpoints`), i.e. exactly what a person approved.
 *
 * Per endpoint, each probe is `passed`, `failed`, `skipped` or `inconclusive`. A probe that did not run, or whose
 * outcome could not be told apart from a local limitation, is never a pass:
 *   dns                  the name resolves only to the approved targets
 *   tls_pin              with the client certificate: TLS established at the approved minimum version or better, the
 *                        server key matches the approved pin, the certificate covers the host name
 *   mtls_required        WITHOUT a client certificate nothing is served
 *   tls_floor            a TLS 1.1 client is refused
 *   allowlist_denial     from a source OUTSIDE the allowlist (declared by the operator) a valid client certificate is
 *                        still refused. From an allowlisted machine it is `skipped` and marked not applicable (and the
 *                        pin, mutual-TLS and floor probes are the ones marked not applicable from outside): a complete proof
 *                        is one run from each vantage point.
 *
 * Contract level: the injected `ProbeIo` is what the contract tests fake; the real `nodeProbeIo` below is exercised only
 * by the gated live harness (`tests/live/mixed-connectivity.live.test.ts`).
 */
import dns from "node:dns/promises";
import { X509Certificate, createHash } from "node:crypto";
import tls from "node:tls";

export interface ClientMaterial { cert: Buffer; key: Buffer; ca?: Buffer }

export type TlsAttempt =
  | { outcome: "established"; protocol: string; spkiSha256: string; names: string[]; authorized: boolean; answered: boolean }
  | { outcome: "refused"; reason: "handshake_failed" | "reset" | "timeout" | "closed_after_handshake" | "local_unsupported" };

export interface TlsRequest { host: string; port: number; servername: string; client?: ClientMaterial; minVersion?: "TLSv1.2" | "TLSv1.3"; maxVersion?: "TLSv1.1" | "TLSv1.2" | "TLSv1.3"; timeoutMs: number }

export interface ProbeIo {
  resolve(host: string): Promise<string[]>;
  tlsConnect(request: TlsRequest): Promise<TlsAttempt>;
}

export interface ProbeEndpoint {
  id: string;
  dataClass: "database" | "service" | "function";
  host: string;
  port: number;
  dnsTargets: readonly string[];
  tlsMinVersion: "1.2" | "1.3";
  serverNames: readonly string[];
  serverSpkiSha256: string;
  allowlist: readonly string[];
}

export type ProbeId = "dns" | "tls_pin" | "mtls_required" | "tls_floor" | "allowlist_denial";
export type ProbeStatus = "passed" | "failed" | "skipped" | "inconclusive";
export interface ProbeResult {
  endpointId: string;
  probe: ProbeId;
  status: ProbeStatus;
  detail: string;
  /** false when this vantage point cannot tell the answer apart from another cause (so it is reported, never counted) */
  applicable: boolean;
}

export interface ProbeVerdict {
  /** nothing failed, every APPLICABLE probe passed, and at least one probe applied */
  ok: boolean;
  /** every applicable probe ran to a conclusion (none skipped or inconclusive) */
  complete: boolean;
  results: ProbeResult[];
  /** probes this vantage point cannot establish; a second run from the other vantage point is needed for them */
  notChecked: ProbeId[];
  vantage: "allowlisted_or_unknown" | "outside_allowlist";
  limits: string[];
}

const LIMITS = [
  "A passed probe shows what the probing machine could and could not do at that moment, not the provider's route tables or rules.",
  "Allowlist denial can only be shown from a machine outside the allowlist, and the certificate, pin, mutual-TLS and protocol-floor probes only from one inside it: a complete proof needs one run from each vantage point.",
  "TLS protocol floor and pin are checked on the connection made, not on every address behind the name.",
];

const VERSION_RANK: Record<string, number> = { "TLSv1": 0, "TLSv1.1": 1, "TLSv1.2": 2, "TLSv1.3": 3 };

export interface ProbeInput {
  endpoints: readonly ProbeEndpoint[];
  io: ProbeIo;
  /** client certificate material read from FILES by the caller; absent means the certificate-dependent probes are skipped */
  client?: ClientMaterial;
  /** the operator states the probing machine's public address is outside every allowlist */
  sourceOutsideAllowlist?: boolean;
  timeoutMs?: number;
}

export async function runConnectivityProbes(input: ProbeInput): Promise<ProbeVerdict> {
  const results: ProbeResult[] = [];
  const timeoutMs = input.timeoutMs ?? 8000;
  const outside = input.sourceOutsideAllowlist === true;
  const add = (endpointId: string, probe: ProbeId, status: ProbeStatus, detail: string, applicable = true) => { results.push({ endpointId, probe, status, detail, applicable }); };
  for (const ep of input.endpoints) {
    // dns: valid from any vantage point
    try {
      const got = [...new Set(await input.io.resolve(ep.host))].sort();
      const expected = new Set(ep.dnsTargets);
      const stray = got.filter((g) => !expected.has(g));
      if (!got.length) add(ep.id, "dns", "failed", "The name did not resolve.");
      else if (stray.length) add(ep.id, "dns", "failed", `The name resolves to ${stray.length} address(es) that were not approved.`);
      else add(ep.id, "dns", "passed", `Resolves only to approved targets (${got.length}).`);
    } catch { add(ep.id, "dns", "inconclusive", "The name could not be resolved from here (resolver error)."); }

    if (outside) {
      // From outside the allowlist every refusal looks the same, so only the allowlist question is answerable here.
      const note = "Not answerable from outside the allowlist: a refusal could be the allowlist, not this property. Run it from an allowlisted machine.";
      add(ep.id, "tls_pin", "skipped", note, false);
      add(ep.id, "mtls_required", "skipped", note, false);
      add(ep.id, "tls_floor", "skipped", note, false);
      if (!input.client) add(ep.id, "allowlist_denial", "skipped", "No client certificate file was given; the denial must be shown with a VALID certificate.");
      else {
        const attempt = await input.io.tlsConnect({ host: ep.host, port: ep.port, servername: ep.host, client: input.client, minVersion: `TLSv${ep.tlsMinVersion}` as "TLSv1.2" | "TLSv1.3", timeoutMs });
        if (attempt.outcome === "established" && attempt.answered) add(ep.id, "allowlist_denial", "failed", "A source outside the allowlist was served with a valid client certificate.");
        else if (attempt.outcome === "refused" && attempt.reason === "local_unsupported") add(ep.id, "allowlist_denial", "inconclusive", "This machine could not make the attempt.");
        else add(ep.id, "allowlist_denial", "passed", "A valid client certificate from outside the allowlist was not served.");
      }
      continue;
    }

    add(ep.id, "allowlist_denial", "skipped", "Needs a run from a machine OUTSIDE the allowlist (declare it with sourceOutsideAllowlist).", false);
    // pin + version + name, with the client certificate
    if (!input.client) add(ep.id, "tls_pin", "skipped", "No client certificate file was given.");
    else {
      const attempt = await input.io.tlsConnect({ host: ep.host, port: ep.port, servername: ep.host, client: input.client, minVersion: `TLSv${ep.tlsMinVersion}` as "TLSv1.2" | "TLSv1.3", timeoutMs });
      if (attempt.outcome !== "established") add(ep.id, "tls_pin", "failed", `Could not establish TLS with the client certificate (${attempt.reason}).`);
      else {
        const problems: string[] = [];
        if (!attempt.authorized) problems.push("the certificate chain is not trusted");
        if (attempt.spkiSha256 !== ep.serverSpkiSha256) problems.push("the server key does not match the approved pin");
        if (!ep.serverNames.includes(ep.host) || !attempt.names.includes(ep.host)) problems.push("the certificate does not name the host");
        if ((VERSION_RANK[attempt.protocol] ?? -1) < (VERSION_RANK[`TLSv${ep.tlsMinVersion}`] ?? 99)) problems.push(`negotiated ${attempt.protocol}, below the approved minimum`);
        add(ep.id, "tls_pin", problems.length ? "failed" : "passed", problems.length ? problems.join("; ") : `TLS ${attempt.protocol}, key pinned, host named.`);
      }
    }

    // mutual TLS: no client certificate, nothing must be served
    const bare = await input.io.tlsConnect({ host: ep.host, port: ep.port, servername: ep.host, timeoutMs });
    if (bare.outcome === "established" && bare.answered) add(ep.id, "mtls_required", "failed", "The endpoint served a request without a client certificate.");
    else if (bare.outcome === "refused" && bare.reason === "local_unsupported") add(ep.id, "mtls_required", "inconclusive", "This machine could not make the attempt.");
    else if (bare.outcome === "refused" && bare.reason === "timeout") add(ep.id, "mtls_required", "inconclusive", "The attempt timed out; it could be a firewall rather than a certificate requirement.");
    else add(ep.id, "mtls_required", "passed", "Nothing was served without a client certificate.");

    // protocol floor
    const old = await input.io.tlsConnect({ host: ep.host, port: ep.port, servername: ep.host, ...(input.client ? { client: input.client } : {}), maxVersion: "TLSv1.1", timeoutMs });
    if (old.outcome === "established") add(ep.id, "tls_floor", "failed", `A TLS 1.1 client negotiated ${old.protocol}.`);
    else if (old.reason === "local_unsupported" || old.reason === "timeout") add(ep.id, "tls_floor", "inconclusive", old.reason === "timeout" ? "The attempt timed out." : "This machine cannot offer TLS 1.1, so the floor was not tested.");
    else add(ep.id, "tls_floor", "passed", "A TLS 1.1 client was refused.");
  }
  const applicable = results.filter((r) => r.applicable);
  const failed = applicable.some((r) => r.status === "failed");
  const complete = applicable.every((r) => r.status === "passed" || r.status === "failed");
  return {
    ok: !failed && complete && applicable.length > 0, complete, results, vantage: outside ? "outside_allowlist" : "allowlisted_or_unknown", limits: LIMITS,
    notChecked: [...new Set(results.filter((r) => !r.applicable).map((r) => r.probe))],
  };
}

/* ------------------------------ the real io ------------------------------- */

function spkiOf(raw: Buffer): string {
  const cert = new X509Certificate(raw);
  return createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

export const nodeProbeIo: ProbeIo = {
  async resolve(host) {
    const out: string[] = [];
    for (const lookup of [() => dns.resolve4(host), () => dns.resolve6(host), () => dns.resolveCname(host)]) {
      try { out.push(...(await lookup())); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENODATA" && (e as NodeJS.ErrnoException).code !== "ENOTFOUND") throw e; }
    }
    return out;
  },
  tlsConnect(request) {
    return new Promise<TlsAttempt>((resolve) => {
      let settled = false;
      const done = (value: TlsAttempt, socket?: tls.TLSSocket) => { if (settled) return; settled = true; socket?.destroy(); resolve(value); };
      let socket: tls.TLSSocket;
      try {
        // rejectUnauthorized is false on purpose: this is a prober that must SEE a bad certificate to report it. It never sends
        // application data beyond one HEAD line, and `authorized`, the key pin and the host names are all checked and reported
        // by `runConnectivityProbes`; an untrusted certificate fails the tls_pin probe.
        socket = tls.connect({
          host: request.host, port: request.port, servername: request.servername, timeout: request.timeoutMs, rejectUnauthorized: false,
          ...(request.client ? { cert: request.client.cert, key: request.client.key, ...(request.client.ca ? { ca: request.client.ca } : {}) } : {}),
          ...(request.minVersion ? { minVersion: request.minVersion } : {}), ...(request.maxVersion ? { maxVersion: request.maxVersion } : {}),
        });
      } catch { resolve({ outcome: "refused", reason: "local_unsupported" }); return; }
      socket.once("timeout", () => done({ outcome: "refused", reason: "timeout" }, socket));
      socket.once("error", (e: NodeJS.ErrnoException) => {
        const code = String(e.code ?? "");
        if (code === "ERR_SSL_NO_PROTOCOLS_AVAILABLE" || code === "ERR_TLS_INVALID_PROTOCOL_VERSION") done({ outcome: "refused", reason: "local_unsupported" }, socket);
        else if (code === "ECONNRESET") done({ outcome: "refused", reason: "reset" }, socket);
        else done({ outcome: "refused", reason: "handshake_failed" }, socket);
      });
      socket.once("secureConnect", () => {
        const peer = socket.getPeerCertificate(true);
        const raw = peer && "raw" in peer && peer.raw ? peer.raw : undefined;
        const names = [...(peer?.subjectaltname ?? "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("DNS:")).map((s) => s.slice(4)), ...(peer?.subject?.CN ? [String(peer.subject.CN)] : [])];
        let answered = false;
        socket.write("HEAD / HTTP/1.0\r\n\r\n");
        socket.once("data", () => { answered = true; done({ outcome: "established", protocol: socket.getProtocol() ?? "unknown", spkiSha256: raw ? spkiOf(raw) : "", names, authorized: socket.authorized, answered }, socket); });
        socket.once("close", () => done(answered ? { outcome: "established", protocol: socket.getProtocol() ?? "unknown", spkiSha256: raw ? spkiOf(raw) : "", names, authorized: socket.authorized, answered } : { outcome: "refused", reason: "closed_after_handshake" }));
        setTimeout(() => done(raw ? { outcome: "established", protocol: socket.getProtocol() ?? "unknown", spkiSha256: spkiOf(raw), names, authorized: socket.authorized, answered: false } : { outcome: "refused", reason: "timeout" }, socket), Math.min(request.timeoutMs, 4000)).unref();
      });
    });
  },
};
