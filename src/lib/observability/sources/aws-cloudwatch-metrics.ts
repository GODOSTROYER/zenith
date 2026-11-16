/**
 * CloudWatch Metrics source (`aws.cloudwatch-metrics`).
 *
 * Evidence level: `contract` — mocked SDK only; never run against real
 * CloudWatch or LocalStack.
 *
 * Portable metric names are translated through a fixed table
 * (`AWS_METRIC_TABLE`) to a CloudWatch namespace, metric name, statistic and
 * dimensions. The translation never pretends two signals are the same: the
 * series keeps the native namespace/metric/stat/dimensions in `native`, and
 * the unit is the CloudWatch unit (e.g. `http.target_response_time` is
 * `Seconds`, not milliseconds).
 *
 *   portable                    namespace            metric                            stat     unit      dimensions              node kind
 *   cpu.utilization             AWS/ECS              CPUUtilization                    Average  Percent   ClusterName,ServiceName container_service
 *   memory.utilization          AWS/ECS              MemoryUtilization                 Average  Percent   ClusterName,ServiceName container_service
 *   http.requests               AWS/ApplicationELB   RequestCount                      Sum      Count     LoadBalancer            load_balancer
 *   http.5xx.count              AWS/ApplicationELB   HTTPCode_Target_5XX_Count         Sum      Count     LoadBalancer            load_balancer
 *   http.target_response_time   AWS/ApplicationELB   TargetResponseTime                Average  Seconds   LoadBalancer            load_balancer
 *   lb.unhealthy_hosts          AWS/ApplicationELB   UnHealthyHostCount                Maximum  Count     LoadBalancer,TargetGroup load_balancer
 *   db.cpu                      AWS/RDS              CPUUtilization                    Average  Percent   DBInstanceIdentifier    postgres, mysql
 *   db.connections              AWS/RDS              DatabaseConnections               Average  Count     DBInstanceIdentifier    postgres, mysql
 *   db.free_storage             AWS/RDS              FreeStorageSpace                  Minimum  Bytes     DBInstanceIdentifier    postgres, mysql
 *   cache.cpu                   AWS/ElastiCache      CPUUtilization                    Average  Percent   CacheClusterId          redis
 *   queue.depth                 AWS/SQS              ApproximateNumberOfMessagesVisible Maximum Count     QueueName               queue
 *
 * A metric name that is not in the table, a node kind the metric does not
 * apply to, or a node whose native identifier cannot be read all produce an
 * `unavailable` entry saying which — never an exception and never a guess.
 * A series with no datapoints is returned with an empty `points` array
 * (CloudWatch had nothing in the window), and says so in `native.datapoints`.
 */
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery, type MetricDataResult } from "@aws-sdk/client-cloudwatch";
import type { AwsSession } from "@/lib/credentials/types";
import type { Observation, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { throwIfAborted } from "../abort";
import { errorMessage } from "../normalize";
import { SERIES_PER_QUERY_MAX } from "../query";
import { sanitizeNative, sanitizeReason } from "../redact";
import type { MetricPoint, MetricQuery, MetricSeries, ObservabilitySource, QueryResult } from "../types";
import {
  awsContext,
  cacheClusterOf,
  dbInstanceOf,
  ecsServiceOf,
  loadBalancerDimension,
  queueNameOf,
  targetGroupDimension,
  type AwsContext,
  type Resolved,
} from "./aws-resolve";
import { bindingOf, coversScope, nodesInScope, sameEnvironment, type EnvironmentBinding, type NodeKind } from "./scope";
import { abortable } from "./util";

export const CLOUDWATCH_METRICS_SOURCE_ID = "aws.cloudwatch-metrics";
const MAX_PAGES = 5;

type Stat = "Average" | "Sum" | "Maximum" | "Minimum";
type Dimensions = { Name: string; Value: string }[];

export interface AwsMetricDef {
  portable: string;
  namespace: string;
  metricName: string;
  stat: Stat;
  unit: string;
  /** CloudWatch dimension names, for documentation and tests */
  dimensionNames: readonly string[];
  kinds: readonly NodeKind[];
  dimensions(ctx: AwsContext, node: ResourceNode): Resolved<Dimensions>;
}

const dim = (Name: string, Value: string) => ({ Name, Value });

const ecsDims = (ctx: AwsContext, node: ResourceNode): Resolved<Dimensions> => {
  const r = ecsServiceOf(ctx, node);
  return r.ok ? { ok: true, value: [dim("ClusterName", r.value.cluster), dim("ServiceName", r.value.service)] } : r;
};
const lbDims = (ctx: AwsContext, node: ResourceNode): Resolved<Dimensions> => {
  const r = loadBalancerDimension(ctx, node);
  return r.ok ? { ok: true, value: [dim("LoadBalancer", r.value)] } : r;
};
const lbTgDims = (ctx: AwsContext, node: ResourceNode): Resolved<Dimensions> => {
  const lb = loadBalancerDimension(ctx, node);
  if (!lb.ok) return lb;
  const tg = targetGroupDimension(ctx, node);
  return tg.ok ? { ok: true, value: [dim("LoadBalancer", lb.value), dim("TargetGroup", tg.value)] } : tg;
};
const dbDims = (ctx: AwsContext, node: ResourceNode): Resolved<Dimensions> => {
  const r = dbInstanceOf(ctx, node);
  return r.ok ? { ok: true, value: [dim("DBInstanceIdentifier", r.value)] } : r;
};
const cacheDims = (ctx: AwsContext, node: ResourceNode): Resolved<Dimensions> => {
  const r = cacheClusterOf(ctx, node);
  return r.ok ? { ok: true, value: [dim("CacheClusterId", r.value)] } : r;
};
const queueDims = (ctx: AwsContext, node: ResourceNode): Resolved<Dimensions> => {
  const r = queueNameOf(ctx, node);
  return r.ok ? { ok: true, value: [dim("QueueName", r.value)] } : r;
};

export const AWS_METRIC_TABLE: readonly AwsMetricDef[] = [
  { portable: "cpu.utilization", namespace: "AWS/ECS", metricName: "CPUUtilization", stat: "Average", unit: "Percent", dimensionNames: ["ClusterName", "ServiceName"], kinds: ["container_service"], dimensions: ecsDims },
  { portable: "memory.utilization", namespace: "AWS/ECS", metricName: "MemoryUtilization", stat: "Average", unit: "Percent", dimensionNames: ["ClusterName", "ServiceName"], kinds: ["container_service"], dimensions: ecsDims },
  { portable: "http.requests", namespace: "AWS/ApplicationELB", metricName: "RequestCount", stat: "Sum", unit: "Count", dimensionNames: ["LoadBalancer"], kinds: ["load_balancer"], dimensions: lbDims },
  { portable: "http.5xx.count", namespace: "AWS/ApplicationELB", metricName: "HTTPCode_Target_5XX_Count", stat: "Sum", unit: "Count", dimensionNames: ["LoadBalancer"], kinds: ["load_balancer"], dimensions: lbDims },
  { portable: "http.target_response_time", namespace: "AWS/ApplicationELB", metricName: "TargetResponseTime", stat: "Average", unit: "Seconds", dimensionNames: ["LoadBalancer"], kinds: ["load_balancer"], dimensions: lbDims },
  { portable: "lb.unhealthy_hosts", namespace: "AWS/ApplicationELB", metricName: "UnHealthyHostCount", stat: "Maximum", unit: "Count", dimensionNames: ["LoadBalancer", "TargetGroup"], kinds: ["load_balancer"], dimensions: lbTgDims },
  { portable: "db.cpu", namespace: "AWS/RDS", metricName: "CPUUtilization", stat: "Average", unit: "Percent", dimensionNames: ["DBInstanceIdentifier"], kinds: ["postgres", "mysql"], dimensions: dbDims },
  { portable: "db.connections", namespace: "AWS/RDS", metricName: "DatabaseConnections", stat: "Average", unit: "Count", dimensionNames: ["DBInstanceIdentifier"], kinds: ["postgres", "mysql"], dimensions: dbDims },
  { portable: "db.free_storage", namespace: "AWS/RDS", metricName: "FreeStorageSpace", stat: "Minimum", unit: "Bytes", dimensionNames: ["DBInstanceIdentifier"], kinds: ["postgres", "mysql"], dimensions: dbDims },
  { portable: "cache.cpu", namespace: "AWS/ElastiCache", metricName: "CPUUtilization", stat: "Average", unit: "Percent", dimensionNames: ["CacheClusterId"], kinds: ["redis"], dimensions: cacheDims },
  { portable: "queue.depth", namespace: "AWS/SQS", metricName: "ApproximateNumberOfMessagesVisible", stat: "Maximum", unit: "Count", dimensionNames: ["QueueName"], kinds: ["queue"], dimensions: queueDims },
];

const TABLE = new Map(AWS_METRIC_TABLE.map((d) => [d.portable, d] as const));
const METRIC_KINDS = new Set<string>(AWS_METRIC_TABLE.flatMap((d) => d.kinds));

export interface CloudWatchMetricsConfig {
  session: AwsSession;
  graph: ResourceGraph;
  provider?: "aws" | "localstack";
  workspaceId?: string;
  observations?: readonly Observation[];
}

interface Planned {
  id: string;
  def: AwsMetricDef;
  node: ResourceNode;
  dimensions: Dimensions;
  period: number;
}

export function createCloudWatchMetricsSource(config: CloudWatchMetricsConfig): ObservabilitySource {
  const provider = config.provider ?? "aws";
  const binding: EnvironmentBinding = bindingOf(config.graph, config.workspaceId);
  const ctx = awsContext(config.graph, config.observations);
  const isMetricNode = (n: ResourceNode) => (n.provider === "aws" || n.provider === "localstack") && METRIC_KINDS.has(n.kind);

  return {
    id: CLOUDWATCH_METRICS_SOURCE_ID,
    provider,
    supports: ["metric"],
    covers: (scope) => coversScope(binding, config.graph, scope, isMetricNode),

    async queryMetrics(q: MetricQuery, signal: AbortSignal): Promise<QueryResult<MetricSeries>> {
      const result: QueryResult<MetricSeries> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] };
      if (!sameEnvironment(binding, q.scope)) return finalize(result);
      const fromMs = Date.parse(q.range.from);
      const toMs = q.range.to === undefined ? Date.now() : Date.parse(q.range.to);
      const period = Math.max(60, Math.ceil((q.stepSec ?? Math.ceil((toMs - fromMs) / 1000 / 120)) / 60) * 60);
      const nodes = nodesInScope(config.graph, q.scope, isMetricNode);

      // plan: (portable metric × applicable node) → one MetricDataQuery each
      const planned: Planned[] = [];
      const unavailable = (reason: string) => result.unavailable.push({ source: CLOUDWATCH_METRICS_SOURCE_ID, reason: sanitizeReason(reason) });
      for (const name of q.metrics) {
        const def = TABLE.get(name);
        if (!def) {
          unavailable(`metric "${name}" is not mapped for CloudWatch (known: ${AWS_METRIC_TABLE.map((d) => d.portable).join(", ")})`);
          continue;
        }
        const applicable = nodes.filter((n) => def.kinds.includes(n.kind));
        if (applicable.length === 0) {
          unavailable(`metric "${name}" applies to ${def.kinds.join("/")} resources; none in scope`);
          continue;
        }
        for (const node of applicable) {
          const dims = def.dimensions(ctx, node);
          if (!dims.ok) {
            unavailable(`metric "${name}": ${dims.reason}`);
            continue;
          }
          planned.push({ id: `m${planned.length}`, def, node, dimensions: dims.value, period });
        }
      }
      if (planned.length > SERIES_PER_QUERY_MAX) {
        result.truncated = true;
        result.notes!.push(`${planned.length - SERIES_PER_QUERY_MAX} series not queried (limit ${SERIES_PER_QUERY_MAX} per query)`);
        planned.length = SERIES_PER_QUERY_MAX;
      }
      if (planned.length === 0) return finalize(result);

      let data: Map<string, Collected>;
      try {
        data = await fetchMetricData(config.session.client(CloudWatchClient), planned, fromMs, toMs, signal);
      } catch (err) {
        throwIfAborted(signal);
        unavailable(`GetMetricData failed: ${errorMessage(err)}`);
        return finalize(result);
      }

      result.sources.push(CLOUDWATCH_METRICS_SOURCE_ID);
      for (const p of planned) {
        const got = data.get(p.id);
        if (!got) {
          unavailable(`metric "${p.def.portable}" for ${p.node.address}: CloudWatch returned no result`);
          continue;
        }
        if (got.status === "Forbidden" || got.status === "InternalError") {
          unavailable(`metric "${p.def.portable}" for ${p.node.address}: CloudWatch status ${got.status}${got.message ? ` (${got.message})` : ""}`);
          continue;
        }
        if (got.status === "PartialData") result.notes!.push(`metric "${p.def.portable}" for ${p.node.address}: CloudWatch returned partial data`);
        result.items.push({
          metric: p.def.portable,
          unit: p.def.unit,
          address: p.node.address,
          provider,
          native: sanitizeNative({
            namespace: p.def.namespace,
            metricName: p.def.metricName,
            stat: p.def.stat,
            period: p.period,
            dimensions: Object.fromEntries(p.dimensions.map((d) => [d.Name, d.Value])),
            statusCode: got.status,
            datapoints: got.points.length,
          }).value,
          points: got.points,
        });
      }
      return finalize(result);
    },
  };
}

function finalize<T>(result: QueryResult<T>): QueryResult<T> {
  if (!result.notes || result.notes.length === 0) delete result.notes;
  return result;
}

interface Collected {
  points: MetricPoint[];
  status: string;
  message?: string;
}

async function fetchMetricData(cw: CloudWatchClient, planned: Planned[], fromMs: number, toMs: number, signal: AbortSignal): Promise<Map<string, Collected>> {
  const queries: MetricDataQuery[] = planned.map((p) => ({
    Id: p.id,
    MetricStat: { Metric: { Namespace: p.def.namespace, MetricName: p.def.metricName, Dimensions: p.dimensions }, Period: p.period, Stat: p.def.stat },
    ReturnData: true,
  }));
  const collected = new Map<string, { at: number[]; values: number[]; status: string; message?: string }>();
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    throwIfAborted(signal);
    const res = await abortable(
      cw.send(
        new GetMetricDataCommand({
          StartTime: new Date(fromMs),
          EndTime: new Date(toMs),
          MetricDataQueries: queries,
          ScanBy: "TimestampAscending",
          ...(token ? { NextToken: token } : {}),
        }),
        { abortSignal: signal }
      ),
      signal
    );
    for (const r of res.MetricDataResults ?? []) accumulate(collected, r);
    token = res.NextToken;
    if (!token) break;
  }
  const out = new Map<string, Collected>();
  for (const [id, c] of collected) {
    const points: MetricPoint[] = [];
    c.at.forEach((t, i) => {
      const v = c.values[i];
      if (Number.isFinite(t) && Number.isFinite(v)) points.push({ timestamp: new Date(t).toISOString(), value: v });
    });
    points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    // still more pages after the bound → mark the result partial rather than pretend it is complete
    out.set(id, { points, status: token && c.status === "Complete" ? "PartialData" : c.status, ...(c.message ? { message: c.message } : {}) });
  }
  return out;
}

function accumulate(into: Map<string, { at: number[]; values: number[]; status: string; message?: string }>, r: MetricDataResult): void {
  if (!r.Id) return;
  const cur = into.get(r.Id) ?? { at: [], values: [], status: "Complete" };
  for (const t of r.Timestamps ?? []) cur.at.push(t instanceof Date ? t.getTime() : Date.parse(String(t)));
  for (const v of r.Values ?? []) cur.values.push(v);
  // the last page's Complete/PartialData wins; a failure status on any page sticks
  if (r.StatusCode && cur.status !== "Forbidden" && cur.status !== "InternalError") cur.status = r.StatusCode;
  const message = r.Messages?.[0];
  if (message?.Value) cur.message = `${message.Code ?? "message"}: ${message.Value}`;
  into.set(r.Id, cur);
}
