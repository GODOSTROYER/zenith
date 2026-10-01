/**
 * The per-capability request allowlist is the boundary the runner enforces. These
 * tests prove (1) the matcher, (2) that EVERY request the drivers make is inside
 * the allowlist of the capability it belongs to, (3) the whole stack works end to
 * end through the runner-backed transport (payload validation, serialization,
 * response decoding), and (4) the protocol document lists exactly what the code
 * allows.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeRule, isAllowed, OCI_ALLOWLIST, OBSERVE_RULES, ruleMatches } from "@/lib/providers/oci/allowlist";
import { ociDrivers } from "@/lib/providers/oci/drivers";
import { createRunnerOciTransport, type OciHttpJobPayload, type OciHttpJobResult } from "@/lib/providers/oci/runner-transport";
import { OCI_SERVICE_HOSTS } from "@/lib/providers/oci/services";
import type { OciApiRequest, OciApiResponse, OciApiTransport } from "@/lib/providers/oci/transport";
import type { Observation, ResourceNode } from "@/lib/resources";
import { capability } from "@/lib/capabilities/catalog";
import { driverContext, driverFor, expandOci, nodeOf, REGION, webStack, type FakeOci } from "./_support";
import { healthyWorld } from "./_world";
import { moreGraph } from "./_more";

const graph = expandOci();
const observable = (n: { nativeType: string; ownership: string }) => !n.nativeType.startsWith("unsupported:") && !(n.nativeType === "oci:vault_secret" && n.ownership !== "managed");


/** The web stack, plus a graph with a registry (git source) and a block volume, so every driver has a node. */
function richGraphs() {
  const m = webStack();
  m.services[1] = { ...m.services[1], source: { type: "git", repo: "github.com/acme/worker", ref: "main" } };
  const withRepo = expandOci(m);
  const volume = { ...nodeOf(graph, "object_store/assets"), address: "volume/data", kind: "volume", nativeType: "oci:block_volume", spec: { sizeGb: 100, deletionPolicy: "deny" } } as ResourceNode;
  return [graph, moreGraph({ ...withRepo, nodes: [...withRepo.nodes, volume] })];
}

class Recording implements OciApiTransport {
  readonly seen: OciApiRequest[] = [];
  constructor(private readonly inner: OciApiTransport) {}
  async request(req: OciApiRequest, opts?: { signal?: AbortSignal }): Promise<OciApiResponse> {
    this.seen.push(structuredClone(req));
    return this.inner.request(req, opts);
  }
}

describe("matcher", () => {
  const rule = { service: "core", method: "GET", pattern: "vcns/{}" } as const;
  it.each([
    ["/20160918/vcns/ocid1.vcn.oc1.iad.x", true],
    ["/20160918/vcns", false],
    ["/20160918/vcns/x/y", false],
    ["/20160918/vcns/", false],
    ["/20170115/vcns/x", false],
    ["/vcns/x", false],
    ["/20160918/subnets/x", false],
  ])("%s → %s", (p, want) => {
    expect(ruleMatches(rule, { service: "core", method: "GET", path: p })).toBe(want);
  });

  it("method and service must match; unknown capabilities may do nothing", () => {
    expect(ruleMatches(rule, { service: "core", method: "POST", path: "/20160918/vcns/x" })).toBe(false);
    expect(ruleMatches(rule, { service: "loadbalancer", method: "GET", path: "/20160918/vcns/x" })).toBe(false);
    expect(isAllowed("nope", { service: "core", method: "GET", path: "/20160918/vcns" })).toBe(false);
    expect(isAllowed("infrastructure.observe", { service: "core", method: "GET", path: "/20160918/vcns" })).toBe(true);
  });

  it("objectstorage rules have no version prefix", () => {
    expect(isAllowed("infrastructure.observe", { service: "objectstorage", method: "GET", path: "/n/tenantns/b/my-bucket" })).toBe(true);
    expect(isAllowed("infrastructure.observe", { service: "objectstorage", method: "GET", path: "/n/tenantns/b/my-bucket/o/secret.txt" })).toBe(false);
  });
});

describe("what is never allowed", () => {
  const all = Object.values(OCI_ALLOWLIST).flat();

  it("no DELETE anywhere, no secret-bundle retrieval, no object-level Object Storage, no IAM writes", () => {
    expect(all.filter((r) => r.method === ("DELETE" as string))).toEqual([]);
    expect(all.map(describeRule).join("\n")).not.toMatch(/secretbundles|\/o\/|changeCompartment/);
    expect(all.filter((r) => r.service === "identity" && r.method !== "GET")).toEqual([]);
    for (const cap of ["topology.read", "firewall.inspect"]) {
      expect(OCI_ALLOWLIST[cap].every((r) => r.method === "GET"), cap).toBe(true);
    }
    expect(OCI_ALLOWLIST["infrastructure.observe"].filter((r) => r.method !== "GET").map(describeRule)).toEqual([
      "loggingsearch POST /20190909/search",
      "monitoring POST /20180401/metrics/actions/summarizeMetricsData",
    ]);
  });

  it("each mutating rule belongs to exactly the capability that needs it", () => {
    // Capability metadata distinguishes fixed read POSTs from mutations.
    const mutating = Object.entries(OCI_ALLOWLIST).filter(([cap]) => capability(cap).mutates).flatMap(([cap, rules]) => rules.filter((r) => r.method !== "GET").map((r) => `${cap}: ${describeRule(r)}`));
    expect(mutating.sort()).toEqual([
      "database.snapshot: postgresql POST /20220915/backups",
      "secret.write: vault PUT /20180608/secrets/{}",
      "service.restart: containerinstances POST /20210415/containerInstances/{}/actions/restart",
    ]);
  });

  it("every rule's service exists and patterns contain no wildcard other than {}", () => {
    for (const r of all) {
      expect(Object.keys(OCI_SERVICE_HOSTS)).toContain(r.service);
      expect(r.pattern).toMatch(/^(?:[A-Za-z]+|\{\})(?:\/(?:[A-Za-z]+|\{\}))*$/);
    }
  });
});

describe("every driver request is inside its capability's allowlist", () => {
  it("observe / runtime / verify / discover only make observe-allowed calls, and every observe rule is exercised", async () => {
    const rec = new Recording(healthyWorld(graph).oci);
    for (const g of richGraphs()) {
      const world = healthyWorld(g);
      const recording = new Recording(world.oci);
      const ctx = driverContext(recording);
      for (const node of g.nodes.filter(observable)) {
        const d = driverFor(node);
        const obs = await d.observe!(ctx, node);
        const rt = d.runtime ? await d.runtime(ctx, node) : undefined;
        await d.verify!(ctx, node, obs, rt);
        // the by-id path, once the id is known
        if (obs.externalId) await d.observe!(ctx, node, obs.externalId);
      }
      for (const d of ociDrivers) if (d.discover) await d.discover(ctx);
      // an unhealthy backend set makes the load balancer driver read that set's health too
      world.db.lbHealth = { status: "CRITICAL", critical: ["bs_web"] };
      const lb = g.nodes.find((n) => n.nativeType === "oci:load_balancer")!;
      await driverFor(lb).runtime!(ctx, lb);
      rec.seen.push(...recording.seen);
    }
    const outside = rec.seen.filter((r) => !isAllowed("infrastructure.observe", r)).map((r) => `${r.service} ${r.method} ${r.path}`);
    expect(outside).toEqual([]);
    expect(rec.seen.length).toBeGreaterThan(100);
    // no dead weight: every observe rule is exercised by some driver
    const unused = OBSERVE_RULES.filter((rule) => !rec.seen.some((r) => ruleMatches(rule, r))).map(describeRule);
    expect(unused).toEqual([]);
  });

  it("each operation only makes calls from its own capability's rules", async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ["secret.write", graph.nodes.find((n) => n.address.startsWith("secret/session-secret"))!.address, { resolveValue: () => "v" }],
      ["service.restart", "container_service/web", {}],
      ["database.snapshot", "postgres/db", {}],
      ["firewall.inspect", "firewall/web-to-db", {}],
    ];
    for (const [capability, address, input] of cases) {
      const world = healthyWorld(graph);
      const rec = new Recording(world.oci);
      const node = nodeOf(graph, address);
      const r = await driverFor(node).operations![capability](driverContext(rec), node, input);
      expect(r.ok, `${capability}: ${r.summary}`).toBe(true);
      expect(rec.seen.length, capability).toBeGreaterThan(0);
      expect(rec.seen.filter((q) => !isAllowed(capability, q)).map((q) => `${q.method} ${q.path}`), capability).toEqual([]);
      // and the observe capability alone could not have done the mutation
      expect(rec.seen.some((q) => q.method !== "GET" && isAllowed("infrastructure.observe", q)), capability).toBe(false);
    }
  });
});

/** A runner stand-in: decodes the unsigned payload exactly as a runner would and answers from the fake OCI. */
function runnerOver(oci: FakeOci, seen: OciHttpJobPayload[] = []) {
  return async (p: OciHttpJobPayload): Promise<OciHttpJobResult> => {
    seen.push(p);
    const res = await oci.request({
      service: p.service,
      region: p.region,
      method: p.method,
      path: p.path,
      query: Object.fromEntries(p.query),
      headers: p.headers,
      body: p.bodyB64 ? JSON.parse(Buffer.from(p.bodyB64, "base64").toString("utf8")) : undefined,
      endpointHost: p.endpointHost,
    });
    return { status: res.status, headers: res.headers, bodyB64: res.body === undefined ? undefined : Buffer.from(JSON.stringify(res.body), "utf8").toString("base64") };
  };
}

describe("end to end through the runner-backed transport", () => {
  it("the whole healthy stack observes, runs and verifies through serialized oci.http jobs", async () => {
    const world = healthyWorld(graph);
    const jobs: OciHttpJobPayload[] = [];
    const transport = createRunnerOciTransport(runnerOver(world.oci, jobs), { capability: "infrastructure.observe" });
    const ctx = driverContext(transport);
    const observations: Observation[] = [];
    for (const node of graph.nodes.filter(observable)) {
      const d = driverFor(node);
      const obs = await d.observe!(ctx, node);
      observations.push(obs);
      const rt = d.runtime ? await d.runtime(ctx, node) : undefined;
      const v = await d.verify!(ctx, node, obs, rt);
      expect(obs.presence, `${node.address}: ${obs.error}`).toBe("present");
      expect(v.checks.filter((c) => c.passed === false), node.address).toEqual([]);
    }
    expect(jobs.length).toBeGreaterThan(50);
    // every job is unsigned, host-less and region-scoped
    for (const j of jobs) {
      expect(j.region).toBe(REGION);
      expect(Object.keys(j.headers)).toEqual([]);
      expect(JSON.stringify(j)).not.toMatch(/authorization|signature|oraclecloud\.com\/|https?:/i);
    }
    // the queue data-plane call carries its endpoint host, and nothing else does
    const withHost = jobs.filter((j) => j.endpointHost);
    expect(withHost.length).toBeGreaterThan(0);
    expect(withHost.every((j) => j.service === "queue-data")).toBe(true);
  });

  it("a tenancy-scoped OCID in a path (dynamic group, policy) passes the transport's path check", async () => {
    const world = healthyWorld(graph);
    const transport = createRunnerOciTransport(runnerOver(world.oci), { capability: "infrastructure.observe" });
    const id = world.ids.get("identity/web")!;
    const withEmptyRegion = id.replace(/\.oc1\.[^.]+\./, ".oc1..");
    expect(withEmptyRegion).toContain("oc1..");
    const res = await transport.request({ service: "identity", region: REGION, method: "GET", path: `/20160918/dynamicGroups/${withEmptyRegion}` });
    expect(res.status).toBe(404); // the fake has no such group; the point is the request was NOT refused
  });

  it("a session minted for observe cannot be used to write, even by a buggy driver", async () => {
    const world = healthyWorld(graph);
    const transport = createRunnerOciTransport(runnerOver(world.oci), { capability: "infrastructure.observe" });
    const node = nodeOf(graph, "container_service/web");
    const r = await driverFor(node).operations!["service.restart"](driverContext(transport), node, {});
    expect(r.ok).toBe(false);
    expect(world.oci.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("the operations work through the transport with their own capability", async () => {
    const world = healthyWorld(graph);
    const secret = graph.nodes.find((n) => n.address.startsWith("secret/session-secret"))!;
    const jobs: OciHttpJobPayload[] = [];
    const t = createRunnerOciTransport(runnerOver(world.oci, jobs), { capability: "secret.write" });
    const r = await driverFor(secret).operations!["secret.write"](driverContext(t), secret, { resolveValue: () => "v-canary" });
    expect(r.ok).toBe(true);
    const put = jobs.find((j) => j.method === "PUT")!;
    expect(JSON.parse(Buffer.from(put.bodyB64!, "base64").toString("utf8")).secretContent.content).toBe(Buffer.from("v-canary").toString("base64"));
  });
});

describe("the protocol document and the code agree", () => {
  // The scoped workstream documents additive rules in deploy/oci; the shared
  // protocol remains owned by the orchestrator. Both must describe every rule.
  const doc = ["docs/platform/RUNNER-PROTOCOL-OCI.md", "deploy/oci/DRIVERS-MORE.md"].map((file) => fs.readFileSync(path.join(process.cwd(), file), "utf8")).join("\n");

  it("lists every allowlist rule of every capability", () => {
    for (const [cap, rules] of Object.entries(OCI_ALLOWLIST)) {
      for (const rule of rules) expect(doc, `${cap}: ${describeRule(rule)}`).toContain(describeRule(rule));
      expect(doc).toContain(`\`${cap}\``);
    }
  });

  it("lists every service with its host and API version", () => {
    for (const [id, h] of Object.entries(OCI_SERVICE_HOSTS)) {
      expect(doc, id).toContain(`| \`${id}\` |`);
      if (id !== "queue-data") expect(doc, id).toContain(h.host);
      if (h.version) expect(doc, id).toContain(`\`${h.version}\``);
    }
  });

  it("states the implemented scope, that nothing is live-verified, and the sensitive-payload requirement", () => {
    expect(doc).toMatch(/IMPLEMENTED AND WIRED; NOT LIVE-VERIFIED/);
    expect(doc).toMatch(/sealedBodyB64/);
    expect(doc).toMatch(/oci\.secretWrite: false/);
    expect(doc).toContain("go/internal/oci/");
    expect(doc).toContain("go/internal/runner/kinds/ocihttp");
  });
});
