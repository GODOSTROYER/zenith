/**
 * Non-AWS DNS teardown ownership proof (PROD-LIFE-06). The provider assessors run
 * over the existing modeled REST/runner fixtures; those fixtures are contract
 * shapes, so nothing here proves a live GCP, Azure or OCI deletion.
 */
import { describe, expect, it } from "vitest";
import { assessRecordDeletion as gcpAssess } from "@/lib/providers/gcp/dns-ownership";
import { assessRecordDeletion as azureAssess } from "@/lib/providers/azure/dns-ownership";
import { assessRecordDeletion as ociAssess } from "@/lib/providers/oci/dns-ownership";
import { assertProofsMatchReview, DnsProofMismatch, dnsDisposition, dnsOwnershipSummary, makeProof, proofsDigest, reviewedProofFor, sortProofs, type DnsRecordSetProof } from "@/lib/providers/dns-teardown-proof";
import { azureDnsWorld } from "./azure/dns-ownership-fixtures";
import { gcpDnsWorld } from "./gcp/dns-ownership-fixtures";
import { ociDnsWorld } from "./oci/dns-ownership-fixtures";

const base = { provider: "gcp" as const, address: "dns_record/app.example.com", zone: "example.com", name: "app.example.com", type: "A", disposition: "present" as const, stateMatch: "unrecorded" as const };
const proof = (over: Partial<DnsRecordSetProof> = {}, extra: { values?: string[]; ownership?: string[] } = {}) => makeProof({ ...base, ...over, values: extra.values ?? ["203.0.113.10"], ownership: extra.ownership ?? ["gcp:forwarding_rule_labels"] });

describe("proof construction and binding", () => {
  it("normalizes values and ownership deterministically", () => {
    const a = makeProof({ ...base, values: ["b", "a", "b"], ownership: ["y", "x", "x"] });
    expect(a.values).toEqual(["a", "b", "b"]);
    expect(a.ownership).toEqual(["x", "y"]);
  });

  it("digests the same proofs identically regardless of order and differently when any field changes", () => {
    const one = proof(), two = proof({ address: "dns_record/b.example.com", name: "b.example.com" });
    expect(proofsDigest([one, two])).toBe(proofsDigest([two, one]));
    for (const changed of [proof({}, { values: ["203.0.113.99"] }), proof({ disposition: "absent" }), proof({ stateMatch: "externalRef" }), proof({}, { ownership: ["other"] }), proof({ zone: "example.org" })]) {
      expect(proofsDigest([changed])).not.toBe(proofsDigest([one]));
    }
  });

  it("accepts a fresh proof equal to the reviewed one", () => {
    const summary = dnsOwnershipSummary([proof()]);
    expect(() => assertProofsMatchReview([proof()], summary)).not.toThrow();
  });

  it.each([
    ["a re-pointed value", () => proof({}, { values: ["203.0.113.99"] })],
    ["a different ownership basis", () => proof({}, { ownership: ["something-else"] })],
    ["a newly absent record", () => proof({ disposition: "absent" })],
  ])("refuses %s after approval", (_name, fresh) => {
    expect(() => assertProofsMatchReview([fresh()], dnsOwnershipSummary([proof()]))).toThrow(DnsProofMismatch);
  });

  it("refuses an extra record set that was not reviewed, and a reviewed set that disappeared", () => {
    const extra = proof({ address: "dns_record/c.example.com", name: "c.example.com" });
    expect(() => assertProofsMatchReview([proof(), extra], dnsOwnershipSummary([proof()]))).toThrow(DnsProofMismatch);
    expect(() => assertProofsMatchReview([], dnsOwnershipSummary([proof()]))).toThrow(DnsProofMismatch);
  });

  it.each([
    ["no stored proof", undefined],
    ["a malformed stored proof", { digest: "x", records: [] }],
    ["a stored digest that does not match its records", { digest: "a".repeat(64), records: [proof()] }],
    ["a non-object stored proof", "proof"],
  ])("refuses to tear down against %s", (_name, stored) => {
    expect(() => assertProofsMatchReview([proof()], stored)).toThrow(DnsProofMismatch);
  });

  it("allows no proofs at all when nothing was reviewed and nothing is torn down", () => {
    expect(() => assertProofsMatchReview([], undefined)).not.toThrow();
    expect(dnsOwnershipSummary([])).toBeUndefined();
  });

  it("looks a reviewed proof up by address only from a self-consistent summary", () => {
    const summary = dnsOwnershipSummary([proof()]);
    expect(reviewedProofFor(summary, base.address)?.name).toBe(base.name);
    expect(reviewedProofFor(summary, "dns_record/other")).toBeUndefined();
    expect(reviewedProofFor({ digest: "a".repeat(64), records: [proof()] }, base.address)).toBeUndefined();
    expect(sortProofs([proof({ address: "z" }), proof({ address: "a" })]).map((p) => p.address)).toEqual(["a", "z"]);
  });
});

describe("idempotent delete classification", () => {
  it.each([
    ["present at review, now missing", "present", "missing", false, "deleted"],
    ["absent at review, still missing (re-run)", "absent", "missing", false, "already_absent"],
    ["still present", "present", "present", false, "still_present"],
    ["inaccessible", "present", "inaccessible", false, "unknown"],
    ["unknown", "present", "unknown", false, "unknown"],
    ["simulated missing", "present", "missing", true, "unknown"],
  ] as const)("%s is %s", (_name, was, now, simulated, expected) => {
    expect(dnsDisposition(proof({ disposition: was }), { presence: now, simulated })).toBe(expected);
  });

  it("is unknown when there is no reviewed proof", () => {
    expect(dnsDisposition(undefined, { presence: "missing", simulated: false })).toBe("unknown");
  });
});

describe("assessors produce a bound proof only for an owned, readable record set", () => {
  it("GCP: labels on the primary forwarding rule, value equal to its IP, zone read", async () => {
    const w = gcpDnsWorld();
    const result = await gcpAssess(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(true);
    expect(result.proof).toMatchObject({ provider: "gcp", address: w.node.address, zone: "example.com", name: "app.example.com", type: "A", disposition: "present", values: ["203.0.113.10"], stateMatch: "unrecorded" });
    expect(result.proof?.ownership).toEqual(expect.arrayContaining(["gcp:forwarding_rule_labels", "gcp:value_equals_rule_ip"]));
  });

  it("GCP: a matching recorded provider id is a state match; an absent record gets an absent proof", async () => {
    const w = gcpDnsWorld();
    w.node.externalRef = `projects/${w.ctx.session.projectId}/managedZones/owned-zone/rrsets/app.example.com./A`;
    expect((await gcpAssess(w.ctx, w.node, w.nodes)).proof?.stateMatch).toBe("externalRef");
    w.state.recordStatus = 404;
    const absent = await gcpAssess(w.ctx, w.node, w.nodes);
    expect(absent.proof).toMatchObject({ disposition: "absent", values: [] });
  });

  it("Azure: record and endpoint tags, endpoint value match and the asuid TXT marker", async () => {
    const w = azureDnsWorld();
    const result = await azureAssess(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(true);
    expect(result.proof).toMatchObject({ provider: "azure", zone: "example.com", name: "app.example.com", type: "CNAME", disposition: "present", values: ["owned.azurecontainerapps.io"] });
    expect(result.proof?.ownership).toEqual(expect.arrayContaining(["azure:record_tags", "azure:endpoint_tags", "azure:value_matches_endpoint", "azure:asuid_txt_marker"]));
    expect(JSON.stringify(result.proof)).not.toContain("domain-proof-canary");
  });

  it("Azure: an apex A record set proves its address values; an absent record is an absent proof", async () => {
    const apex = azureDnsWorld(undefined, undefined, true);
    expect((await azureAssess(apex.ctx, apex.node, apex.nodes)).proof).toMatchObject({ type: "A", values: ["203.0.113.10"], name: "example.com" });
    const w = azureDnsWorld();
    w.state.recordStatus = 404;
    expect((await azureAssess(w.ctx, w.node, w.nodes)).proof).toMatchObject({ disposition: "absent", values: [] });
  });

  it("OCI: managed load balancer tags and the rdata inside its addresses", async () => {
    const w = ociDnsWorld();
    const result = await ociAssess(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(true);
    expect(result.proof).toMatchObject({ provider: "oci", zone: "example.com", name: "app.example.com", disposition: "present", values: ["203.0.113.10"] });
    expect(result.proof?.ownership).toEqual(expect.arrayContaining(["oci:load_balancer_tags", "oci:rdata_in_load_balancer_ips"]));
  });

  it("OCI: an empty rrset in a readable zone is an absent proof", async () => {
    const w = ociDnsWorld();
    w.state.records = { items: [] };
    expect((await ociAssess(w.ctx, w.node, w.nodes)).proof).toMatchObject({ disposition: "absent", values: [] });
  });

  it.each([
    ["GCP", async () => { const w = gcpDnsWorld(); w.state.record.rrdatas = ["198.51.100.7"]; return gcpAssess(w.ctx, w.node, w.nodes); }],
    ["GCP unreadable", async () => { const w = gcpDnsWorld(); w.state.recordStatus = 403; return gcpAssess(w.ctx, w.node, w.nodes); }],
    ["Azure foreign TXT marker", async () => { const w = azureDnsWorld(); w.state.txt.properties = { TXTRecords: [{ value: ["foreign"] }] }; return azureAssess(w.ctx, w.node, w.nodes); }],
    ["Azure unreadable", async () => { const w = azureDnsWorld(); w.state.recordStatus = 403; return azureAssess(w.ctx, w.node, w.nodes); }],
    ["OCI foreign", async () => { const w = ociDnsWorld(); w.state.records = { items: [{ domain: "app.example.com", rtype: "A", rdata: "198.51.100.7" }] }; return ociAssess(w.ctx, w.node, w.nodes); }],
    ["OCI unreadable", async () => { const w = ociDnsWorld(); w.state.recordStatus = 403; return ociAssess(w.ctx, w.node, w.nodes); }],
  ])("%s: a foreign or unreadable record set has no proof", async (_name, run) => {
    const result = await run();
    expect(result.safe).toBe(false);
    expect(result.proof).toBeUndefined();
  });
});
