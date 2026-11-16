import { afterEach, describe, expect, it } from "vitest";
import type { Observation } from "@/lib/resources/types";
import { AZURE_METRIC_TABLE, buildConsoleLogQuery, createAzureLogsSource, createAzureMetricsSource } from "@/lib/providers/azure/observability";
import { kqlDatetime, kqlIdent, kqlInt, kqlString, KqlError } from "@/lib/providers/azure/kql";
import { ENV_ID, fakeArm, fakeEntra, graphOf, sampleGraph, sessionFor, SUB, type ArmRoute, type FakeArm } from "./_helpers";
import { WORKSPACE_GUID, RG } from "./_world";

const open: FakeArm[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const nodes = sampleGraph();
const graph = graphOf(nodes);
const scope = { workspaceId: "ws_1", environmentId: ENV_ID };
const webScope = { ...scope, addresses: ["container_service/web"] };
const range = { from: "2026-09-30T10:00:00Z", to: "2026-09-30T11:00:00Z" };
const never = new AbortController().signal;

const obs = (address: string, externalId: string | undefined, native?: Record<string, unknown>): Observation => ({
  address, externalId, presence: "present", attributes: {}, native, observedAt: "2026-09-30T11:00:00Z", source: "azure.test@1", simulated: false,
});
const ARM = (type: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${RG}/providers/${type}/${name}`;
const observations: Observation[] = [
  obs("container_service/web", ARM("Microsoft.App/containerApps", "zn-k3x9q2-web")),
  obs("log_group/web", ARM("Microsoft.OperationalInsights/workspaces", "logs"), { customerId: WORKSPACE_GUID }),
  obs("postgres/db", ARM("Microsoft.DBforPostgreSQL/flexibleServers", "zn-k3x9q2-db-pg")),
  obs("queue/jobs", ARM("Microsoft.ServiceBus/namespaces", "zn-k3x9q2-jobs-bus")),
];

async function setup(routes: ArmRoute[]) {
  const arm = await fakeArm(routes, fakeEntra());
  open.push(arm);
  return { arm, session: await sessionFor(arm) };
}

describe("KQL parameter rendering", () => {
  it("escapes backslashes and quotes, and refuses control characters, overlong text and non-strings", () => {
    expect(kqlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(kqlString('"; drop table x; //')).toBe('"\\"; drop table x; //"');
    for (const bad of ["a\nb", "a\rb", "a\0b", "a\u001bb", "x".repeat(600)]) expect(() => kqlString(bad)).toThrow(KqlError);
    expect(() => kqlString(5 as never)).toThrow(KqlError);
    expect(kqlInt(5, 1, 10)).toBe("5");
    for (const bad of [0, 11, 1.5, NaN, Infinity]) expect(() => kqlInt(bad, 1, 10)).toThrow(KqlError);
    expect(kqlDatetime(new Date("2026-09-30T12:00:00Z"))).toBe("datetime(2026-09-30T12:00:00.000Z)");
    expect(() => kqlDatetime(new Date("nope"))).toThrow(KqlError);
    expect(kqlIdent("Log_s")).toBe("Log_s");
    for (const bad of ["a b", "a|b", "1a", "a;"]) expect(() => kqlIdent(bad)).toThrow(KqlError);
  });

  it("the console log query is a fixed template; hostile text stays inside one string literal", () => {
    const hostile = 'x" or 1==1 | union (SecretTable) //';
    const q = buildConsoleLogQuery(["app-a", 'app"b'], hostile, 50);
    expect(q).toBe(
      [
        "ContainerAppConsoleLogs_CL",
        '| where ContainerAppName_s in ("app-a", "app\\"b") or ContainerGroupName_s has_any ("app-a", "app\\"b")',
        '| where Log_s contains "x\\" or 1==1 | union (SecretTable) //"',
        "| project TimeGenerated, ContainerAppName_s, ContainerName_s, RevisionName_s, Stream_s, Log_s",
        "| order by TimeGenerated desc",
        "| take 50",
      ].join("\n")
    );
    expect(() => buildConsoleLogQuery([], undefined, 10)).toThrow();
    expect(() => buildConsoleLogQuery(["a\nb"], undefined, 10)).toThrow();
    expect(() => buildConsoleLogQuery(["a"], undefined, 5000)).toThrow();
    expect(buildConsoleLogQuery(["a"], undefined, 10)).not.toContain("Log_s contains");
  });
});

describe("Log Analytics logs source", () => {
  const logBody = (rows: unknown[][]) => ({ tables: [{ name: "PrimaryResult", columns: ["TimeGenerated", "ContainerAppName_s", "ContainerName_s", "RevisionName_s", "Stream_s", "Log_s"].map((name) => ({ name })), rows }] });
  const logRoute = (rows: unknown[][], seen: { body?: string; auth?: string } = {}): ArmRoute => ({
    method: "POST",
    match: `/v1/workspaces/${WORKSPACE_GUID}/query`,
    handler: ({ body, headers }) => ((seen.body = body), (seen.auth = String(headers.authorization)), { status: 200, body: logBody(rows) }),
  });

  it("queries the workspace the observation names, with the Log Analytics token, and the range as the API timespan", async () => {
    const seen: { body?: string; auth?: string } = {};
    const { arm, session } = await setup([logRoute([["2026-09-30T10:30:00Z", "zn-k3x9q2-web", "web", "r1", "stdout", "GET /healthz 200"]], seen)]);
    const source = createAzureLogsSource({ session, graph, observations });
    expect(source.provider).toBe("azure");
    expect(source.supports).toEqual(["log"]);
    expect(source.covers!({ ...scope, addresses: ["container_service/web"] })).toBe(true);
    expect(source.covers!({ workspaceId: "ws_1", environmentId: "env_other" })).toBe(false);
    const r = await source.searchLogs!({ scope: webScope, range, text: 'er"ror', limit: 10 }, never);
    expect(r.sources).toEqual(["azure.log-analytics"]);
    expect(r.unavailable).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ address: "container_service/web", provider: "azure", environmentId: ENV_ID, severity: "unknown", message: "GET /healthz 200", timestamp: "2026-09-30T10:30:00.000Z", attributes: { stream: "stdout", revision: "r1" } });
    const body = JSON.parse(seen.body!);
    expect(body.timespan).toBe("2026-09-30T10:00:00.000Z/2026-09-30T11:00:00.000Z");
    expect(body.query).toContain('Log_s contains "er\\"ror"');
    expect(body.query).toContain('"zn-k3x9q2-web"');
    expect(body.query).toContain("| take 11"); // limit + 1 to detect truncation
    expect(arm.requests[0].authorization).toMatch(/^Bearer entra-access-token-/);
  });

  it("returns the newest matches, marks truncation and scrubs secret-shaped log text", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => [`2026-09-30T10:0${i}:00Z`, "zn-k3x9q2-web", "web", "r1", "stderr", i === 3 ? "connect failed password=hunter2hunter2 Bearer abcdefghijklmnop" : `line ${i}`]);
    const { session } = await setup([logRoute(rows)]);
    const source = createAzureLogsSource({ session, graph, observations });
    const r = await source.searchLogs!({ scope: webScope, range, limit: 3, minSeverity: "error" }, never);
    expect(r.items.map((i) => i.message)).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.items[0].timestamp > r.items[2].timestamp).toBe(true);
    const text = JSON.stringify(r);
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(r.notes).toEqual(["minSeverity was not applied: Container Apps console logs carry no severity."]);
  });

  it("never invents identifiers: a workload without an observation or a workspace is reported unavailable and not queried", async () => {
    const { arm, session } = await setup([logRoute([])]);
    const noObs = createAzureLogsSource({ session, graph, observations: [] });
    const r = await noObs.searchLogs!({ scope: webScope, range }, never);
    expect(r.items).toEqual([]);
    expect(r.unavailable.map((u) => u.reason).join("|")).toMatch(/no observation with an Azure resource id/);
    const noWorkspace = createAzureLogsSource({ session, graph, observations: observations.filter((o) => o.address !== "log_group/web") });
    expect((await noWorkspace.searchLogs!({ scope: webScope, range }, never)).unavailable[0].reason).toMatch(/no observation with a workspace id/);
    // a workspace id that is not a GUID is not trusted either
    const bad = createAzureLogsSource({ session, graph, observations: observations.map((o) => (o.address === "log_group/web" ? { ...o, native: { customerId: "../x" } } : o)) });
    expect((await bad.searchLogs!({ scope: webScope, range }, never)).unavailable).toHaveLength(1);
    expect(arm.requests).toHaveLength(0);
  });

  it("a forbidden, throttled or failing workspace is an unavailable entry, not an exception; a wrong environment returns nothing", async () => {
    for (const [status, reason] of [[403, "access denied"], [429, "throttled (retry after 4s)"], [500, "HTTP 500"]] as const) {
      const { session } = await setup([{ method: "POST", match: () => true, status, headers: status === 429 ? { "retry-after": "4" } : {}, body: { error: { code: "X", message: "m" } } }]);
      const r = await createAzureLogsSource({ session, graph, observations }).searchLogs!({ scope: webScope, range }, never);
      expect(r.items).toEqual([]);
      expect(r.unavailable[0].source).toBe("azure.log-analytics");
      expect(r.unavailable[0].reason).toContain(reason);
    }
    const { session } = await setup([logRoute([])]);
    const other = await createAzureLogsSource({ session, graph, observations }).searchLogs!({ scope: { workspaceId: "ws_1", environmentId: "env_other" }, range }, never);
    expect(other).toMatchObject({ items: [], sources: [], unavailable: [] });
    const badRange = await createAzureLogsSource({ session, graph, observations }).searchLogs!({ scope, range: { from: "not a date" } }, never);
    expect(badRange.unavailable[0].reason).toBe("invalid time range");
  });

  it("only a caller abort rejects", async () => {
    const { session } = await setup([{ method: "POST", match: () => true, body: logBody([]) }]);
    const ac = new AbortController();
    ac.abort(new Error("caller gave up"));
    await expect(createAzureLogsSource({ session, graph, observations }).searchLogs!({ scope: webScope, range }, ac.signal)).rejects.toThrow("caller gave up");
  });
});

describe("Azure Monitor metrics source", () => {
  const metricsRoute = (type: string, name: string, metric: string, data: Record<string, unknown>[], seen: { q?: URLSearchParams }[] = []): ArmRoute => ({
    method: "GET",
    match: `${ARM(type, name)}/providers/Microsoft.Insights/metrics`,
    handler: ({ query }) => (seen.push({ q: query }), { status: 200, body: { value: [{ unit: "Count", name: { value: metric }, timeseries: [{ data }] }] } }),
  });

  it("translates portable metric names through the fixed table and keeps native identity", async () => {
    const seen: { q?: URLSearchParams }[] = [];
    const { session } = await setup([
      metricsRoute("Microsoft.App/containerApps", "zn-k3x9q2-web", "Requests", [{ timeStamp: "2026-09-30T10:00:00Z", total: 12 }, { timeStamp: "2026-09-30T10:05:00Z", total: 30 }, { timeStamp: "2026-09-30T10:10:00Z" }], seen),
      metricsRoute("Microsoft.ServiceBus/namespaces", "zn-k3x9q2-jobs-bus", "ActiveMessages", [{ timeStamp: "2026-09-30T10:00:00Z", maximum: 7 }], seen),
    ]);
    const source = createAzureMetricsSource({ session, graph, observations });
    expect(source.covers!({ ...scope, addresses: ["queue/jobs"] })).toBe(true);
    const r = await source.queryMetrics!({ scope, range, metrics: ["http.requests", "queue.depth", "http.requests"], stepSec: 120 }, never);
    expect(r.unavailable).toEqual([]);
    const byMetric = Object.fromEntries(r.items.map((s) => [s.metric, s]));
    expect(byMetric["http.requests"]).toMatchObject({ unit: "Count", address: "container_service/web", provider: "azure", native: { metric: "Requests", aggregation: "Total", interval: "PT5M", datapoints: 2 } });
    expect(byMetric["http.requests"].points).toEqual([{ timestamp: "2026-09-30T10:00:00.000Z", value: 12 }, { timestamp: "2026-09-30T10:05:00.000Z", value: 30 }]);
    expect(byMetric["queue.depth"].points[0].value).toBe(7);
    const [web, queue] = seen.map((s) => s.q!);
    expect(web.get("metricnames")).toBe("Requests");
    expect(web.get("aggregation")).toBe("Total");
    expect(web.get("timespan")).toBe("2026-09-30T10:00:00.000Z/2026-09-30T11:00:00.000Z");
    expect(web.get("api-version")).toBe("2023-10-01");
    expect(queue.get("$filter")).toBe("EntityName eq 'jobs'");
    // duplicates in the request are queried once
    expect(seen).toHaveLength(2);
  });

  it("reports unknown metrics, missing nodes and missing observations as unavailable with the reason — never a guess", async () => {
    const { arm, session } = await setup([]);
    const r = await createAzureMetricsSource({ session, graph, observations: [] }).queryMetrics!({ scope, range, metrics: ["cpu.nonsense", "db.cpu", "cache.cpu", "x\nbad"] }, never);
    expect(r.items).toEqual([]);
    const reasons = r.unavailable.map((u) => u.reason);
    expect(reasons[0]).toMatch(/not in the Azure metric table/);
    expect(reasons[1]).toMatch(/postgres\/db has no observation with a Microsoft.DBforPostgreSQL\/flexibleServers id/);
    expect(reasons[2]).toMatch(/redis\/cache has no observation/);
    expect(arm.requests).toHaveLength(0);
    // an observation of the wrong type of resource is not used for the metric
    const wrong = createAzureMetricsSource({ session, graph, observations: [obs("postgres/db", ARM("Microsoft.Cache/redis", "x"))] });
    expect((await wrong.queryMetrics!({ scope, range, metrics: ["db.cpu"] }, never)).unavailable[0].reason).toMatch(/no observation with a Microsoft.DBforPostgreSQL/);
  });

  it("a forbidden or throttled series is unavailable; an empty window is an empty series", async () => {
    const { session } = await setup([{ method: "GET", match: () => true, status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } }]);
    const r = await createAzureMetricsSource({ session, graph, observations }).queryMetrics!({ scope, range, metrics: ["db.cpu"] }, never);
    expect(r.unavailable[0].reason).toContain("db.cpu: access denied");
    const empty = await setup([metricsRoute("Microsoft.DBforPostgreSQL/flexibleServers", "zn-k3x9q2-db-pg", "cpu_percent", [])]);
    const e = await createAzureMetricsSource({ session: empty.session, graph, observations }).queryMetrics!({ scope, range, metrics: ["db.cpu"] }, never);
    expect(e.items).toHaveLength(1);
    expect(e.items[0].points).toEqual([]);
    expect(e.items[0].native).toMatchObject({ datapoints: 0 });
  });

  it("the metric table names Azure's own units and covers a small portable set", () => {
    expect(AZURE_METRIC_TABLE.map((m) => m.portable).sort()).toEqual(["cache.cpu", "cpu.usage", "db.connections", "db.cpu", "db.free_storage", "http.requests", "memory.working_set", "queue.depth", "replica.count"]);
    expect(AZURE_METRIC_TABLE.find((m) => m.portable === "cpu.usage")!.unit).toBe("NanoCores");
    expect(new Set(AZURE_METRIC_TABLE.map((m) => m.portable)).size).toBe(AZURE_METRIC_TABLE.length);
  });
});

