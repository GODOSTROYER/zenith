/**
 * Analysis stages of expansion: read env vars, bindings and routes and record
 * what they imply (secret reads, ordering dependencies, identity grants,
 * firewall candidates, edges) BEFORE any node is emitted, so node specs are
 * built once with everything they need. No node is created here.
 */
import type { Binding } from "@/lib/domain/types";
import type { Ctx, ResInfo, SvcInfo } from "./expand-context";
import { cmp, secretAddress, type Place } from "./expand-support";
import { looksSecretKey, urlHasCredentials } from "./secrets";

export const LB_ADDRESS = "load_balancer/public";

/* ------------------------------- env vars -------------------------------- */

/**
 * Split each managed service's env into plain values and secret references.
 *
 *   - `secretRef` wins. If a var also carries an inline `value`, the value is
 *     NOT copied into the graph (that is the leak this guards against).
 *   - A plain `value` under a credential-looking key is kept — the manifest is
 *     the user's — but flagged, so it gets moved to a reference.
 *   - `ZENITH_CHAOS` is sandbox-only failure injection and never ships to a
 *     real provider (same rule as the existing AWS export).
 */
export function analyzeEnv(ctx: Ctx): void {
  for (const info of ctx.svcs.values()) {
    if (!info.managed) continue;
    const name = info.s.name;
    const ordered = info.s.env.map((e, i) => ({ e, i })).sort((a, b) => cmp(a.e.key, b.e.key) || a.i - b.i);
    for (const { e } of ordered) {
      if (e.key === "ZENITH_CHAOS" && info.place.provider !== "sandbox") {
        ctx.b.note("env", `${name}.ZENITH_CHAOS is sandbox-only failure injection and is not carried to ${info.place.provider}.`);
        continue;
      }
      const ref = e.secretRef !== undefined && e.secretRef !== "" ? e.secretRef : undefined;
      if (ref !== undefined) {
        if (e.value !== undefined)
          ctx.b.note("secrets", `${name}.${e.key} has both a value and a secretRef; only the reference is kept, the inline value is not copied into the graph.`);
        info.env.push({ key: e.key, secretRef: ref });
        info.secretReads.push({ key: e.key, ref });
        info.deps.add(secretAddress(ref));
        grant(info, secretAddress(ref), ["read"], `env:${e.key}`, true);
      } else if (e.value !== undefined) {
        info.env.push({ key: e.key, value: e.value });
        if (looksSecretKey(e.key) || urlHasCredentials(e.value))
          ctx.b.note(
            "secrets",
            `${name}.${e.key} ${looksSecretKey(e.key) ? "looks like a credential" : "embeds credentials in a URL"} but holds an inline value in the manifest. It is kept as authored (the manifest is yours), not moved; store it as a secretRef so it stays out of graphs, diffs and plans.`
          );
      } else {
        ctx.b.note("env", `${name}.${e.key} declares neither a value nor a secretRef and is skipped.`);
      }
    }
  }
}

export function grant(info: SvcInfo, target: string, access: string[], via: string, dependsOn: boolean): void {
  const g = info.grants.get(target) ?? { access: new Set<string>(), via: new Set<string>() };
  for (const a of access) g.access.add(a);
  g.via.add(via);
  info.grants.set(target, g);
  if (dependsOn) info.grantDeps.add(target);
}

/* ------------------------------- bindings -------------------------------- */

export interface FirewallCandidate {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  port: number;
  capability: string;
  fromPlace: Place;
  toPlace: Place;
  origin: string[];
  description: string;
  /** set for the public-internet rule: the source is a CIDR, not a node */
  cidr?: string;
}

const TARGET_KIND: Partial<Record<Binding["capability"], string>> = {
  sql: "postgres",
  cache: "redis",
  blob: "object_store",
  queue_publish: "queue",
  queue_consume: "queue",
  smtp: "email",
};

const PORT: Partial<Record<Binding["capability"], number>> = { sql: 5432, cache: 6379 };

const BLOB_ACCESS = ["delete", "list", "read", "write"];

/** A referenced AWS API target needs an exact ARN before IAM can name it. */
function canGrant(ctx: Ctx, from: SvcInfo, to: ResInfo): boolean {
  if (from.place.provider !== "aws" || to.managed) return true;
  const service = to.r.kind === "object_store" ? "s3" : "sqs";
  const arn = to.r.externalRef;
  if (to.place.provider === "aws" && arn !== undefined &&
      /^arn:[a-z-]+:[a-z0-9-]+:[a-z0-9-]*:(?:\d{12})?:[A-Za-z0-9_+=,.@:/!-]+$/.test(arn) && arn.split(":")[2] === service) return true;
  ctx.b.note("identity", `${from.address} → ${to.address}: no IAM grant derived because this ${to.r.ownership} target has no exact ${service} ARN; supply externalRef before Zenith can scope access. The binding remains a runtime dependency.`);
  return false;
}

/**
 * Turn service→service and service→resource bindings into edges, ordering
 * dependencies, identity grants and firewall candidates. Route bindings are
 * `analyzeRoutes`' business.
 *
 * Least privilege: a grant names ONE target address and explicit verbs. Only
 * capabilities that reach a cloud API (blob, queues) or need generated
 * credentials (managed postgres) or IAM cache authentication produce grants;
 * network capabilities also produce firewall rules. `blob` is not split into read/write in V1, so it
 * grants the four verbs the existing AWS export grants.
 */
export function analyzeBindings(ctx: Ctx): FirewallCandidate[] {
  const routeIds = new Set(ctx.routes.map((r) => r.id));
  const out: FirewallCandidate[] = [];
  const b = ctx.b;

  for (const bd of ctx.bindings) {
    if (routeIds.has(bd.from)) continue;
    const from = ctx.svcs.get(bd.from);
    if (!from) {
      b.note("binding", `${bd.id} starts at ${bd.from}, which is not a service in this manifest; ignored.`);
      continue;
    }
    const toSvc = ctx.svcs.get(bd.to);
    const toRes = ctx.ress.get(bd.to);
    const to: SvcInfo | ResInfo | undefined = toSvc ?? toRes;
    if (!to) {
      b.note("binding", `${bd.id} (${from.name}, ${bd.capability}) points at ${bd.to}, which is not in this manifest; ignored.`);
      continue;
    }

    if (bd.capability === "http") {
      if (!toSvc) {
        b.note("binding", `${bd.id}: http from ${from.name} must target a service, but ${to.name} is a resource; ignored.`);
        continue;
      }
    } else {
      const want = TARGET_KIND[bd.capability];
      if (!toRes || toRes.r.kind !== want) {
        b.note("binding", `${bd.id}: ${bd.capability} from ${from.name} expects a ${want} target, but ${to.name} is not; ignored.`);
        continue;
      }
      if (!toRes.modelled) {
        b.note("binding", `${bd.id}: ${bd.capability} from ${from.name} to ${to.name} ignored; ${to.name} (${toRes.r.kind}) has no portable primitive, so no infrastructure is derived for it.`);
        continue;
      }
    }

    const targetPort = toSvc ? toSvc.s.port : PORT[bd.capability];
    const relation: "connects_to" | "publishes_to" | "consumes_from" =
      bd.capability === "queue_publish" ? "publishes_to" : bd.capability === "queue_consume" ? "consumes_from" : "connects_to";
    const detail =
      bd.capability === "http" ? (targetPort ? `http:${targetPort}` : "http") : PORT[bd.capability] ? `${bd.capability}:${PORT[bd.capability]}` : bd.capability;
    b.edge(from.address, to.address, relation, detail);

    if (!from.managed || from.kind === "static_site") continue;
    // Ordering: a store must exist before its client. Service → service calls are runtime
    // dependencies, not provisioning order (two services may call each other).
    if (toRes && to.managed) from.deps.add(to.address);

    // Identity grants: exact target, explicit verbs.
    if (bd.capability === "blob" && canGrant(ctx, from, toRes!)) grant(from, to.address, BLOB_ACCESS, "binding:blob", to.managed);
    else if (bd.capability === "queue_publish" && canGrant(ctx, from, toRes!)) grant(from, to.address, ["publish"], "binding:queue_publish", to.managed);
    else if (bd.capability === "queue_consume" && canGrant(ctx, from, toRes!)) grant(from, to.address, ["consume"], "binding:queue_consume", to.managed);
    else if (bd.capability === "sql" && to.managed) grant(from, to.address, ["read_credentials"], "binding:sql", true);
    else if (bd.capability === "cache" && to.managed) grant(from, to.address, ["connect"], "binding:cache", true);

    // Firewall: only capabilities that travel over the network.
    if (bd.capability !== "sql" && bd.capability !== "cache" && bd.capability !== "http") continue;
    if (toSvc && toSvc.kind === "static_site") continue;
    if (targetPort === undefined) {
      b.note("binding", `${from.name} → ${to.name} (${bd.capability}): ${to.name} has no port, so no firewall rule could be derived.`);
      continue;
    }
    if (!to.managed) {
      b.note(
        "binding",
        `${from.name} → ${to.name} (${bd.capability}): ${to.name} is ${toSvc ? toSvc.s.ownership : toRes!.r.ownership}, so Zenith adds no firewall rule to it. Make sure it accepts connections from ${from.name} on port ${targetPort}.`
      );
      continue;
    }
    out.push({
      from: from.address,
      fromName: from.name,
      to: to.address,
      toName: to.name,
      port: targetPort,
      capability: bd.capability,
      fromPlace: from.place,
      toPlace: to.place,
      origin: [bd.id, from.id, to.id],
      description: `${from.name} reaches ${to.name} (${bd.capability}) on tcp/${targetPort}`,
    });
  }
  return out;
}

/* --------------------------------- routes -------------------------------- */

export interface RouteUse {
  route: Ctx["routes"][number];
  /** lowercased host */
  host: string;
  target: SvcInfo;
}

/**
 * Which routes lead to a service Zenith runs. A route to a web service needs
 * the load balancer; a route to a static site needs DNS and a certificate only.
 * Routes into referenced/external services, workers or nothing are reported
 * and derive no infrastructure: Zenith does not wire ingress into services it
 * does not own.
 */
export function analyzeRoutes(ctx: Ctx): RouteUse[] {
  const routeById = new Map(ctx.routes.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const uses: RouteUse[] = [];
  for (const bd of ctx.bindings) {
    const route = routeById.get(bd.from);
    if (!route) continue;
    seen.add(route.id);
    const host = route.host.toLowerCase();
    if (bd.capability !== "http") {
      ctx.b.note("route", `${host}: binding ${bd.id} uses ${bd.capability}, but a route can only be bound with http; ignored.`);
      continue;
    }
    const target = ctx.svcs.get(bd.to);
    if (!target) {
      ctx.b.note("route", `${host} is bound to ${bd.to}, which is not a service in this manifest; ignored.`);
      continue;
    }
    if (!target.managed) {
      ctx.b.note("route", `${host} → ${target.name}: ${target.name} is ${target.s.ownership}, and Zenith does not wire ingress into services it does not run; no load balancer, DNS or certificate derived for it.`);
      continue;
    }
    if (target.s.kind === "worker" || target.s.kind === "cron") {
      ctx.b.note("route", `${host} → ${target.name}: a ${target.s.kind} service does not serve HTTP; ignored.`);
      continue;
    }
    uses.push({ route, host, target });
  }
  for (const r of ctx.routes)
    if (!seen.has(r.id)) ctx.b.note("route", `${r.host.toLowerCase()} is not bound to a service; no DNS, certificate or load balancer rule derived.`);
  return uses.sort((x, y) =>
    cmp(`${x.host}\0${x.route.pathPrefix}\0${x.target.address}\0${x.route.id}`, `${y.host}\0${y.route.pathPrefix}\0${y.target.address}\0${y.route.id}`)
  );
}
