import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/lib/providers/zenith/plans";
import { PRIVATE_IPV4_RANGES, PRIVATE_IPV6_RANGES, dnsLabelOf, labelValue, renderTenancy, tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { OWNERSHIP, type K8sObject } from "@/lib/providers/zenith/k8s-port";
import { PLAN_TIERS, TENANCY_OBJECTS, ZenithError, type ZenithTenant } from "@/lib/providers/zenith/types";
import { FULL_ENV, TENANT, substrate } from "./support";

const DNS_1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const find = (objs: K8sObject[], kind: string, name?: string): K8sObject => {
  const o = objs.find((x) => x.kind === kind && (name === undefined || x.metadata.name === name));
  if (!o) throw new Error(`no ${kind} ${name ?? ""}`);
  return o;
};

describe("tenant namespace naming", () => {
  it("is deterministic", () => {
    expect(tenantNamespace("ws_1", "env_1")).toBe(tenantNamespace("ws_1", "env_1"));
  });

  it("is a DNS-1123 label of at most 63 characters, for any input", () => {
    const cases: [string, string][] = [
      ["ws_7f3a9c", "env_b12e04"],
      ["WS UPPER", "Env With Spaces!"],
      ["!!!", "???"],
      ["a".repeat(500), "b".repeat(500)],
      ["ünïcödé-ws", "ênv"],
      ["-leading", "trailing-"],
      ["a/b/c", "d.e.f"],
    ];
    for (const [ws, env] of cases) {
      const ns = tenantNamespace(ws, env);
      expect(ns, `${ws}/${env}`).toMatch(DNS_1123);
      expect(ns.length).toBeLessThanOrEqual(63);
      expect(ns.startsWith("zt-")).toBe(true);
    }
  });

  it("differs when ids differ, even when their readable parts truncate or sanitize to the same text", () => {
    const seen = new Map<string, string>();
    const pairs: [string, string][] = [
      ["a", "bc"],
      ["ab", "c"], // NUL separation: must not collide with ("a","bc")
      ["ws_1", "env_1"],
      ["ws-1", "env_1"], // readable part identical after sanitizing
      ["WS_1", "env_1"],
      ["ws.1", "env_1"],
      ["w".repeat(40) + "1", "env"],
      ["w".repeat(40) + "2", "env"], // identical after truncation to 18
      ["ws", "e".repeat(40) + "1"],
      ["ws", "e".repeat(40) + "2"],
    ];
    for (const [ws, env] of pairs) {
      const ns = tenantNamespace(ws, env);
      expect(seen.get(ns), `collision: ${ns} for ${ws}/${env} and ${seen.get(ns)}`).toBeUndefined();
      seen.set(ns, `${ws}/${env}`);
    }
    expect(seen.size).toBe(pairs.length);
  });

  it("has no collisions across a thousand generated tenants", () => {
    const names = new Set<string>();
    for (let w = 0; w < 40; w++) for (let e = 0; e < 25; e++) names.add(tenantNamespace(`ws_${w}`, `env_${e}`));
    expect(names.size).toBe(1000);
  });

  it("never equals a platform namespace", () => {
    for (const platform of ["kube-system", "kube-public", "default", "zenith-system", "zenith-gateway", "cert-manager"]) {
      expect(tenantNamespace(platform, platform)).not.toBe(platform);
      expect(tenantNamespace(platform, platform).startsWith("zt-")).toBe(true);
    }
  });

  it("refuses empty ids", () => {
    expect(() => tenantNamespace("", "e")).toThrow();
    expect(() => tenantNamespace("w", "")).toThrow();
  });
});

describe("label and name helpers", () => {
  it("keeps a valid label value and hashes a changed one", () => {
    expect(labelValue("env_b12e04")).toBe("env_b12e04");
    const a = labelValue("env b12e04");
    const b = labelValue("env-b12e04");
    expect(a).toMatch(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/);
    expect(a).not.toBe(b);
    expect(labelValue("x".repeat(200)).length).toBeLessThanOrEqual(63);
  });

  it("derives DNS labels that start with a letter", () => {
    expect(dnsLabelOf("route-web.production.acme.apps.example.com")).toMatch(DNS_1123);
    expect(dnsLabelOf("9lives")).toMatch(/^[a-z]/);
  });
});

describe("renderTenancy: namespace", () => {
  const sub = substrate();
  const t = renderTenancy(TENANT, sub);
  const ns = find(t.objects, "Namespace");

  it("renders the deterministic namespace", () => {
    expect(t.namespace).toBe(tenantNamespace(TENANT.workspaceId, TENANT.environmentId));
    expect(ns.metadata.name).toBe(t.namespace);
    expect(ns.metadata.namespace).toBeUndefined();
  });

  it("labels the workspace and environment", () => {
    expect(ns.metadata.labels?.["zenith.dev/workspace"]).toBe(labelValue(TENANT.workspaceId));
    expect(ns.metadata.labels?.["zenith.dev/environment"]).toBe(labelValue(TENANT.environmentId));
    expect(ns.metadata.labels?.["zenith.dev/tenant"]).toBe("true");
    expect(ns.metadata.annotations?.["zenith.dev/workspace-id"]).toBe(TENANT.workspaceId);
  });

  it("enforces the restricted Pod Security Standard (and audits and warns on it)", () => {
    const l = ns.metadata.labels ?? {};
    expect(l["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(l["pod-security.kubernetes.io/audit"]).toBe("restricted");
    expect(l["pod-security.kubernetes.io/warn"]).toBe("restricted");
  });

  it("carries the ownership marks the Kubernetes apply guard compares, exact environment id included", () => {
    for (const o of t.objects) {
      expect(o.metadata.labels?.[OWNERSHIP.managedByLabel], `${o.kind}/${o.metadata.name}`).toBe("zenith");
      expect(o.metadata.annotations?.[OWNERSHIP.environmentAnnotation], `${o.kind}/${o.metadata.name}`).toBe(TENANT.environmentId);
      expect(typeof o.metadata.annotations?.[OWNERSHIP.resourceAnnotation]).toBe("string");
    }
  });

  it("places every namespaced object in the tenant namespace", () => {
    for (const o of t.objects.filter((x) => x.kind !== "Namespace")) expect(o.metadata.namespace).toBe(t.namespace);
  });

  it("is pure: rendering twice is byte-identical", () => {
    expect(JSON.stringify(renderTenancy(TENANT, sub))).toBe(JSON.stringify(t));
  });

  it("rejects malformed tenants by field name", () => {
    const bad = (over: Partial<ZenithTenant>) => () => renderTenancy({ ...TENANT, ...over }, sub);
    expect(bad({ workspaceId: "" })).toThrow(ZenithError);
    expect(bad({ environmentId: "x".repeat(300) })).toThrow(/environmentId/);
    expect(bad({ workspaceSlug: "Has Caps" })).toThrow(/workspaceSlug/);
    expect(bad({ environmentSlug: "xn--punycode" })).toThrow(/environmentSlug/);
    expect(bad({ planTier: "enterprise" as never })).toThrow(/planTier/);
  });
});

describe("renderTenancy: network isolation", () => {
  const sub = substrate();
  const t = renderTenancy(TENANT, sub, { withManagedDatabase: true });
  const deny = find(t.objects, "NetworkPolicy", TENANCY_OBJECTS.defaultDeny);
  const allow = find(t.objects, "NetworkPolicy", TENANCY_OBJECTS.allowPlatform);

  it("default-denies every pod in both directions, with no rules", () => {
    expect(deny.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
  });

  it("allows ingress only from the platform gateway namespace", () => {
    const spec = allow.spec as { ingress: { from: { namespaceSelector: { matchLabels: Record<string, string> } }[] }[] };
    expect(spec.ingress).toHaveLength(1);
    expect(spec.ingress[0].from).toEqual([{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": sub.gateway.namespace } } }]);
  });

  it("allows egress to cluster DNS, internet 443 and the configured database endpoint, nothing else", () => {
    const egress = (allow.spec as { egress: { to: Record<string, unknown>[]; ports: { protocol: string; port: number }[] }[] }).egress;
    expect(egress).toHaveLength(3);
    expect(egress[0].ports).toEqual([
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ]);
    expect(JSON.stringify(egress[0].to)).toContain("kube-dns");
    expect(egress[1].ports).toEqual([{ protocol: "TCP", port: 443 }]);
    expect(egress[2].ports).toEqual([{ protocol: "TCP", port: 5432 }]);
  });

  it("never lets an open CIDR reach private, link-local (metadata) or carrier-grade ranges", () => {
    const egress = (allow.spec as { egress: { to: { ipBlock?: { cidr: string; except?: string[] } }[] }[] }).egress;
    for (const rule of egress.slice(1)) {
      for (const peer of rule.to) {
        const ip = peer.ipBlock!;
        if (ip.cidr === "0.0.0.0/0") for (const r of PRIVATE_IPV4_RANGES) expect(ip.except).toContain(r);
        if (ip.cidr === "::/0") for (const r of PRIVATE_IPV6_RANGES) expect(ip.except).toContain(r);
      }
    }
    expect(PRIVATE_IPV4_RANGES).toContain("169.254.0.0/16");
  });

  it("adds the substrate's internal cluster CIDRs to the exceptions", () => {
    const s2 = substrate({ ...FULL_ENV, ZENITH_MANAGED_INTERNAL_CIDRS: "10.96.0.0/12,fd00:1234::/48" });
    const a = find(renderTenancy(TENANT, s2).objects, "NetworkPolicy", TENANCY_OBJECTS.allowPlatform);
    const text = JSON.stringify(a.spec);
    expect(text).toContain("10.96.0.0/12");
    expect(text).toContain("fd00:1234::/48");
  });

  it("renders database egress only for environments that have a managed database", () => {
    const without = find(renderTenancy(TENANT, sub).objects, "NetworkPolicy", TENANCY_OBJECTS.allowPlatform);
    expect((without.spec as { egress: unknown[] }).egress).toHaveLength(2);
    const noEgressConfigured = substrate({ ...FULL_ENV, ZENITH_MANAGED_DB_EGRESS: "" });
    const r = renderTenancy(TENANT, noEgressConfigured, { withManagedDatabase: true });
    expect((find(r.objects, "NetworkPolicy", TENANCY_OBJECTS.allowPlatform).spec as { egress: unknown[] }).egress).toHaveLength(2);
    expect(r.notes.join(" ")).toMatch(/no network path|ZENITH_MANAGED_DB_EGRESS/);
  });

  it("keeps a narrow database egress CIDR narrow", () => {
    const narrow = substrate({ ...FULL_ENV, ZENITH_MANAGED_DB_EGRESS: "203.0.113.0/24:5432" });
    const a = find(renderTenancy(TENANT, narrow, { withManagedDatabase: true }).objects, "NetworkPolicy", TENANCY_OBJECTS.allowPlatform);
    const egress = (a.spec as { egress: { to: { ipBlock: { cidr: string; except?: string[] } }[] }[] }).egress;
    expect(egress[2].to[0].ipBlock).toEqual({ cidr: "203.0.113.0/24" });
  });
});

describe("renderTenancy: quotas, limits, service account", () => {
  it("renders a ResourceQuota from each plan tier's named constants", () => {
    for (const tier of PLAN_TIERS) {
      const t = renderTenancy({ ...TENANT, planTier: tier }, substrate());
      const q = find(t.objects, "ResourceQuota");
      expect((q.spec as { hard: Record<string, string> }).hard).toEqual(PLAN_LIMITS[tier].quota);
    }
  });

  it("scales up with the tier", () => {
    const cpu = (tier: "free" | "starter" | "pro") => Number(PLAN_LIMITS[tier].quota["requests.cpu"]);
    expect(cpu("free")).toBeLessThan(cpu("starter"));
    expect(cpu("starter")).toBeLessThan(cpu("pro"));
  });

  it("forbids public load balancers and node ports on every tier", () => {
    for (const tier of PLAN_TIERS) {
      expect(PLAN_LIMITS[tier].quota["services.loadbalancers"]).toBe("0");
      expect(PLAN_LIMITS[tier].quota["services.nodeports"]).toBe("0");
    }
  });

  it("gives the free tier no persistent storage and the paid tiers a bounded amount", () => {
    expect(PLAN_LIMITS.free.quota.persistentvolumeclaims).toBe("0");
    expect(PLAN_LIMITS.free.pvc).toBeUndefined();
    expect(Number(PLAN_LIMITS.starter.quota.persistentvolumeclaims)).toBeGreaterThan(0);
    expect(PLAN_LIMITS.pro.pvc?.max).toBeDefined();
  });

  it("renders a LimitRange whose container floor is below the lightest thing Zenith renders (100m / 128Mi)", () => {
    for (const tier of PLAN_TIERS) {
      const lr = find(renderTenancy({ ...TENANT, planTier: tier }, substrate()).objects, "LimitRange");
      const c = (lr.spec as { limits: { type: string; min: { cpu: string; memory: string }; max: { cpu: string; memory: string }; defaultRequest: { cpu: string } }[] }).limits.find((l) => l.type === "Container")!;
      expect(c.min.cpu).toBe("10m");
      expect(c.defaultRequest.cpu).toBe("100m");
      expect(c.max).toEqual(PLAN_LIMITS[tier].container.max);
    }
  });

  it("renders a PVC LimitRange only for tiers with storage", () => {
    const has = (tier: "free" | "starter" | "pro") => (find(renderTenancy({ ...TENANT, planTier: tier }, substrate()).objects, "LimitRange").spec as { limits: { type: string }[] }).limits.some((l) => l.type === "PersistentVolumeClaim");
    expect([has("free"), has("starter"), has("pro")]).toEqual([false, true, true]);
  });

  it("creates a service account that mounts no token and has no role bindings", () => {
    const t = renderTenancy(TENANT, substrate());
    const sa = find(t.objects, "ServiceAccount", TENANCY_OBJECTS.serviceAccount);
    expect(sa.automountServiceAccountToken).toBe(false);
    expect(t.objects.some((o) => /Role/.test(o.kind))).toBe(false);
  });

  it("applies the baseline in a safe order: namespace, identity, limits, then policies", () => {
    const kinds = renderTenancy(TENANT, substrate()).objects.map((o) => o.kind);
    expect(kinds).toEqual(["Namespace", "ServiceAccount", "ResourceQuota", "LimitRange", "NetworkPolicy", "NetworkPolicy"]);
  });
});
