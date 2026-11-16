/** Mocked ARM ownership contracts; no live Azure verification. */
import { describe, expect, it } from "vitest";
import { assessRecordDeletion } from "@/lib/providers/azure/dns-ownership";
import { azureDnsWorld } from "./dns-ownership-fixtures";

describe("Azure DNS deletion target ownership", () => {
  it.each([[false, false], [true, false], [false, true]])("permits owned endpoints (apex=%s, staticSite=%s)", async (apex, site) => {
    const w = azureDnsWorld(undefined, undefined, apex, site);
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(true);
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it.each(["foreign_cname", "foreign_txt", "mixed_txt", "missing_tags", "foreign_workspace", "foreign_environment", "not_managed", "changed_app_id", "foreign_subscription", "foreign_environment_id", "ambiguous_zone", "duplicate_target", "truncated", "missing_target", "referenced_target", "unsupported_type"])("refuses %s without leaking values", async (fault) => {
    const w = azureDnsWorld(); const canary = "foreign-endpoint-canary";
    if (fault === "foreign_cname") w.state.record.properties = { CNAMERecord: { cname: canary } };
    if (fault === "foreign_txt") w.state.txt.properties = { TXTRecords: [{ value: [canary] }] };
    if (fault === "mixed_txt") w.state.txt.properties = { TXTRecords: [{ value: ["domain-proof-canary"] }, { value: [canary] }] };
    if (fault === "missing_tags") w.state.app.tags = {};
    if (["foreign_workspace", "foreign_environment", "not_managed"].includes(fault)) {
      const tags = w.state.app.tags as Record<string, string>;
      tags[fault === "foreign_workspace" ? "zenith:workspace" : fault === "foreign_environment" ? "zenith:environment" : "zenith:managed"] = "foreign";
    }
    if (fault === "changed_app_id") w.state.app.id = `${w.state.app.id}other`;
    if (fault === "foreign_subscription") w.state.record.id = String(w.state.record.id).replace(w.ctx.session.subscriptionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    if (fault === "foreign_environment_id") (w.state.app.properties as Record<string, unknown>).managedEnvironmentId = canary;
    if (fault === "ambiguous_zone") w.state.zones.push(w.state.zones[0]);
    if (fault === "duplicate_target") w.state.resources.push(w.state.resources[0]);
    if (fault === "truncated") w.state.nextLink = `https://management.azure.com/subscriptions/${w.ctx.session.subscriptionId}/resources`;
    if (fault === "missing_target") w.nodes.splice(1, 1);
    if (fault === "referenced_target") w.nodes[1].ownership = "referenced";
    if (fault === "unsupported_type") w.node.nativeType = "azure:dns_txt_record";
    const result = await assessRecordDeletion(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(false);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain("domain-proof-canary");
    expect(w.ctx.log).not.toHaveBeenCalled();
  });

  it("refuses an apex record containing one foreign IP among owned values", async () => {
    const w = azureDnsWorld(undefined, undefined, true);
    w.state.record.properties = { ARecords: [{ ipv4Address: "203.0.113.10" }, { ipv4Address: "203.0.113.99" }] };
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it.each([401, 403, 429, 500])("fails closed on HTTP %i", async (status) => {
    const w = azureDnsWorld(); w.state.status = status;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it("checks the companion TXT even when the primary record is missing", async () => {
    const w = azureDnsWorld(); w.state.recordStatus = 404;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(true);
    w.state.txt.properties = { TXTRecords: [{ value: ["foreign-canary"] }] };
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    w.state.txtStatus = 404;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(true);
  });

  it("fails closed on malformed responses, aborted reads and thrown payloads", async () => {
    const w = azureDnsWorld();
    w.fetch.mockResolvedValue(new Response("not JSON"));
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    w.fetch.mockRejectedValue(new Error("secret-exception-canary"));
    const result = await assessRecordDeletion(w.ctx, w.node, w.nodes);
    expect(result.safe).toBe(false); expect(JSON.stringify(result)).not.toContain("secret-exception-canary");
    w.ctx.signal = AbortSignal.abort();
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
  });

  it("refuses malformed collection members, incomplete later pages and off-subscription pagination", async () => {
    const w = azureDnsWorld(); w.state.resources.push({ invalid: true });
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    w.state.resources.pop();
    const fetch = w.fetch.getMockImplementation()!;
    w.fetch.mockImplementation(async (url, init) => {
      if (new URL(url).searchParams.has("page")) return new Response(JSON.stringify({ unexpected: [] }));
      return fetch(url, init);
    });
    w.state.nextLink = `https://management.azure.com/subscriptions/${w.ctx.session.subscriptionId}/resources?page=more`;
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    w.state.nextLink = "https://management.azure.com/subscriptions/foreign/resources";
    expect((await assessRecordDeletion(w.ctx, w.node, w.nodes)).safe).toBe(false);
    expect(w.fetch.mock.calls.some(([url]) => url.includes("/subscriptions/foreign/"))).toBe(false);
  });
});
