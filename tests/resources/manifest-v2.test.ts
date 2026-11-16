import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isV1,
  isV2,
  listNativeTypes,
  ManifestV2,
  parseManifest,
  registerNativeType,
  resolvePolicies,
  unregisterNativeType,
  findInlineSecretPaths,
  type ManifestV2 as ManifestV2Type,
} from "@/lib/resources";
import { bind, manifest, res, route, svc, webDb } from "./_fixtures";

const v2 = (over: Record<string, unknown> = {}) => ({
  version: 2,
  services: [svc({ id: "svc-web", name: "web", kind: "web", port: 3000 })],
  resources: [res({ id: "res-db", name: "db", kind: "postgres" })],
  routes: [],
  bindings: [bind("b1", "svc-web", "res-db", "sql")],
  ...over,
});

const issues = (input: unknown): string[] => {
  const r = parseManifest(input);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

describe("ManifestV2 schema", () => {
  it("accepts a minimal V2 and reuses V1's field defaults", () => {
    const r = parseManifest({ version: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok || !isV2(r.manifest)) throw new Error("expected V2");
    expect(r.manifest).toMatchObject({ version: 2, services: [], resources: [], routes: [], bindings: [] });
    expect(r.manifest.placement).toBeUndefined();
  });

  it("accepts every V2 section together", () => {
    const input = v2({
      placement: { provider: "aws", regions: ["us-east-1", "eu-west-1"], zones: 3, residency: ["eu"] },
      constraints: { budgetUsdMonthly: 500, availabilityTarget: 99.95, latencyTargetMs: 150, userRegions: ["india"], tolerateSingleFailure: true },
      policies: { deletion: "deny", backup: "hourly", approvalRequired: true, allowStatefulDeletion: false },
      nodePlacement: { db: { provider: "gcp", region: "europe-west1" } },
      providerConfig: {
        aws: { vpcCidr: "10.20.0.0/16", natGateways: "per_az", fargatePlatformVersion: "1.4.0", rdsEngineVersion: "16.3", multiAz: true, instanceClassOverrides: { db: "db.r6g.large" } },
        gcp: { cloudSqlTier: "db-custom-2-7680", highAvailability: true },
        azure: { vnetCidr: "10.30.0.0/16", zoneRedundant: true },
        oci: { vcnCidr: "10.40.0.0/16" },
        kubernetes: { namespace: "acme", ingressClass: "nginx", storageClass: "gp3" },
      },
      native: [{ id: "topic", provider: "aws", type: "aws:sns_topic", config: { fifo: false }, dependsOn: ["web"] }],
    });
    const r = parseManifest(input);
    expect(r.errors ?? []).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("dispatches on version and rejects everything else with one clear error", () => {
    expect(parseManifest(webDb()).ok).toBe(true);
    const v1 = parseManifest(webDb());
    if (!v1.ok) throw new Error("v1");
    expect(isV1(v1.manifest)).toBe(true);
    expect(issues({ version: 3 })).toEqual(["version: version must be 1 or 2."]);
    expect(issues({})).toEqual(["version: version must be 1 or 2."]);
    expect(issues(null)).toEqual([": A manifest must be a JSON object."]);
    expect(issues([1])).toEqual([": A manifest must be a JSON object."]);
    expect(issues("nope")).toEqual([": A manifest must be a JSON object."]);
  });

  it("rejects unknown keys at the top level and in every V2 section", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["polcies", { polcies: { deletion: "deny" } }],
      ["placement.extra", { placement: { provider: "aws", regions: ["us-east-1"], extra: 1 } }],
      ["constraints.extra", { constraints: { budget: 5 } }],
      ["policies.extra", { policies: { deletion: "deny", oops: true } }],
      ["nodePlacement.web.extra", { nodePlacement: { web: { provider: "aws", extra: 1 } } }],
      ["providerConfig.gpu", { providerConfig: { gpu: {} } }],
      ["providerConfig.aws.extra", { providerConfig: { aws: { natGateway: "single" } } }],
      ["providerConfig.kubernetes.extra", { providerConfig: { kubernetes: { ns: "x" } } }],
      ["native.0.extra", { native: [{ id: "t", provider: "aws", type: "aws:sns_topic", config: {}, bogus: 1 }] }],
    ];
    for (const [label, over] of cases) {
      const got = issues(v2(over));
      expect(got.length, `${label} should be rejected`).toBeGreaterThan(0);
    }
  });

  it("validates placement: a region is required unless provider is auto", () => {
    expect(issues(v2({ placement: { provider: "aws", regions: [] } }))[0]).toMatch(/regions needs at least one region/);
    expect(issues(v2({ placement: { provider: "aws" } }))[0]).toMatch(/regions needs at least one region/);
    expect(issues(v2({ placement: { provider: "auto" } }))).toEqual([]);
    expect(issues(v2({ placement: { provider: "auto", regions: [] } }))).toEqual([]);
    expect(issues(v2({ placement: { provider: "aws", regions: ["us-east-1"], zones: 4 } })).length).toBeGreaterThan(0);
    expect(issues(v2({ placement: { provider: "aws", regions: ["us-east-1"], zones: 0 } })).length).toBeGreaterThan(0);
    expect(issues(v2({ placement: { provider: "aws", regions: ["US East; rm -rf"] } })).length).toBeGreaterThan(0);
    expect(issues(v2({ placement: { provider: "mars", regions: ["x"] } })).length).toBeGreaterThan(0);
  });

  it("validates constraints and policies", () => {
    expect(issues(v2({ constraints: { availabilityTarget: 0 } })).length).toBeGreaterThan(0);
    expect(issues(v2({ constraints: { availabilityTarget: 100.1 } })).length).toBeGreaterThan(0);
    expect(issues(v2({ constraints: { availabilityTarget: 100 } }))).toEqual([]);
    expect(issues(v2({ constraints: { budgetUsdMonthly: -1 } })).length).toBeGreaterThan(0);
    expect(issues(v2({ policies: { deletion: "sometimes" } })).length).toBeGreaterThan(0);
    expect(issues(v2({ policies: { backup: "weekly" } })).length).toBeGreaterThan(0);
  });

  it("applies policy defaults: deletion approval, backup daily", () => {
    const r = ManifestV2.parse(v2({ policies: {} }));
    expect(r.policies).toEqual({ deletion: "approval", backup: "daily" });
    expect(resolvePolicies(r)).toEqual({ deletion: "approval", backup: "daily", approvalRequired: false, allowStatefulDeletion: false });
    const v1 = parseManifest(webDb());
    if (!v1.ok) throw new Error("v1");
    expect(resolvePolicies(v1.manifest).deletion).toBe("approval");
  });

  it("constrains provider config values that end up in generated infrastructure", () => {
    const bad: Record<string, unknown>[] = [
      { aws: { vpcCidr: "10.0.0.0/8" } },
      { aws: { vpcCidr: "10.0.0.0/24" } },
      { aws: { vpcCidr: "999.0.0.0/16" } },
      { aws: { vpcCidr: '10.0.0.0/16"; drop' } },
      { aws: { natGateways: "many" } },
      { aws: { fargatePlatformVersion: "latest-ish" } },
      { aws: { rdsEngineVersion: "16; DROP" } },
      { aws: { instanceClassOverrides: { db: "$(whoami)" } } },
      { aws: { instanceClassOverrides: { "Bad Name": "db.t4g.small" } } },
      { kubernetes: { namespace: "Not_A_Label" } },
      { gcp: { cloudRunIngress: "everything" } },
    ];
    for (const providerConfig of bad) expect(issues(v2({ providerConfig })).length, JSON.stringify(providerConfig)).toBeGreaterThan(0);
  });

  it("checks that nodePlacement keys refer to nodes in the manifest", () => {
    expect(issues(v2({ nodePlacement: { db: { provider: "aws", region: "us-east-1" } } }))).toEqual([]);
    expect(issues(v2({ nodePlacement: { "res-db": { provider: "aws" } } }))).toEqual([]);
    expect(issues(v2({ nodePlacement: { ghost: { provider: "aws" } } }))[0]).toMatch(/nodePlacement\.ghost/);
    expect(issues(v2({ nodePlacement: { db: { provider: "auto" } } })).length).toBeGreaterThan(0);
  });

  it("keeps the V1 pieces' own validation (host injection, names)", () => {
    expect(issues(v2({ routes: [route({ id: "r", host: 'a.com"; rm' })] })).length).toBeGreaterThan(0);
    expect(issues(v2({ services: [svc({ id: "s", name: "Bad_Name", kind: "web" })] })).length).toBeGreaterThan(0);
  });

  it("does not echo a rejected value back in error text", () => {
    const secret = "hunter2-super-secret-value";
    const msg = issues(v2({ placement: { provider: secret, regions: ["us-east-1"] } })).join(" ");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain(secret);
    const msg2 = issues(v2({ policies: { deletion: secret } })).join(" ");
    expect(msg2).not.toContain(secret);
  });
});

describe("native escape hatch", () => {
  const native = (over: Record<string, unknown> = {}) => ({ id: "topic", provider: "aws", type: "aws:sns_topic", config: {}, ...over });
  const cleanup: [Parameters<typeof registerNativeType>[0], string][] = [];
  afterEach(() => {
    for (const [p, t] of cleanup.splice(0)) unregisterNativeType(p, t);
  });

  it("accepts a registered type with a valid config", () => {
    expect(issues(v2({ native: [native({ config: { name: "orders", fifo: true } })] }))).toEqual([]);
    expect(issues(v2({ native: [native({ type: "aws:dynamodb_table", id: "tbl", config: { hashKey: { name: "pk", type: "S" } } })] }))).toEqual([]);
  });

  it("rejects an unregistered type and names what is registered", () => {
    const got = issues(v2({ native: [native({ type: "aws:cloudfront_distribution" })] }));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^native\.0\.type: Unknown native type "aws:cloudfront_distribution" for provider aws\./);
    expect(got[0]).toMatch(/Registered: .*aws:dynamodb_table/);
    expect(got[0]).toMatch(/registerNativeType\(\)/);
  });

  it("rejects a type that does not carry its provider's prefix", () => {
    expect(issues(v2({ native: [native({ type: "gcp:pubsub_topic" })] }))[0]).toMatch(/must start with "aws:"/);
    expect(issues(v2({ native: [native({ type: "sns_topic" })] }))[0]).toMatch(/must start with "aws:"/);
  });

  it("rejects an invalid config, including unknown keys, with a path into the config", () => {
    const missing = issues(v2({ native: [native({ type: "aws:dynamodb_table", id: "tbl", config: {} })] }));
    expect(missing.some((m) => m.startsWith("native.0.config.hashKey"))).toBe(true);
    const extra = issues(v2({ native: [native({ config: { retentionDays: 3 } })] }));
    expect(extra.some((m) => m.startsWith("native.0.config"))).toBe(true);
    const bad = issues(v2({ native: [native({ type: "aws:dynamodb_table", id: "tbl", config: { hashKey: { name: "pk", type: "S" }, billingMode: "FREE" } })] }));
    expect(bad.some((m) => m.startsWith("native.0.config.billingMode"))).toBe(true);
  });

  it("rejects inline secret values in native config but accepts references", () => {
    registerNativeType(
      "aws",
      "aws:custom_thing",
      z.object({ endpoint: z.string(), password: z.string().optional(), passwordSecretRef: z.string().optional(), auth: z.object({ secretRef: z.string() }).strict().optional() }).strict()
    );
    cleanup.push(["aws", "aws:custom_thing"]);
    const inline = issues(v2({ native: [native({ type: "aws:custom_thing", id: "cust", config: { endpoint: "x", password: "hunter2" } })] }));
    expect(inline.some((m) => m.startsWith("native.0.config.password") && /looks like a secret value/.test(m))).toBe(true);
    expect(inline.join(" ")).not.toContain("hunter2");
    expect(issues(v2({ native: [native({ type: "aws:custom_thing", id: "cust", config: { endpoint: "x", passwordSecretRef: "vault:p/x/PW", auth: { secretRef: "vault:p/x/AUTH" } } })] }))).toEqual([]);
    expect(findInlineSecretPaths({ a: { apiKey: "k", tokenName: "ok", nested: [{ client_secret: "s" }] } })).toEqual(["a.apiKey", "a.nested.0.client_secret"]);
  });

  it("validates ids, dependencies and cycles", () => {
    expect(issues(v2({ native: [native(), native()] })).some((m) => /duplicate native id/.test(m))).toBe(true);
    expect(issues(v2({ native: [native({ dependsOn: ["ghost"] })] })).some((m) => /not a service, resource or native id/.test(m))).toBe(true);
    expect(issues(v2({ native: [native({ dependsOn: ["topic"] })] })).some((m) => /cannot depend on itself/.test(m))).toBe(true);
    expect(issues(v2({ native: [native({ dependsOn: ["db", "web", "res-db"] })] }))).toEqual([]);
    const cycle = issues(v2({ native: [native({ id: "aa", dependsOn: ["bb"] }), native({ id: "bb", dependsOn: ["cc"] }), native({ id: "cc", dependsOn: ["aa"] })] }));
    expect(cycle.some((m) => /cycle: aa → bb → cc → aa/.test(m))).toBe(true);
    expect(issues(v2({ native: [native({ id: "Bad_Id" })] })).length).toBeGreaterThan(0);
  });

  it("registry: strict schemas only, prefix enforced, last registration wins, unregister works", () => {
    expect(() => registerNativeType("aws", "aws:loose", z.object({ a: z.string() }))).toThrow(/must be \.strict\(\)/);
    expect(() => registerNativeType("aws", "gcp:wrong", z.object({}).strict())).toThrow(/must look like "aws:<name>"/);
    expect(() => registerNativeType("aws", "aws:", z.object({}).strict())).toThrow();
    // a refined strict object is still strict
    expect(() => registerNativeType("aws", "aws:refined", z.object({ a: z.number() }).strict().refine((c) => c.a > 0))).not.toThrow();
    cleanup.push(["aws", "aws:refined"]);
    expect(issues(v2({ native: [native({ type: "aws:refined", id: "refd", config: { a: 0 } })] })).length).toBeGreaterThan(0);
    // tighten the schema: last registration wins
    registerNativeType("aws", "aws:refined", z.object({ a: z.number() }).strict());
    expect(issues(v2({ native: [native({ type: "aws:refined", id: "refd", config: { a: 0 } })] }))).toEqual([]);
    expect(unregisterNativeType("aws", "aws:refined")).toBe(true);
    expect(unregisterNativeType("aws", "aws:refined")).toBe(false);
    expect(issues(v2({ native: [native({ type: "aws:refined", id: "refd", config: { a: 1 } })] })).length).toBeGreaterThan(0);
  });

  it("lists registered types per provider, sorted", () => {
    const aws = listNativeTypes("aws").map((e) => e.type);
    expect(aws).toEqual([...aws].sort());
    expect(aws).toContain("aws:sns_topic");
    expect(listNativeTypes("gcp").map((e) => e.type)).toContain("gcp:pubsub_topic");
    expect(listNativeTypes("kubernetes").map((e) => e.type)).toContain("k8s:HorizontalPodAutoscaler");
    expect(listNativeTypes("zenith").map((e) => e.type)).toContain("k8s:HorizontalPodAutoscaler");
  });

  it("keeps the config as authored (drivers re-parse for defaults)", () => {
    const r = ManifestV2.parse(v2({ native: [native({ type: "aws:dynamodb_table", id: "tbl", config: { hashKey: { name: "pk", type: "S" } } })] })) as ManifestV2Type;
    expect(r.native![0].config).toEqual({ hashKey: { name: "pk", type: "S" } });
  });
});

describe("V1 manifests through parseManifest", () => {
  it("returns V1 untouched in meaning (no implicit upgrade)", () => {
    const m = manifest({ services: [svc({ id: "s", name: "web", kind: "web", port: 80 })] });
    const r = parseManifest(m);
    expect(r.ok && r.manifest.version).toBe(1);
  });
});
