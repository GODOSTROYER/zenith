/** Mocked REST ownership contracts; no live GCP verification. */
import { describe, expect, it } from "vitest";
import { assessRecordDeletion } from "@/lib/providers/gcp/dns-ownership";
import { gcpDnsWorld } from "./dns-ownership-fixtures";

describe("Cloud DNS deletion target ownership", () => {
  it("allows every A value owned by the scoped primary forwarding rule", async () => {
    const w = gcpDnsWorld();
    expect(await assessRecordDeletion(w.ctx, w.node, w.nodes)).toMatchObject({ safe: true });
    expect(w.fetch).toHaveBeenCalledTimes(4);
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it.each(["foreign", "mixed", "malformed", "wrong_record", "wrong_project", "missing_tags", "foreign_workspace", "foreign_environment", "not_managed", "duplicate", "truncated_rules", "truncated_zones", "ambiguous_zone", "foreign_id", "referenced_target", "missing_target"])("refuses %s without returning external data", async (fault) => {
    const w = gcpDnsWorld(); const canary = "foreign-target-canary";
    if (fault === "foreign") w.state.record.rrdatas = [canary];
    if (fault === "mixed") w.state.record.rrdatas = ["203.0.113.10", "203.0.113.99"];
    if (fault === "malformed") w.state.record.rrdatas = [null];
    if (fault === "wrong_record") w.state.record.name = "other.example.com.";
    if (fault === "wrong_project") w.state.rule.selfLink = String(w.state.rule.selfLink).replace(w.ctx.session.projectId, "foreign-project");
    if (fault === "missing_tags") w.state.rule.labels = {};
    if (["foreign_workspace", "foreign_environment", "not_managed"].includes(fault)) {
      const labels = w.state.rule.labels as Record<string, string>;
      labels[fault === "foreign_workspace" ? "zenith_workspace" : fault === "foreign_environment" ? "zenith_environment" : "zenith_managed"] = "foreign";
    }
    if (fault === "duplicate") w.state.rules.items = [w.state.rule, w.state.rule];
    if (fault === "truncated_rules") w.state.rules.nextPageToken = "more";
    if (fault === "truncated_zones") w.state.zones.nextPageToken = "more";
    if (fault === "ambiguous_zone") w.state.zones.managedZones = [{ name: "one", dnsName: "example.com." }, { name: "two", dnsName: "example.com." }];
    if (fault === "foreign_id") w.node.externalRef = canary;
    if (fault === "referenced_target") w.nodes[1].ownership = "referenced";
    if (fault === "missing_target") w.nodes.splice(1, 1);
    const result = await assessRecordDeletion(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(false);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])("fails closed on HTTP %i", async (status) => {
    const w = gcpDnsWorld(); w.state.status = status;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it("permits an absent record only after resolving its readable exact zone", async () => {
    const w = gcpDnsWorld(); w.state.recordStatus = 404;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(true);
    w.state.zones = { managedZones: [] };
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it("fails closed on malformed JSON, cancellation and thrown session payloads", async () => {
    const w = gcpDnsWorld();
    w.fetch.mockResolvedValue(new Response("not JSON"));
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    w.fetch.mockRejectedValue(new Error("secret-exception-canary"));
    const result = await assessRecordDeletion(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(false); expect(JSON.stringify(result)).not.toContain("secret-exception-canary");
    w.ctx.signal = AbortSignal.abort();
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it("refuses malformed collection members and malformed later pages", async () => {
    const w = gcpDnsWorld();
    w.state.rules.items = [w.state.rule, null];
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    w.state.rules.items = [w.state.rule];
    const fetch = w.fetch.getMockImplementation()!;
    w.fetch.mockImplementation(async (url, init) => {
      if (url.includes("/forwardingRules?") && url.includes("pageToken=")) return new Response(JSON.stringify({ unexpected: [] }));
      return fetch(url, init);
    });
    w.state.rules.nextPageToken = "more";
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });
});
