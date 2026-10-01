/** Mocked runner/OCI contracts; neither a Go runner nor a live tenancy is used. */
import { describe, expect, it } from "vitest";
import { assessRecordDeletion } from "@/lib/providers/oci/dns-ownership";
import { isAllowed, OCI_ALLOWLIST } from "@/lib/providers/oci/allowlist";
import { ociDnsWorld } from "./dns-ownership-fixtures";

describe("OCI DNS deletion target ownership", () => {
  it.each(["infrastructure.plan", "infrastructure.apply", "deployment.deploy", "deployment.rollback"])("reads owned targets through serialized runner requests under %s", async (capability) => {
    const w = ociDnsWorld(undefined, undefined, capability);
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(true);
    expect(w.jobs).toHaveLength(4);
    for (const job of w.jobs) {
      expect(job.method).toBe("GET");
      expect(job.bodyB64).toBeUndefined();
      expect(job.headers).toEqual({});
      expect(isAllowed(capability, job)).toBe(true);
    }
    // DNS ownership reads stay read-only; deployment.deploy separately holds the migration-launch write (WS-RELEASE-OCI).
    expect(OCI_ALLOWLIST[capability].filter((r) => r.service === "dns" || r.service === "loadbalancer").every((r) => r.method === "GET")).toBe(true);
    expect(isAllowed(capability, { service: "loadbalancer", method: "POST", path: "/20170115/loadBalancers" })).toBe(false);
    expect(isAllowed(capability, { service: "vault", method: "GET", path: "/20190301/secrets/foreign" })).toBe(false);
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it.each(["foreign", "mixed", "malformed", "malformed_lb", "wrong_record", "missing_tags", "foreign_workspace", "foreign_environment", "not_managed", "foreign_compartment", "foreign_zone", "changed_id", "private_lb", "inactive_lb", "duplicate", "truncated_records", "truncated_lbs", "referenced_target", "missing_target", "foreign_session", "foreign_external_id"])("refuses %s without leaking cloud values", async (fault) => {
    const w = ociDnsWorld(); const canary = "foreign-target-canary";
    if (fault === "foreign") w.state.records = { items: [{ domain: "app.example.com", rtype: "A", rdata: canary }] };
    if (fault === "mixed") w.state.records = { items: ["203.0.113.10", "203.0.113.99"].map((rdata) => ({ domain: "app.example.com", rtype: "A", rdata })) };
    if (fault === "malformed") w.state.records = { unexpected: [] };
    if (fault === "malformed_lb") w.state.lbs = [w.state.lb, {}];
    if (fault === "wrong_record") w.state.records = { items: [{ domain: "other.example.com", rtype: "A", rdata: "203.0.113.10" }] };
    if (fault === "missing_tags") w.state.lb.freeformTags = {};
    if (["foreign_workspace", "foreign_environment", "not_managed"].includes(fault)) {
      const tags = w.state.lb.freeformTags as Record<string, string>;
      tags[fault === "foreign_workspace" ? "zenith_workspace" : fault === "foreign_environment" ? "zenith_environment" : "zenith_managed"] = "foreign";
    }
    if (fault === "foreign_compartment") w.state.lb.compartmentId = "ocid1.compartment.oc1..foreign";
    if (fault === "foreign_zone") w.state.zone.compartmentId = "ocid1.compartment.oc1..foreign";
    if (fault === "changed_id") w.state.lb.id = "ocid1.loadbalancer.oc1.iad.foreign";
    if (fault === "private_lb") w.state.lb.isPrivate = true;
    if (fault === "inactive_lb") w.state.lb.lifecycleState = "DELETED";
    if (fault === "duplicate") w.state.lbs = [w.state.lb, w.state.lb];
    if (fault === "truncated_records") w.state.recordPage = "more";
    if (fault === "truncated_lbs") w.state.lbPage = "more";
    if (fault === "referenced_target") w.nodes[1].ownership = "referenced";
    if (fault === "missing_target") w.nodes.splice(1, 1);
    if (fault === "foreign_session") w.ctx.environmentId = "foreign-env";
    if (fault === "foreign_external_id") w.node.externalRef = canary;
    const result = await assessRecordDeletion(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(false); expect(JSON.stringify(result)).not.toContain(canary);
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 429, 500])("fails closed on unreadable zone HTTP %i", async (status) => {
    const w = ociDnsWorld(); w.state.zoneStatus = status;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it("requires a complete empty rrset for absence, and refuses ambiguous 404s", async () => {
    const w = ociDnsWorld(); w.state.records = { items: [] };
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(true);
    w.state.recordStatus = 404;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it("checks later pages rather than approving the first owned value", async () => {
    const w = ociDnsWorld(); w.state.recordPage = "more";
    w.dispatch.mockImplementation(async (job) => {
      w.jobs.push(job);
      const page = job.query.some(([key]) => key === "page");
      const body = job.path.includes("/records/") ? { items: [{ domain: "app.example.com", rtype: "A", rdata: page ? "203.0.113.99" : "203.0.113.10" }] } : w.state.zone;
      const headers: Record<string, string> = job.path.includes("/records/") && !page ? { "opc-next-page": "more" } : {};
      return { status: 200, headers, bodyB64: Buffer.from(JSON.stringify(body)).toString("base64") };
    });
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    expect(w.jobs.filter((j) => j.path.includes("/records/"))).toHaveLength(2);
  });

  it("fails closed on runner refusals, aborts, and secret-bearing transport errors", async () => {
    const w = ociDnsWorld(undefined, undefined, "unknown.capability");
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    expect(w.dispatch).not.toHaveBeenCalled();
    const owned = ociDnsWorld(); owned.dispatch.mockRejectedValue(new Error("secret-transport-canary"));
    const result = await assessRecordDeletion(owned.ctx, owned.node, owned.nodes);
    expect(result.safe).toBe(false); expect(JSON.stringify(result)).not.toContain("secret-transport-canary");
    owned.ctx.signal = AbortSignal.abort();
    expect((await assessRecordDeletion(owned.ctx, owned.node, owned.nodes)).safe).toBe(false);
  });
});
