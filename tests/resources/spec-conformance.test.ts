import { describe, expect, it } from "vitest";
import {
  expandManifest,
  findInlineSecretPaths,
  stripUrlCredentials,
  urlHasCredentials,
  type ExpandEnv,
  type ResourceNode,
} from "@/lib/resources";
import { PROD, bind, fullManifest, manifest, res, route, svc, v1Fixtures } from "./_fixtures";

/**
 * `src/lib/resources/specs.ts` is a pinned contract that drivers are written
 * against. This test mirrors it as key sets and holds `expandManifest()` to
 * it: a spec that grows an undeclared key, or drops a required one, is a
 * contract break that must be made deliberately (additively, in specs.ts).
 */
type Shape = { required: string[]; optional?: string[] };

const WORKLOAD = ["size", "vcpu", "memoryMb", "artifact", "env", "zones", "subnetTier"];
const WORKLOAD_OPT = ["platformVersion", "shape", "ingress", "namespace"];
const MANAGED_DATA = ["size", "deletionPolicy", "encryption"];

const shapeOf = (n: ResourceNode): Shape => {
  const managed = n.ownership === "managed";
  switch (n.kind) {
    case "network": return { required: ["zones"], optional: ["cidr", "egress", "namespace"] };
    case "subnet": return { required: ["tier", "zone", "cidr", "network"] };
    case "firewall": return { required: ["direction", "protocol", "port", "source", "target", "capability", "description"], optional: ["crossBoundary", "namespace"] };
    case "load_balancer": return { required: ["scheme", "tier", "listeners", "routes"], optional: ["ingressClass", "namespace"] };
    case "dns_zone": return { required: ["name", "private"] };
    case "dns_record": return { required: ["name", "type", "target", "zone"], optional: ["namespace"] };
    case "tls_certificate": return { required: ["domain", "validation"], optional: ["zone", "namespace"] };
    case "container_service":
      return managed
        ? { required: [...WORKLOAD, "workload", "replicas"], optional: [...WORKLOAD_OPT, "port", "healthPath"] }
        : { required: ["workload", "size"], optional: ["replicas", "port", "healthPath", "namespace"] };
    case "scheduled_job":
      return managed ? { required: WORKLOAD, optional: [...WORKLOAD_OPT, "schedule"] } : { required: ["workload", "size"], optional: ["replicas", "port", "healthPath", "namespace"] };
    case "static_site":
      return managed ? { required: ["size", "artifact"], optional: ["namespace"] } : { required: ["workload", "size"], optional: ["replicas", "port", "healthPath", "namespace"] };
    case "postgres":
      return managed
        ? { required: [...MANAGED_DATA, "engine", "version", "highAvailability", "backup", "credentials", "subnetTier", "zones"], optional: ["config", "instanceClass", "storageClass", "namespace"] }
        : { required: ["size"], optional: ["engine", "config", "namespace"] };
    case "redis":
      return managed
        ? { required: [...MANAGED_DATA, "engine", "highAvailability", "backup", "subnetTier", "zones"], optional: ["config", "instanceClass", "storageClass", "namespace"] }
        : { required: ["size"], optional: ["engine", "config", "namespace"] };
    case "object_store":
      return managed ? { required: [...MANAGED_DATA, "versioning", "publicAccess"], optional: ["config", "namespace"] } : { required: ["size"], optional: ["config", "namespace"] };
    case "queue":
      return managed ? { required: MANAGED_DATA, optional: ["config", "namespace"] } : { required: ["size"], optional: ["config", "namespace"] };
    case "secret": return { required: ["secretRef", "store", "purpose"], optional: ["namespace"] };
    case "identity": return { required: ["principal", "workload", "grants"], optional: ["namespace"] };
    case "log_group": return { required: ["workload", "retentionDays"] };
    case "container_registry": return { required: ["scanOnPush", "immutableTags"] };
    case "build_pipeline": return { required: ["source", "output", "location"] };
    case "provider_native": return { required: ["type", "config"] };
    default: return { required: [] };
  }
};

const problems = (n: ResourceNode): string[] => {
  const shape = shapeOf(n);
  const keys = Object.keys(n.spec);
  const out: string[] = [];
  for (const k of shape.required) if (!keys.includes(k)) out.push(`${n.address}: missing required ${k}`);
  for (const k of keys) if (![...shape.required, ...(shape.optional ?? [])].includes(k)) out.push(`${n.address}: undeclared key ${k}`);
  if (n.kind === "identity")
    for (const g of n.spec.grants as Record<string, unknown>[])
      if (Object.keys(g).sort().join() !== "access,target,via") out.push(`${n.address}: grant keys ${Object.keys(g)}`);
  return out;
};

describe("expandManifest honours the pinned spec shapes (specs.ts)", () => {
  const envs: ExpandEnv[] = [
    PROD,
    { ...PROD, class: "staging", name: "staging" },
    { ...PROD, provider: "kubernetes", region: "kind" },
    { ...PROD, provider: "zenith", region: "zenith-managed" },
    { ...PROD, provider: "gcp", region: "us-central1" },
    { ...PROD, provider: "sandbox", region: "sim-1" },
  ];

  it("every node of every fixture on every provider matches its kind's shape", () => {
    const seen = new Set<string>();
    for (const { name, manifest: m } of v1Fixtures())
      for (const env of envs) {
        const g = expandManifest(m, env);
        for (const n of g.nodes) {
          seen.add(n.kind);
          expect(problems(n), `${name} on ${env.provider}`).toEqual([]);
        }
      }
    // the fixtures exercise every kind expansion produces
    for (const k of ["network", "subnet", "firewall", "load_balancer", "dns_zone", "dns_record", "tls_certificate", "container_service", "scheduled_job", "static_site", "postgres", "redis", "object_store", "queue", "secret", "identity", "log_group", "container_registry", "build_pipeline"])
      expect(seen.has(k), `no fixture produced ${k}`).toBe(true);
  });

  it("holds for tuned specs too (providerConfig fields, provider-native nodes)", () => {
    const g = expandManifest(
      {
        ...fullManifest(),
        version: 2,
        providerConfig: { aws: { fargatePlatformVersion: "1.4.0", rdsEngineVersion: "16.3", instanceClassOverrides: { db: "db.r6g.large", cache: "cache.r6g.large" } } },
        native: [{ id: "topic", provider: "aws", type: "aws:sns_topic", config: {} }],
      } as never,
      PROD
    );
    for (const n of g.nodes) expect(problems(n), n.address).toEqual([]);
    expect(g.nodes.find((n) => n.address === "container_service/api")!.spec.platformVersion).toBe("1.4.0");
    expect(g.nodes.find((n) => n.address === "redis/cache")!.spec.instanceClass).toBe("cache.r6g.large");
  });
});

describe("URL credentials never reach the graph", () => {
  const detect = [
    ["https://user:pass@github.com/acme/api.git", true],
    ["https://ghp_token123@github.com/acme/api.git", true],
    ["postgres://admin:pw@db.internal:5432/app", true],
    ["ssh://git@github.com/acme/api.git", false],
    ["git@github.com:acme/api.git", false],
    ["https://github.com/acme/api.git", false],
    ["legacy.abc.us-east-1.rds.amazonaws.com", false],
    ["arn:aws:rds:us-east-1:123456789012:db:legacy", false],
  ] as const;

  it("recognises embedded credentials and strips exactly them", () => {
    for (const [url, has] of detect) {
      expect(urlHasCredentials(url), url).toBe(has);
      const s = stripUrlCredentials(url);
      expect(s.stripped, url).toBe(has);
      if (!has) expect(s.value).toBe(url);
    }
    expect(stripUrlCredentials("https://user:pass@github.com/acme/api.git").value).toBe("https://github.com/acme/api.git");
    expect(stripUrlCredentials("postgres://admin:pw@db.internal:5432/app").value).toBe("postgres://db.internal:5432/app");
  });

  it("removes credentials from a git repo URL and a referenced resource's externalRef, and says so", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "api", kind: "web", port: 80, source: { type: "git", repo: "https://oauth2:SUPERSECRETTOKEN@github.com/acme/api.git", ref: "main" } })],
      resources: [res({ id: "r", name: "old", kind: "postgres", ownership: "referenced", externalRef: "postgres://admin:hunter2pw@legacy.example.com:5432/app" })],
    });
    const g = expandManifest(m, PROD);
    const json = JSON.stringify(g);
    expect(json).not.toContain("SUPERSECRETTOKEN");
    expect(json).not.toContain("hunter2pw");
    expect(g.nodes.find((n) => n.address === "build_pipeline/api")!.spec.source).toMatchObject({ repo: "https://github.com/acme/api.git" });
    expect(g.nodes.find((n) => n.address === "postgres/old")!.externalRef).toBe("postgres://legacy.example.com:5432/app");
    expect(g.notes.filter((n) => n.startsWith("secrets:") && /embeds credentials/.test(n))).toHaveLength(2);
  });

  it("flags (but keeps) an inline env value that embeds credentials, and resource config credentials", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "api", kind: "web", port: 80, env: [{ key: "DATABASE_URL", value: "postgres://app:pw@db:5432/app" }, { key: "LOG_URL", value: "https://logs.example.com/x" }] })],
      resources: [res({ id: "r", name: "cache", kind: "redis", config: { password: "abc", size_hint: "big" } })],
    });
    const g = expandManifest(m, PROD);
    const env = g.nodes.find((n) => n.address === "container_service/api")!.spec.env as { key: string; value?: string }[];
    expect(env.find((e) => e.key === "DATABASE_URL")!.value).toBe("postgres://app:pw@db:5432/app");
    expect(g.notes.filter((n) => /api\.DATABASE_URL embeds credentials in a URL/.test(n))).toHaveLength(1);
    expect(g.notes.some((n) => /api\.LOG_URL/.test(n))).toBe(false);
    expect(g.notes.some((n) => /redis\/cache config\.password looks like a credential/.test(n))).toBe(true);
    expect(g.notes.some((n) => /size_hint/.test(n))).toBe(false);
  });

  it("findInlineSecretPaths exempts pointer-shaped keys", () => {
    expect(findInlineSecretPaths({ passwordSecretRef: "vault:x", tokenArn: "arn:x", secretName: "n", apiKeyId: "1", password: "p" })).toEqual(["password"]);
  });
});

describe("misc contract details drivers rely on", () => {
  it("scheduled jobs carry their schedule and the same workload fields as services", () => {
    const m = manifest({ services: [svc({ id: "s", name: "nightly", kind: "cron", schedule: "0 3 * * *" })], bindings: [bind("b", "s", "s", "http")] });
    const g = expandManifest(m, PROD);
    expect(g.nodes.find((n) => n.address === "scheduled_job/nightly")!.spec).toMatchObject({ schedule: "0 3 * * *", subnetTier: "private", zones: 2 });
  });

  it("a route host is lowercased in every address and spec", () => {
    const m = manifest({
      services: [svc({ id: "s", name: "web", kind: "web", port: 80 })],
      routes: [route({ id: "r", host: "App.Example.COM" })],
      bindings: [bind("b", "r", "s", "http")],
    });
    const g = expandManifest(m, PROD);
    expect(g.nodes.map((n) => n.address).filter((a) => /[A-Z]/.test(a))).toEqual([]);
    expect(JSON.stringify(g.nodes.map((n) => n.spec))).not.toMatch(/App\.Example/);
  });
});
