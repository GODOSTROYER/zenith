/**
 * SafeProber: the SSRF rules, DNS-rebinding resistance, and — against a real
 * local TLS server — the transport's SNI, certificate check, redirect, body cap
 * and timeout behaviour.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeProber, httpsTransport, isPublicAddress, ProbeTransportError, type ProbeTransport } from "@/lib/execution/prober";

const HOST = "app.example.test";
const allowed = new Set([HOST, "other.example.test"]);
const PUBLIC = "93.184.216.34";

describe("isPublicAddress", () => {
  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // just outside 172.16/12
    "100.63.255.255", // just outside CGNAT
    "2606:2800:220:1:248:1893:25c8:1946",
    "2001:4860:4860::8888",
  ])("accepts the public address %s", (ip) => expect(isPublicAddress(ip)).toBe(true));

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "this network"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.1", "documentation"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["::1", "loopback v6"],
    ["::", "unspecified v6"],
    ["fe80::1", "link-local v6"],
    ["fd00:ec2::254", "AWS IMDS v6"],
    ["fc00::1", "unique local"],
    ["ff02::1", "multicast v6"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:7f00:1", "IPv4-mapped loopback, hex form"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::7f00:1", "NAT64 of loopback"],
    ["2002:7f00:1::1", "6to4 of loopback"],
    ["2001:db8::1", "documentation v6"],
    ["fe80::1%eth0", "zone id"],
  ])("refuses %s (%s)", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["", "not-an-ip", "1.2.3", "1.2.3.4.5", "999.1.1.1", "0x7f.0.0.1", "2130706433", "127.1"])("refuses the unparseable %j", (ip) => expect(isPublicAddress(ip)).toBe(false));
});

const never: ProbeTransport = async () => {
  throw new Error("the transport must not be called");
};

describe("createSafeProber: what it refuses before touching the network", () => {
  const refusals: [string, { host: string; path: string }][] = [
    ["a host that is not one of the graph's DNS records", { host: "evil.example.test", path: "/" }],
    ["an IPv4 literal", { host: "169.254.169.254", path: "/" }],
    ["an IPv6 literal", { host: "::1", path: "/" }],
    ["a host written with a scheme (http://)", { host: "http://app.example.test", path: "/" }],
    ["a host with a port", { host: "app.example.test:8080", path: "/" }],
    ["a host with userinfo", { host: "user:pw@app.example.test", path: "/" }],
    ["an uppercase host", { host: "APP.example.test", path: "/" }],
    ["a bare label (no dot)", { host: "localhost", path: "/" }],
    ["an empty host", { host: "", path: "/" }],
    ["a path with a query string", { host: HOST, path: "/health?x=1" }],
    ["a path with a fragment", { host: HOST, path: "/health#x" }],
    ["a path with whitespace", { host: HOST, path: "/a b" }],
    ["a path with a CRLF (header injection)", { host: HOST, path: "/a\r\nHost: evil" }],
    ["a relative path", { host: HOST, path: "health" }],
    ["an absolute URL as the path", { host: HOST, path: "http://169.254.169.254/" }],
    ["a path over 512 characters", { host: HOST, path: `/${"a".repeat(512)}` }],
  ];
  it.each(refusals)("refuses %s without resolving or connecting", async (_why, req) => {
    let resolves = 0;
    const prober = createSafeProber({
      resolve: async () => {
        resolves++;
        return [{ address: PUBLIC, family: 4 }];
      },
      transport: never,
    });
    const result = await prober.probe({ ...req, allowedHosts: req.host === "evil.example.test" ? allowed : new Set([...allowed, req.host]) });
    expect(result.outcome).toBe("refused");
    expect(resolves).toBe(0);
  });

  it("refuses an allowed-set miss even for a perfectly valid name", async () => {
    const prober = createSafeProber({ resolve: async () => [{ address: PUBLIC, family: 4 }], transport: never });
    const result = await prober.probe({ host: "valid.example.test", path: "/", allowedHosts: allowed });
    expect(result).toMatchObject({ outcome: "refused", reason: expect.stringContaining("not one of this environment's DNS records") });
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.1.2.3"],
    ["link-local metadata", "169.254.169.254"],
    ["IPv4-mapped private", "::ffff:192.168.0.1"],
  ])("refuses a host that resolves to a %s address, and never connects", async (_n, ip) => {
    const prober = createSafeProber({ resolve: async () => [{ address: ip, family: ip.includes(":") ? 6 : 4 }], transport: never });
    const result = await prober.probe({ host: HOST, path: "/", allowedHosts: allowed });
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/non-public address/);
    expect(JSON.stringify(result)).not.toContain(ip);
  });

  it("refuses the WHOLE host when only one of several answers is non-public", async () => {
    const prober = createSafeProber({
      resolve: async () => [
        { address: PUBLIC, family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
      transport: never,
    });
    expect((await prober.probe({ host: HOST, path: "/", allowedHosts: allowed })).outcome).toBe("refused");
  });
});

describe("createSafeProber: DNS rebinding", () => {
  it("resolves once and connects to THAT address; a later answer cannot redirect the request", async () => {
    const answers = [[{ address: PUBLIC, family: 4 as const }], [{ address: "169.254.169.254", family: 4 as const }]];
    let resolves = 0;
    const connected: string[] = [];
    const prober = createSafeProber({
      resolve: async () => answers[Math.min(resolves++, answers.length - 1)],
      transport: async (req) => {
        connected.push(req.ip);
        return { status: 200, latencyMs: 5, bytes: 0, truncated: false, bodyDigest: "0".repeat(64) };
      },
    });
    const first = await prober.probe({ host: HOST, path: "/health", allowedHosts: allowed });
    expect(first).toMatchObject({ outcome: "responded", status: 200, address: PUBLIC });
    expect(connected).toEqual([PUBLIC]);
    expect(resolves).toBe(1); // the transport never resolved again

    // the next probe sees the rebound answer and refuses it
    const second = await prober.probe({ host: HOST, path: "/health", allowedHosts: allowed });
    expect(second.outcome).toBe("refused");
    expect(connected).toEqual([PUBLIC]);
  });

  it("hands the transport the validated address, SNI host and path — and nothing it could resolve itself", async () => {
    let seen: Parameters<ProbeTransport>[0] | undefined;
    const prober = createSafeProber({
      resolve: async () => [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }],
      transport: async (req) => {
        seen = req;
        return { status: 204, latencyMs: 1, bytes: 0, truncated: false, bodyDigest: "0".repeat(64) };
      },
    });
    await prober.probe({ host: HOST, path: "/healthz", allowedHosts: allowed });
    expect(seen).toMatchObject({ ip: "2606:2800:220:1:248:1893:25c8:1946", family: 6, host: HOST, path: "/healthz", maxBodyBytes: 65_536 });
    expect(seen!.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe("createSafeProber: failures that say something about the app", () => {
  it("reports a DNS error or an empty answer as unreachable, with a short reason and no raw error text", async () => {
    const enotfound = createSafeProber({
      resolve: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND app.example.test"), { code: "ENOTFOUND" });
      },
      transport: never,
    });
    expect(await enotfound.probe({ host: HOST, path: "/", allowedHosts: allowed })).toMatchObject({ outcome: "unreachable", reason: "dns error (ENOTFOUND)" });
    const empty = createSafeProber({ resolve: async () => [], transport: never });
    expect(await empty.probe({ host: HOST, path: "/", allowedHosts: allowed })).toMatchObject({ outcome: "unreachable", reason: "the name has no address" });
  });

  it("gives up on a resolver that never answers within the probe timeout", async () => {
    const prober = createSafeProber({ timeoutMs: 40, resolve: () => new Promise(() => undefined), transport: never });
    expect(await prober.probe({ host: HOST, path: "/", allowedHosts: allowed })).toMatchObject({ outcome: "unreachable", reason: "dns timeout" });
  });

  it("tries the next validated address after a connection failure, but not after a TLS failure or timeout", async () => {
    const tried: string[] = [];
    const answers = [
      { address: "93.184.216.34", family: 4 as const },
      { address: "93.184.216.35", family: 4 as const },
    ];
    const connectFail = createSafeProber({
      resolve: async () => answers,
      transport: async (req) => {
        tried.push(req.ip);
        if (req.ip.endsWith(".34")) throw new ProbeTransportError("connect", "ECONNREFUSED");
        return { status: 200, latencyMs: 1, bytes: 0, truncated: false, bodyDigest: "0".repeat(64) };
      },
    });
    expect(await connectFail.probe({ host: HOST, path: "/", allowedHosts: allowed })).toMatchObject({ outcome: "responded", address: "93.184.216.35" });
    expect(tried).toEqual(["93.184.216.34", "93.184.216.35"]);

    tried.length = 0;
    const tlsFail = createSafeProber({
      resolve: async () => answers,
      transport: async (req) => {
        tried.push(req.ip);
        throw new ProbeTransportError("tls", "CERT_HAS_EXPIRED");
      },
    });
    expect(await tlsFail.probe({ host: HOST, path: "/", allowedHosts: allowed })).toMatchObject({ outcome: "unreachable", reason: "tls (CERT_HAS_EXPIRED)" });
    expect(tried).toHaveLength(1);
  });
});

/* ------------------------- real TLS, local server ------------------------- */

const opensslOk = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!opensslOk)("httpsTransport against a real local TLS server", () => {
  let dir: string;
  let cert: string;
  let key: string;
  let server: https.Server;
  let port: number;
  const seen: { host?: string; sni?: string; url?: string; method?: string }[] = [];
  let mode: "ok" | "redirect" | "big" | "hang" = "ok";
  const body = "hello from the app";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "zenith-probe-tls-"));
    const keyFile = path.join(dir, "key.pem");
    const certFile = path.join(dir, "cert.pem");
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "2", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "pipe" });
    if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr.toString()}`);
    cert = readFileSync(certFile, "utf8");
    key = readFileSync(keyFile, "utf8");
    server = https.createServer({ key, cert }, (req, res) => {
      seen.push({ host: req.headers.host, sni: (req.socket as TLSSocket).servername || undefined, url: req.url, method: req.method });
      if (mode === "hang") return; // never answers
      if (mode === "redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      }
      if (mode === "big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("a".repeat(200_000));
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const prober = (over: { timeoutMs?: number; maxBodyBytes?: number; ca?: string } = {}) =>
    createSafeProber({
      timeoutMs: over.timeoutMs,
      maxBodyBytes: over.maxBodyBytes,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      isAllowedAddress: () => true, // loopback is exactly what the default policy refuses; this test needs it
      transport: httpsTransport({ ca: over.ca ?? cert, port }),
    });

  it("verifies the certificate against the hostname, sends SNI and Host for it, and reports status, latency, expiry and a body digest", async () => {
    mode = "ok";
    seen.length = 0;
    const result = await prober().probe({ host: HOST, path: "/health", allowedHosts: allowed });
    expect(result).toMatchObject({ outcome: "responded", status: 200, bytes: body.length, truncated: false, address: "127.0.0.1" });
    expect(result.bodyDigest).toBe(createHash("sha256").update(body).digest("hex"));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const expires = Date.parse(result.tlsExpiresAt!);
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires).toBeLessThan(Date.now() + 3 * 86_400_000);
    expect(seen).toEqual([{ host: HOST, sni: HOST, url: "/health", method: "GET" }]);
    expect(JSON.stringify(result)).not.toContain(body); // the body is hashed and dropped
  });

  it("does not follow a redirect (a redirect is a status, not a destination)", async () => {
    mode = "redirect";
    seen.length = 0;
    const result = await prober().probe({ host: HOST, path: "/", allowedHosts: allowed });
    expect(result).toMatchObject({ outcome: "responded", status: 302 });
    expect(seen).toHaveLength(1);
  });

  it("reads at most the body cap, marks the answer truncated and stops", async () => {
    mode = "big";
    const result = await prober({ maxBodyBytes: 64 * 1024 }).probe({ host: HOST, path: "/", allowedHosts: allowed });
    expect(result).toMatchObject({ outcome: "responded", status: 200, bytes: 64 * 1024, truncated: true });
    expect(result.bodyDigest).toBe(createHash("sha256").update("a".repeat(64 * 1024)).digest("hex"));
  });

  it("times out a server that accepts the request and never answers", async () => {
    mode = "hang";
    const started = Date.now();
    const result = await prober({ timeoutMs: 250 }).probe({ host: HOST, path: "/", allowedHosts: allowed });
    expect(result).toMatchObject({ outcome: "unreachable", reason: expect.stringContaining("timeout") });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("fails TLS for a certificate that does not match the host, and for an untrusted one", async () => {
    mode = "ok";
    const wrongName = await prober().probe({ host: "other.example.test", path: "/", allowedHosts: allowed });
    expect(wrongName).toMatchObject({ outcome: "unreachable", reason: expect.stringMatching(/^tls/) });
    const untrusted = createSafeProber({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      isAllowedAddress: () => true,
      transport: httpsTransport({ port }), // system trust store: the self-signed test certificate is not in it
    });
    expect(await untrusted.probe({ host: HOST, path: "/", allowedHosts: allowed })).toMatchObject({ outcome: "unreachable", reason: expect.stringMatching(/^tls/) });
  });

  it("reports a closed port as a connection failure", async () => {
    const closed = createSafeProber({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      isAllowedAddress: () => true,
      transport: httpsTransport({ ca: cert, port: 1 }),
    });
    expect(await closed.probe({ host: HOST, path: "/", allowedHosts: allowed })).toMatchObject({ outcome: "unreachable", reason: expect.stringMatching(/^connect/) });
  });
});
