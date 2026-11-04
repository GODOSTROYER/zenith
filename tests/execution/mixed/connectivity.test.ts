/**
 * PROD-MIX-05: protected cross-cloud connectivity. Contract level: pure rules over the logical mixed plan fixture
 * (azure database <- gcp web <- aws functions); no network, DNS or TLS is touched. The live probes of a deployed run are
 * tests/live/mixed-connectivity.live.test.ts (gated, deferred).
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTIVITY_FORMAT, assessConnectivity, cidrContains, cidrsOverlap, connectivityDetails, connectivityDigest, dataClassOf, defaultProtectedEndpoints, isPrivateRange, parseCidr, requiredPairs,
  type ConnectivityDeclaration, type ConnectivityProblemCode, type EdgeFacts, type PartitionNetwork,
} from "@/lib/execution/mixed/connectivity";
import { mixedProposalDetails } from "@/lib/execution/mixed/details";
import { assertParentPlanIntegrity, parentProposalInput, proposalMatchesPlan } from "@/lib/execution/mixed/parent-plan";
import { MixedPlanError, type MixedParentPlan } from "@/lib/execution/mixed/types";
import { plan } from "./_fixtures";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

function parts(p: MixedParentPlan) {
  const by = (provider: string) => p.children.find((c) => c.authority.provider === provider)!;
  return { db: by("azure"), web: by("gcp"), fn: by("aws") };
}

function networks(p: MixedParentPlan): PartitionNetwork[] {
  const { db, web, fn } = parts(p);
  return [
    { partitionId: db.partitionId, cidrs: ["10.10.0.0/16"], egress: ["20.20.20.1"] },
    { partitionId: web.partitionId, cidrs: ["10.20.0.0/16"], egress: ["34.1.1.1", "34.1.1.2"] },
    { partitionId: fn.partitionId, cidrs: ["10.30.0.0/16"], egress: ["52.1.1.0/28"] },
  ];
}

function facts(p: MixedParentPlan): EdgeFacts[] {
  const { db, web, fn } = parts(p);
  const common = { serverSpkiSha256: HEX_A, clientCaDigest: HEX_B, clientKeyRef: "vault:ws/env/client-key", clientCertRef: "vault:ws/env/client-cert" };
  return [
    { consumerPartitionId: web.partitionId, producerPartitionId: db.partitionId, host: "db.mixed.example.com", port: 5432, dnsTargets: ["20.20.20.10"], clientCertSubject: "CN=web", ...common },
    { consumerPartitionId: fn.partitionId, producerPartitionId: web.partitionId, host: "web.mixed.example.com", port: 443, dnsTargets: ["34.1.1.10"], clientCertSubject: "CN=functions", ...common },
  ];
}

const base = plan();
const good = (): ConnectivityDeclaration => defaultProtectedEndpoints(base, networks(base), facts(base));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const codes = (d: ConnectivityDeclaration): ConnectivityProblemCode[] => assessConnectivity(base, d).problems.map((p) => p.code);

function mutate(edit: (d: ConnectivityDeclaration & { endpoints: Record<string, unknown>[]; networks: Record<string, unknown>[] }) => void): ConnectivityDeclaration {
  const d = clone(good()) as ConnectivityDeclaration & { endpoints: Record<string, unknown>[]; networks: Record<string, unknown>[] };
  edit(d);
  return d;
}
const dbEndpoint = (d: { endpoints: Record<string, unknown>[] }) => d.endpoints.find((e) => e.dataClass === "database")!;
const serviceEndpoint = (d: { endpoints: Record<string, unknown>[] }) => d.endpoints.find((e) => e.dataClass === "service")!;

describe("cidr arithmetic", () => {
  it.each(["10.0.0.0/8", "192.168.1.0/24", "8.8.8.8", "0.0.0.0/0", "::1", "2001:db8::/32", "::", "fe80::/10"])("parses %s", (text) => {
    expect(parseCidr(text)).toBeDefined();
  });

  it.each(["10.0.0.5/24", "256.1.1.1", "1.2.3", "10.0.0.0/33", "::/129", "abc", "10.0.0.0/", "1.2.3.4/-1", "", "01.2.3.4", "2001:db8:::1"])("refuses %j", (text) => {
    expect(parseCidr(text)).toBeUndefined();
  });

  it("detects overlap and containment within one family only", () => {
    const a = parseCidr("10.0.0.0/16")!; const b = parseCidr("10.0.5.0/24")!; const c = parseCidr("10.1.0.0/16")!; const v6 = parseCidr("::/0")!;
    expect(cidrsOverlap(a, b)).toBe(true);
    expect(cidrsOverlap(a, c)).toBe(false);
    expect(cidrContains(a, b)).toBe(true);
    expect(cidrContains(b, a)).toBe(false);
    expect(cidrsOverlap(a, v6)).toBe(false);
  });

  it("knows the private and shared ranges", () => {
    for (const text of ["10.1.2.3", "172.16.5.0/24", "172.31.255.255", "192.168.0.0/16", "100.64.1.1", "169.254.169.254", "127.0.0.1", "fc00::1", "fd12:3456::/32", "fe80::1", "::1"]) expect(isPrivateRange(parseCidr(text)!), text).toBe(true);
    for (const text of ["8.8.8.8", "34.1.1.1", "172.32.0.1", "2001:4860::/32", "11.0.0.0/8"]) expect(isPrivateRange(parseCidr(text)!), text).toBe(false);
  });
});

describe("the protected-endpoint default", () => {
  it("builds one mutual-TLS endpoint per cross-partition dependency, allowlisted to the consumer's egress", () => {
    const d = good();
    expect(d.format).toBe(CONNECTIVITY_FORMAT);
    expect(d.endpoints).toHaveLength(2);
    expect(d.vpn).toBeUndefined();
    const { db, web, fn } = parts(base);
    const dbEp = d.endpoints.find((e) => e.producerPartitionId === db.partitionId)!;
    expect(dbEp).toMatchObject({ consumerPartitionId: web.partitionId, dataClass: "database", mode: "protected_endpoint", allowlist: ["34.1.1.1", "34.1.1.2"] });
    expect(dbEp.tls).toMatchObject({ clientAuth: "required", minVersion: "1.3", serverSpkiSha256: HEX_A });
    expect(dbEp.identity.consumerConnectionIdentityDigest).toBe(web.authority.connectionIdentityDigest);
    expect(d.endpoints.find((e) => e.producerPartitionId === web.partitionId)!.identity.consumerConnectionIdentityDigest).toBe(fn.authority.connectionIdentityDigest);
  });

  it("is accepted, covers every dependency of the plan and has a stable digest", () => {
    const d = good();
    const a = assessConnectivity(base, d);
    expect(a.problems).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.paths.map((p) => p.via)).toEqual(["protected_endpoint", "protected_endpoint"]);
    expect(requiredPairs(base)).toHaveLength(2);
    expect(a.digest).toBe(connectivityDigest(good()));
    expect(connectivityDigest(mutate((x) => { (x.endpoints[0]!.dns as { ttlMaxSeconds: number }).ttlMaxSeconds = 60; }))).not.toBe(a.digest);
  });

  it("infers the data class from what the producer holds", () => {
    const { db, web, fn } = parts(base);
    expect(dataClassOf(db)).toBe("database");
    expect(dataClassOf(web)).toBe("service");
    expect(dataClassOf(fn)).toBe("function");
  });
});

describe("a database is never silently public", () => {
  it("admits single hosts only and refuses a range, the whole internet, a private range and an address outside the consumer's egress", () => {
    expect(codes(mutate((d) => { dbEndpoint(d).allowlist = ["34.1.1.0/24"]; }))).toContain("database_public");
    expect(codes(mutate((d) => { dbEndpoint(d).allowlist = ["0.0.0.0/0"]; }))).toContain("allowlist_wildcard");
    expect(codes(mutate((d) => { dbEndpoint(d).allowlist = ["::/0"]; }))).toContain("allowlist_wildcard");
    expect(codes(mutate((d) => { dbEndpoint(d).allowlist = ["10.0.0.1"]; }))).toContain("allowlist_private");
    expect(codes(mutate((d) => { dbEndpoint(d).allowlist = ["34.9.9.9"]; }))).toContain("allowlist_outside_egress");
    expect(codes(mutate((d) => { dbEndpoint(d).allowlist = []; }))).toContain("allowlist_empty");
    expect(codes(mutate((d) => { dbEndpoint(d).allowlist = ["not-an-address"]; }))).toContain("cidr_invalid");
  });

  it("requires mutual TLS, a modern protocol, a pinned server key and a client CA", () => {
    expect(codes(mutate((d) => { (dbEndpoint(d).tls as Record<string, unknown>).clientAuth = "optional"; }))).toContain("mtls_not_required");
    expect(codes(mutate((d) => { (dbEndpoint(d).tls as Record<string, unknown>).minVersion = "1.0"; }))).toContain("tls_version");
    expect(codes(mutate((d) => { (dbEndpoint(d).tls as Record<string, unknown>).serverNames = ["other.example.com"]; }))).toContain("tls_name_mismatch");
    expect(codes(mutate((d) => { (dbEndpoint(d).tls as Record<string, unknown>).serverNames = ["*.example.com", "db.mixed.example.com"]; }))).toContain("tls_wildcard");
    expect(codes(mutate((d) => { (dbEndpoint(d).tls as Record<string, unknown>).serverSpkiSha256 = "xyz"; }))).toContain("tls_pin_missing");
    expect(codes(mutate((d) => { (dbEndpoint(d).tls as Record<string, unknown>).clientCaDigest = ""; }))).toContain("client_ca_missing");
  });

  it("a service endpoint may use a small range but not a broad one", () => {
    expect(codes(mutate((d) => { serviceEndpoint(d).allowlist = ["52.1.1.0/28"]; }))).toEqual([]);
    expect(codes(mutate((d) => { serviceEndpoint(d).allowlist = ["52.0.0.0/16"]; }))).toContain("allowlist_too_broad");
  });
});

describe("dns, identity and secret bindings", () => {
  it("binds the name, its targets and its time to live", () => {
    expect(codes(mutate((d) => { const e = dbEndpoint(d); e.host = "10.1.1.1"; (e.dns as Record<string, unknown>).name = "10.1.1.1"; }))).toContain("dns_invalid");
    expect(codes(mutate((d) => { const e = dbEndpoint(d); e.host = "*.example.com"; (e.dns as Record<string, unknown>).name = "*.example.com"; }))).toContain("dns_invalid");
    expect(codes(mutate((d) => { (dbEndpoint(d).dns as Record<string, unknown>).name = "other.example.com"; }))).toContain("dns_invalid");
    expect(codes(mutate((d) => { (dbEndpoint(d).dns as Record<string, unknown>).expectedTargets = []; }))).toContain("dns_invalid");
    expect(codes(mutate((d) => { (dbEndpoint(d).dns as Record<string, unknown>).expectedTargets = ["10.9.9.9"]; }))).toContain("dns_target_private");
    expect(codes(mutate((d) => { (dbEndpoint(d).dns as Record<string, unknown>).ttlMaxSeconds = 86_400; }))).toContain("dns_ttl");
    expect(codes(mutate((d) => { dbEndpoint(d).port = 0; }))).toContain("port_invalid");
  });

  it("binds the client identity to the consumer's connection", () => {
    expect(codes(mutate((d) => { (dbEndpoint(d).identity as Record<string, unknown>).consumerConnectionIdentityDigest = HEX_B; }))).toContain("identity_mismatch");
    expect(codes(mutate((d) => { (dbEndpoint(d).identity as Record<string, unknown>).clientCertSubject = "  "; }))).toContain("identity_mismatch");
  });

  it("holds secrets as vault references only and never as key material", () => {
    expect(codes(mutate((d) => { (dbEndpoint(d).secrets as Record<string, unknown>).clientKeyRef = "plain-text"; }))).toContain("secret_not_reference");
    const inline = codes(mutate((d) => { (dbEndpoint(d).secrets as Record<string, unknown>).clientKeyRef = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"; }));
    expect(inline).toContain("inline_secret");
    expect(inline).toContain("secret_not_reference");
    expect(JSON.stringify(assessConnectivity(base, mutate((d) => { (dbEndpoint(d).secrets as Record<string, unknown>).clientKeyRef = "-----BEGIN PRIVATE KEY-----"; })).problems)).not.toContain("BEGIN PRIVATE");
  });
});

describe("coverage and structure", () => {
  it("refuses a dependency no endpoint or opted-in VPN covers, naming the pair", () => {
    const missing = assessConnectivity(base, mutate((d) => { d.endpoints.pop(); }));
    expect(missing.problems.map((p) => p.code)).toEqual(["missing_connectivity"]);
    expect(assessConnectivity(base, { format: CONNECTIVITY_FORMAT, networks: [], endpoints: [] }).problems.filter((p) => p.code === "missing_connectivity")).toHaveLength(2);
  });

  it("refuses unknown partitions, duplicates and a wrong format", () => {
    expect(codes(mutate((d) => { dbEndpoint(d).producerPartitionId = "nope"; }))).toContain("unknown_partition");
    expect(codes(mutate((d) => { dbEndpoint(d).consumerPartitionId = dbEndpoint(d).producerPartitionId; }))).toContain("unknown_partition");
    expect(codes(mutate((d) => { d.endpoints[1]!.id = d.endpoints[0]!.id; }))).toContain("duplicate_id");
    expect(codes(mutate((d) => { d.networks.push({ ...d.networks[0]! }); }))).toContain("duplicate_id");
    expect(codes(mutate((d) => { d.networks.push({ partitionId: "ghost", cidrs: [], egress: [] }); }))).toContain("unknown_partition");
    expect(assessConnectivity(base, { ...good(), format: "other" as typeof CONNECTIVITY_FORMAT }).problems.map((p) => p.code)).toEqual(["format"]);
  });

  it("refuses a network with ambiguous CIDRs, private or wildcard egress, or no egress at all", () => {
    expect(codes(mutate((d) => { (d.networks[0]!.cidrs as string[]).push("10.0.0.5/24"); }))).toContain("cidr_invalid");
    expect(codes(mutate((d) => { (d.networks[1]!.egress as string[]).push("192.168.0.1"); }))).toContain("allowlist_private");
    expect(codes(mutate((d) => { (d.networks[1]!.egress as string[]).push("0.0.0.0/0"); }))).toContain("allowlist_wildcard");
    expect(codes(mutate((d) => { d.networks[1]!.egress = []; }))).toContain("no_egress_declared");
  });

  it("notes overlapping private space between partitions as tolerated only when no VPN would route it", () => {
    const d = mutate((x) => { x.networks[0]!.cidrs = ["10.20.0.0/16"]; });
    const a = assessConnectivity(base, d);
    expect(a.ok).toBe(true);
    expect(a.overlapsTolerated).toHaveLength(1);
  });
});

describe("the VPN module is opt-in", () => {
  const vpn = (p: MixedParentPlan, over: Record<string, unknown> = {}) => {
    const { db, web } = parts(p);
    return { optIn: true, links: [{ id: "vpn-web-db", producerPartitionId: db.partitionId, consumerPartitionId: web.partitionId, kind: "wireguard" as const, producerCidr: "10.10.0.0/24", consumerCidr: "10.20.0.0/24", keyRef: "vault:ws/env/vpn-key", ...over }] };
  };

  it("is never inferred: links without an explicit opt-in are refused", () => {
    expect(codes({ ...good(), vpn: { ...vpn(base), optIn: false } })).toContain("vpn_not_opted_in");
  });

  it("covers a dependency when opted in with disjoint networks and a vaulted key", () => {
    const d = mutate((x) => { x.endpoints.splice(x.endpoints.findIndex((e) => e.dataClass === "database"), 1); });
    const withVpn: ConnectivityDeclaration = { ...d, vpn: vpn(base) };
    const a = assessConnectivity(base, withVpn);
    expect(a.problems).toEqual([]);
    expect(a.paths.some((p) => p.via === "vpn")).toBe(true);
  });

  it("refuses overlapping address space, unknown partitions, links outside the declared network and a key that is not a reference", () => {
    const overlapping = mutate((x) => { x.networks[0]!.cidrs = ["10.20.0.0/16"]; });
    expect(codes({ ...overlapping, vpn: vpn(base, { producerCidr: "10.20.0.0/24", consumerCidr: "10.20.0.0/24" }) })).toEqual(expect.arrayContaining(["cidr_overlap", "vpn_overlap"]));
    expect(codes({ ...good(), vpn: vpn(base, { producerPartitionId: "nope" }) })).toContain("vpn_unknown_partition");
    expect(codes({ ...good(), vpn: vpn(base, { producerCidr: "172.16.0.0/24" }) })).toContain("cidr_invalid");
    expect(codes({ ...good(), vpn: vpn(base, { keyRef: "psk-in-the-open" }) })).toContain("vpn_key_not_reference");
  });
});

describe("binding the declaration into the plan and its approval", () => {
  it("stores the assessed declaration, binds its digest into the plan id and the approved proposal input", () => {
    const plain = plan();
    const declared = plan({ connectivity: good() });
    expect(plain.connectivity).toBeUndefined();
    expect(parentProposalInput(plain)).not.toHaveProperty("connectivityDigest");
    expect(declared.connectivity!.digest).toBe(connectivityDigest(good()));
    expect(declared.parentPlanId).not.toBe(plain.parentPlanId);
    expect(declared.parentDigest).toBe(plain.parentDigest);
    expect(parentProposalInput(declared)).toMatchObject({ connectivityDigest: declared.connectivity!.digest });
    expect(proposalMatchesPlan(parentProposalInput(declared), declared)).toBe(true);
    expect(proposalMatchesPlan(parentProposalInput(plain), declared)).toBe(false);
    expect(() => assertParentPlanIntegrity(declared)).not.toThrow();
    expect(plan({ connectivity: good() }).parentPlanId).toBe(declared.parentPlanId);
  });

  it("changes the plan id when any endpoint changes, so the approval cannot be reused", () => {
    const other = mutate((d) => { (dbEndpoint(d).dns as { ttlMaxSeconds: number }).ttlMaxSeconds = 120; });
    expect(plan({ connectivity: other }).parentPlanId).not.toBe(plan({ connectivity: good() }).parentPlanId);
  });

  it("refuses to build a plan from an unsafe declaration and names the code only", () => {
    try {
      plan({ connectivity: mutate((d) => { dbEndpoint(d).allowlist = ["0.0.0.0/0"]; }) });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MixedPlanError);
      expect((error as MixedPlanError).code).toBe("plan_refused");
      expect((error as MixedPlanError).detail).toMatchObject({ code: "allowlist_wildcard" });
    }
  });

  it("re-checks the stored declaration on every integrity check", () => {
    const declared = clone(plan({ connectivity: good() })) as { connectivity: { declaration: { endpoints: { allowlist: string[] }[] } } } & MixedParentPlan;
    declared.connectivity.declaration.endpoints[0]!.allowlist = ["34.1.1.1", "34.1.1.2", "34.1.1.3"];
    expect(() => assertParentPlanIntegrity(declared)).toThrow(/does not match its digest/);
    const forged = clone(plan({ connectivity: good() })) as MixedParentPlan & { connectivity: { digest: string } };
    forged.connectivity.digest = HEX_B;
    expect(() => assertParentPlanIntegrity(forged)).toThrow();
  });

  it("shows the approver what approving the declaration approves", () => {
    const declared = plan({ connectivity: good() });
    const lines = mixedProposalDetails(parentProposalInput(declared));
    expect(lines.join("\n")).toContain("cross-cloud connectivity");
    expect(mixedProposalDetails(parentProposalInput(plan())).join("\n")).not.toContain("cross-cloud connectivity");
    const detail = connectivityDetails(good(), connectivityDigest(good())).join("\n");
    expect(detail).toContain("mutual TLS");
    expect(detail).toContain("no VPN");
    expect(detail).toContain("34.1.1.1");
    expect(connectivityDetails({ ...good(), vpn: vpn2() }, "d".repeat(64)).join("\n")).toContain("VPN vpn-1");
  });
});

function vpn2() {
  const { db, web } = parts(base);
  return { optIn: true, links: [{ id: "vpn-1", producerPartitionId: db.partitionId, consumerPartitionId: web.partitionId, kind: "ipsec" as const, producerCidr: "10.10.0.0/24", consumerCidr: "10.20.0.0/24", keyRef: "vault:ws/env/k" }] };
}
