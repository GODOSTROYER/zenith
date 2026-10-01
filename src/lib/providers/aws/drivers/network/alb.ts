/**
 * `aws:alb` (kind `load_balancer`): the Application Load Balancer, its
 * listeners, target groups and rules. Compile is in alb-compile.ts; this file is
 * the read side. Nothing here mutates.
 *
 * `observe` (ELBv2, read-only). The load balancer is found by `externalId`
 * (its ARN) or by its Zenith tags; then, as independent reads that each degrade
 * to `unknown` on failure: DescribeListeners, DescribeTargetGroups (+ DescribeTags
 * for each group's `zenith:target` tag), DescribeRules per listener,
 * DescribeLoadBalancerAttributes. Attributes (all comparable with
 * `expectedAttributes`, see alb-routes.ts for the exact forms):
 *   scheme, state (the load balancer state code; desired `active`), listeners
 *   (`[{ port, protocol, redirect? }]` sorted by port — the shape the incident engine
 *   reads), sslPolicy (only with an https listener), targetGroups, routes,
 *   dropInvalidHeaderFields.
 * `native` carries `loadBalancerArn`, `dnsName`, `canonicalHostedZoneId`, `state`,
 * `targetGroupArns`, `targetGroupsByRoute` (`host + path` → target-group ARN, read
 * from the LISTENER RULES, not assumed from the spec) and the provider `tags`.
 * `externalId` is the load balancer ARN.
 *
 * `runtime` = DescribeTargetHealth for every target group: counts
 * (`target_groups`, `targets`, `targets_healthy`, `targets_unhealthy`, `targets_initial`,
 * `targets_draining`, `targets_unused`, `targets_unavailable` — the names the incident
 * engine reads) and reason-code signals (`target_unhealthy:2`, `target_reason:Target.Timeout:2`,
 * `no_registered_targets`). Health: all groups have a healthy target and none is
 * unhealthy → healthy; some → degraded; none healthy → unhealthy; a group with
 * no registered targets counts as having no healthy one.
 *
 * `verify`: exists, every expected attribute (including `state` = `active`), and
 * — when `runtime` is supplied — the targets are healthy (otherwise that check
 * is `unknown`: the caller did not read target health).
 *
 * Evidence: `contract` only (mocked ELBv2 client).
 */
import {
  DescribeListenersCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  type Listener,
  type LoadBalancer,
  type Rule,
  type TargetGroup,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { AwsSession } from "@/lib/credentials/types";
import type { DiscoveredResource, ResourceDriver, VerificationCheck } from "@/lib/drivers/types";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import {
  type AwsDriverContext,
  attempt,
  attributesFromAttempts,
  boundNative,
  chunk,
  classifyAwsError,
  failedObservation,
  hasZenithManagedTag,
  nowIso,
  paginate,
  runtimeState,
  standardVerification,
  unknownAttributes,
  verificationResult,
  type Attempt,
} from "../shared";
import { findLoadBalancer, loadTags, loadTargetGroups, MAX_LB_PAGES } from "./alb-lookup";
import { TLS_POLICY, listenerEntries, routeKeys, targetGroupKeys, tryModel, type ListenerEntry } from "./alb-routes";
import { compileLoadBalancer } from "./alb-compile";

const SOURCE = "aws.alb@1";
const ALL_ATTRIBUTES = ["scheme", "state", "listeners", "sslPolicy", "targetGroups", "routes", "dropInvalidHeaderFields"] as const;
const NATIVE_PRIORITY = ["loadBalancerArn", "targetGroupArns", "targetGroupsByRoute", "tags", "state"] as const;
const TARGET_TAG = "zenith:target";
const REASON = /^[A-Za-z][A-Za-z.]{0,63}$/;

export function expectedAlbAttributes(node: ResourceNode): Record<string, unknown> {
  const model = tryModel(node);
  if (!model) return {};
  const https = model.listeners.some((l) => l.protocol === "HTTPS");
  return {
    scheme: "internet-facing",
    state: "active",
    listeners: listenerEntries(model),
    ...(https ? { sslPolicy: TLS_POLICY } : {}),
    targetGroups: targetGroupKeys(model),
    routes: routeKeys(model),
    dropInvalidHeaderFields: true,
  };
}

function attributeNames(node: ResourceNode): string[] {
  const expected = Object.keys(expectedAlbAttributes(node));
  return expected.length > 0 ? expected : [...ALL_ATTRIBUTES];
}

/* --------------------------------- reading --------------------------------- */

async function listListeners(ctx: AwsDriverContext, elb: ElasticLoadBalancingV2Client, lbArn: string): Promise<Listener[]> {
  const { items } = await paginate(
    async (m) => {
      const r = await elb.send(new DescribeListenersCommand({ LoadBalancerArn: lbArn, Marker: m, PageSize: 100 }), { abortSignal: ctx.signal });
      return { items: r.Listeners ?? [], next: r.NextMarker };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  return items;
}

async function listRules(ctx: AwsDriverContext, elb: ElasticLoadBalancingV2Client, listenerArn: string): Promise<Rule[]> {
  const { items } = await paginate(
    async (m) => {
      const r = await elb.send(new DescribeRulesCommand({ ListenerArn: listenerArn, Marker: m, PageSize: 100 }), { abortSignal: ctx.signal });
      return { items: r.Rules ?? [], next: r.NextMarker };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  return items;
}

const tgKey = (g: TargetGroup, tags: Record<string, string> | undefined): string => `${tags?.[TARGET_TAG] ?? `unmanaged:${g.TargetGroupName ?? "?"}`}:${g.Port ?? "?"}`;

function ruleRoute(rule: Rule): { host?: string; path: string } {
  let host: string | undefined;
  let path = "/";
  for (const c of rule.Conditions ?? []) {
    if (c.Field === "host-header") host = (c.HostHeaderConfig?.Values ?? c.Values ?? [])[0];
    if (c.Field === "path-pattern") path = [...(c.PathPatternConfig?.Values ?? c.Values ?? [])].sort()[0] ?? "/";
  }
  return { host, path };
}

function ruleTargetGroupArn(rule: Rule): string | undefined {
  for (const a of rule.Actions ?? []) {
    if (a.Type !== "forward") continue;
    return a.TargetGroupArn ?? a.ForwardConfig?.TargetGroups?.[0]?.TargetGroupArn;
  }
  return undefined;
}

async function observeAlb(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const names = attributeNames(node);
  const elb = ctx.session.client(ElasticLoadBalancingV2Client);
  const base = { address: node.address, observedAt: nowIso(ctx), source: SOURCE, simulated: false };
  let found;
  try {
    found = await findLoadBalancer(ctx, elb, node.address, externalId);
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return failedObservation(ctx, node, SOURCE, names, failure, externalId);
  }
  if (found.matches === 0) {
    const unsure = found.truncated;
    return {
      ...base,
      presence: unsure ? "unknown" : "missing",
      attributes: unknownAttributes(names, unsure ? "error" : "not_applicable", unsure ? `not found in the first ${MAX_LB_PAGES} pages of load balancers` : undefined),
      ...(unsure ? { error: `the load balancer was not found in the first ${MAX_LB_PAGES} pages; it may exist beyond them.` } : {}),
    };
  }
  if (found.matches > 1 || !found.lb) {
    return { ...base, presence: "unknown", attributes: unknownAttributes(names, "error", "more than one load balancer carries this node's Zenith tags"), error: `${found.matches} load balancers carry the Zenith tags of ${node.address}; refusing to pick one.` };
  }
  const lb = found.lb as LoadBalancer & { LoadBalancerArn: string };
  const lbArn = lb.LoadBalancerArn;
  const tags = found.tags ?? {};

  const [listeners, groups, lbAttrs] = await Promise.all([
    attempt(() => listListeners(ctx, elb, lbArn), ctx.signal),
    attempt(() => loadTargetGroups(ctx, elb, lbArn), ctx.signal),
    attempt(async () => (await elb.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: lbArn }), { abortSignal: ctx.signal })).Attributes ?? [], ctx.signal),
  ]);
  const tgTags = groups.ok ? await attempt(() => loadTags(ctx, elb, groups.value.map((g) => g.TargetGroupArn).filter((a): a is string => typeof a === "string")), ctx.signal) : undefined;
  const rules = listeners.ok ? await attempt(async () => Promise.all(listeners.value.filter((l) => l.ListenerArn).map(async (l) => ({ listener: l, rules: await listRules(ctx, elb, l.ListenerArn as string) }))), ctx.signal) : undefined;

  const groupKeyByArn = new Map<string, string>();
  if (groups.ok && tgTags?.ok) for (const g of groups.value) if (g.TargetGroupArn) groupKeyByArn.set(g.TargetGroupArn, tgKey(g, tgTags.value.get(g.TargetGroupArn)));

  // Each derived attribute is only as good as every read it depends on: the first failed one makes it unknown.
  const firstFailure = (...deps: (Attempt<unknown> | undefined)[]): Attempt<unknown> | undefined => deps.find((d) => d !== undefined && !d.ok);
  const reads: Record<string, Attempt<unknown> | undefined> = {
    scheme: { ok: true, value: lb.Scheme },
    state: { ok: true, value: lb.State?.Code },
    listeners: listeners.ok ? { ok: true, value: observedListeners(listeners.value) } : listeners,
    sslPolicy: listeners.ok ? { ok: true, value: listeners.value.find((l) => l.Protocol === "HTTPS")?.SslPolicy ?? null } : listeners,
    targetGroups:
      firstFailure(groups, tgTags) ??
      (groups.ok ? { ok: true, value: groups.value.map((g) => `${groupKeyByArn.get(g.TargetGroupArn ?? "") ?? "?"}:${g.HealthCheckPath ?? ""}`).sort() } : undefined),
    routes: firstFailure(listeners, rules, groups, tgTags) ?? (rules?.ok ? { ok: true, value: routeKeysFromRules(rules.value, groupKeyByArn) } : undefined),
    dropInvalidHeaderFields: lbAttrs.ok ? { ok: true, value: lbAttrs.value.find((a) => a.Key === "routing.http.drop_invalid_header_fields.enabled")?.Value === "true" } : lbAttrs,
  };
  const targetGroupsByRoute: Record<string, string> = {};
  if (rules?.ok) {
    for (const { rules: rs } of rules.value) {
      for (const r of rs) {
        if (r.IsDefault) continue;
        const { host, path } = ruleRoute(r);
        const arn = ruleTargetGroupArn(r);
        if (host && arn) targetGroupsByRoute[`${host}${path}`] = arn;
      }
    }
  }
  const nativeOf = (key: string): unknown => (lbAttrs.ok ? lbAttrs.value.find((a) => a.Key === key)?.Value : undefined);
  return {
    ...base,
    externalId: lbArn,
    presence: "present",
    attributes: attributesFromAttempts(ctx, names, reads),
    native: boundNative(
      {
        loadBalancerArn: lbArn,
        dnsName: lb.DNSName,
        canonicalHostedZoneId: lb.CanonicalHostedZoneId,
        state: lb.State?.Code,
        type: lb.Type,
        scheme: lb.Scheme,
        vpcId: lb.VpcId,
        securityGroups: lb.SecurityGroups,
        zones: (lb.AvailabilityZones ?? []).map((z) => ({ zone: z.ZoneName, subnetId: z.SubnetId })),
        deletionProtection: nativeOf("deletion_protection.enabled"),
        targetGroupArns: groups.ok ? groups.value.map((g) => g.TargetGroupArn).filter((a): a is string => typeof a === "string").sort() : undefined,
        targetGroupsByRoute: rules?.ok ? targetGroupsByRoute : undefined,
        listenerArns: listeners.ok ? listeners.value.map((l) => l.ListenerArn).filter((a): a is string => typeof a === "string").sort() : undefined,
        tags,
      },
      { priority: NATIVE_PRIORITY }
    ),
  };
}

/** `{ port, protocol, redirect? }` per listener, sorted by port: the same shape `expectedAlbAttributes` produces. */
function observedListeners(listeners: Listener[]): ListenerEntry[] {
  return listeners
    .filter((l) => typeof l.Port === "number" && (l.Protocol === "HTTP" || l.Protocol === "HTTPS"))
    .map((l): ListenerEntry => ({ port: l.Port as number, protocol: l.Protocol as "HTTP" | "HTTPS", ...((l.DefaultActions ?? []).some((a) => a.Type === "redirect") ? { redirect: true as const } : {}) }))
    .sort((x, y) => x.port - y.port);
}

function routeKeysFromRules(perListener: { listener: Listener; rules: Rule[] }[], groupKeyByArn: Map<string, string>): string[] {
  const keys: string[] = [];
  for (const { listener, rules } of perListener) {
    for (const r of rules) {
      if (r.IsDefault) continue;
      const { host, path } = ruleRoute(r);
      const arn = ruleTargetGroupArn(r);
      const target = arn ? groupKeyByArn.get(arn) : undefined;
      keys.push(host && target ? `${listener.Port} ${host}${path} -> ${target}` : `${listener.Port} other:${r.Priority ?? "?"}`);
    }
  }
  return keys.sort();
}

/* --------------------------------- runtime --------------------------------- */

/** Signals are `name:segment:segment` with segments `[A-Za-z0-9_.-]{1,64}` (the incident engine drops anything else). */
const signalLabel = (text: string): string => text.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "target-group";

async function runtimeAlb(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  const elb = ctx.session.client(ElasticLoadBalancingV2Client);
  const unknown = (signal: string) => runtimeState(ctx, node, SOURCE, "unknown", {}, [signal]);
  let found;
  try {
    found = await findLoadBalancer(ctx, elb, node.address, externalId);
  } catch (error) {
    const f = classifyAwsError(error, ctx.signal);
    if (f.kind === "aborted") throw error;
    return unknown(`read_failed:${f.kind === "inaccessible" ? "access_denied" : f.kind}`);
  }
  if (!found.lb?.LoadBalancerArn) return unknown(found.matches === 0 ? "load_balancer_missing" : "load_balancer_ambiguous");
  const lbArn = found.lb.LoadBalancerArn;

  let groups: TargetGroup[];
  let names: Map<string, Record<string, string>>;
  try {
    groups = await loadTargetGroups(ctx, elb, lbArn);
    names = await loadTags(ctx, elb, groups.map((g) => g.TargetGroupArn).filter((a): a is string => typeof a === "string"));
  } catch (error) {
    const f = classifyAwsError(error, ctx.signal);
    if (f.kind === "aborted") throw error;
    return unknown(`read_failed:${f.kind === "inaccessible" ? "access_denied" : f.kind}`);
  }
  if (groups.length === 0) return runtimeState(ctx, node, SOURCE, "unknown", { target_groups: 0 }, ["no_target_groups"]);

  const counts: Record<string, number> = { target_groups: groups.length, targets: 0, targets_healthy: 0, targets_unhealthy: 0, targets_initial: 0, targets_draining: 0, targets_unused: 0, targets_unavailable: 0 };
  const reasons = new Map<string, number>();
  const signals: string[] = [];
  let groupsWithoutHealthy = 0;
  let groupsWithUnhealthy = 0;
  for (const g of groups) {
    const label = signalLabel((names.get(g.TargetGroupArn ?? "") ?? {})[TARGET_TAG] ?? g.TargetGroupName ?? "target-group");
    try {
      const r = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: g.TargetGroupArn }), { abortSignal: ctx.signal });
      const descriptions = r.TargetHealthDescriptions ?? [];
      let healthy = 0;
      let unhealthy = 0;
      for (const d of descriptions) {
        counts.targets++;
        const state = d.TargetHealth?.State ?? "unavailable";
        if (state === "healthy") healthy++;
        else if (state === "unhealthy") unhealthy++;
        const bucket = state === "unhealthy.draining" ? "draining" : state;
        counts[`targets_${bucket}` in counts ? `targets_${bucket}` : "targets_unavailable"]++;
        if (state !== "healthy" && d.TargetHealth?.Reason) {
          const reason = REASON.test(d.TargetHealth.Reason) ? d.TargetHealth.Reason : "Other";
          reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        }
      }
      if (descriptions.length === 0) signals.push(`target_group_no_targets:${label}`);
      if (healthy === 0) groupsWithoutHealthy++;
      if (unhealthy > 0) groupsWithUnhealthy++;
    } catch (error) {
      const f = classifyAwsError(error, ctx.signal);
      if (f.kind === "aborted") throw error;
      signals.push(`read_failed:${label}:${f.kind === "inaccessible" ? "access_denied" : f.kind}`);
      groupsWithoutHealthy++;
    }
  }
  if (counts.targets_unhealthy > 0) signals.push(`target_unhealthy:${counts.targets_unhealthy}`);
  for (const [reason, n] of [...reasons].sort(([a], [b]) => (a < b ? -1 : 1))) signals.push(`target_reason:${reason}:${n}`);
  if (counts.targets === 0) signals.push("no_registered_targets");

  const unreadable = signals.some((s) => s.startsWith("read_failed:"));
  const health: HealthState = unreadable && counts.targets === 0 ? "unknown" : groupsWithoutHealthy === groups.length ? "unhealthy" : groupsWithoutHealthy > 0 || groupsWithUnhealthy > 0 ? "degraded" : "healthy";
  return runtimeState(ctx, node, SOURCE, health, counts, signals);
}

/* --------------------------------- verify ---------------------------------- */

async function verifyAlb(ctx: AwsDriverContext, node: ResourceNode, observation: Observation, runtime?: RuntimeState) {
  const base = standardVerification(ctx, node, observation, expectedAlbAttributes(node), "the load balancer");
  if (observation.presence !== "present") return base;
  const checks: VerificationCheck[] = [...base.checks];
  const healthy: boolean | "unknown" = !runtime || runtime.health === "unknown" ? "unknown" : runtime.health === "healthy";
  checks.push({
    id: "targets_healthy",
    description: "every target group has healthy targets",
    passed: healthy,
    ...(healthy === true ? {} : { detail: !runtime ? "target health was not read" : `health is ${runtime.health}${runtime.signals.length ? ` (${runtime.signals.join(", ")})` : ""}` }),
  });
  return verificationResult(ctx, node, checks);
}

/* -------------------------------- discovery -------------------------------- */

async function discoverAlbs(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const elb = ctx.session.client(ElasticLoadBalancingV2Client);
  const { items } = await paginate(
    async (m) => {
      const r = await elb.send(new DescribeLoadBalancersCommand({ Marker: m, PageSize: 100 }), { abortSignal: ctx.signal });
      return { items: r.LoadBalancers ?? [], next: r.NextMarker };
    },
    { maxPages: MAX_LB_PAGES, signal: ctx.signal }
  );
  const apps = items.filter((l): l is LoadBalancer & { LoadBalancerArn: string } => typeof l.LoadBalancerArn === "string" && l.Type === "application");
  const tags = new Map<string, Record<string, string>>();
  for (const batch of chunk(apps.map((l) => l.LoadBalancerArn), 20)) {
    try {
      for (const [arn, t] of await loadTags(ctx, elb, batch)) tags.set(arn, t);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
    }
  }
  return apps.map((l) => ({
    provider: "aws" as const,
    kind: "load_balancer" as const,
    nativeType: "aws:alb",
    externalId: l.LoadBalancerArn,
    name: l.LoadBalancerName ?? l.LoadBalancerArn,
    region: ctx.region,
    zenithTagged: hasZenithManagedTag(tags.get(l.LoadBalancerArn) ?? {}),
    attributes: { scheme: l.Scheme ?? "", dnsName: l.DNSName ?? "", vpcId: l.VpcId ?? "", state: l.State?.Code ?? "unknown" },
  }));
}

export const albDriver: ResourceDriver<AwsSession> = {
  id: SOURCE,
  provider: "aws",
  kind: "load_balancer",
  nativeType: "aws:alb",
  capabilities: {
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileLoadBalancer,
  observe: observeAlb,
  runtime: runtimeAlb,
  expectedAttributes: expectedAlbAttributes,
  verify: verifyAlb,
  discover: discoverAlbs,
};
