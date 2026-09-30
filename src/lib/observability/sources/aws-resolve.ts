/**
 * Address → AWS native identifier resolution.
 *
 * Observability speaks portable addresses (`service/web`); CloudWatch and ECS
 * speak log group names, cluster/service names, load balancer dimensions. This
 * module translates, and NEVER guesses: a node whose native identifier cannot
 * be read from what the platform already knows resolves to `{ ok: false,
 * reason }`, and the source reports that as an `unavailable` entry instead of
 * querying a name it invented.
 *
 * Where identifiers come from, in order (first hit wins):
 *   1. the node's latest observation — `Observation.externalId` (an ARN, name
 *      or URL a driver read) and `Observation.native.<key>`;
 *   2. `ResourceNode.externalRef` (referenced / external nodes);
 *   3. `ResourceNode.spec.<key>`, `spec.provider.aws.<key>` or `spec.aws.<key>`.
 * Recognized keys: `clusterName`|`cluster`, `serviceName`, `logGroup`|
 * `logGroupName`, `loadBalancerArn`, `targetGroupArn`|`targetGroupArns`,
 * `dbInstanceIdentifier`, `cacheClusterId`, `queueUrl`|`queueName`.
 * An observation with `presence: "missing"` contributes nothing — an id read
 * from something that no longer exists is not an identifier.
 *
 * Every resolved identifier is validated against the character set the service
 * allows before it is used as a request parameter or metric dimension value.
 */
import type { Observation, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { isRecord } from "../normalize";

export type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Resolved<T> => ({ ok: true, value });
const no = <T>(reason: string): Resolved<T> => ({ ok: false, reason });

export interface AwsContext {
  graph: ResourceGraph;
  observations: ReadonlyMap<string, Observation>;
}

export function awsContext(graph: ResourceGraph, observations: readonly Observation[] = []): AwsContext {
  const map = new Map<string, Observation>();
  for (const o of observations) if (o.presence !== "missing") map.set(o.address, o);
  return { graph, observations: map };
}

/* --------------------------------- hints ---------------------------------- */

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" && v.length <= 1024 ? v.trim() : undefined);

function nested(root: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function candidates(ctx: AwsContext, node: ResourceNode, key: string): unknown[] {
  const obs = ctx.observations.get(node.address);
  return [obs?.native?.[key], node.spec[key], nested(node.spec, ["provider", "aws", key]), nested(node.spec, ["aws", key])];
}

/** First non-empty string hint under any of `keys`. */
export function hint(ctx: AwsContext, node: ResourceNode, ...keys: string[]): string | undefined {
  for (const key of keys) for (const c of candidates(ctx, node, key)) {
    const s = asString(c);
    if (s) return s;
  }
  return undefined;
}

/** All string hints under `keys`, arrays flattened, de-duplicated. */
export function hintList(ctx: AwsContext, node: ResourceNode, ...keys: string[]): string[] {
  const out = new Set<string>();
  for (const key of keys) for (const c of candidates(ctx, node, key)) {
    if (Array.isArray(c)) for (const v of c) {
      const s = asString(v);
      if (s) out.add(s);
    }
    else {
      const s = asString(c);
      if (s) out.add(s);
    }
  }
  return [...out];
}

/** The provider-side id a driver observed, else the node's `externalRef`. */
export function externalIdOf(ctx: AwsContext, node: ResourceNode): string | undefined {
  return asString(ctx.observations.get(node.address)?.externalId) ?? asString(node.externalRef);
}

/* ---------------------------------- ARNs ---------------------------------- */

export interface Arn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

export function parseArn(value: string | undefined): Arn | undefined {
  if (!value || !value.startsWith("arn:")) return undefined;
  const parts = value.split(":");
  if (parts.length < 6) return undefined;
  const [, partition, service, region, account, ...rest] = parts;
  return { partition, service, region, account, resource: rest.join(":") };
}

const ECS_NAME = /^[A-Za-z0-9_-]{1,255}$/;
const LOG_GROUP_NAME = /^[A-Za-z0-9_./#-]{1,512}$/;
const ELB_DIM = /^[A-Za-z0-9_./-]{1,255}$/;
const DB_ID = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
const CACHE_ID = /^[A-Za-z][A-Za-z0-9-]{0,49}$/;
const QUEUE_NAME = /^[A-Za-z0-9_-]{1,80}(?:\.fifo)?$/;

/* ----------------------------------- ECS ---------------------------------- */

export interface EcsServiceRef {
  cluster: string;
  service: string;
}

function clusterNameOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const arn = parseArn(raw);
  const name = arn ? (arn.service === "ecs" && arn.resource.startsWith("cluster/") ? arn.resource.slice("cluster/".length) : undefined) : raw;
  return name && ECS_NAME.test(name) ? name : undefined;
}

/** ECS cluster + service names for a `container_service` node on AWS. */
export function ecsServiceOf(ctx: AwsContext, node: ResourceNode): Resolved<EcsServiceRef> {
  const external = externalIdOf(ctx, node);
  const arn = parseArn(external);
  let cluster: string | undefined;
  let service: string | undefined;
  if (arn) {
    if (arn.service !== "ecs" || !arn.resource.startsWith("service/")) return no(`${node.address}: externalId is not an ECS service ARN`);
    const parts = arn.resource.slice("service/".length).split("/");
    if (parts.length === 2) [cluster, service] = parts;
    else if (parts.length === 1) service = parts[0];
  } else if (external && ECS_NAME.test(external)) {
    service = external;
  }
  service ??= hint(ctx, node, "serviceName");
  cluster ??= clusterNameOf(hint(ctx, node, "clusterName", "cluster"));
  if (!service || !ECS_NAME.test(service)) return no(`${node.address}: no ECS service name (need an observation externalId/serviceName)`);
  if (!cluster) return no(`${node.address}: no ECS cluster name (need an ECS service ARN with cluster, or spec.clusterName)`);
  return ok({ cluster, service });
}

/* ------------------------------- log groups ------------------------------- */

function logGroupFromValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const arn = parseArn(raw);
  let name = raw;
  if (arn) {
    if (arn.service !== "logs" || !arn.resource.startsWith("log-group:")) return undefined;
    name = arn.resource.slice("log-group:".length).replace(/:\*$/, "");
  }
  return LOG_GROUP_NAME.test(name) ? name : undefined;
}

export interface LogGroupRef {
  group: string;
  /** node the group was resolved through; services win over bare log_group nodes */
  address: string;
}

/**
 * CloudWatch log groups for one node:
 *   - a `log_group` node names its own group;
 *   - a `container_service` (or function/scheduled job) uses `logGroup`, else
 *     the `log_group/<suffix>` node beside `service/<suffix>`, else a
 *     `log_group` node connected to it by an edge.
 */
export function logGroupsOf(ctx: AwsContext, node: ResourceNode): Resolved<string[]> {
  if (node.kind === "log_group") {
    const g = logGroupFromValue(externalIdOf(ctx, node)) ?? logGroupFromValue(hint(ctx, node, "logGroupName", "logGroup", "name"));
    return g ? ok([g]) : no(`${node.address}: log group name not resolvable (need spec.name/logGroupName or an observation)`);
  }
  const direct = logGroupFromValue(hint(ctx, node, "logGroup", "logGroupName"));
  if (direct) return ok([direct]);
  const linked = linkedLogGroupNodes(ctx, node);
  const groups = [...new Set(linked.map((n) => logGroupOfLinked(ctx, n)).filter((g): g is string => g !== undefined))];
  if (groups.length) return ok(groups);
  return no(`${node.address}: no log group (need spec.logGroup or a log_group node with a name)`);
}

function logGroupOfLinked(ctx: AwsContext, node: ResourceNode): string | undefined {
  const r = logGroupsOf(ctx, node);
  return r.ok ? r.value[0] : undefined;
}

function linkedLogGroupNodes(ctx: AwsContext, node: ResourceNode): ResourceNode[] {
  const byAddress = new Map(ctx.graph.nodes.map((n) => [n.address, n] as const));
  const found = new Map<string, ResourceNode>();
  const suffix = node.address.includes("/") ? node.address.slice(node.address.indexOf("/") + 1) : undefined;
  if (suffix) {
    const sibling = byAddress.get(`log_group/${suffix}`);
    if (sibling?.kind === "log_group") found.set(sibling.address, sibling);
  }
  for (const e of ctx.graph.edges) {
    const other = e.from === node.address ? e.to : e.to === node.address ? e.from : undefined;
    const n = other ? byAddress.get(other) : undefined;
    if (n?.kind === "log_group") found.set(n.address, n);
  }
  return [...found.values()];
}

/* ------------------------------ load balancers ---------------------------- */

/** CloudWatch `LoadBalancer` dimension (`app/<name>/<id>`) of an application load balancer. */
export function loadBalancerDimension(ctx: AwsContext, node: ResourceNode): Resolved<string> {
  const arn = parseArn(loadBalancerArnOf(ctx, node));
  if (!arn || arn.service !== "elasticloadbalancing" || !arn.resource.startsWith("loadbalancer/")) return no(`${node.address}: no load balancer ARN (need an observation externalId or spec.loadBalancerArn)`);
  const dim = arn.resource.slice("loadbalancer/".length);
  if (!dim.startsWith("app/")) return no(`${node.address}: only application load balancers (AWS/ApplicationELB) are mapped`);
  return ELB_DIM.test(dim) ? ok(dim) : no(`${node.address}: load balancer ARN has unexpected shape`);
}

export function loadBalancerArnOf(ctx: AwsContext, node: ResourceNode): string | undefined {
  const ext = externalIdOf(ctx, node);
  if (parseArn(ext)?.service === "elasticloadbalancing") return ext;
  return hint(ctx, node, "loadBalancerArn");
}

export function targetGroupArnsOf(ctx: AwsContext, node: ResourceNode): string[] {
  return hintList(ctx, node, "targetGroupArn", "targetGroupArns").filter((a) => parseArn(a)?.service === "elasticloadbalancing");
}

/** CloudWatch `TargetGroup` dimension (`targetgroup/<name>/<id>`); the first target group when several. */
export function targetGroupDimension(ctx: AwsContext, node: ResourceNode): Resolved<string> {
  const arn = parseArn(targetGroupArnsOf(ctx, node)[0]);
  if (!arn || !arn.resource.startsWith("targetgroup/")) return no(`${node.address}: no target group ARN (need spec.targetGroupArn or an observation with native.targetGroupArns)`);
  return ELB_DIM.test(arn.resource) ? ok(arn.resource) : no(`${node.address}: target group ARN has unexpected shape`);
}

/* ------------------------------ databases, etc. --------------------------- */

export function dbInstanceOf(ctx: AwsContext, node: ResourceNode): Resolved<string> {
  const external = externalIdOf(ctx, node);
  const arn = parseArn(external);
  let id: string | undefined;
  if (arn) id = arn.service === "rds" && arn.resource.startsWith("db:") ? arn.resource.slice(3) : undefined;
  else id = external;
  id ??= hint(ctx, node, "dbInstanceIdentifier", "identifier");
  return id && DB_ID.test(id) ? ok(id) : no(`${node.address}: no RDS DB instance identifier (need an observation externalId or spec.dbInstanceIdentifier)`);
}

export function cacheClusterOf(ctx: AwsContext, node: ResourceNode): Resolved<string> {
  const external = externalIdOf(ctx, node);
  const arn = parseArn(external);
  let id: string | undefined;
  if (arn) {
    if (arn.service === "elasticache" && arn.resource.startsWith("replicationgroup:"))
      return no(`${node.address}: ElastiCache replication group — cache metrics need a member cache cluster id (spec.cacheClusterId)`);
    id = arn.service === "elasticache" && arn.resource.startsWith("cluster:") ? arn.resource.slice("cluster:".length) : undefined;
  } else id = external;
  id ??= hint(ctx, node, "cacheClusterId");
  return id && CACHE_ID.test(id) ? ok(id) : no(`${node.address}: no ElastiCache cluster id (need an observation externalId or spec.cacheClusterId)`);
}

export function queueNameOf(ctx: AwsContext, node: ResourceNode): Resolved<string> {
  const raw = externalIdOf(ctx, node) ?? hint(ctx, node, "queueUrl", "queueName");
  let name: string | undefined;
  const arn = parseArn(raw);
  if (arn) name = arn.service === "sqs" ? arn.resource : undefined;
  else if (raw?.startsWith("http")) name = raw.replace(/[?#].*$/, "").split("/").filter(Boolean).pop();
  else name = raw;
  name ??= hint(ctx, node, "queueName");
  return name && QUEUE_NAME.test(name) ? ok(name) : no(`${node.address}: no SQS queue name (need an observation externalId or spec.queueUrl)`);
}
