/** AWS provider minima and expansion-to-IAM compatibility, without cloud I/O. */
import { describe, expect, it } from "vitest";
import { expandManifest, upgradeManifest } from "@/lib/resources";
import type { IdentitySpec } from "@/lib/resources/specs";
import { iamRoleDriver } from "@/lib/providers/aws/drivers/data";
import { GRANT_RULES, type GrantTargetKind } from "@/lib/providers/aws/drivers/data/iam-grants";
import { compileContext } from "../providers/aws/drivers/_integration";
import { PROD, STAGING, bind, manifest, res, route, svc, v1Fixtures, webDb } from "./_fixtures";

describe("AWS data topology", () => {
  it.each(["sandbox", "staging", "production"] as const)("gives single-instance RDS two private AZs in %s, overriding an explicit one-zone request with a note", (envClass) => {
    const m = upgradeManifest(webDb(), { provider: "aws", region: PROD.region });
    m.placement = { provider: "aws", regions: [PROD.region], zones: 1 };
    m.providerConfig = { aws: { multiAz: false } };
    const graph = expandManifest(m, { ...PROD, class: envClass });
    expect(graph.nodes.find((n) => n.kind === "network")?.spec.zones).toBe(2);
    expect(graph.nodes.filter((n) => n.kind === "subnet" && n.spec.tier === "private").map((n) => n.spec.zone)).toEqual(["a", "b"]);
    expect(graph.nodes.find((n) => n.kind === "postgres")?.spec).toMatchObject({ highAvailability: false, zones: 2 });
    expect(graph.notes.some((n) => n.includes("placement.zones=1 raised to 2") && n.includes("RDS"))).toBe(true);
  });

  it("raises Redis HA to two AZs while keeping a standalone Redis instance at one in staging", () => {
    const m = upgradeManifest(manifest({ resources: [res({ id: "cache", name: "cache", kind: "redis" })] }), { provider: "aws", region: PROD.region });
    const single = expandManifest(m, STAGING);
    expect(single.nodes.find((n) => n.kind === "network")?.spec.zones).toBe(1);
    m.providerConfig = { aws: { multiAz: true } };
    const ha = expandManifest(m, STAGING);
    expect(ha.nodes.find((n) => n.kind === "redis")?.spec).toMatchObject({ highAvailability: true, zones: 2 });
    expect(ha.nodes.filter((n) => n.kind === "subnet" && n.spec.tier === "private")).toHaveLength(2);
    expect(ha.notes.some((n) => n.includes("highly available Redis require private subnets"))).toBe(true);
  });

  it("gives an AWS load balancer two public AZs in staging, and leaves a route-less staging app at one", () => {
    const routed = manifest({ services: [svc({ id: "web", name: "web", kind: "web", port: 8080 })],
      routes: [route({ id: "r", host: "app.example.com" })], bindings: [bind("rb", "r", "web", "http")] });
    const graph = expandManifest(routed, STAGING);
    expect(graph.nodes.some((n) => n.kind === "load_balancer")).toBe(true);
    expect(graph.nodes.find((n) => n.kind === "network")?.spec.zones).toBe(2);
    expect(graph.nodes.filter((n) => n.kind === "subnet" && n.spec.tier === "public").map((n) => n.spec.zone)).toEqual(["a", "b"]);
    expect(graph.notes.some((n) => n.includes("staging default raised to 2") && n.includes("Application Load Balancer"))).toBe(true);
    const plain = expandManifest(manifest({ services: [svc({ id: "web", name: "web", kind: "web", port: 8080 })] }), STAGING);
    expect(plain.nodes.find((n) => n.kind === "network")?.spec.zones).toBe(1);
    expect(expandManifest(routed, { ...STAGING, provider: "gcp" }).nodes.find((n) => n.kind === "network")?.spec.zones).toBe(1);
  });

  it("does not raise another provider's zone minimum or provision a network for a referenced DB", () => {
    const graph = expandManifest(webDb(), { ...STAGING, provider: "gcp" });
    expect(graph.nodes.find((n) => n.kind === "network")?.spec.zones).toBe(1);
    const referenced = expandManifest(manifest({ resources: [res({ id: "db", name: "db", kind: "postgres", ownership: "referenced" })] }), STAGING);
    expect(referenced.nodes.some((n) => n.kind === "network")).toBe(false);
  });

  it("emits the cache connect grant as well as its firewall rule", () => {
    const graph = expandManifest(manifest({ services: [svc({ id: "web", name: "web", kind: "web" })],
      resources: [res({ id: "cache", name: "cache", kind: "redis" })], bindings: [bind("cache", "web", "cache", "cache")] }), STAGING);
    expect(graph.nodes.find((n) => n.kind === "identity")?.spec.grants).toContainEqual({ target: "redis/cache", access: ["connect"], via: ["binding:cache"] });
    expect(graph.nodes.some((n) => n.kind === "firewall" && n.spec.port === 6379)).toBe(true);
    expect(GRANT_RULES.redis.connect).toEqual([{ sid: "ConnectIamAuth", actions: ["elasticache:Connect"], on: "cache_connect" }]);
  });

  it.each([undefined, "x-1", "arn:aws:s3:::*", "arn:aws:s3:::bucket${hostile}", "arn:aws:sqs:ap-south-1:123456789012:jobs"])("notes an unscopable referenced bucket (%s) instead of inventing IAM access", (externalRef) => {
    const input = manifest({ services: [svc({ id: "web", name: "web", kind: "web" })],
      resources: [res({ id: "bucket", name: "uploads", kind: "object_store", ownership: "referenced", externalRef })], bindings: [bind("blob", "web", "bucket", "blob")] });
    const graph = expandManifest(input, STAGING);
    const grants = graph.nodes.find((n) => n.kind === "identity")?.spec.grants as IdentitySpec["grants"];
    expect(grants.some((g) => g.target === "object_store/uploads")).toBe(false);
    expect(graph.edges.some((e) => e.from === "container_service/web" && e.to === "object_store/uploads")).toBe(true);
    expect(graph.notes.some((n) => n.includes("no IAM grant derived") && n.includes("exact s3 ARN"))).toBe(true);
    expect(() => iamRoleDriver.compile!(graph.nodes.find((n) => n.kind === "identity")!, compileContext(graph))).not.toThrow();
  });

  it("keeps least-privilege grants to a referenced bucket when its exact ARN is supplied", () => {
    const input = manifest({ services: [svc({ id: "web", name: "web", kind: "web" })],
      resources: [res({ id: "bucket", name: "uploads", kind: "object_store", ownership: "referenced", externalRef: "arn:aws:s3:::acme-uploads" })], bindings: [bind("blob", "web", "bucket", "blob")] });
    const graph = expandManifest(input, STAGING);
    const identity = graph.nodes.find((n) => n.kind === "identity")!;
    expect(identity.spec.grants).toContainEqual({ target: "object_store/uploads", access: ["delete", "list", "read", "write"], via: ["binding:blob"] });
    expect(() => iamRoleDriver.compile!(identity, compileContext(graph))).not.toThrow();
  });
});

describe.each(["production", "staging"] as const)("expansion IAM grant compatibility in %s", (envClass) => {
  it.each(v1Fixtures())("compiles every identity in $name with verbs from GRANT_RULES", ({ manifest: input }) => {
    const graph = expandManifest(upgradeManifest(input, { provider: "aws", region: PROD.region }), { ...PROD, class: envClass });
    for (const identity of graph.nodes.filter((n) => n.kind === "identity")) {
      for (const grant of (identity.spec as unknown as IdentitySpec).grants) {
        const target = graph.nodes.find((n) => n.address === grant.target)!;
        const rules = GRANT_RULES[target.kind as GrantTargetKind];
        expect(rules, `unsupported grant target ${target.address}`).toBeDefined();
        for (const verb of grant.access) expect(rules[verb], `unsupported ${target.kind}:${verb}`).toBeDefined();
      }
      expect(() => iamRoleDriver.compile!(identity, compileContext(graph)), identity.address).not.toThrow();
    }
  });
});
