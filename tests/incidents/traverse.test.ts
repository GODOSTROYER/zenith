/**
 * Request-path traversal: which nodes are on the path for an entry point, in
 * what order, and that it is deterministic and cannot loop.
 */
import { describe, expect, it } from "vitest";
import { MAX_SERVICE_DEPTH, TraversalError, traverse } from "@/lib/incidents";
import type { ResourceEdge, ResourceGraph } from "@/lib/resources/types";
import { ADDR, buildGraph, node, withCache } from "./fixtures";

const hops = (g: ResourceGraph, entry?: string) => traverse(g, entry).steps.map((s) => `${s.hop}:${s.address}`);
const edge = (from: string, to: string, relation: ResourceEdge["relation"], detail?: string): ResourceEdge => ({ from, to, relation, ...(detail ? { detail } : {}) });

const FULL_PATH = [
  `dns:${ADDR.dns}`,
  `tls:${ADDR.tls}`,
  `firewall:${ADDR.fw443}`,
  `firewall:${ADDR.fw80}`,
  `load_balancer:${ADDR.lb}`,
  `firewall:${ADDR.fwLbWeb}`,
  `container:${ADDR.web}`,
  `application:${ADDR.web}`,
  `firewall:${ADDR.fwWebDb}`,
  `database:${ADDR.db}`,
  `secret:${ADDR.secret}`,
  `identity:${ADDR.identity}`,
];

describe("entry points", () => {
  it("defaults to the load balancer and walks dns → tls → firewall → lb → firewall → service → dependencies → side hops", () => {
    const p = traverse(buildGraph());
    expect(p.entry).toEqual({ address: ADDR.lb, kind: "load_balancer" });
    expect(p.steps.map((s) => `${s.hop}:${s.address}`)).toEqual(FULL_PATH);
    expect(p.notes).toEqual([]);
  });

  it("a dns_record entry (by address or by host, case-insensitively) gives the same path", () => {
    expect(hops(buildGraph(), ADDR.dns)).toEqual(FULL_PATH);
    expect(hops(buildGraph(), "App.Example.COM")).toEqual(FULL_PATH);
    expect(traverse(buildGraph(), "app.example.com").entry.kind).toBe("dns_record");
  });

  it("a service entry (by address or bare name) brings in the load balancer that routes to it, and its hosts", () => {
    expect(hops(buildGraph(), ADDR.web)).toEqual(FULL_PATH);
    expect(hops(buildGraph(), "web")).toEqual(FULL_PATH);
  });

  it("rejects anything that is not an entry point, or not in the graph", () => {
    expect(() => traverse(buildGraph(), ADDR.db)).toThrow(TraversalError);
    expect(() => traverse(buildGraph(), ADDR.db)).toThrow(/must be a dns_record/);
    expect(() => traverse(buildGraph(), "nothing/here")).toThrow(/is not an address, DNS host or service name/);
    expect(() => traverse({ ...buildGraph(), nodes: [], edges: [] })).toThrow(/no load balancer, DNS record or container service/);
  });

  it("with no load balancer it starts at the first web service, else the first container service", () => {
    const g = buildGraph();
    const noLb: ResourceGraph = {
      ...g,
      nodes: g.nodes.filter((n) => !["load_balancer", "dns_record", "tls_certificate"].includes(n.kind) && !n.address.includes("internet") && n.address !== ADDR.fwLbWeb),
      edges: g.edges.filter((e) => e.from === ADDR.web || e.from === ADDR.fwWebDb),
    };
    expect(hops(noLb)).toEqual([`container:${ADDR.web}`, `application:${ADDR.web}`, `firewall:${ADDR.fwWebDb}`, `database:${ADDR.db}`, `secret:${ADDR.secret}`, `identity:${ADDR.identity}`]);

    const worker = { ...noLb, nodes: noLb.nodes.map((n) => (n.address === ADDR.web ? { ...n, spec: { ...n.spec, workload: "worker" } } : n)) };
    expect(traverse(worker).entry.address).toBe(ADDR.web);
  });

  it("a dns record that points straight at a service walks dns, its certificate, then the service", () => {
    const g = buildGraph();
    const direct: ResourceGraph = {
      ...g,
      nodes: g.nodes.filter((n) => n.kind !== "load_balancer" && !n.address.startsWith("firewall/internet") && n.address !== ADDR.fwLbWeb),
      edges: [edge(ADDR.dns, ADDR.web, "resolves_to"), edge(ADDR.tls, ADDR.web, "secures"), ...g.edges.filter((e) => e.from === ADDR.web || e.from === ADDR.fwWebDb)],
    };
    expect(hops(direct, ADDR.dns).slice(0, 4)).toEqual([`dns:${ADDR.dns}`, `tls:${ADDR.tls}`, `container:${ADDR.web}`, `application:${ADDR.web}`]);
  });

  it("a dns record that points at something with no hop ends the path there, with a note", () => {
    const g = buildGraph();
    const odd: ResourceGraph = {
      ...g,
      nodes: [...g.nodes, node("static_site/docs", "static_site", { size: "small", artifact: { type: "image", ref: "x" } })],
      edges: [...g.edges, edge(ADDR.dns, "static_site/docs", "resolves_to")],
    };
    odd.edges = odd.edges.filter((e) => !(e.from === ADDR.dns && e.to === ADDR.lb));
    const p = traverse(odd, ADDR.dns);
    expect(p.steps.map((s) => s.hop)).toEqual(["dns"]);
    expect(p.notes.join(" ")).toMatch(/path ends there/);
  });
});

describe("what hangs off the path", () => {
  it("firewall steps carry the rule exactly as the graph states it; dependency steps say who depends on them", () => {
    const p = traverse(buildGraph());
    const fw = p.steps.find((s) => s.address === ADDR.fwWebDb)!;
    expect(fw.rule).toEqual({ source: { address: ADDR.web }, target: ADDR.db, port: 5432, capability: "sql" });
    expect(fw.dependency).toEqual({ class: "database", address: ADDR.db, client: ADDR.web, port: 5432 });
    expect(p.steps.find((s) => s.address === ADDR.db)?.dependency).toEqual({ class: "database", address: ADDR.db, client: ADDR.web, port: 5432 });
    const inet = p.steps.find((s) => s.address === ADDR.fw443)!;
    expect(inet.rule?.source).toEqual({ cidr: "0.0.0.0/0" });
    expect(inet.dependency).toBeUndefined();
    expect(p.steps.find((s) => s.hop === "secret")?.owner).toBe(ADDR.web);
    expect(p.steps.find((s) => s.hop === "identity")?.owner).toBe(ADDR.web);
  });

  it("a second dependency (a cache) gets its own firewall and node step, in address order", () => {
    const p = traverse(withCache(buildGraph()));
    const tail = p.steps.map((s) => `${s.hop}:${s.address}`).slice(8);
    expect(tail).toEqual([`firewall:${ADDR.fwWebDb}`, `database:${ADDR.db}`, "firewall:firewall/web-to-cache", "cache:redis/cache", `secret:${ADDR.secret}`, `identity:${ADDR.identity}`]);
  });

  it("a queue or an object store is a hop of its own kind", () => {
    const g = buildGraph();
    const more: ResourceGraph = {
      ...g,
      nodes: [...g.nodes, node("queue/jobs", "queue", {}), node("object_store/uploads", "object_store", {})],
      edges: [...g.edges, edge(ADDR.web, "queue/jobs", "publishes_to", "queue_publish"), edge(ADDR.web, "object_store/uploads", "connects_to", "blob")],
    };
    const hopsSeen = traverse(more).steps.map((s) => s.hop);
    expect(hopsSeen).toContain("queue");
    expect(hopsSeen).toContain("storage");
  });

  it("a shared dependency appears once, and each client keeps its own firewall", () => {
    const g = buildGraph();
    const api = node("container_service/api", "container_service", { workload: "web", replicas: 1, port: 4000, env: [] });
    const fwApiDb = node("firewall/api-to-db", "firewall", { direction: "ingress", protocol: "tcp", port: 5432, source: { address: "container_service/api" }, target: ADDR.db, capability: "sql", description: "" });
    const fwLbApi = node("firewall/lb-to-api", "firewall", { direction: "ingress", protocol: "tcp", port: 4000, source: { address: ADDR.lb }, target: "container_service/api", capability: "http", description: "" });
    const two: ResourceGraph = {
      ...g,
      nodes: [...g.nodes, api, fwApiDb, fwLbApi],
      edges: [...g.edges, edge(ADDR.lb, "container_service/api", "routes_to", "api.example.com/"), edge("container_service/api", ADDR.db, "connects_to", "sql:5432")],
    };
    const p = traverse(two);
    const addresses = p.steps.map((s) => `${s.hop}:${s.address}`);
    expect(addresses.filter((a) => a === `database:${ADDR.db}`)).toHaveLength(1);
    expect(addresses).toContain(`firewall:${ADDR.fwWebDb}`);
    expect(addresses).toContain("firewall:firewall/api-to-db");
    // routed targets are visited in address order: api before web
    expect(addresses.indexOf("container:container_service/api")).toBeLessThan(addresses.indexOf(`container:${ADDR.web}`));
    // a service entry restricts the LB hop to that service
    const only = traverse(two, ADDR.web).steps.map((s) => s.address);
    expect(only).not.toContain("container_service/api");
  });

  it("a secret read by two services is visited once; a host filter keeps other hosts' certificates out", () => {
    const g = buildGraph();
    const other = node("tls_certificate/api.example.com", "tls_certificate", { domain: "api.example.com", validation: "dns_automatic" });
    const dns2 = node("dns_record/api.example.com", "dns_record", { name: "api.example.com", type: "alias", target: ADDR.lb, zone: "z" });
    const more: ResourceGraph = {
      ...g,
      nodes: [...g.nodes, other, dns2],
      edges: [...g.edges, edge(other.address, ADDR.lb, "secures"), edge(dns2.address, ADDR.lb, "resolves_to")],
    };
    const viaDns = traverse(more, ADDR.dns).steps.map((s) => s.address);
    expect(viaDns).toContain(ADDR.tls);
    expect(viaDns).not.toContain(other.address);
    expect(viaDns).not.toContain(dns2.address);
    const viaLb = traverse(more).steps.map((s) => s.address);
    expect(viaLb).toContain(other.address);
    expect(viaLb).toContain(dns2.address);
  });
});

describe("service-to-service dependencies", () => {
  function chain(n: number): ResourceGraph {
    const g = buildGraph();
    const nodes = [...g.nodes];
    const edges = [...g.edges];
    let prev: string = ADDR.web;
    for (let i = 1; i <= n; i++) {
      const a = `container_service/s${i}`;
      nodes.push(node(a, "container_service", { workload: "web", replicas: 1, port: 3000 + i, env: [] }));
      edges.push(edge(prev, a, "connects_to", `http:${3000 + i}`));
      prev = a;
    }
    return { ...g, nodes, edges };
  }

  it("follows dependency services to a bounded depth and says what it did not probe", () => {
    const p = traverse(chain(5));
    const services = p.steps.filter((s) => s.hop === "container").map((s) => s.address);
    expect(services).toEqual([ADDR.web, "container_service/s1", "container_service/s2"]);
    expect(services).toHaveLength(MAX_SERVICE_DEPTH); // the entry service counts
    expect(p.notes.join(" ")).toMatch(/beyond the traversal depth/);
  });

  it("cannot loop on a cycle", () => {
    const g = chain(2);
    g.edges.push(edge("container_service/s2", ADDR.web, "connects_to", "http:3000"));
    const p = traverse(g);
    const containers = p.steps.filter((s) => s.hop === "container").map((s) => s.address);
    expect(new Set(containers).size).toBe(containers.length);
  });
});

describe("determinism", () => {
  it("does not depend on the order of nodes or edges in the graph", () => {
    const g = withCache(buildGraph());
    const shuffled: ResourceGraph = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
    expect(traverse(shuffled)).toEqual(traverse(g));
    expect(traverse(shuffled, ADDR.web)).toEqual(traverse(g, ADDR.web));
  });

  it("ignores edges that point at nodes the graph does not contain", () => {
    const g = buildGraph();
    g.edges.push(edge(ADDR.web, "postgres/ghost", "connects_to", "sql:5432"), edge("ghost/x", ADDR.lb, "resolves_to"));
    expect(traverse(g).steps.map((s) => `${s.hop}:${s.address}`)).toEqual(FULL_PATH);
  });
});
