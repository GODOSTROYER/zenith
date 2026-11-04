/**
 * How every OCI driver's observe/runtime/verify behave when OCI says no:
 * 200 / 404 / 401-403 / 429 / 5xx / transport failure / abort, plus the
 * honesty rules that are specific to OCI:
 *   - a 404 (NotAuthorizedOrNotFound) alone NEVER proves "missing";
 *   - "missing" needs a successful, complete compartment listing with no match;
 *   - a throttled or failed read is `unknown`, a denied one `inaccessible`;
 *   - nothing is reported as known when it was not read.
 */
import { describe, expect, it } from "vitest";
import type { Observation, ResourceNode } from "@/lib/resources";
import { driverContext, driverFor, err, expandOci, FakeOci, json, ocid, zenithTagsFor, ENV_ID } from "./_support";
import { healthyWorld } from "./_world";

const graph = expandOci();
const managed = graph.nodes.filter((n) => n.provider === "oci" && !n.nativeType.startsWith("unsupported:") && !(n.nativeType === "oci:vault_secret" && n.ownership !== "managed"));

const LIST_NAMES = new Set(["vcns", "subnets", "internetGateways", "natGateways", "networkSecurityGroups", "securityRules", "volumes", "loadBalancers", "certificates", "dynamicGroups", "policies", "logGroups", "logs", "containerInstances", "repositories", "dbSystems", "b", "queues", "secrets", "redisClusters"]);

/** Everything 200-empty for collections, 404 NotAuthorizedOrNotFound for single objects. */
function emptyWorld(): FakeOci {
  return new FakeOci().on((req) => {
    if (req.method !== "GET") return undefined;
    if (req.path === "/n") return json("tenantns");
    const last = req.path.split("/").pop()!;
    return LIST_NAMES.has(last) ? json({ items: [] }) : undefined;
  });
}

const every = (status: number, code: string, headers: Record<string, string> = {}): FakeOci => new FakeOci().on(() => err(status, code, "nope", headers));

async function observeWith(oci: FakeOci, node: ResourceNode, over = {}): Promise<Observation> {
  return driverFor(node).observe!(driverContext(oci, over), node);
}

describe("denied, throttled, unavailable, transport failure", () => {
  it.each(managed.map((n) => [n.address, n] as const))("%s: 403 is inaccessible and reads nothing", async (_a, node) => {
    const obs = await observeWith(every(403, "NotAuthenticated"), node);
    expect(obs.presence).toBe("inaccessible");
    expect(obs.attributes).toEqual({});
    expect(obs.error).toMatch(/403/);
  });

  it.each(managed.map((n) => [n.address, n] as const))("%s: 401 is inaccessible", async (_a, node) => {
    expect((await observeWith(every(401, "NotAuthenticated"), node)).presence).toBe("inaccessible");
  });

  it.each(managed.map((n) => [n.address, n] as const))("%s: 429 is unknown (never missing) and names the throttle", async (_a, node) => {
    const obs = await observeWith(every(429, "TooManyRequests", { "retry-after": "7" }), node);
    expect(obs.presence).toBe("unknown");
    expect(obs.attributes).toEqual({});
    expect(obs.error).toMatch(/429/);
  });

  it.each(managed.map((n) => [n.address, n] as const))("%s: 503 is unknown", async (_a, node) => {
    expect((await observeWith(every(503, "ServiceUnavailable"), node)).presence).toBe("unknown");
  });

  it.each(managed.map((n) => [n.address, n] as const))("%s: a transport failure is unknown and leaks no stack", async (_a, node) => {
    const oci = new FakeOci();
    oci.failWith = new Error("connect ECONNREFUSED 10.0.0.5:443\n    at secret/internal/path.js:1:1");
    const obs = await observeWith(oci, node);
    expect(obs.presence).toBe("unknown");
    expect(obs.error ?? "").not.toMatch(/secret\/internal|\n/);
  });

  it.each(managed.map((n) => [n.address, n] as const))("%s: an aborted operation makes no call", async (_a, node) => {
    const oci = new FakeOci();
    const ac = new AbortController();
    ac.abort();
    const obs = await observeWith(oci, node, { signal: ac.signal });
    expect(oci.calls).toEqual([]);
    expect(obs.presence).toBe("unknown");
  });
});

describe("404 is not proof of absence", () => {
  it.each(managed.map((n) => [n.address, n] as const))("%s: 404 NotAuthorizedOrNotFound everywhere is never `missing` or `present`", async (_a, node) => {
    const obs = await observeWith(new FakeOci(), node);
    expect(["inaccessible", "unknown"]).toContain(obs.presence);
    expect(obs.attributes).toEqual({});
  });

  it("a GET-by-id 404 is corroborated by the compartment list before `missing` is claimed", async () => {
    const node = managed.find((n) => n.address === "subnet/private-a")!;
    const oci = emptyWorld();
    const obs = await driverFor(node).observe!(driverContext(oci), node, ocid("subnet", "gone"));
    expect(obs.presence).toBe("missing");
    // it tried the id, then the list, in that order
    expect(oci.calls.map((c) => c.path)).toEqual([expect.stringMatching(/subnets\/ocid1\.subnet/), "/20160918/subnets"]);
  });

  it("a GET-by-id 404 with a DENIED list is inaccessible, not missing", async () => {
    const node = managed.find((n) => n.address === "subnet/private-a")!;
    const oci = new FakeOci().on((req) => (req.path === "/20160918/subnets" ? err(403, "NotAuthenticated") : undefined));
    const obs = await driverFor(node).observe!(driverContext(oci), node, ocid("subnet", "gone"));
    expect(obs.presence).toBe("inaccessible");
  });
});

describe("missing needs a complete, successful listing", () => {
  it.each(managed.map((n) => [n.address, n] as const))("%s: an empty, successful listing is `missing` (or `inaccessible` where the API cannot prove absence)", async (_a, node) => {
    const obs = await observeWith(emptyWorld(), node);
    const cannotProveAbsence = ["oci:dns_zone", "oci:dns_rrset"].includes(node.nativeType);
    expect(obs.presence).toBe(cannotProveAbsence ? "inaccessible" : node.address.startsWith("container_service/") && (node.spec as { replicas: number }).replicas === 0 ? "present" : "missing");
    expect(obs.attributes).toEqual({});
  });

  it("a listing truncated by the page bound cannot conclude absence", async () => {
    const node = managed.find((n) => n.address === "subnet/public-a")!;
    const oci = new FakeOci().route("GET", "/20160918/subnets", json([], { "opc-next-page": "more" }));
    const obs = await driverFor(node).observe!(driverContext(oci), node);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/pages|truncated/i);
    expect(oci.calls.length).toBe(8);
  });

  it("follows opc-next-page and finds an object on the second page", async () => {
    const node = managed.find((n) => n.address === "subnet/public-a")!;
    const mine = { id: ocid("subnet", "second"), lifecycleState: "AVAILABLE", cidrBlock: "10.0.0.0/24", prohibitPublicIpOnVnic: false, freeformTags: zenithTagsFor(node.address) };
    const oci = new FakeOci().on((req) => (req.path === "/20160918/subnets" ? (req.query?.page === "p2" ? json([mine]) : json([], { "opc-next-page": "p2" })) : undefined));
    const obs = await driverFor(node).observe!(driverContext(oci), node);
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(mine.id);
  });

  it("an object tagged for ANOTHER environment or resource is not this node", async () => {
    const node = managed.find((n) => n.address === "subnet/public-a")!;
    const other = (tags: Record<string, string>) => ({ id: ocid("subnet", "other"), lifecycleState: "AVAILABLE", cidrBlock: "10.0.0.0/24", prohibitPublicIpOnVnic: false, freeformTags: tags });
    const oci = new FakeOci().route("GET", "/20160918/subnets", json([other(zenithTagsFor(node.address, "some-other-env")), other(zenithTagsFor("subnet/elsewhere")), other({})]));
    expect((await driverFor(node).observe!(driverContext(oci), node)).presence).toBe("missing");
  });

  it("two objects with this node's tags are ambiguous: unknown, no pick", async () => {
    const node = managed.find((n) => n.address === "subnet/public-a")!;
    const dup = (n: string) => ({ id: ocid("subnet", n), lifecycleState: "AVAILABLE", cidrBlock: "10.0.0.0/24", prohibitPublicIpOnVnic: false, freeformTags: zenithTagsFor(node.address) });
    const oci = new FakeOci().route("GET", "/20160918/subnets", json([dup("a"), dup("b")]));
    const obs = await driverFor(node).observe!(driverContext(oci), node);
    expect(obs.presence).toBe("unknown");
    expect(obs.externalId).toBeUndefined();
    expect(obs.error).toMatch(/2 objects/);
  });

  it("a TERMINATED object is treated as gone", async () => {
    const node = managed.find((n) => n.address === "subnet/public-a")!;
    const dead = { id: ocid("subnet", "dead"), lifecycleState: "TERMINATED", cidrBlock: "10.0.0.0/24", freeformTags: zenithTagsFor(node.address) };
    const oci = new FakeOci().route("GET", "/20160918/subnets", json([dead]));
    expect((await driverFor(node).observe!(driverContext(oci), node)).presence).toBe("missing");
  });

  it("an externalId that is not an OCID is never put in a path", async () => {
    const node = managed.find((n) => n.address === "subnet/public-a")!;
    const oci = new FakeOci();
    const obs = await driverFor(node).observe!(driverContext(oci), node, "../../identity/policies?x=1");
    expect(obs.presence).toBe("unknown");
    expect(oci.calls).toEqual([]);
  });
});

describe("partial data and broken worlds", () => {
  it("attributes the response does not carry are `unknown`, not invented", async () => {
    const node = managed.find((n) => n.address === "subnet/private-a")!;
    const item = { id: ocid("subnet", "bare"), lifecycleState: "AVAILABLE", freeformTags: zenithTagsFor(node.address) };
    const obs = await driverFor(node).observe!(driverContext(new FakeOci().route("GET", "/20160918/subnets", json([item]))), node);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.cidr).toMatchObject({ state: "unknown" });
    expect(obs.attributes.tier).toMatchObject({ state: "unknown" });
    const v = await driverFor(node).verify!(driverContext(new FakeOci()), node, obs);
    expect(v.status).toBe("unknown");
    expect(v.checks.filter((c) => c.passed === false)).toEqual([]);
  });

  it("verify fails a missing object and reports unknown for an unreadable one", async () => {
    const node = managed.find((n) => n.address === "queue/jobs")!;
    const d = driverFor(node);
    const missing = await d.observe!(driverContext(emptyWorld()), node);
    expect((await d.verify!(driverContext(new FakeOci()), node, missing)).status).toBe("failed");
    const denied = await d.observe!(driverContext(every(403, "NotAuthenticated")), node);
    const v = await d.verify!(driverContext(new FakeOci()), node, denied);
    expect(v.status).toBe("unknown");
    expect(v.checks[0]).toMatchObject({ id: "exists", passed: "unknown" });
  });

  it("an unexpected body shape never throws", async () => {
    for (const node of managed) {
      const oci = new FakeOci().on(() => ({ status: 200, headers: {}, body: "<html>not json</html>" }));
      const obs = await observeWith(oci, node);
      expect(["present", "missing", "unknown", "inaccessible"]).toContain(obs.presence);
    }
  });
});

describe("degraded worlds are reported as such", () => {
  it("drift-relevant facts: an opened bucket, a wrong CIDR, a missing rule", async () => {
    const world = healthyWorld(graph);
    const bucket = managed.find((n) => n.address === "object_store/assets")!;
    world.db.buckets.forEach((b) => (b.publicAccessType = "ObjectRead"));
    const obs = await observeWith(world.oci, bucket);
    expect(obs.attributes.publicAccess).toMatchObject({ state: "known", value: true });
    const v = await driverFor(bucket).verify!(driverContext(world.oci), bucket, obs);
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "config:publicAccess")).toMatchObject({ passed: false });

    const rule = managed.find((n) => n.address === "firewall/web-to-db")!;
    world.db.nsgRules.forEach((rules, k) => world.db.nsgRules.set(k, rules.filter((r) => !String(r.id).includes("webtodb"))));
    const gone = await observeWith(world.oci, rule);
    expect(gone.presence).toBe("missing");
  });

  it("a critical load balancer backend set makes runtime unhealthy", async () => {
    const world = healthyWorld(graph);
    world.db.lbHealth = { status: "CRITICAL", critical: ["bs_web"] };
    const lb = managed.find((n) => n.address === "load_balancer/public")!;
    const rt = await driverFor(lb).runtime!(driverContext(world.oci), lb);
    expect(rt.health).toBe("unhealthy");
    expect(rt.signals.join()).toMatch(/lb_health:CRITICAL/);
    expect(rt.counts.backendsUnhealthy).toBeGreaterThan(0);
  });

  it("container instances: a failed replica degrades, all failed is unhealthy", async () => {
    const world = healthyWorld(graph);
    const web = managed.find((n) => n.address === "container_service/web")!;
    const insts = world.db.instances.get("container_service/web")!;
    insts[0].lifecycleState = "FAILED";
    const d = await driverFor(web).runtime!(driverContext(world.oci), web);
    expect(d.health).toBe("degraded");
    expect(d.counts).toMatchObject({ desired: 2, running: 1, failed: 1 });
    insts[1].lifecycleState = "FAILED";
    expect((await driverFor(web).runtime!(driverContext(world.oci), web)).health).toBe("unhealthy");
  });

  it("an image swapped outside Zenith shows up as drift on `image`", async () => {
    const world = healthyWorld(graph);
    const web = managed.find((n) => n.address === "container_service/web")!;
    world.oci.route("GET", /^\/20210415\/containers\/[^/]+$/, json({ imageUrl: "evil.example/app:latest", lifecycleState: "ACTIVE" }));
    const obs = await observeWith(world.oci, web);
    expect(obs.attributes.image).toMatchObject({ state: "known", value: "evil.example/app:latest" });
  });

  it("the ENV var used for tag lookup is the node's environment id", () => {
    expect(ENV_ID).toBe("env-oci");
  });
});
