/**
 * SSRF destination policy, differential test (WS-SEC; threat rows: SSRF,
 * metadata-service access, webhook abuse).
 *
 * `src/lib/alerts/webhook-policy.ts` hand-rolls an address classifier (the only
 * egress filter in the codebase today; its own tests in
 * tests/alerts/webhook-policy.test.ts pin a table of literals). A hand-written
 * classifier is exactly where an off-by-one in a prefix length hides, so this
 * file checks it against an INDEPENDENT oracle — `node:net`'s `BlockList`, which
 * is written and tested by somebody else — over boundary addresses of every
 * blocked range and a deterministic sample of the whole IPv4 space, each also
 * wrapped the four ways IPv6 can smuggle an IPv4 destination (mapped, NAT64,
 * 6to4, compatible).
 *
 * The same filter will be reused by the runner's probe kinds and by observability
 * probes (pending hook: tests/security/README.md); a new egress path should run
 * this file's `assertNoEgressBypass` against its own classifier.
 */
import { BlockList } from "node:net";
import { describe, expect, it } from "vitest";
import { injectionsFor } from "../_support/security";

const { addressCategoryForTest, resolveWebhookTarget, WebhookPolicyError } = await import("@/lib/alerts/webhook-policy");

const oracle = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  oracle.addSubnet(net, bits, "ipv4");

const v4 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const hex4 = (a: string) => a.split(".").map(Number).reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
const h = (n: bigint, bits: number) => n.toString(16).padStart(bits / 4, "0");
const pair = (a: string) => {
  const n = hex4(a);
  return `${h(n >> 16n, 16).replace(/^0+(?=.)/, "")}:${h(n & 0xffffn, 16).replace(/^0+(?=.)/, "")}`;
};

/** The IPv6 literals that carry `a` as an IPv4 destination. */
const wrappers = (a: string) => ({
  mapped: `::ffff:${pair(a)}`,
  mappedDotted: `::ffff:${a}`,
  compatible: `::${pair(a)}`,
  nat64: `64:ff9b::${pair(a)}`,
  sixToFour: `2002:${pair(a)}::`,
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 0;
}

/** Boundaries of each blocked range plus a deterministic sweep of the address space. */
function sample(): string[] {
  const out = new Set<string>();
  for (const base of ["0.0.0.0", "10.0.0.0", "100.64.0.0", "127.0.0.0", "169.254.0.0", "172.16.0.0", "192.0.0.0", "192.0.2.0", "192.88.99.0", "192.168.0.0", "198.18.0.0", "198.51.100.0", "203.0.113.0", "224.0.0.0"]) {
    const n = Number(hex4(base));
    for (const d of [-2, -1, 0, 1, 2, 255, 256, 257, 65535, 65536, 65537, 1048575, 1048576]) out.add(v4((n + d) >>> 0));
  }
  out.add("255.255.255.255").add("169.254.169.254").add("100.100.100.200").add("8.8.8.8").add("1.1.1.1").add("93.184.216.34");
  const next = rng(2026);
  for (let i = 0; i < 6000; i++) out.add(v4(next()));
  return [...out];
}

/** The oracle's verdict on one IPv4 address. */
const oracleBlocks = (a: string) => oracle.check(a, "ipv4");

export function assertNoEgressBypass(classify: (address: string) => string | undefined, label: string): void {
  const offenders: string[] = [];
  for (const a of sample()) {
    const blocked = oracleBlocks(a);
    const got = classify(a) !== undefined;
    if (blocked && !got) offenders.push(`BYPASS: ${a} is in a restricted range but ${label} allows it`);
    // the converse is a correctness bug, not a bypass, but a wrongly blocked public address breaks delivery
    if (!blocked && got) offenders.push(`OVER-BLOCK: ${a} is public but ${label} blocks it (${classify(a)})`);
    const w = wrappers(a);
    for (const [kind, literal] of Object.entries(w)) {
      const verdict = classify(literal);
      // a blocked IPv4 must stay blocked however it is wrapped
      if (blocked && verdict === undefined) offenders.push(`BYPASS: ${a} wrapped as ${kind} (${literal}) is allowed by ${label}`);
      // The classifier refuses every IPv4-mapped and every transition-range literal, even around a PUBLIC address: a
      // deliberate over-block (nothing legitimate is addressed that way, and a relay decides where the packet really goes).
      // The property that matters is that none of them is ever allowed.
      if (!blocked && verdict === undefined) offenders.push(`BYPASS: ${kind} literal ${literal} around public ${a} is allowed by ${label}`);
    }
  }
  expect(offenders.slice(0, 20), `${label}: ${offenders.length} disagreement(s) with the independent oracle`).toEqual([]);
}

describe("webhook destination classifier vs an independent oracle", () => {
  it("agrees with node:net BlockList on ~6,100 IPv4 addresses and on every IPv6 wrapping of each", () => {
    assertNoEgressBypass(addressCategoryForTest, "addressCategoryForTest");
  });

  it("blocks the IPv6 ranges a BlockList lists: loopback, unspecified, unique-local, link-local, multicast, documentation, Teredo, instance metadata", () => {
    const v6 = new BlockList();
    for (const [net, bits] of [
      ["::1", 128],
      ["::", 128],
      ["fc00::", 7],
      ["fe80::", 10],
      ["ff00::", 8],
      ["2001:db8::", 32],
      ["2001::", 32],
    ] as const)
      v6.addSubnet(net, bits, "ipv6");
    const probes = ["::1", "::", "fc00::1", "fd00:ec2::254", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::1", "febf::1", "ff02::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:4860:4860::8888", "2606:4700:4700::1111"];
    for (const p of probes) expect(addressCategoryForTest(p) !== undefined, p).toBe(v6.check(p, "ipv6") || p.startsWith("fd00:ec2"));
  });

  it("every corpus URL that names a restricted destination is refused by the full resolver path (public DNS answer injected)", async () => {
    const publicDns = async () => ["93.184.216.34"];
    const refusedOrPublic: string[] = [];
    for (const c of injectionsFor("url")) {
      for (const candidate of c.value.split(/\s+/).filter((s) => /^[a-z]+:\/\//i.test(s))) {
        let host = "";
        try {
          host = new URL(candidate).hostname;
        } catch {
          /* unparsable: must be refused below */
        }
        try {
          await resolveWebhookTarget(candidate, { resolveAll: publicDns, signal: AbortSignal.timeout(5000) });
          // accepted: only a public, https, credential-free, allowed-port URL may be
          const u = new URL(candidate);
          expect(u.protocol, `${c.id}: ${candidate}`).toBe("https:");
          expect(u.username + u.password, `${c.id}: ${candidate}`).toBe("");
          expect(oracleBlocks(host.replace(/^\[|\]$/g, "")), `${c.id}: ${candidate} is an IPv4 literal in a restricted range`).toBe(false);
          refusedOrPublic.push(`accepted: ${candidate}`);
        } catch (e) {
          expect(e, `${c.id}: ${candidate}`).toBeInstanceOf(WebhookPolicyError);
        }
      }
    }
    // the only URL of the corpus that may pass is the open-redirect one: a public https host. Delivery refuses redirects (src/lib/alerts/deliver.ts, tests/alerts/delivery.test.ts "refuses redirects without following them")
    expect(refusedOrPublic).toEqual(["accepted: https://trusted.example/redirect?to=http://169.254.169.254/"]);
  });

  it("a hostname is judged by EVERY address it resolves to: one private answer among public ones refuses it", async () => {
    for (const answers of [["93.184.216.34", "10.0.0.5"], ["10.0.0.5", "93.184.216.34"], ["2606:4700::1111", "fd00:ec2::254"], ["93.184.216.34", "::ffff:169.254.169.254"], ["93.184.216.34", "64:ff9b::a9fe:a9fe"]]) {
      await expect(resolveWebhookTarget("https://rebind.example/hook", { resolveAll: async () => answers }), JSON.stringify(answers)).rejects.toBeInstanceOf(WebhookPolicyError);
    }
  });

  it("only ports 443 and 8443 by default: a public host is not a port scanner", async () => {
    const dns = async () => ["93.184.216.34"];
    for (const port of [22, 25, 80, 6379, 9200, 5432, 10250, 65535]) {
      await expect(resolveWebhookTarget(`https://hooks.example:${port}/x`, { resolveAll: dns }), String(port)).rejects.toBeInstanceOf(WebhookPolicyError);
    }
    for (const ok of ["https://hooks.example/x", "https://hooks.example:443/x", "https://hooks.example:8443/x"]) {
      await expect(resolveWebhookTarget(ok, { resolveAll: dns }), ok).resolves.toMatchObject({ address: "93.184.216.34" });
    }
  });
});
