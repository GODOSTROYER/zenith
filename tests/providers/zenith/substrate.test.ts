import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUBSTRATE_ENV_VARS,
  assertTenant,
  describeSubstrate,
  isManagedHost,
  managedHostSuffix,
  managedHostname,
  readSubstrateConfig,
  serviceLabelOf,
  substrateConnectionConfig,
  tenantObjectPrefix,
  type ZenithEnv,
} from "@/lib/providers/zenith/substrate";
import { ZenithError } from "@/lib/providers/zenith/types";
import { FULL_ENV, NS, TENANT, substrate } from "./support";

const REQUIRED = ["ZENITH_MANAGED_CLUSTER_SERVER", "ZENITH_MANAGED_KUBECONFIG_REF", "ZENITH_MANAGED_APP_DOMAIN"];
const without = (...names: string[]): ZenithEnv => Object.fromEntries(Object.entries(FULL_ENV).filter(([k]) => !names.includes(k)));

function invalid(env: ZenithEnv): { variable: string; problem: string }[] {
  const cfg = readSubstrateConfig(env);
  if (cfg.configured) throw new Error("expected the substrate to be unconfigured");
  return cfg.invalid;
}

describe("readSubstrateConfig: missing configuration", () => {
  it("answers not configured, naming every required variable, for an empty environment", () => {
    const cfg = readSubstrateConfig({});
    expect(cfg.configured).toBe(false);
    if (cfg.configured) return;
    expect(cfg.missing).toEqual(expect.arrayContaining(REQUIRED));
    expect(cfg.message).toContain("not configured");
    for (const v of REQUIRED) expect(cfg.message).toContain(v);
  });

  it.each(REQUIRED)("is unconfigured without %s", (name) => {
    const cfg = readSubstrateConfig(without(name));
    expect(cfg.configured).toBe(false);
    if (!cfg.configured) expect(cfg.missing).toContain(name);
  });

  it("treats empty and whitespace-only values as unset", () => {
    expect(readSubstrateConfig({ ...FULL_ENV, ZENITH_MANAGED_APP_DOMAIN: "   " }).configured).toBe(false);
  });

  it("is configured with only the required variables, every optional component absent", () => {
    const cfg = readSubstrateConfig({ ZENITH_MANAGED_CLUSTER_SERVER: FULL_ENV.ZENITH_MANAGED_CLUSTER_SERVER, ZENITH_MANAGED_KUBECONFIG_REF: FULL_ENV.ZENITH_MANAGED_KUBECONFIG_REF, ZENITH_MANAGED_APP_DOMAIN: FULL_ENV.ZENITH_MANAGED_APP_DOMAIN });
    expect(cfg.configured).toBe(true);
    if (!cfg.configured) return;
    expect(cfg.substrate.registry).toBeUndefined();
    expect(cfg.substrate.objectStorage).toBeUndefined();
    expect(cfg.substrate.database).toBeUndefined();
    expect(cfg.substrate.gateway).toMatchObject({ mode: "gateway_api", className: "zenith", namespace: "zenith-gateway", name: "zenith-gateway" });
    expect(cfg.substrate.region).toBe("zenith-managed");
  });

  it("reads every component when fully configured", () => {
    const s = substrate();
    expect(s.cluster.kubeconfigRef).toBe("vault:zenith-managed/kubeconfig");
    expect(s.baseDomain).toBe("apps.example.com");
    expect(s.registry).toEqual({ host: "registry.example.com", repositoryPrefix: "zenith" });
    expect(s.objectStorage).toMatchObject({ bucket: "zenith-tenants", prefixRoot: "tenants" });
    expect(s.database).toMatchObject({ provider: "neon", regionId: "aws-us-east-2", apiBase: "https://console.neon.tech/api/v2" });
    expect(s.database?.egress).toEqual([{ cidr: "0.0.0.0/0", port: 5432 }]);
  });
});

describe("readSubstrateConfig: invalid values fail closed and are named", () => {
  it("rejects a non-https cluster server", () => {
    expect(invalid({ ...FULL_ENV, ZENITH_MANAGED_CLUSTER_SERVER: "http://k8s.example.com" }).map((i) => i.variable)).toContain("ZENITH_MANAGED_CLUSTER_SERVER");
  });

  it("rejects credentials in the server URL and metadata/link-local hosts", () => {
    for (const server of ["https://user:pass@k8s.example.com", "https://169.254.169.254", "https://metadata.google.internal", "https://x.internal"]) {
      expect(invalid({ ...FULL_ENV, ZENITH_MANAGED_CLUSTER_SERVER: server }).map((i) => i.variable), server).toContain("ZENITH_MANAGED_CLUSTER_SERVER");
    }
  });

  it("refuses an inline kubeconfig or key where a reference belongs, without echoing it", () => {
    const inlineKubeconfig = "apiVersion: v1\nkind: Config\nusers:\n- name: x\n  user:\n    token: SUPERSECRETTOKEN123";
    const bad = invalid({ ...FULL_ENV, ZENITH_MANAGED_KUBECONFIG_REF: inlineKubeconfig });
    expect(bad.map((i) => i.variable)).toContain("ZENITH_MANAGED_KUBECONFIG_REF");
    const cfg = readSubstrateConfig({ ...FULL_ENV, ZENITH_MANAGED_KUBECONFIG_REF: inlineKubeconfig });
    if (!cfg.configured) {
      expect(cfg.message).not.toContain("SUPERSECRETTOKEN123");
      expect(JSON.stringify(cfg)).not.toContain("SUPERSECRETTOKEN123");
    }
    expect(invalid({ ...FULL_ENV, ZENITH_MANAGED_DB_API_KEY_REF: "napi_abcdefghijklmnop" }).map((i) => i.variable)).toContain("ZENITH_MANAGED_DB_API_KEY_REF");
    expect(invalid({ ...FULL_ENV, ZENITH_MANAGED_KUBECONFIG_REF: "-----BEGIN PRIVATE KEY-----abc" }).map((i) => i.variable)).toContain("ZENITH_MANAGED_KUBECONFIG_REF");
  });

  it.each(["localhost", "apps", "192.0.2.1", "UPPER.example.com", "a..b.com", "-bad.example.com", "exa mple.com"])("rejects base domain %s", (domain) => {
    expect(invalid({ ...FULL_ENV, ZENITH_MANAGED_APP_DOMAIN: domain }).map((i) => i.variable)).toContain("ZENITH_MANAGED_APP_DOMAIN");
  });

  it("rejects an unknown gateway mode, and requires an ingress class in ingress mode", () => {
    expect(invalid({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "nginx" }).map((i) => i.variable)).toContain("ZENITH_MANAGED_GATEWAY_MODE");
    const cfg = readSubstrateConfig({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress" });
    expect(cfg.configured).toBe(false);
    if (!cfg.configured) expect(cfg.missing).toContain("ZENITH_MANAGED_INGRESS_CLASS");
    expect(readSubstrateConfig({ ...FULL_ENV, ZENITH_MANAGED_GATEWAY_MODE: "ingress", ZENITH_MANAGED_INGRESS_CLASS: "nginx" }).configured).toBe(true);
  });

  it("rejects malformed names, CIDRs, egress rules, registry, bucket and database settings", () => {
    const cases: [string, string, string][] = [
      ["ZENITH_MANAGED_GATEWAY_NAMESPACE", "Not A Label", "ZENITH_MANAGED_GATEWAY_NAMESPACE"],
      ["ZENITH_MANAGED_INTERNAL_CIDRS", "10.0.0.0/8,banana", "ZENITH_MANAGED_INTERNAL_CIDRS"],
      ["ZENITH_MANAGED_INTERNAL_CIDRS", "10.0.0.0/33", "ZENITH_MANAGED_INTERNAL_CIDRS"],
      ["ZENITH_MANAGED_DB_EGRESS", "0.0.0.0/0", "ZENITH_MANAGED_DB_EGRESS"],
      ["ZENITH_MANAGED_DB_EGRESS", "0.0.0.0/0:99999", "ZENITH_MANAGED_DB_EGRESS"],
      ["ZENITH_MANAGED_REGISTRY", "https://registry.example.com/x", "ZENITH_MANAGED_REGISTRY"],
      ["ZENITH_MANAGED_OBJECT_STORAGE_BUCKET", "Bad_Bucket", "ZENITH_MANAGED_OBJECT_STORAGE_BUCKET"],
      ["ZENITH_MANAGED_OBJECT_STORAGE_PREFIX", "../escape", "ZENITH_MANAGED_OBJECT_STORAGE_PREFIX"],
      ["ZENITH_MANAGED_DB_PROVIDER", "postgres-fleet", "ZENITH_MANAGED_DB_PROVIDER"],
      ["ZENITH_MANAGED_DB_REGION", "US EAST", "ZENITH_MANAGED_DB_REGION"],
      ["ZENITH_MANAGED_DB_API_BASE", "http://console.neon.tech", "ZENITH_MANAGED_DB_API_BASE"],
      ["ZENITH_MANAGED_CLUSTER_CA_DATA", "not base64 !!", "ZENITH_MANAGED_CLUSTER_CA_DATA"],
    ];
    for (const [name, value, expected] of cases) {
      expect(invalid({ ...FULL_ENV, [name]: value }).map((i) => i.variable), `${name}=${value}`).toContain(expected);
    }
  });

  it("requires a bucket when an endpoint is given, and a region and key reference when a database provider is", () => {
    expect(readSubstrateConfig(without("ZENITH_MANAGED_OBJECT_STORAGE_BUCKET")).configured).toBe(false);
    expect(readSubstrateConfig(without("ZENITH_MANAGED_DB_API_KEY_REF")).configured).toBe(false);
    expect(readSubstrateConfig(without("ZENITH_MANAGED_DB_REGION")).configured).toBe(false);
  });

  it("warns, rather than failing, when database egress is not configured", () => {
    const cfg = readSubstrateConfig(without("ZENITH_MANAGED_DB_EGRESS"));
    expect(cfg.configured).toBe(true);
    if (cfg.configured) expect(cfg.warnings.join(" ")).toMatch(/ZENITH_MANAGED_DB_EGRESS/);
  });
});

describe("describeSubstrate", () => {
  it("reports presence and non-secret shape only", () => {
    const d = describeSubstrate(readSubstrateConfig(FULL_ENV));
    const text = JSON.stringify(d);
    expect(d.configured).toBe(true);
    expect(d.components.managedDatabase.state).toBe("configured");
    for (const secretish of ["vault:", "kubeconfig", "neon-api-key"]) expect(text).not.toContain(secretish);
  });

  it("names the variables to fix when unconfigured", () => {
    const d = describeSubstrate(readSubstrateConfig({ ...FULL_ENV, ZENITH_MANAGED_DB_API_KEY_REF: "raw-key-value" }));
    expect(d.configured).toBe(false);
    expect(d.components.managedDatabase.state).toBe("invalid");
    expect(d.components.managedDatabase.detail).toContain("ZENITH_MANAGED_DB_API_KEY_REF");
    expect(JSON.stringify(d)).not.toContain("raw-key-value");
  });

  it("marks absent optional components not_configured", () => {
    const d = describeSubstrate(readSubstrateConfig(without("ZENITH_MANAGED_REGISTRY")));
    expect(d.components.registry.state).toBe("not_configured");
  });
});

describe("the variable list is the variable list", () => {
  it("every variable the reader recognizes is documented in MANAGED-PLATFORM.md", () => {
    const doc = fs.readFileSync(path.resolve(__dirname, "../../../docs/platform/MANAGED-PLATFORM.md"), "utf8");
    for (const v of SUBSTRATE_ENV_VARS) expect(doc, v).toContain(v);
  });

  it("the source only ever reads variables from the list", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../src/lib/providers/zenith/substrate.ts"), "utf8");
    const used = new Set([...src.matchAll(/(?:\.(?:raw|require|ref|url|label|list)\(|parseEgress\(r, )"(ZENITH_MANAGED_[A-Z_]+)"/g)].map((m) => m[1]));
    for (const v of used) expect(SUBSTRATE_ENV_VARS as readonly string[], v).toContain(v);
    for (const v of SUBSTRATE_ENV_VARS) expect(used.has(v), v).toBe(true);
  });
});

describe("managed hostnames", () => {
  const parts = { service: "web", environmentSlug: "production", workspaceSlug: "acme", baseDomain: "apps.example.com" };

  it("follows <service>.<env>.<workspace-slug>.<domain>", () => {
    expect(managedHostname(parts)).toBe("web.production.acme.apps.example.com");
  });

  it("derives the service label from the node address", () => {
    expect(serviceLabelOf("container_service/web")).toBe("web");
    expect(serviceLabelOf("static_site/Marketing")).toBe("marketing");
  });

  it.each([
    ["service", { service: "Web" }],
    ["service", { service: "we b" }],
    ["service", { service: "web_1" }],
    ["service", { service: "-web" }],
    ["service", { service: "a".repeat(64) }],
    ["service", { service: "" }],
    ["service", { service: "web.evil" }],
    ["environment", { environmentSlug: "prod.x" }],
    ["workspace", { workspaceSlug: "xn--acme-abc" }],
    ["workspace", { workspaceSlug: "ACME" }],
  ])("refuses an invalid %s label instead of sanitizing it", (_what, over) => {
    expect(() => managedHostname({ ...parts, ...over })).toThrow(ZenithError);
    try {
      managedHostname({ ...parts, ...over });
    } catch (e) {
      expect((e as ZenithError).code).toBe("invalid_hostname");
    }
  });

  it("refuses a hostname over 253 characters and a bad base domain", () => {
    expect(() => managedHostname({ ...parts, baseDomain: `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.com`, service: "s".repeat(60), environmentSlug: "e".repeat(60), workspaceSlug: "w".repeat(60) })).toThrow(/253/);
    expect(() => managedHostname({ ...parts, baseDomain: "localhost" })).toThrow(ZenithError);
  });

  it("recognizes only hostnames under this tenant's suffix, one label deep", () => {
    const suffix = managedHostSuffix(TENANT, "apps.example.com");
    expect(suffix).toBe(".production.acme.apps.example.com");
    expect(isManagedHost("web.production.acme.apps.example.com", TENANT, "apps.example.com")).toBe(true);
    expect(isManagedHost("a.b.production.acme.apps.example.com", TENANT, "apps.example.com")).toBe(false);
    expect(isManagedHost("*.production.acme.apps.example.com", TENANT, "apps.example.com")).toBe(false);
    expect(isManagedHost("web.production.other.apps.example.com", TENANT, "apps.example.com")).toBe(false);
    expect(isManagedHost("web.staging.acme.apps.example.com", TENANT, "apps.example.com")).toBe(false);
    expect(isManagedHost("app.customer.com", TENANT, "apps.example.com")).toBe(false);
    expect(isManagedHost("production.acme.apps.example.com", TENANT, "apps.example.com")).toBe(false);
  });

  it("a workspace named like another tenant's suffix cannot spoof it", () => {
    const evil = { ...TENANT, workspaceSlug: "acme-apps" };
    expect(isManagedHost("web.production.acme.apps.example.com", evil, "apps.example.com")).toBe(false);
  });
});

describe("tenant validation", () => {
  it("accepts the fixture tenant and returns it unchanged", () => {
    expect(assertTenant(TENANT)).toEqual(TENANT);
  });

  it("rejects control characters in ids", () => {
    expect(() => assertTenant({ ...TENANT, workspaceId: "ws\u0000evil" })).toThrow(ZenithError);
    expect(() => assertTenant({ ...TENANT, environmentId: "env\nline" })).toThrow(ZenithError);
  });
});

describe("object storage prefix", () => {
  it("derives a per-tenant prefix under the configured root", () => {
    const p = tenantObjectPrefix(TENANT, substrate());
    expect(p).toEqual({ bucket: "zenith-tenants", prefix: "tenants/ws_7f3a9c/env_b12e04/" });
  });

  it("differs per tenant and never escapes the root, whatever the ids hold", () => {
    const s = substrate();
    const a = tenantObjectPrefix({ workspaceId: "a", environmentId: "b" }, s)!.prefix;
    const b = tenantObjectPrefix({ workspaceId: "a", environmentId: "c" }, s)!.prefix;
    expect(a).not.toBe(b);
    for (const id of ["../../other", "a/b", "..", "x\u0000y", "a b"]) {
      const p = tenantObjectPrefix({ workspaceId: id, environmentId: "e" }, s)!.prefix;
      expect(p.startsWith("tenants/")).toBe(true);
      expect(p.split("/").filter(Boolean)).toHaveLength(3);
      expect(p).not.toContain("..");
    }
  });

  it("distinguishes a literal id from a hashed one", () => {
    const s = substrate();
    const hashed = tenantObjectPrefix({ workspaceId: "a/b", environmentId: "e" }, s)!.prefix;
    expect(hashed).toContain("~");
    expect(tenantObjectPrefix({ workspaceId: "~abc", environmentId: "e" }, s)!.prefix).toContain("~");
  });

  it("is undefined when object storage is not configured", () => {
    expect(tenantObjectPrefix(TENANT, substrate(without("ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT", "ZENITH_MANAGED_OBJECT_STORAGE_BUCKET", "ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF")))).toBeUndefined();
  });
});

describe("kubernetes connection", () => {
  it("carries a credential REFERENCE and allows exactly the tenant namespace", () => {
    const c = substrateConnectionConfig(substrate(), NS);
    expect(c).toMatchObject({ provider: "kubernetes", mode: "kubeconfig_ref", credentialRef: "vault:zenith-managed/kubeconfig", namespaces: [NS] });
    expect(JSON.stringify(c)).not.toMatch(/token|BEGIN|password/i);
  });
});
