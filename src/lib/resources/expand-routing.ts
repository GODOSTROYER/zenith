/**
 * Routing and firewall stages of expansion: the load balancer, DNS records,
 * certificates and referenced zones derived from routes, and the firewall
 * rules derived from routes and bindings. See `expand.ts` for the rules.
 */
import { digest } from "@/lib/controlplane/digest";
import type { Ctx } from "./expand-context";
import { LB_ADDRESS, type FirewallCandidate, type RouteUse } from "./expand-analyze";
import { contain, netDeps, type Topologies } from "./expand-topology";
import { apexOf, cmp, uniqSorted } from "./expand-support";
import { tuningFor } from "./expand-context";
import type { DnsRecordSpec, DnsZoneSpec, FirewallSpec, LoadBalancerSpec, TlsCertificateSpec } from "./specs";

export function emitRouting(ctx: Ctx, uses: RouteUse[], topo: Topologies, firewalls: FirewallCandidate[]): void {
  const b = ctx.b;
  const lbUses = uses.filter((u) => u.target.s.kind === "web");
  const hosts = uniqSorted(uses.map((u) => u.host));
  const tlsHosts = new Set(uses.filter((u) => u.route.tls).map((u) => u.host));
  const place = ctx.defaultPlace;

  for (const u of lbUses)
    if (!u.target.s.port) b.note("route", `${u.host} → ${u.target.name}: ${u.target.name} has no port, so the load balancer has no target port to forward to.`);

  if (lbUses.length) {
    const anyTls = lbUses.some((u) => u.route.tls);
    const tuning = tuningFor(ctx.v2, place.provider);
    const spec: LoadBalancerSpec = {
      scheme: "internet-facing",
      tier: "public",
      listeners: anyTls
        ? [{ port: 80, protocol: "http", redirectToHttps: true }, { port: 443, protocol: "https" }]
        : [{ port: 80, protocol: "http" }],
      routes: lbUses.map((u) => ({
        host: u.host,
        pathPrefix: u.route.pathPrefix,
        tls: u.route.tls,
        target: u.target.address,
        ...(u.target.s.port ? { port: u.target.s.port } : {}),
        ...(u.target.s.healthPath ? { healthPath: u.target.s.healthPath } : {}),
      })),
      ...(tuning.ingressClass ? { ingressClass: tuning.ingressClass } : {}),
    };
    const certs = uniqSorted(lbUses.filter((u) => tlsHosts.has(u.host)).map((u) => `tls_certificate/${u.host}`));
    b.add({
      address: LB_ADDRESS,
      kind: "load_balancer",
      place,
      spec: { ...spec },
      origin: lbUses.flatMap((u) => [u.route.id, u.target.id]),
      dependsOn: [...netDeps(topo, place, "public"), ...certs],
    });
    contain(ctx, topo, place, LB_ADDRESS, "public");
    const targets = uniqSorted(lbUses.map((u) => u.target.address));
    b.note("routing", `${LB_ADDRESS} derived from ${lbUses.length} route${lbUses.length === 1 ? "" : "s"} to ${targets.join(", ")}; listeners ${spec.listeners.map((l) => l.port).join(" and ")}${anyTls ? " (port 80 redirects to HTTPS)" : ""}.`);
    for (const u of lbUses) b.edge(LB_ADDRESS, u.target.address, "routes_to", `${u.host}${u.route.pathPrefix}`);

    const originIds = lbUses.map((u) => u.route.id);
    for (const port of anyTls ? [80, 443] : [80])
      firewalls.push({
        from: "internet", fromName: "internet", to: LB_ADDRESS, toName: "lb", port, capability: "public_http",
        fromPlace: place, toPlace: place, origin: originIds, description: `the public internet reaches the load balancer on tcp/${port}`, cidr: "0.0.0.0/0",
      });
    for (const u of new Map(lbUses.filter((x) => x.target.s.port).map((x) => [x.target.address, x])).values())
      firewalls.push({
        from: LB_ADDRESS, fromName: "lb", to: u.target.address, toName: u.target.name, port: u.target.s.port!, capability: "http",
        fromPlace: place, toPlace: u.target.place, origin: [u.route.id, u.target.id], description: `the load balancer reaches ${u.target.name} on tcp/${u.target.s.port}`,
      });
  }

  const zones = new Set<string>();
  for (const host of hosts) {
    const hostUses = uses.filter((u) => u.host === host);
    const managedDns = hostUses.some((u) => u.route.managedDns);
    if (managedDns && hostUses.some((u) => !u.route.managedDns))
      b.note("dns", `${host} has routes with managedDns both on and off; DNS is managed for the host.`);
    const web = hostUses.find((u) => u.target.s.kind === "web");
    const target = web ? LB_ADDRESS : hostUses[0].target.address;
    if (web && hostUses.some((u) => u.target.s.kind === "static"))
      b.note("dns", `${host} serves a web service and a static site; DNS points at the load balancer.`);
    const origin = hostUses.map((u) => u.route.id);

    let zone: string | undefined;
    if (managedDns) {
      const { apex, inferred } = apexOf(host, ctx.env.baseDomain);
      zone = `dns_zone/${apex}`;
      if (!zones.has(zone)) {
        zones.add(zone);
        const zspec: DnsZoneSpec = { name: apex, private: false };
        b.add({ address: zone, kind: "dns_zone", place, ownership: "referenced", spec: { ...zspec }, origin });
        b.note(
          "dns",
          `${zone} is referenced: Zenith looks the zone up and never creates a customer's zone${inferred ? `; the apex was inferred from ${host} (heuristic, no public-suffix list) — check it` : `; ${host} is under the environment base domain`}.`
        );
      } else b.nodes.get(zone)!.origin = uniqSorted([...b.nodes.get(zone)!.origin, ...origin]);
      const rspec: DnsRecordSpec = { name: host, type: "alias", target, zone };
      b.add({ address: `dns_record/${host}`, kind: "dns_record", place, spec: { ...rspec }, origin, dependsOn: [target, zone] });
      b.edge(`dns_record/${host}`, target, "resolves_to");
      b.note("dns", `dns_record/${host} derived from the route for ${host}; it points at ${target}.`);
    } else {
      b.note("dns", `${host} has managedDns off: no DNS record is derived; point ${host} at ${target === LB_ADDRESS ? "the load balancer" : target} yourself.`);
    }
    if (tlsHosts.has(host)) {
      const cspec: TlsCertificateSpec = { domain: host, validation: managedDns ? "dns_automatic" : "dns_manual", ...(zone ? { zone } : {}) };
      b.add({ address: `tls_certificate/${host}`, kind: "tls_certificate", place, spec: { ...cspec }, origin, dependsOn: zone ? [zone] : [] });
      b.edge(`tls_certificate/${host}`, target, "secures");
      b.note("tls", `tls_certificate/${host} derived because a route for ${host} has tls on.`);
      if (!managedDns) b.note("dns", `tls_certificate/${host} needs a DNS validation record you create yourself (managedDns is off).`);
    }
  }
}

/* -------------------------------- firewalls ------------------------------- */

export function emitFirewalls(ctx: Ctx, candidates: FirewallCandidate[]): void {
  // One rule per (from, to, port); bindings that imply the same rule merge.
  const merged = new Map<string, FirewallCandidate>();
  for (const c of [...candidates].sort((x, y) => cmp(`${x.from}\0${x.to}\0${String(x.port).padStart(5, "0")}\0${x.capability}`, `${y.from}\0${y.to}\0${String(y.port).padStart(5, "0")}\0${y.capability}`))) {
    const k = `${c.from}\0${c.to}\0${c.port}`;
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, origin: [...prev.origin, ...c.origin] } : c);
  }
  const rules = [...merged.values()];
  const portsByPair = new Map<string, Set<number>>();
  for (const r of rules) portsByPair.set(`${r.from}\0${r.to}`, (portsByPair.get(`${r.from}\0${r.to}`) ?? new Set()).add(r.port));

  const claimed = new Map<string, string>();
  for (const r of rules) {
    const pair = `${r.from}\0${r.to}`;
    let address = `firewall/${r.fromName}-to-${r.toName}${portsByPair.get(pair)!.size > 1 ? `-${r.port}` : ""}`;
    const owner = claimed.get(address);
    // `a-to-b-to-c` can be (a → b-to-c) or (a-to-b → c): disambiguate by identity.
    if (owner !== undefined && owner !== `${pair}\0${r.port}`) address = `${address}-${uniqDigest(`${pair}\0${r.port}`)}`;
    claimed.set(address, `${pair}\0${r.port}`);

    const cross: FirewallSpec["crossBoundary"] = r.cidr
      ? undefined
      : r.fromPlace.provider !== r.toPlace.provider
        ? "cross_cloud"
        : r.fromPlace.region !== r.toPlace.region
          ? "cross_region"
          : undefined;
    const spec: FirewallSpec = {
      direction: "ingress",
      protocol: "tcp",
      port: r.port,
      source: r.cidr ? { cidr: r.cidr } : { address: r.from },
      target: r.to,
      capability: r.capability,
      description: r.description,
      ...(cross ? { crossBoundary: cross } : {}),
    };
    ctx.b.add({
      address,
      kind: "firewall",
      place: r.toPlace,
      spec: { ...spec },
      origin: r.origin,
      dependsOn: r.cidr ? [r.to] : [r.from, r.to],
    });
    ctx.b.edge(address, r.to, "secures", `tcp/${r.port}`);
    ctx.b.note("firewall", `${address} derived: ${r.description}.`);
  }
}

const uniqDigest = (s: string): string => digest(s).slice(0, 6);
