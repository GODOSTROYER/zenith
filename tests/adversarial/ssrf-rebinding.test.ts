/**
 * Threat class: SSRF, address-encoding smuggling and DNS rebinding (PROD-OPS-08).
 *
 * Attacker model: a tenant (or anything a tenant can write into a connection
 * secret, an alert channel, a DNS record or an exported artifact) names a host.
 * The attacker's goal is a request from inside Zenith's network to loopback, an
 * internal address or a cloud metadata service, either by spelling the address
 * in a way a classifier mis-reads or by answering DNS differently between the
 * check and the connection.
 *
 * Independence: the oracle is a `node:net` BlockList built here from the IANA
 * registries, NOT any guard's own table. Every guard is driven only through its
 * exported public function. The outbound inventory at the bottom reads source
 * text and fails when a new outbound primitive appears that has not been
 * reviewed, so a bypass cannot be added silently.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BlockList } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyAddress, resolveConnectableHost } from "@/lib/portability/net";
import { resolveWebhookTarget, WebhookPolicyError } from "@/lib/alerts/webhook-policy";
import { createSafeProber, isPublicAddress, type ProbeTransport } from "@/lib/execution/prober";

/* ------------------------------ independent oracle ------------------------------ */

const oracle = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) oracle.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) oracle.addSubnet(net, bits, "ipv6");

const pair = (a: string): string => {
  const [w, x, y, z] = a.split(".").map(Number) as [number, number, number, number];
  return `${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
};

/** Every IPv6 spelling that carries an IPv4 destination. */
const wrap = (a: string): Record<string, string> => ({
  mapped: `::ffff:${pair(a)}`,
  mappedDotted: `::ffff:${a}`,
  mappedUpper: `::FFFF:${pair(a).toUpperCase()}`,
  compatible: `::${pair(a)}`,
  translated: `::ffff:0:${pair(a)}`,
  nat64: `64:ff9b::${pair(a)}`,
  nat64Dotted: `64:ff9b::${a}`,
  nat64Local: `64:ff9b:1::${pair(a)}`,
  sixToFour: `2002:${pair(a)}::`,
  sixToFourHost: `2002:${pair(a)}:1:2:3:4:5`,
});

/** Internal targets worth a request. `metadata` ones must stay blocked even under the private-range opt-in. */
const INTERNAL_V4 = [
  { a: "127.0.0.1", metadata: false }, { a: "127.255.255.254", metadata: false }, { a: "10.0.0.1", metadata: false },
  { a: "172.16.0.1", metadata: false }, { a: "172.31.255.255", metadata: false }, { a: "192.168.0.1", metadata: false },
  { a: "100.64.0.1", metadata: false }, { a: "198.18.0.1", metadata: false }, { a: "169.254.169.254", metadata: true },
  { a: "169.254.170.2", metadata: true }, { a: "100.100.100.200", metadata: true }, { a: "0.0.0.0", metadata: true },
  { a: "224.0.0.1", metadata: true }, { a: "255.255.255.255", metadata: true },
];
const NATIVE_V6 = [
  { a: "::1", metadata: false }, { a: "::", metadata: true }, { a: "fe80::1", metadata: true }, { a: "fe80::1%eth0", metadata: true },
  { a: "fc00::1", metadata: false }, { a: "fd12:3456::1", metadata: false }, { a: "fd00:ec2::254", metadata: true },
  { a: "fec0::1", metadata: true }, { a: "ff02::1", metadata: true }, { a: "2001:db8::1", metadata: true }, { a: "2001::1", metadata: true },
  { a: "100::1", metadata: true },
];

interface Case { label: string; address: string; metadata: boolean }
function corpus(): Case[] {
  const out: Case[] = [];
  for (const { a, metadata } of INTERNAL_V4) {
    out.push({ label: `v4 ${a}`, address: a, metadata });
    // IPv4 smuggled through IPv6: NAT64/6to4/compatible/translated are never a legitimate tenant service, so all are metadata-class.
    for (const [kind, lit] of Object.entries(wrap(a))) out.push({ label: `${kind}(${a})`, address: lit, metadata: kind.startsWith("mapped") ? metadata : true });
  }
  for (const { a, metadata } of NATIVE_V6) out.push({ label: `v6 ${a}`, address: a, metadata });
  return out;
}

/** An address the oracle says is globally routable must not be refused (no denial of service by over-blocking). */
const PUBLIC = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81a::200e", "151.101.1.69"];

const strictEnv = (): void => {
  delete process.env.ZENITH_ALERT_WEBHOOK_ALLOW_INSECURE;
  delete process.env.ZENITH_ALERT_WEBHOOK_ALLOWED_PORTS;
  delete process.env.ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS;
};
beforeEach(strictEnv);
afterEach(strictEnv);

const refuses = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try { await fn(); return false; } catch { return true; }
};

describe("the oracle itself", () => {
  it("agrees that every internal base and wrapper is non-public, and the public set is public", () => {
    for (const c of corpus().filter((x) => !x.address.includes("%"))) expect(oracle.check(c.address, c.address.includes(":") ? "ipv6" : "ipv4"), c.label).toBe(true);
    for (const p of PUBLIC) expect(oracle.check(p, p.includes(":") ? "ipv6" : "ipv4"), p).toBe(false);
  });
});

describe("every guard refuses every spelling of an internal destination", () => {
  const cases = corpus();

  it("portability connect guard (connection secrets, S3/MySQL/Postgres/DNS engines), default policy", async () => {
    const leaks: string[] = [];
    for (const c of cases) {
      const host = c.address.includes(":") ? `[${c.address}]` : c.address;
      if (!(await refuses(() => resolveConnectableHost(host, { allowPrivate: false })))) leaks.push(c.label);
    }
    expect(leaks, "internal destinations the portability guard would connect to").toEqual([]);
  });

  it("portability connect guard keeps metadata and transition ranges blocked even with the private-range opt-in", async () => {
    const leaks: string[] = [];
    for (const c of cases.filter((x) => x.metadata)) {
      const host = c.address.includes(":") ? `[${c.address}]` : c.address;
      if (!(await refuses(() => resolveConnectableHost(host, { allowPrivate: true })))) leaks.push(c.label);
    }
    expect(leaks, "the opt-in must never unlock metadata or smuggling ranges").toEqual([]);
  });

  it("portability classifier labels every internal destination non-public", () => {
    const wrong = cases.filter((c) => classifyAddress(c.address) === "public").map((c) => c.label);
    expect(wrong).toEqual([]);
  });

  it("portability guard follows names to every answer, not just the first", async () => {
    for (const c of cases) {
      const lookup = async (): Promise<string[]> => ["93.184.216.34", c.address.split("%")[0]!];
      expect(await refuses(() => resolveConnectableHost("mixed.example.org", { allowPrivate: false, lookup })), `mixed answer with ${c.label}`).toBe(true);
    }
  });

  it("alert webhook guard refuses literals in URL form (strict policy)", async () => {
    const leaks: string[] = [];
    for (const c of cases.filter((x) => !x.address.includes("%"))) {
      const host = c.address.includes(":") ? `[${c.address}]` : c.address;
      if (!(await refuses(() => resolveWebhookTarget(`https://${host}/hook`)))) leaks.push(c.label);
    }
    expect(leaks, "internal destinations the webhook guard would POST to").toEqual([]);
  });

  it("alert webhook guard refuses names whose answers include an internal address", async () => {
    const leaks: string[] = [];
    for (const c of cases.filter((x) => !x.address.includes("%"))) {
      const answers = async (): Promise<readonly string[]> => ["93.184.216.34", c.address];
      if (!(await refuses(() => resolveWebhookTarget("https://hooks.example.org/x", { resolveAll: answers })))) leaks.push(c.label);
    }
    expect(leaks).toEqual([]);
  });

  it("execution prober classifier refuses every internal destination", () => {
    const leaks = cases.filter((c) => isPublicAddress(c.address)).map((c) => c.label);
    expect(leaks).toEqual([]);
  });

  it("no guard over-blocks ordinary public addresses", async () => {
    for (const p of PUBLIC) {
      const host = p.includes(":") ? `[${p}]` : p;
      await expect(resolveConnectableHost(host, { allowPrivate: false }), p).resolves.toBeTruthy();
      await expect(resolveWebhookTarget(`https://${host}/hook`), p).resolves.toBeTruthy();
      expect(isPublicAddress(p), p).toBe(true);
    }
  });
});

describe("URL-level host obfuscation reaches the same refusal", () => {
  // The WHATWG parser canonicalises these to dotted IPv4; the guard must see the canonical form, not the spelling.
  const obfuscated = [
    "https://2130706433/", "https://0x7f000001/", "https://017700000001/", "https://0x7f.1/", "https://127.1/", "https://127.0.1/",
    "https://0177.0.0.1/", "https://0xA9FEA9FE/", "https://2852039166/", "https://[::ffff:7f00:1]/", "https://[::ffff:127.0.0.1]/",
    "https://[0:0:0:0:0:ffff:7f00:1]/", "https://LOCALHOST/", "https://localhost./", "https://foo.localhost/", "https://user:pw@127.0.0.1/",
    "https://127.0.0.1#@example.com/", "https://example.com@127.0.0.1/", "http://127.0.0.1/", "file:///etc/passwd", "gopher://127.0.0.1:70/",
    "https://127.0.0.1:443/", "https://[::1]/", "https://0/", "https://0.0.0.0/", "https://%31%32%37.0.0.1/",
  ];
  it.each(obfuscated)("webhook %s is refused", async (url) => {
    let refused = false;
    try {
      await resolveWebhookTarget(url, { resolveAll: async () => ["127.0.0.1"] });
    } catch (error) {
      refused = true;
      expect(error).toBeInstanceOf(WebhookPolicyError);
    }
    expect(refused).toBe(true);
  });

  it("a refusal never echoes the resolved address or the secret-bearing URL parts", async () => {
    for (const url of ["https://user:s3cretpw@127.0.0.1/x?token=abc", "https://internal.example.org/x"]) {
      try {
        await resolveWebhookTarget(url, { resolveAll: async () => ["10.9.8.7"] });
      } catch (error) {
        const text = String((error as Error).message);
        expect(text).not.toMatch(/10\.9\.8\.7|s3cretpw|token=abc/);
      }
    }
  });

  it("hostnames that the portability guard names as local are refused by name without a lookup", async () => {
    let looked = 0;
    const lookup = async (): Promise<string[]> => { looked++; return ["93.184.216.34"]; };
    for (const name of ["localhost", "LOCALHOST", "db.internal", "metadata.google.internal", "printer.local", "a.localdomain", "x.localhost"]) {
      expect(await refuses(() => resolveConnectableHost(name, { allowPrivate: false, lookup })), name).toBe(true);
    }
    expect(looked).toBe(0);
  });
});

describe("DNS rebinding: the validated literal is the only thing a transport may connect to", () => {
  it("portability returns literals only; a later private answer cannot reach a connection already authorised", async () => {
    let call = 0;
    const lookup = async (): Promise<string[]> => (call++ === 0 ? ["93.184.216.34"] : ["169.254.169.254"]);
    const first = await resolveConnectableHost("rebind.example.org", { allowPrivate: false, lookup });
    expect(first.map((a) => a.address)).toEqual(["93.184.216.34"]);
    // The result carries no hostname a transport could re-resolve.
    expect(JSON.stringify(first)).not.toContain("rebind.example.org");
    // A fresh connection resolves anew and is checked again: the flipped answer is refused.
    expect(await refuses(() => resolveConnectableHost("rebind.example.org", { allowPrivate: false, lookup }))).toBe(true);
  });

  it("webhook returns the address to pin, and the flipped second answer is refused on the next check", async () => {
    let call = 0;
    const resolveAll = async (): Promise<readonly string[]> => (call++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const first = await resolveWebhookTarget("https://rebind.example.org/hook", { resolveAll });
    expect(first.address).toBe("93.184.216.34");
    await expect(resolveWebhookTarget("https://rebind.example.org/hook", { resolveAll })).rejects.toBeInstanceOf(WebhookPolicyError);
  });

  it("webhook ports outside the allowlist are refused (no port scanner with an oracle)", async () => {
    for (const port of [22, 25, 80, 3306, 5432, 6379, 8080, 9200, 11211]) {
      await expect(resolveWebhookTarget(`https://hooks.example.org:${port}/x`, { resolveAll: async () => ["93.184.216.34"] }), String(port)).rejects.toBeInstanceOf(WebhookPolicyError);
    }
  });

  it("the development acknowledgement is ignored on hosted, Postgres or serverless deployments", async () => {
    for (const env of [{ ZENITH_HOSTED_MODE: "1" }, { ZENITH_STORE: "postgres" }, { VERCEL: "1" }, { ZENITH_SERVERLESS: "1" }]) {
      const saved = { ...process.env };
      try {
        Object.assign(process.env, { ZENITH_ALERT_WEBHOOK_ALLOW_INSECURE: "1", ...env });
        await expect(resolveWebhookTarget("http://127.0.0.1:9000/x", { resolveAll: async () => ["127.0.0.1"] }), JSON.stringify(env)).rejects.toBeInstanceOf(WebhookPolicyError);
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      }
    }
  });

  it("even the acknowledged development policy never reaches metadata or smuggling ranges", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.ZENITH_HOSTED_MODE; delete process.env.VERCEL; delete process.env.ZENITH_SERVERLESS; delete process.env.ZENITH_STORE;
      process.env.ZENITH_ALERT_WEBHOOK_ALLOW_INSECURE = "1";
      const leaks: string[] = [];
      for (const c of corpus().filter((x) => x.metadata && !x.address.includes("%") && !/169\.254\.170\.2|fe80/.test(`${x.label} ${x.address}`))) {
        const host = c.address.includes(":") ? `[${c.address}]` : c.address;
        if (!(await refuses(() => resolveWebhookTarget(`http://${host}:9000/x`)))) leaks.push(c.label);
      }
      expect(leaks).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("the execution prober resolves once, validates every answer and connects only to the validated literal", async () => {
    const connectedTo: string[] = [];
    const transport: ProbeTransport = async (req) => {
      connectedTo.push(req.ip);
      return { status: 200, latencyMs: 1, bytes: 0, truncated: false, bodyDigest: "0".repeat(64) };
    };
    let call = 0;
    const prober = createSafeProber({ resolve: async () => (call++ === 0 ? [{ address: "93.184.216.34", family: 4 as const }] : [{ address: "10.0.0.5", family: 4 as const }]), transport });
    const allowedHosts = new Set(["app.example.org"]);
    const ok = await prober.probe({ host: "app.example.org", path: "/health", allowedHosts });
    expect(ok.outcome).toBe("responded");
    expect(connectedTo).toEqual(["93.184.216.34"]);
    const flipped = await prober.probe({ host: "app.example.org", path: "/health", allowedHosts });
    expect(flipped.outcome).toBe("refused");
    expect(connectedTo).toEqual(["93.184.216.34"]);
  });

  it("the prober refuses IP literals, uppercase and off-list hosts, and query or traversal paths", async () => {
    const transport: ProbeTransport = async () => { throw new Error("must not connect"); };
    const prober = createSafeProber({ resolve: async () => [{ address: "93.184.216.34", family: 4 as const }], transport });
    const allowedHosts = new Set(["app.example.org", "127.0.0.1"]);
    for (const [host, p] of [["127.0.0.1", "/"], ["APP.example.org", "/"], ["evil.example.org", "/"], ["app.example.org", "/a?x=1"], ["app.example.org", "/a%2e%2e/b"], ["app.example.org", "/a b"], ["app.example.org", "http://evil/"]] as const) {
      const result = await prober.probe({ host, path: p, allowedHosts });
      expect(result.outcome, `${host}${p}`).toBe("refused");
    }
  });
});

/* ------------------------------ outbound inventory ------------------------------ */

type Review = "guarded" | "operator-config" | "relative-or-in-process" | "provider-api" | "fixed-origin" | "dns-query";

/**
 * Every source file that opens an outbound connection, with the reason it is acceptable. The classes mean:
 *   guarded                 destination is tenant-influenced and passes through a destination guard (checked below)
 *   operator-config         destination is set by the deployment operator in environment variables, never by a tenant
 *   relative-or-in-process  browser fetch of the app's own origin, or an in-process server.fetch
 *   provider-api            fixed first-party provider API origin with an operator or connection credential
 *   fixed-origin            tenant supplies only validated path coordinates against a hard-coded GitHub origin; redirects refused or allowlisted
 * A new file in the scan that is not listed here fails this test: the author must classify it, and a tenant-influenced
 * one must call a guard.
 */
const REVIEWED: Record<string, Review> = {
  // Trusted local operator CLI destinations; these are not server-side tenant request inputs.
  "src/cli/plugins/launcher.ts": "operator-config",
  "src/cli/plugins/main.ts": "operator-config",
  "src/lib/ops/recovery/health.ts": "operator-config",
  // Exact configured registry origin, immutable digest paths, no redirects or provider-selected token endpoint.
  "src/lib/providers/kubernetes/build/artifact.ts": "operator-config",
  "src/lib/billing/stripe.ts": "provider-api",
  "src/lib/managed-serving/domains.ts": "dns-query",
  "src/lib/managed-serving/readiness.ts": "operator-config",
  "src/lib/platform/zenith-managed.ts": "operator-config",
  "src/lib/alerts/deliver.ts": "guarded",
  "src/lib/alerts/webhook-policy.ts": "guarded",
  "src/lib/execution/prober.ts": "guarded",
  "src/lib/portability/connect.ts": "guarded",
  "src/lib/portability/net.ts": "guarded",
  "src/lib/portability/engines/mysql-inprocess.ts": "guarded",
  "src/lib/portability/engines/s3.ts": "guarded",
  "src/lib/observability/sources/http.ts": "operator-config",
  "src/lib/ops/telemetry/otlp.ts": "operator-config",
  "src/lib/cost/catalog-fetch.ts": "operator-config",
  "src/lib/db/pg/sync-rest.ts": "operator-config",
  "src/lib/hosted/access/mail.ts": "operator-config",
  "src/lib/providers/localstack/health.ts": "operator-config",
  "src/lib/providers/zenith/neon.ts": "provider-api",
  "src/lib/hosted/runtime/cf-api.ts": "provider-api",
  "src/lib/hosted/runtime/cloudflare.ts": "provider-api",
  "src/lib/hosted/runtime/cloudflare-worker-module.ts": "provider-api",
  "src/lib/client/api.ts": "relative-or-in-process",
  "src/lib/auth/destination.ts": "relative-or-in-process",
  "src/lib/agent-access/control/http.ts": "relative-or-in-process",
  "src/lib/agent-access/v3/server.ts": "relative-or-in-process",
  "src/lib/analysis/github.ts": "fixed-origin",
  "src/lib/platform/source-bundle.ts": "fixed-origin",
  "src/lib/sources/github/app.ts": "fixed-origin",
  "src/lib/sources/github/inspect.ts": "fixed-origin",
  "src/lib/sources/github/runtime.ts": "fixed-origin",
  "src/lib/hosted/data/backend.ts": "provider-api",
  "src/lib/cost/billing/live.ts": "provider-api",
  "src/lib/providers/azure/acr-build.ts": "provider-api",
  "src/lib/providers/azure/credentials.ts": "provider-api",
  "src/lib/providers/azure/release/acr-task.ts": "provider-api",
  "src/lib/providers/gcp/credentials.ts": "provider-api",
};

const PRIMITIVES = [
  /(?<![\w.])fetch\(/, /\.fetch\(/, /\bhttps?\.request\(/, /\bhttps?\.get\(/, /\bnet\.(?:connect|createConnection)\(/, /\btls\.connect\(/,
  /\bhttp2\.connect\(/, /\bnew Resolver\(/, /\bdns\.(?:resolve\w*|lookup)\(/, /\bdnsLookup\(/, /\bcreateTransport\(/, /\bnew WebSocket\(/, /\bnew EventSource\(/,
  /\bdoFetch\(/, /\bfetchImpl\(/, /\?\? fetch\b/, /\bfetch\)\(/, /= fetch;/,
];
const GUARD = /resolveConnectableHost|assertConnectableHost|resolveWebhookTarget|validateWebhookTarget|isPublicAddress|classifyAddress|from "\.\.?\/net"|\.\/webhook-policy/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "components" && name !== "node_modules") walk(full, out); }
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe("outbound inventory: no unreviewed path to the network", () => {
  const root = process.cwd();
  const files = walk(path.join(root, "src")).map((f) => path.relative(root, f).split(path.sep).join("/"));
  const outbound = files.filter((f) => {
    const text = readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    return PRIMITIVES.some((p) => p.test(text));
  });

  it("finds the known primitives (the scan is not vacuous)", () => {
    expect(outbound).toEqual(expect.arrayContaining(["src/lib/alerts/deliver.ts", "src/lib/execution/prober.ts", "src/lib/portability/engines/s3.ts"]));
  });

  it("every file that opens an outbound connection has been reviewed and classified", () => {
    const unreviewed = outbound.filter((f) => !(f in REVIEWED));
    expect(unreviewed, `Unreviewed outbound network path(s): ${unreviewed.join(", ")}. Classify in REVIEWED; a tenant-influenced destination must call a destination guard.`).toEqual([]);
  });

  it("no reviewed entry is stale", () => {
    const stale = Object.keys(REVIEWED).filter((f) => !outbound.includes(f));
    expect(stale).toEqual([]);
  });

  it("every tenant-influenced path names a destination guard in its own source", () => {
    const missing = Object.entries(REVIEWED).filter(([, kind]) => kind === "guarded").map(([f]) => f).filter((f) => !GUARD.test(readFileSync(path.join(root, f), "utf8")));
    expect(missing).toEqual([]);
  });

  it("domain ownership performs bounded TXT queries and never connects to the claimant address", () => {
    const source = readFileSync("src/lib/managed-serving/domains.ts", "utf8");
    expect(source).toContain("resolveTxt");
    expect(source).toContain("new Resolver({ timeout: timeoutMs, tries: 2 })");
    expect(source).toContain("checkCustomHostname");
    expect(source).not.toMatch(/\bfetch\(|\bhttps?\.(?:request|get)\(|\b(?:net|tls)\.connect\(/);
  });

  it("fixed-origin GitHub paths hard-code the origin and never follow a redirect off the allowlist", () => {
    const offenders: string[] = [];
    for (const [f, kind] of Object.entries(REVIEWED)) {
      if (kind !== "fixed-origin") continue;
      const text = readFileSync(path.join(root, f), "utf8");
      if (!/https:\/\/(?:codeload\.|api\.)?github\.com/.test(text) || !/redirect\s*:\s*["'](?:error|manual)["']/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("brokered AWS connections refuse endpoint overrides (STS and tokens never go to a configured host)", () => {
    const text = readFileSync(path.join(root, "src/lib/credentials/aws/broker.ts"), "utf8");
    expect(text).toMatch(/endpoint_not_permitted/);
  });
});
