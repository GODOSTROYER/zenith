/** Local HTTP contracts, not actual Prometheus evidence. */
import { afterEach, describe, expect, it } from "vitest";
import { sourcesForEnvironment } from "@/lib/observability/sources/factory";
import { graph, node, scope, WS } from "../observability/_fixtures";
import { startServer, json, type TestServer } from "../observability/_http";
let server: TestServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
describe("default cost source coverage and tenant selectors", () => {
  it.each(["aws", "gcp", "azure", "oci", "zenith"] as const)("selects only the scoped usage source for %s, including databases and object stores", async provider => {
    server = await startServer((_req, res) => json(res, { status: "success", data: { resultType: "matrix", result: [{ metric: {}, values: [[1, "42"]] }] } }));
    const nodes = [node("service/main", "container_service", provider, { labels: { app: "foreign", zenith_workspace_id: "foreign" } }), node("db/main", "postgres", provider), node("mysql/main", "mysql", provider), node("objects/main", "object_store", provider)];
    const sources = sourcesForEnvironment({ purpose: "cost", provider, graph: graph(nodes), workspaceId: WS, sessions: {}, endpoints: { prometheus: { baseUrl: server.url } } });
    expect(sources.map(s => s.id)).toEqual(["prometheus"]);
    for (const [address, metrics] of [["service/main", ["cpu.utilization", "memory.utilization", "http.requests", "cost.internet_egress.bytes", "cost.inter_component.bytes", "cost.log_ingest.bytes"]], ["db/main", ["cost.db_storage.bytes"]], ["mysql/main", ["cost.db_storage.bytes"]], ["objects/main", ["cost.object_storage.bytes"]]] as const) {
      const result = await sources[0].queryMetrics!({ scope: scope({ addresses: [address] }), range: { from: "1970-01-01T00:00:00Z", to: "1970-01-01T00:01:00Z" }, metrics: [...metrics] }, new AbortController().signal);
      expect(result.items).toHaveLength(metrics.length); expect(result.unavailable).toEqual([]);
      expect(result.items.every(s => s.provider === provider && s.address === address)).toBe(true);
    }
    for (const req of server.requests) {
      const query = req.params.get("query")!;
      expect(query).toContain('zenith_workspace_id="ws-1"'); expect(query).toContain('zenith_environment_id="env-1"');
      expect(query).toContain('zenith_resource_address="'); expect(query).not.toContain("foreign");
      expect(query).toContain("< 90"); expect(query).toContain("== 1");
    }
    const before = server.requests.length;
    const foreign = await sources[0].queryMetrics!({ scope: scope({ workspaceId: "foreign" }), range: { from: "1970-01-01T00:00:00Z" }, metrics: ["cost.db_storage.bytes"] }, new AbortController().signal);
    expect(foreign.items).toEqual([]); expect(server.requests).toHaveLength(before);
  });
  it("reports missing configuration and refuses a usage query without a workspace binding", async () => {
    const g = graph([node("db/main", "postgres", "aws")]);
    const [missing] = sourcesForEnvironment({ purpose: "cost", provider: "aws", graph: g, workspaceId: WS, sessions: {}, endpoints: {} });
    expect(missing.id).toBe("prometheus");
    server = await startServer((_req, res) => json(res, {}));
    const [unbound] = sourcesForEnvironment({ purpose: "cost", provider: "aws", graph: g, sessions: {}, endpoints: { prometheus: { baseUrl: server.url } } });
    const result = await unbound.queryMetrics!({ scope: scope(), range: { from: "1970-01-01T00:00:00Z" }, metrics: ["cost.db_storage.bytes"] }, new AbortController().signal);
    expect(result.unavailable).toHaveLength(1); expect(server.requests).toHaveLength(0);
  });
});
