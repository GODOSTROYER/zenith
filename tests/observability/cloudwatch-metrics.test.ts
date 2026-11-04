import { CloudWatchClient, GetMetricDataCommand, type MetricDataResult } from "@aws-sdk/client-cloudwatch";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { AWS_METRIC_TABLE, CLOUDWATCH_METRICS_SOURCE_ID, createCloudWatchMetricsSource } from "@/lib/observability/sources/aws-cloudwatch-metrics";
import type { MetricQuery } from "@/lib/observability/types";
import { ARN, CANARY, ENV, fakeAwsSession, graph, node, scope } from "./_fixtures";

const cw = mockClient(CloudWatchClient);
beforeEach(() => cw.reset());

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const range = (minutes = 60) => ({ from: new Date(NOW - minutes * 60_000).toISOString(), to: new Date(NOW).toISOString() });
const signal = () => new AbortController().signal;
const mq = (metrics: string[], over: Partial<MetricQuery> = {}): MetricQuery => ({ scope: scope(), range: range(), metrics, stepSec: 60, ...over });

const nodes = [
  node("service/web", "container_service", "aws", { externalRef: ARN.ecsService("prod", "web-svc") }),
  node("load_balancer/main", "load_balancer", "aws", { externalRef: ARN.alb(), spec: { targetGroupArns: [ARN.tg()] } }),
  node("resource/db", "postgres", "aws", { externalRef: ARN.rds("orders-db") }),
  node("resource/cache", "redis", "aws", { externalRef: ARN.cache("cache-001") }),
  node("resource/jobs", "queue", "aws", { externalRef: ARN.sqs("jobs") }),
];

const source = (over: Partial<Parameters<typeof createCloudWatchMetricsSource>[0]> = {}) => createCloudWatchMetricsSource({ session: fakeAwsSession(), graph: graph(nodes), ...over });

const okResult = (id: string, values: number[] = [1, 2, 3], over: Partial<MetricDataResult> = {}): MetricDataResult => ({
  Id: id,
  Label: id,
  StatusCode: "Complete",
  Timestamps: values.map((_, i) => new Date(NOW - (values.length - i) * 60_000)),
  Values: values,
  ...over,
});

/** Answers every requested query id with three points. */
function answerAll(values = [1, 2, 3]) {
  cw.on(GetMetricDataCommand).callsFake((input: { MetricDataQueries: { Id: string }[] }) => Promise.resolve({ MetricDataResults: input.MetricDataQueries.map((q) => okResult(q.Id, values)) }));
}

const queryOf = (call = 0) => cw.commandCalls(GetMetricDataCommand)[call].args[0].input;

describe("portable metric table", () => {
  const expectations: Record<string, { namespace: string; metricName: string; stat: string; dims: string[]; address: string; unit: string }> = {
    "cpu.utilization": { namespace: "AWS/ECS", metricName: "CPUUtilization", stat: "Average", dims: ["ClusterName", "ServiceName"], address: "service/web", unit: "Percent" },
    "memory.utilization": { namespace: "AWS/ECS", metricName: "MemoryUtilization", stat: "Average", dims: ["ClusterName", "ServiceName"], address: "service/web", unit: "Percent" },
    "http.requests": { namespace: "AWS/ApplicationELB", metricName: "RequestCount", stat: "Sum", dims: ["LoadBalancer"], address: "load_balancer/main", unit: "Count" },
    "http.5xx.count": { namespace: "AWS/ApplicationELB", metricName: "HTTPCode_Target_5XX_Count", stat: "Sum", dims: ["LoadBalancer"], address: "load_balancer/main", unit: "Count" },
    "http.target_response_time": { namespace: "AWS/ApplicationELB", metricName: "TargetResponseTime", stat: "Average", dims: ["LoadBalancer"], address: "load_balancer/main", unit: "Seconds" },
    "lb.unhealthy_hosts": { namespace: "AWS/ApplicationELB", metricName: "UnHealthyHostCount", stat: "Maximum", dims: ["LoadBalancer", "TargetGroup"], address: "load_balancer/main", unit: "Count" },
    "db.cpu": { namespace: "AWS/RDS", metricName: "CPUUtilization", stat: "Average", dims: ["DBInstanceIdentifier"], address: "resource/db", unit: "Percent" },
    "db.connections": { namespace: "AWS/RDS", metricName: "DatabaseConnections", stat: "Average", dims: ["DBInstanceIdentifier"], address: "resource/db", unit: "Count" },
    "db.free_storage": { namespace: "AWS/RDS", metricName: "FreeStorageSpace", stat: "Minimum", dims: ["DBInstanceIdentifier"], address: "resource/db", unit: "Bytes" },
    "cache.cpu": { namespace: "AWS/ElastiCache", metricName: "CPUUtilization", stat: "Average", dims: ["CacheClusterId"], address: "resource/cache", unit: "Percent" },
    "queue.depth": { namespace: "AWS/SQS", metricName: "ApproximateNumberOfMessagesVisible", stat: "Maximum", dims: ["QueueName"], address: "resource/jobs", unit: "Count" },
  };

  it("covers exactly the documented portable metrics", () => {
    expect(AWS_METRIC_TABLE.map((d) => d.portable).sort()).toEqual(Object.keys(expectations).sort());
  });

  it.each(Object.entries(expectations))("%s maps to the right namespace, metric, statistic and dimensions", async (portable, want) => {
    answerAll();
    const r = await source().queryMetrics!(mq([portable]), signal());
    const queries = queryOf().MetricDataQueries!;
    expect(queries).toHaveLength(1);
    const stat = queries[0].MetricStat!;
    expect(stat.Metric!.Namespace).toBe(want.namespace);
    expect(stat.Metric!.MetricName).toBe(want.metricName);
    expect(stat.Stat).toBe(want.stat);
    expect(stat.Metric!.Dimensions!.map((d) => d.Name)).toEqual(want.dims);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ metric: portable, unit: want.unit, address: want.address, provider: "aws" });
    expect(r.items[0].native).toMatchObject({ namespace: want.namespace, metricName: want.metricName, stat: want.stat });
  });

  it("derives dimension VALUES from ARNs", async () => {
    answerAll();
    await source().queryMetrics!(mq(["cpu.utilization", "lb.unhealthy_hosts", "db.cpu", "cache.cpu", "queue.depth"]), signal());
    const byMetric = new Map(queryOf().MetricDataQueries!.map((q) => [`${q.MetricStat!.Metric!.Namespace}/${q.MetricStat!.Metric!.MetricName}`, Object.fromEntries(q.MetricStat!.Metric!.Dimensions!.map((d) => [d.Name, d.Value]))]));
    expect(byMetric.get("AWS/ECS/CPUUtilization")).toEqual({ ClusterName: "prod", ServiceName: "web-svc" });
    expect(byMetric.get("AWS/ApplicationELB/UnHealthyHostCount")).toEqual({ LoadBalancer: "app/web-alb/50dc6c495c0c9188", TargetGroup: "targetgroup/web-tg/73e2d6bc24d8a067" });
    expect(byMetric.get("AWS/RDS/CPUUtilization")).toEqual({ DBInstanceIdentifier: "orders-db" });
    expect(byMetric.get("AWS/ElastiCache/CPUUtilization")).toEqual({ CacheClusterId: "cache-001" });
    expect(byMetric.get("AWS/SQS/ApproximateNumberOfMessagesVisible")).toEqual({ QueueName: "jobs" });
  });

  it("prefers a driver observation's externalId over the node's externalRef", async () => {
    answerAll();
    const s = source({ observations: [{ address: "resource/db", externalId: ARN.rds("observed-db"), presence: "present", attributes: {}, observedAt: "t", source: "x", simulated: false }] });
    await s.queryMetrics!(mq(["db.cpu"]), signal());
    expect(queryOf().MetricDataQueries![0].MetricStat!.Metric!.Dimensions).toEqual([{ Name: "DBInstanceIdentifier", Value: "observed-db" }]);
  });

  it("ignores an observation whose presence is missing", async () => {
    answerAll();
    const s = source({ observations: [{ address: "resource/db", externalId: ARN.rds("gone-db"), presence: "missing", attributes: {}, observedAt: "t", source: "x", simulated: false }] });
    await s.queryMetrics!(mq(["db.cpu"]), signal());
    expect(queryOf().MetricDataQueries![0].MetricStat!.Metric!.Dimensions![0].Value).toBe("orders-db");
  });
});

describe("request shape", () => {
  it("passes the range, ascending scan, and a period that is a multiple of 60 seconds", async () => {
    answerAll();
    await source().queryMetrics!(mq(["cpu.utilization"], { stepSec: 90 }), signal());
    const input = queryOf();
    expect(input.StartTime).toEqual(new Date(NOW - 3600_000));
    expect(input.EndTime).toEqual(new Date(NOW));
    expect(input.ScanBy).toBe("TimestampAscending");
    expect(input.MetricDataQueries![0].MetricStat!.Period).toBe(120);
    cw.reset();
    answerAll();
    await source().queryMetrics!(mq(["cpu.utilization"], { stepSec: 10 }), signal());
    expect(queryOf().MetricDataQueries![0].MetricStat!.Period).toBe(60);
  });

  it("uses only ids that are valid CloudWatch query ids", async () => {
    answerAll();
    await source().queryMetrics!(mq(["cpu.utilization", "db.cpu", "queue.depth"]), signal());
    for (const q of queryOf().MetricDataQueries!) expect(q.Id).toMatch(/^[a-z][A-Za-z0-9_]*$/);
  });
});

describe("unavailable, never an error", () => {
  it("an unknown metric name is an unavailable entry; known ones still answer", async () => {
    answerAll();
    const r = await source().queryMetrics!(mq(["cpu.utilization", "made.up.metric", "constructor"]), signal());
    expect(r.items.map((s) => s.metric)).toEqual(["cpu.utilization"]);
    expect(r.unavailable.map((u) => u.reason)).toEqual([
      expect.stringContaining('metric "made.up.metric" is not mapped'),
      expect.stringContaining('metric "constructor" is not mapped'),
    ]);
    expect(r.unavailable.every((u) => u.source === CLOUDWATCH_METRICS_SOURCE_ID)).toBe(true);
  });

  it("only unknown metrics: no AWS call at all", async () => {
    answerAll();
    const r = await source().queryMetrics!(mq(["nope"]), signal());
    expect(cw.commandCalls(GetMetricDataCommand)).toHaveLength(0);
    expect(r.items).toEqual([]);
    expect(r.sources).toEqual([]);
  });

  it("a metric with no applicable node in scope is unavailable", async () => {
    answerAll();
    const r = await source().queryMetrics!(mq(["db.cpu"], { scope: scope({ addresses: ["service/web"] }) }), signal());
    expect(r.unavailable[0].reason).toMatch(/applies to postgres\/mysql resources; none in scope/);
  });

  it("an unresolvable identifier is unavailable and names why", async () => {
    answerAll();
    const bare = node("service/bare", "container_service", "aws");
    const lbNoTg = node("load_balancer/notg", "load_balancer", "aws", { externalRef: ARN.alb("x", "abc") });
    const nlb = node("load_balancer/nlb", "load_balancer", "aws", { externalRef: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/n/1" });
    const rg = node("resource/rg", "redis", "aws", { externalRef: "arn:aws:elasticache:us-east-1:123456789012:replicationgroup:cache" });
    const s = source({ graph: graph([bare, lbNoTg, nlb, rg]) });
    const r = await s.queryMetrics!(mq(["cpu.utilization", "lb.unhealthy_hosts", "http.requests", "cache.cpu"]), signal());
    const reasons = r.unavailable.map((u) => u.reason).join("\n");
    expect(reasons).toMatch(/service\/bare: no ECS service name/);
    expect(reasons).toMatch(/load_balancer\/notg: no target group ARN/);
    expect(reasons).toMatch(/load_balancer\/nlb: only application load balancers/);
    expect(reasons).toMatch(/replication group/);
    expect(r.items.map((i) => `${i.metric}@${i.address}`)).toEqual(["http.requests@load_balancer/notg"]);
  });

  it("does not use a cluster it was not told: an old-format service ARN without a cluster is unresolved", async () => {
    answerAll();
    const n = node("service/old", "container_service", "aws", { externalRef: "arn:aws:ecs:us-east-1:123456789012:service/old-svc" });
    const r = await source({ graph: graph([n]) }).queryMetrics!(mq(["cpu.utilization"]), signal());
    expect(r.unavailable[0].reason).toMatch(/no ECS cluster name/);
    n.spec.clusterName = "prod";
    const r2 = await source({ graph: graph([n]) }).queryMetrics!(mq(["cpu.utilization"]), signal());
    expect(r2.unavailable).toEqual([]);
    expect(queryOf().MetricDataQueries![0].MetricStat!.Metric!.Dimensions).toEqual([
      { Name: "ClusterName", Value: "prod" },
      { Name: "ServiceName", Value: "old-svc" },
    ]);
  });

  it("Forbidden and InternalError results are unavailable entries, not series", async () => {
    cw.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "m0", StatusCode: "Forbidden", Messages: [{ Code: "AccessDenied", Value: "not allowed" }], Timestamps: [], Values: [] },
        okResult("m1"),
      ],
    });
    const r = await source().queryMetrics!(mq(["cpu.utilization", "db.cpu"]), signal());
    expect(r.items.map((s) => s.metric)).toEqual(["db.cpu"]);
    expect(r.unavailable[0].reason).toMatch(/"cpu.utilization" for service\/web: CloudWatch status Forbidden \(AccessDenied: not allowed\)/);
  });

  it("a failed GetMetricData call is one unavailable entry with a redacted reason", async () => {
    cw.on(GetMetricDataCommand).rejects(Object.assign(new Error(`denied password=${CANARY.password}`), { name: "AccessDeniedException" }));
    const r = await source().queryMetrics!(mq(["cpu.utilization"]), signal());
    expect(r.items).toEqual([]);
    expect(r.unavailable).toHaveLength(1);
    expect(r.unavailable[0].reason).toContain("AccessDeniedException");
    expect(JSON.stringify(r)).not.toContain(CANARY.password);
  });

  it("through the fabric an unknown metric is a labeled partial answer, not an exception", async () => {
    answerAll();
    const fabric = createObservabilityFabric([source()], { now: () => new Date(NOW) });
    const r = await fabric.queryMetrics({ scope: scope(), range: range(), metrics: ["cpu.utilization", "bogus.metric"] });
    expect(r.items).toHaveLength(1);
    expect(r.unavailable).toHaveLength(1);
    expect(r.sources).toEqual([CLOUDWATCH_METRICS_SOURCE_ID]);
  });
});

describe("results", () => {
  it("merges paginated pages into one series, sorted ascending, dropping non-finite values", async () => {
    cw.on(GetMetricDataCommand)
      .resolvesOnce({ MetricDataResults: [okResult("m0", [5, 6], { StatusCode: "PartialData", Timestamps: [new Date(NOW - 120_000), new Date(NOW - 60_000)] })], NextToken: "t2" })
      .resolves({ MetricDataResults: [okResult("m0", [7, Number.NaN], { Timestamps: [new Date(NOW - 30_000), new Date(NOW - 15_000)] })] });
    const r = await source().queryMetrics!(mq(["cpu.utilization"]), signal());
    expect(cw.commandCalls(GetMetricDataCommand)).toHaveLength(2);
    expect(cw.commandCalls(GetMetricDataCommand)[1].args[0].input.NextToken).toBe("t2");
    expect(r.items[0].points.map((p) => p.value)).toEqual([5, 6, 7]);
    expect(r.items[0].native.statusCode).toBe("Complete");
    expect(r.notes).toBeUndefined();
  });

  it("bounds pagination", async () => {
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [okResult("m0")], NextToken: "again" });
    const r = await source().queryMetrics!(mq(["cpu.utilization"]), signal());
    expect(cw.commandCalls(GetMetricDataCommand).length).toBeLessThanOrEqual(5);
    expect(r.items[0].native.statusCode).toBe("PartialData");
    expect(r.notes?.join()).toMatch(/partial data/);
  });

  it("an empty series is returned as such and says it had no datapoints", async () => {
    cw.on(GetMetricDataCommand).resolves({ MetricDataResults: [{ Id: "m0", StatusCode: "Complete", Timestamps: [], Values: [] }] });
    const r = await source().queryMetrics!(mq(["cpu.utilization"]), signal());
    expect(r.items[0].points).toEqual([]);
    expect(r.items[0].native.datapoints).toBe(0);
  });

  it("caps queries at 50 series and says so", async () => {
    const many = Array.from({ length: 60 }, (_, i) => node(`resource/q${i}`, "queue", "aws", { externalRef: ARN.sqs(`q${i}`) }));
    answerAll();
    const r = await source({ graph: graph(many) }).queryMetrics!(mq(["queue.depth"]), signal());
    expect(queryOf().MetricDataQueries).toHaveLength(50);
    expect(r.items).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("stays within its environment and covers only nodes it can chart", async () => {
    answerAll();
    const s = source();
    expect(s.covers!({ workspaceId: "ws-1", environmentId: "other" })).toBe(false);
    expect(s.covers!(scope({ addresses: ["network/main"] }))).toBe(false);
    expect(s.covers!(scope())).toBe(true);
    const r = await s.queryMetrics!(mq(["cpu.utilization"], { scope: { workspaceId: "ws-1", environmentId: "other" } }), signal());
    expect(r.items).toEqual([]);
    expect(cw.commandCalls(GetMetricDataCommand)).toHaveLength(0);
    expect(ENV).toBeDefined();
  });

  it("an abort cancels an in-flight GetMetricData promptly", async () => {
    cw.on(GetMetricDataCommand).callsFake(() => new Promise(() => undefined));
    const ctl = new AbortController();
    const pending = source().queryMetrics!(mq(["cpu.utilization"]), ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the localstack provider label when configured", async () => {
    answerAll();
    const r = await source({ provider: "localstack" }).queryMetrics!(mq(["cpu.utilization"]), signal());
    expect(r.items[0].provider).toBe("localstack");
  });
});
