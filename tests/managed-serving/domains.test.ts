/**
 * PROD-MAN-03 custom-domain ownership proof: hostname rules, the DNS TXT challenge over a REAL local DNS server (the production
 * resolver code over UDP), and the proof/renewal/lapse state machine. No store here (see domain-store.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CHALLENGE_PREFIX, GRACE_MS, PROOF_TTL_MS, RENEWAL_WINDOW_MS,
  challengeRecordName, checkCustomHostname, decideDomainTransition, describeDomain, hashChallengeValue, newChallenge, systemDomainDns, verifyChallenge, type DomainDnsPort,
} from "@/lib/managed-serving/domains";
import { startLocalDns, type LocalDns } from "./_support/dns";

const BASE = "apps.example.com";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

describe("custom hostname rules", () => {
  it.each([
    ["shop.customer.com", "shop.customer.com"],
    ["  Shop.Customer.COM.  ", "shop.customer.com"],
    ["a-b.c1.example.org", "a-b.c1.example.org"],
  ])("accepts %s", (input, host) => {
    expect(checkCustomHostname(input, BASE)).toEqual({ ok: true, hostname: host });
  });

  it.each([
    ["", "invalid_hostname"],
    [42 as unknown as string, "invalid_hostname"],
    ["*.customer.com", "invalid_hostname"],
    ["customer", "invalid_hostname"],
    ["shop.customer.com/path", "invalid_hostname"],
    ["shop.customer.com:8443", "invalid_hostname"],
    ["bad_label.customer.com", "invalid_hostname"],
    ["-bad.customer.com", "invalid_hostname"],
    ["xn--e1afmkfd.customer.com", "invalid_hostname"],
    ["münchen.customer.com", "invalid_hostname"],
    ["10.0.0.1", "invalid_hostname"],
    ["host.localhost", "reserved_hostname"],
    ["db.internal", "reserved_hostname"],
    ["_zenith-challenge.customer.com", "invalid_hostname"],
    [BASE, "managed_suffix"],
    [`web.production.acme.${BASE}`, "managed_suffix"],
    [`WEB.${BASE.toUpperCase()}`, "managed_suffix"],
    ["a".repeat(64) + ".customer.com", "invalid_hostname"],
  ])("refuses %j as %s", (input, code) => {
    const r = checkCustomHostname(input, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("does not treat a lookalike suffix as the platform's domain", () => {
    expect(checkCustomHostname(`web.not${BASE}`, BASE)).toMatchObject({ ok: true });
    expect(checkCustomHostname("web.apps.example.com.evil.net", BASE)).toMatchObject({ ok: true });
  });
});

describe("the challenge", () => {
  it("is random, per claim, and stored only as the hash of the whole TXT value", () => {
    const a = newChallenge("shop.customer.com");
    const b = newChallenge("shop.customer.com");
    expect(a.token).not.toEqual(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
    expect(a.recordName).toBe("_zenith-challenge.shop.customer.com");
    expect(a.recordValue).toBe(`${CHALLENGE_PREFIX}${a.token}`);
    expect(a.hash).toBe(hashChallengeValue(a.recordValue));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify({ hash: a.hash })).not.toContain(a.token);
  });
});

describe("verification against a fake port", () => {
  const dnsOf = (txt: ReturnType<DomainDnsPort["resolveTxt"]> extends Promise<infer T> ? T : never): DomainDnsPort => ({ resolveTxt: async () => txt });
  const c = newChallenge("shop.customer.com");

  it("verifies when one published value matches, among unrelated records", async () => {
    const r = await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "records", records: ["v=spf1 -all", "other", c.recordValue] }));
    expect(r.outcome).toBe("verified");
  });

  it("separates a missing record from a wrong one from a failed lookup", async () => {
    expect((await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "none" }))).outcome).toBe("not_found");
    expect((await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "records", records: [] }))).outcome).toBe("not_found");
    expect((await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "records", records: [newChallenge("shop.customer.com").recordValue] }))).outcome).toBe("mismatch");
    const down = await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "error", code: "ETIMEOUT" }));
    expect(down.outcome).toBe("uncertain");
    expect(down.detail).not.toContain(c.token);
  });

  it("never accepts the token without the prefix, nor the prefix with a different token", async () => {
    expect((await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "records", records: [c.token] }))).outcome).toBe("mismatch");
    expect((await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "records", records: [`${CHALLENGE_PREFIX}${c.token}x`] }))).outcome).toBe("mismatch");
  });

  it("does not echo the published values in its answer", async () => {
    const r = await verifyChallenge("shop.customer.com", c.hash, dnsOf({ status: "records", records: ["secret-looking-value-123"] }));
    expect(JSON.stringify(r)).not.toContain("secret-looking-value-123");
  });
});

describe("verification over real DNS (local UDP server, production resolver)", () => {
  let dns: LocalDns;
  let port: DomainDnsPort;
  beforeAll(async () => {
    dns = await startLocalDns();
    port = systemDomainDns({ servers: [dns.server], timeoutMs: 250 });
  });
  afterAll(async () => { await dns.close(); });
  beforeEach(() => { dns.clear(); });

  it("finds the challenge in a TXT record, including one split into chunks", async () => {
    const c = newChallenge("shop.customer.com");
    const half = Math.floor(c.recordValue.length / 2);
    dns.set(challengeRecordName("shop.customer.com"), { kind: "txt", values: [["unrelated"], [c.recordValue.slice(0, half), c.recordValue.slice(half)]] });
    expect((await verifyChallenge("shop.customer.com", c.hash, port)).outcome).toBe("verified");
    expect(dns.queries).toContain("_zenith-challenge.shop.customer.com");
  });

  it("reports NXDOMAIN and an empty answer as not_found", async () => {
    const c = newChallenge("shop.customer.com");
    expect((await verifyChallenge("shop.customer.com", c.hash, port)).outcome).toBe("not_found");
    dns.set(challengeRecordName("shop.customer.com"), { kind: "nodata" });
    expect((await verifyChallenge("shop.customer.com", c.hash, port)).outcome).toBe("not_found");
  });

  it("reports a wrong value as mismatch, never as verified", async () => {
    const mine = newChallenge("shop.customer.com");
    const theirs = newChallenge("shop.customer.com");
    dns.set(challengeRecordName("shop.customer.com"), { kind: "txt", values: [[theirs.recordValue]] });
    expect((await verifyChallenge("shop.customer.com", mine.hash, port)).outcome).toBe("mismatch");
  });

  it("treats a server failure and a silent server as uncertain (not as a missing record)", async () => {
    const c = newChallenge("shop.customer.com");
    dns.set(challengeRecordName("shop.customer.com"), { kind: "servfail" });
    expect((await verifyChallenge("shop.customer.com", c.hash, port)).outcome).toBe("uncertain");
    dns.set(challengeRecordName("shop.customer.com"), { kind: "drop" });
    expect((await verifyChallenge("shop.customer.com", c.hash, port)).outcome).toBe("uncertain");
  });
});

describe("proof, renewal and lapse", () => {
  const pending = { status: "pending" as const, expiresAt: null, failureCount: 0 };
  const verifiedAt = (expires: Date, failures = 0) => ({ status: "verified" as const, expiresAt: expires, failureCount: failures });

  it("a match proves a pending claim and sets the proof expiry", () => {
    const d = decideDomainTransition(pending, "verified", NOW)!;
    expect(d).toMatchObject({ status: "verified", change: "verified", failureCount: 0 });
    expect(d.expiresAt!.getTime()).toBe(NOW.getTime() + PROOF_TTL_MS);
  });

  it("a pending claim only ever moves by being proven", () => {
    for (const o of ["not_found", "mismatch", "uncertain"] as const) {
      expect(decideDomainTransition(pending, o, NOW)).toMatchObject({ status: "pending", change: "unchanged", failureCount: 1 });
    }
  });

  it("renewal extends the expiry from now and clears failures", () => {
    const d = decideDomainTransition(verifiedAt(at(RENEWAL_WINDOW_MS - 1000), 2), "verified", NOW)!;
    expect(d).toMatchObject({ status: "verified", change: "renewed", failureCount: 0 });
    expect(d.expiresAt!.getTime()).toBe(NOW.getTime() + PROOF_TTL_MS);
  });

  it("a miss keeps serving until the grace period after expiry, then lapses (whatever the reason)", () => {
    const expires = at(-1000);
    for (const o of ["not_found", "mismatch", "uncertain"] as const) {
      expect(decideDomainTransition(verifiedAt(expires), o, NOW)).toMatchObject({ status: "verified" });
      expect(decideDomainTransition(verifiedAt(expires), o, at(GRACE_MS - 2000))).toMatchObject({ status: "verified" });
      const lapsed = decideDomainTransition(verifiedAt(expires), o, at(GRACE_MS + 1))!;
      expect(lapsed).toMatchObject({ status: "lapsed", change: "lapsed" });
      expect(lapsed.lapsedAt).toEqual(at(GRACE_MS + 1));
    }
  });

  it("a miss inside the renewal window is reported as a failing renewal; a miss long before it is not", () => {
    expect(decideDomainTransition(verifiedAt(at(RENEWAL_WINDOW_MS - 10)), "not_found", NOW)!.change).toBe("renewal_failing");
    expect(decideDomainTransition(verifiedAt(at(PROOF_TTL_MS)), "not_found", NOW)!.change).toBe("unchanged");
  });

  it("a lapsed claim can be proven again, a revoked one never moves", () => {
    expect(decideDomainTransition({ status: "lapsed", expiresAt: at(-GRACE_MS * 2), failureCount: 9 }, "verified", NOW)).toMatchObject({ status: "verified", change: "verified", failureCount: 0 });
    expect(decideDomainTransition({ status: "revoked", expiresAt: null, failureCount: 0 }, "verified", NOW)).toBeNull();
  });

  it("describes the claim for a person without storing a derived state", () => {
    expect(describeDomain("pending", null, NOW)).toBe("pending");
    expect(describeDomain("verified", at(PROOF_TTL_MS).toISOString(), NOW)).toBe("serving");
    expect(describeDomain("verified", at(RENEWAL_WINDOW_MS - 1).toISOString(), NOW)).toBe("renewal_due");
    expect(describeDomain("verified", at(-1).toISOString(), NOW)).toBe("in_grace");
    expect(describeDomain("lapsed", null, NOW)).toBe("lapsed");
    expect(describeDomain("revoked", null, NOW)).toBe("revoked");
  });
});
