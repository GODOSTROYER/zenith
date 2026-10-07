/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-MAN-04 / PROD-MAN-05 policy generators, no cluster: the isolation profile
 * (hostname egress engine, sandbox runtime, per-tenant operator credentials),
 * the isolation bundle (CiliumNetworkPolicy, priority quota, operator access),
 * the cross-tenant operator-separation analysis and the pod-placement gate rules.
 * The live counterpart is tests/isolation/tenant-isolation-acceptance.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertTenantObjects, validateTenantObjects } from "@/lib/providers/zenith/isolation";
import {
  FQDN_POLICY_NAME,
  OPERATOR_NAMESPACE,
  TENANT_OPERATOR_ROLE,
  analyzeOperatorSeparation,
  bundleObjects,
  collectIsolationBundleViolations,
  renderIsolationBundle,
  validateIsolationBundle,
  validateOperatorAccess,
} from "@/lib/providers/zenith/isolation-bundle";
import { METADATA_ENDPOINT_CIDRS, checkFqdnRule, effectiveFqdns, normalizeFqdnRules } from "@/lib/providers/zenith/isolation-profile";
import type { K8sObject } from "@/lib/providers/zenith/k8s-port";
import { PLAN_LIMITS } from "@/lib/providers/zenith/plans";
import { renderZenithEnvironment } from "@/lib/providers/zenith/render";
import { readSubstrateConfig, substrateConnectionConfig, tenantObjectPrefix } from "@/lib/providers/zenith/substrate";
import { renderTenancy, tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { TENANCY_OBJECTS, ZenithError, type ZenithTenant } from "@/lib/providers/zenith/types";
import { FULL_ENV, FakeToolkit, NS, TENANT, TYPICAL_GRAPH, substrate } from "./support";

const CILIUM_ENV = { ...FULL_ENV, ZENITH_MANAGED_FQDN_ENGINE: "cilium", ZENITH_MANAGED_EGRESS_FQDNS: "registry.npmjs.org,*.pkg.example.com" };
const cilium = substrate(CILIUM_ENV);
const TENANT_B: ZenithTenant = { ...TENANT, workspaceId: "ws_other", environmentId: "env_other", workspaceSlug: "globex" };
const NS_B = tenantNamespace(TENANT_B.workspaceId, TENANT_B.environmentId);

describe("FQDN rule validation", () => {
  it.each(["registry.npmjs.org", "*.pkg.example.com", "a.b.c.example.org", "API.Example.COM"])("accepts %s", (rule) => {
    expect(checkFqdnRule(rule).ok).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["*", "bare wildcard"],
    ["*.com", "single-label wildcard suffix"],
    ["com", "single label"],
    ["10.0.0.1", "IPv4 literal"],
    ["169.254.169.254", "metadata IP literal"],
    ["metadata.google.internal", "GCP metadata name"],
    ["svc.cluster.local", "cluster-internal name"],
    ["db.default.svc", "service name"],
    ["foo.internal", ".internal suffix"],
    ["*.foo.internal", "wildcard under .internal"],
    ["localhost", "localhost"],
    ["a.*.example.com", "wildcard in the middle"],
    ["**.example.com", "double wildcard"],
    ["https://example.com", "scheme"],
    ["example.com:443", "port"],
    ["example.com/path", "path"],
    ["user@example.com", "credentials"],
    ["example.com.", "trailing dot"],
    ["exa mple.com", "space"],
    ["xn--e1afmkfd.example.com", "punycode label"],
    ["-bad.example.com", "leading hyphen"],
    ["a".repeat(64) + ".example.com", "label over 63"],
  ])("refuses %j (%s)", (rule) => {
    const c = checkFqdnRule(rule);
    expect(c.ok).toBe(false);
    expect(c.problem).toBeTruthy();
  });

  it("normalizes to lowercase, sorted, unique, and refuses a list with one bad entry by name", () => {
    expect(normalizeFqdnRules(["B.example.com", "a.example.com", "b.example.com"])).toEqual(["a.example.com", "b.example.com"]);
    expect(() => normalizeFqdnRules(["ok.example.com", "10.1.1.1"])).toThrow(/10\.1\.1\.1/);
    expect(() => normalizeFqdnRules(Array.from({ length: 101 }, (_, i) => `h${i}.example.com`))).toThrow(/exceed/);
  });

  it("never widens a hostname request when the substrate has no hostname engine", () => {
    const plain = substrate();
    expect(effectiveFqdns(plain.isolation, [])).toEqual([]);
    try {
      effectiveFqdns(plain.isolation, ["api.example.com"]);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ZenithError).code).toBe("unsupported");
      expect((e as ZenithError).message).toContain("addresses, not names");
    }
    expect(() => renderIsolationBundle(TENANT, plain, { egressFqdns: ["api.example.com"] })).toThrow(ZenithError);
  });
});

describe("substrate isolation configuration", () => {
  it("is absent unless one of the isolation variables is set (existing substrates render exactly as before)", () => {
    expect(substrate().isolation).toBeUndefined();
  });

  it("reads the engine, platform hostnames, runtime class and operator prefix", () => {
    const s = substrate({ ...CILIUM_ENV, ZENITH_MANAGED_RUNTIME_CLASS: "gvisor", ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators" });
    expect(s.isolation).toEqual({ fqdnEngine: "cilium", platformFqdns: ["*.pkg.example.com", "registry.npmjs.org"], runtimeClass: "gvisor", operatorCredentialPrefix: "vault:zenith-managed/operators" });
  });

  it.each([
    [{ ZENITH_MANAGED_FQDN_ENGINE: "calico" }, "ZENITH_MANAGED_FQDN_ENGINE"],
    [{ ZENITH_MANAGED_EGRESS_FQDNS: "a.example.com" }, "ZENITH_MANAGED_EGRESS_FQDNS"],
    [{ ZENITH_MANAGED_FQDN_ENGINE: "cilium", ZENITH_MANAGED_EGRESS_FQDNS: "10.0.0.1" }, "ZENITH_MANAGED_EGRESS_FQDNS"],
    [{ ZENITH_MANAGED_RUNTIME_CLASS: "Not A Class" }, "ZENITH_MANAGED_RUNTIME_CLASS"],
    [{ ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "-----BEGIN PRIVATE KEY-----" }, "ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX"],
    [{ ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "plain-value" }, "ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX"],
    [{ ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators/" }, "ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX"],
  ])("fails closed and names the variable for %j", (extra, variable) => {
    const cfg = readSubstrateConfig({ ...FULL_ENV, ...extra });
    expect(cfg.configured).toBe(false);
    if (!cfg.configured) expect(cfg.invalid.map((i) => i.variable)).toContain(variable);
  });

  it("uses the per-tenant operator credential for a session, and the platform one without a prefix", () => {
    const withPrefix = substrate({ ...FULL_ENV, ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators" });
    const a = substrateConnectionConfig(withPrefix, NS);
    const b = substrateConnectionConfig(withPrefix, NS_B);
    expect(a).toMatchObject({ credentialRef: `vault:zenith-managed/operators/${NS}`, namespaces: [NS] });
    expect(b).toMatchObject({ credentialRef: `vault:zenith-managed/operators/${NS_B}`, namespaces: [NS_B] });
    expect(a.credentialRef).not.toBe(b.credentialRef);
    expect(substrateConnectionConfig(substrate(), NS).credentialRef).toBe("vault:zenith-managed/kubeconfig");
  });
});

describe("hostname egress (cilium engine)", () => {
  const baseline = renderTenancy(TENANT, cilium, { withManagedDatabase: true });
  const bundle = renderIsolationBundle(TENANT, cilium, { egressFqdns: ["api.example.com"] });
  const cnp = bundle.fqdnEgress[0];

  it("drops the 'any public address on 443' rule from the baseline and says so", () => {
    const allow = baseline.objects.find((o) => o.metadata.name === TENANCY_OBJECTS.allowPlatform)!;
    const egress = (allow.spec as { egress: { to: { ipBlock?: { cidr: string } }[]; ports: { port: number }[] }[] }).egress;
    // DNS, plus the managed-database rule on 5432; no rule opens TCP 443 to anything
    expect(egress.flatMap((r) => r.ports.map((p) => p.port)).sort()).toEqual([53, 53, 5432]);
    expect(baseline.notes.join(" ")).toContain("Hostname egress");
  });

  it("keeps the default baseline byte-identical when no engine is configured", () => {
    const plain = renderTenancy(TENANT, substrate(), { withManagedDatabase: true });
    const allow = plain.objects.find((o) => o.metadata.name === TENANCY_OBJECTS.allowPlatform)!;
    expect((allow.spec as { egress: unknown[] }).egress).toHaveLength(3);
  });

  it("renders one CiliumNetworkPolicy: DNS through the proxy, the platform and tenant hostnames on 443, metadata denied", () => {
    expect(bundle.fqdnEgress).toHaveLength(1);
    expect(cnp).toMatchObject({ apiVersion: "cilium.io/v2", kind: "CiliumNetworkPolicy", metadata: { name: FQDN_POLICY_NAME, namespace: NS } });
    const spec = cnp.spec as { endpointSelector: object; egress: Record<string, unknown>[]; egressDeny: { toCIDRSet: { cidr: string }[] }[] };
    expect(spec.endpointSelector).toEqual({});
    expect(spec.egress[0]).toMatchObject({ toPorts: [{ rules: { dns: [{ matchPattern: "*" }] } }] });
    expect(spec.egress[1].toFQDNs).toEqual([{ matchPattern: "*.pkg.example.com" }, { matchName: "api.example.com" }, { matchName: "registry.npmjs.org" }]);
    expect(spec.egress[1].toPorts).toEqual([{ ports: [{ port: "443", protocol: "TCP" }] }]);
    expect(spec.egressDeny[0].toCIDRSet.map((c) => c.cidr)).toEqual([...METADATA_ENDPOINT_CIDRS]);
    expect(bundle.egressFqdns).toEqual(["*.pkg.example.com", "api.example.com", "registry.npmjs.org"]);
  });

  it("is byte-stable and renders nothing when the engine is none", () => {
    expect(JSON.stringify(renderIsolationBundle(TENANT, cilium, { egressFqdns: ["api.example.com"] }))).toBe(JSON.stringify(bundle));
    expect(renderIsolationBundle(TENANT, substrate()).fqdnEgress).toEqual([]);
  });

  it("an empty allowlist still renders DNS and the deny, never a wildcard", () => {
    const only = renderIsolationBundle(TENANT, substrate({ ...FULL_ENV, ZENITH_MANAGED_FQDN_ENGINE: "cilium" }));
    const spec = only.fqdnEgress[0].spec as { egress: unknown[] };
    expect(spec.egress).toHaveLength(1);
  });

  it("the bundle validator accepts the render and refuses every tampered shape", () => {
    expect(collectIsolationBundleViolations(bundle, { tenant: TENANT, substrate: cilium })).toEqual([]);
    const tamper = (mutate: (spec: Record<string, any>) => void): string[] => {
      const copy = structuredClone(bundle);
      mutate(copy.fqdnEgress[0].spec as Record<string, any>);
      return collectIsolationBundleViolations(copy, { tenant: TENANT, substrate: cilium }).map((v) => v.rule);
    };
    expect(tamper((s) => s.egress.push({ toCIDR: ["0.0.0.0/0"] }))).toContain("network_policy");
    expect(tamper((s) => s.egress.push({ toEntities: ["world"] }))).toContain("network_policy");
    expect(tamper((s) => (s.egress[1].toFQDNs = [{ matchPattern: "*" }]))).toContain("fqdn_rule");
    expect(tamper((s) => (s.egress[1].toFQDNs = [{ matchName: "10.0.0.5" }]))).toContain("fqdn_rule");
    expect(tamper((s) => (s.egress[1].toPorts = [{ ports: [{ port: "22", protocol: "TCP" }] }]))).toContain("fqdn_port");
    expect(tamper((s) => (s.egress[1].toPorts = [{ ports: [{ port: "443", protocol: "TCP" }], rules: { http: [{}] } }]))).toContain("fqdn_port");
    expect(tamper((s) => (s.egressDeny = []))).toContain("metadata_deny");
    expect(tamper((s) => (s.endpointSelector = { matchLabels: { a: "b" } }))).toContain("network_policy");
    expect(tamper((s) => (s.ingress = [{ fromEntities: ["world"] }]))).toContain("network_policy");
    expect(() => validateIsolationBundle({ ...bundle, fqdnEgress: [{ ...cnp, metadata: { ...cnp.metadata, namespace: NS_B } }] }, { tenant: TENANT, substrate: cilium })).toThrow(/isolation bundle violation/);
    // a hostname policy with no engine configured is refused
    expect(collectIsolationBundleViolations(bundle, { tenant: TENANT, substrate: substrate() }).map((v) => v.rule)).toContain("fqdn_engine");
  });
});

describe("priority quota", () => {
  it("admits zero pods of the system priority classes", () => {
    const q = renderIsolationBundle(TENANT, substrate()).priorityQuota[0];
    expect(q.spec).toEqual({ hard: { pods: "0" }, scopeSelector: { matchExpressions: [{ scopeName: "PriorityClass", operator: "In", values: ["system-cluster-critical", "system-node-critical"] }] } });
    expect(q.metadata.namespace).toBe(NS);
  });

  it("refuses a tampered quota", () => {
    const b = renderIsolationBundle(TENANT, substrate());
    const bad = { ...b, priorityQuota: [{ ...b.priorityQuota[0], spec: { hard: { pods: "100" } } }] };
    expect(collectIsolationBundleViolations(bad, { tenant: TENANT, substrate: substrate() }).map((v) => v.rule)).toContain("priority_quota");
  });
});

describe("operator separation", () => {
  const sub = substrate({ ...FULL_ENV, ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX: "vault:zenith-managed/operators" });
  const a = renderIsolationBundle(TENANT, sub);
  const b = renderIsolationBundle(TENANT_B, sub);

  it("renders a ServiceAccount per tenant, a namespaced Role and RoleBinding, and a namespace grant by name", () => {
    expect(a.operatorSubject).toEqual({ namespace: OPERATOR_NAMESPACE, name: `zenith-op-${NS}` });
    expect(a.operatorSubject.name).not.toBe(b.operatorSubject.name);
    expect(a.operatorAccess.map((o) => o.kind)).toEqual(["ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]);
    const role = a.operatorAccess.find((o) => o.kind === "Role")!;
    expect(role.metadata).toMatchObject({ name: TENANT_OPERATOR_ROLE, namespace: NS });
    const cr = a.operatorAccess.find((o) => o.kind === "ClusterRole")! as K8sObject & { rules: { resourceNames: string[]; verbs: string[] }[] };
    expect(cr.rules).toEqual([{ apiGroups: [""], resources: ["namespaces"], resourceNames: [NS], verbs: ["get", "patch"] }]);
  });

  it("never grants RBAC, exec, attach, port-forward, token minting, nodes, wildcards or the escalation verbs", () => {
    const role = a.operatorAccess.find((o) => o.kind === "Role")! as K8sObject & { rules: { resources: string[]; verbs: string[]; apiGroups: string[] }[] };
    const resources = role.rules.flatMap((r) => r.resources);
    const verbs = role.rules.flatMap((r) => r.verbs);
    for (const banned of ["roles", "rolebindings", "clusterroles", "pods/exec", "pods/attach", "pods/portforward", "serviceaccounts/token", "nodes", "persistentvolumes", "customresourcedefinitions", "*"]) expect(resources).not.toContain(banned);
    for (const banned of ["escalate", "bind", "impersonate", "deletecollection", "*"]) expect(verbs).not.toContain(banned);
  });

  it("passes validation, and the static analysis finds no grant outside a tenant's own namespace", () => {
    expect(validateOperatorAccess(a.operatorAccess, TENANT)).toEqual([]);
    const { grants, findings } = analyzeOperatorSeparation([
      { tenant: TENANT, objects: a.operatorAccess },
      { tenant: TENANT_B, objects: b.operatorAccess },
    ]);
    expect(findings).toEqual([]);
    const keyA = `${OPERATOR_NAMESPACE}/zenith-op-${NS}`;
    expect(new Set(grants[keyA].map((g) => g.scope))).toEqual(new Set([NS, "cluster"]));
    expect(grants[keyA].some((g) => g.scope === NS_B)).toBe(false);
    expect(grants[`${OPERATOR_NAMESPACE}/zenith-op-${NS_B}`].every((g) => g.scope === NS_B || g.scope === "cluster")).toBe(true);
  });

  it("detects a binding that reaches another tenant, a widened cluster grant and a shared identity", () => {
    // 1. tenant A's subject bound into tenant B's namespace
    const leak: K8sObject = { ...b.operatorAccess[2], subjects: [{ kind: "ServiceAccount", name: a.operatorSubject.name, namespace: OPERATOR_NAMESPACE }] };
    const f1 = analyzeOperatorSeparation([
      { tenant: TENANT, objects: a.operatorAccess },
      { tenant: TENANT_B, objects: [b.operatorAccess[0], b.operatorAccess[1], leak, b.operatorAccess[3], b.operatorAccess[4]] },
    ]).findings;
    expect(f1.some((f) => f.rule === "cross_tenant_namespace" && f.detail.includes(NS_B))).toBe(true);
    // 2. a cluster grant over every namespace
    const wide: K8sObject = { ...a.operatorAccess[3], rules: [{ apiGroups: [""], resources: ["namespaces", "secrets"], verbs: ["get", "list"] }] };
    const f2 = analyzeOperatorSeparation([{ tenant: TENANT, objects: [a.operatorAccess[0], a.operatorAccess[1], a.operatorAccess[2], wide, a.operatorAccess[4]] }]).findings;
    expect(f2.map((f) => f.rule)).toContain("cluster_scope");
    // 3. two tenants rendered with the same ServiceAccount
    const f3 = analyzeOperatorSeparation([
      { tenant: TENANT, objects: a.operatorAccess },
      { tenant: TENANT_B, objects: [{ ...a.operatorAccess[0] }] },
    ]).findings;
    expect(f3.map((f) => f.rule)).toContain("shared_identity");
  });

  it.each<[string, (objs: K8sObject[]) => K8sObject[], string]>([
    ["a Role that can read pods/exec", (o) => o.map((x) => (x.kind === "Role" ? { ...x, rules: [{ apiGroups: [""], resources: ["pods/exec"], verbs: ["create"] }] } : x)), "rbac_rule"],
    ["a wildcard verb", (o) => o.map((x) => (x.kind === "Role" ? { ...x, rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["*"] }] } : x)), "rbac_rule"],
    ["the escalate verb on roles", (o) => o.map((x) => (x.kind === "Role" ? { ...x, rules: [{ apiGroups: ["rbac.authorization.k8s.io"], resources: ["roles"], verbs: ["escalate", "bind"] }] } : x)), "rbac_rule"],
    ["a Role in another namespace", (o) => o.map((x) => (x.kind === "Role" ? { ...x, metadata: { ...x.metadata, namespace: NS_B } } : x)), "namespace_scope"],
    ["a RoleBinding to a foreign subject", (o) => o.map((x) => (x.kind === "RoleBinding" ? { ...x, subjects: [{ kind: "User", name: "someone" }] } : x)), "operator_identity"],
    ["a RoleBinding to a ClusterRole", (o) => o.map((x) => (x.kind === "RoleBinding" ? { ...x, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "cluster-admin" } } : x)), "rbac_rule"],
    ["a ClusterRole over all namespaces", (o) => o.map((x) => (x.kind === "ClusterRole" ? { ...x, rules: [{ apiGroups: [""], resources: ["namespaces"], verbs: ["get"] }] } : x)), "rbac_rule"],
    ["a ClusterRole with create on namespaces", (o) => o.map((x) => (x.kind === "ClusterRole" ? { ...x, rules: [{ apiGroups: [""], resources: ["namespaces"], resourceNames: [NS], verbs: ["create"] }] } : x)), "rbac_rule"],
    ["a ClusterRoleBinding to cluster-admin", (o) => o.map((x) => (x.kind === "ClusterRoleBinding" ? { ...x, roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "cluster-admin" } } : x)), "rbac_rule"],
    ["a mounted token", (o) => o.map((x) => (x.kind === "ServiceAccount" ? { ...x, automountServiceAccountToken: true } : x)), "service_account_token"],
    ["a missing ClusterRoleBinding", (o) => o.filter((x) => x.kind !== "ClusterRoleBinding"), "operator_identity"],
    ["an unrelated kind", (o) => [...o, { apiVersion: "v1", kind: "Pod", metadata: { name: "x", annotations: { "zenith.dev/environment": TENANT.environmentId } } }], "kind_not_allowed"],
  ])("refuses %s", (_name, mutate, rule) => {
    expect(validateOperatorAccess(mutate(structuredClone(a.operatorAccess)), TENANT).map((v) => v.rule)).toContain(rule);
  });

  it("says plainly when separation is rendered but not active", () => {
    expect(renderIsolationBundle(TENANT, substrate()).notes.join(" ")).toContain("Operator separation is not active");
    expect(a.notes.join(" ")).not.toContain("Operator separation is not active");
  });

  it("orders the bundle for a bootstrap identity: RBAC identity, then quota, then network policy", () => {
    const all = bundleObjects(renderIsolationBundle(TENANT, cilium));
    expect(all.map((o) => o.kind)).toEqual(["ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "ResourceQuota", "CiliumNetworkPolicy"]);
  });
});

describe("storage separation", () => {
  it("derives non-overlapping object prefixes, even for hostile ids", () => {
    const s = substrate();
    const ids = ["ws_a", "ws_a/../ws_b", "ws_b", "..", "ws_a/", "WS_A", "a\u0000b"];
    const prefixes = new Set<string>();
    for (const w of ids) {
      for (const e of ["env_1", "env_1/../env_2", "env_2"]) {
        const p = tenantObjectPrefix({ workspaceId: w, environmentId: e }, s)!;
        expect(p.prefix.endsWith("/")).toBe(true);
        expect(p.prefix.split("/").includes("..")).toBe(false);
        prefixes.add(p.prefix);
      }
    }
    expect(prefixes.size).toBe(ids.length * 3);
    const all = [...prefixes];
    for (const x of all) for (const y of all) if (x !== y) expect(y.startsWith(x), `${x} is a prefix of ${y}`).toBe(false);
  });
});

describe("pod placement gate", () => {
  const ctxFor = (substrate_: ReturnType<typeof substrate>) => ({ tenant: TENANT, substrate: substrate_ });
  const marks = {
    name: "web",
    namespace: NS,
    labels: { "app.kubernetes.io/managed-by": "zenith" },
    annotations: { "zenith.dev/environment": TENANT.environmentId, "zenith.dev/resource": "container_service/web" },
  };
  const dep = (pod: Record<string, unknown> = {}): K8sObject => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: marks,
    spec: {
      template: {
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{ name: "app", image: "ghcr.io/acme/web:1", securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] } } }],
          ...pod,
        },
      },
    },
  });
  const rules = (o: K8sObject, s = substrate()) => validateTenantObjects([o], ctxFor(s)).map((v) => v.rule);

  it("refuses a tenant-chosen runtime class when the substrate mandates none", () => {
    expect(rules(dep({ runtimeClassName: "privileged-runtime" }))).toContain("runtime_class");
    expect(rules(dep())).not.toContain("runtime_class");
  });

  it("requires exactly the mandated runtime class when there is one", () => {
    const s = substrate({ ...FULL_ENV, ZENITH_MANAGED_RUNTIME_CLASS: "gvisor" });
    expect(rules(dep(), s)).toContain("runtime_class");
    expect(rules(dep({ runtimeClassName: "runc" }), s)).toContain("runtime_class");
    expect(rules(dep({ runtimeClassName: "gvisor" }), s)).not.toContain("runtime_class");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a system priority class", { priorityClassName: "system-node-critical" }, "priority_class"],
    ["any priority class", { priorityClassName: "mine" }, "priority_class"],
    ["a pinned node", { nodeName: "control-plane" }, "node_name"],
    ["a wildcard toleration", { tolerations: [{ operator: "Exists" }] }, "tolerations"],
    ["a key-less toleration", { tolerations: [{ effect: "NoSchedule" }] }, "tolerations"],
  ])("refuses %s", (_n, pod, rule) => {
    expect(rules(dep(pod))).toContain(rule);
  });

  it("allows a specific toleration", () => {
    expect(rules(dep({ tolerations: [{ key: "dedicated", operator: "Equal", value: "x", effect: "NoSchedule" }] }))).not.toContain("tolerations");
  });
});

describe("route hijack at the gate", () => {
  const sub = substrate();
  const route = (host: string, over: Record<string, unknown> = {}): K8sObject => ({
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: {
      name: "hijack",
      namespace: NS,
      labels: { "app.kubernetes.io/managed-by": "zenith" },
      annotations: { "zenith.dev/environment": TENANT.environmentId, "zenith.dev/resource": "load_balancer/hijack" },
    },
    spec: { hostnames: [host], parentRefs: [], rules: [], ...over },
  });
  const rules = (o: K8sObject) => validateTenantObjects([o], { tenant: TENANT, substrate: sub }).map((v) => v.rule);

  it("refuses a hostname under another tenant's suffix, another workspace, a wildcard or the apex", () => {
    const base = sub.baseDomain;
    for (const host of [`web.production.globex.${base}`, `web.staging.acme.${base}`, `*.production.acme.${base}`, `a.b.production.acme.${base}`, base, `web.production.acme.${base}.evil.test`]) {
      expect(rules(route(host)), host).toContain("route_hostname");
    }
  });

  it("refuses a route that attaches to a parent other than this environment's listener", () => {
    const foreign = [{ group: "gateway.networking.k8s.io", kind: "Gateway", name: "other-tenant-gw", namespace: sub.gateway.namespace, sectionName: "https" }];
    expect(rules(route(`web.production.acme.${sub.baseDomain}`, { parentRefs: foreign }))).toContain("route_parent");
  });
});

describe("route hijack through the renderer", () => {
  it("rewrites a source host that equals another tenant's managed hostname into the caller's own suffix", () => {
    const sub = substrate();
    const victimHost = `web.production.globex.${sub.baseDomain}`;
    const lb = TYPICAL_GRAPH.find((n) => n.kind === "load_balancer")!;
    const hijack = { ...lb, spec: { ...(lb.spec as Record<string, unknown>), routes: [{ host: victimHost, pathPrefix: "/", tls: true, target: "container_service/web", port: 8080 }] } };
    const nodes = TYPICAL_GRAPH.map((n) => (n === lb ? hijack : n));
    const r = renderZenithEnvironment({ tenant: TENANT, substrate: sub, nodes, toolkit: new FakeToolkit() });
    const hosts = r.workloads.filter((o) => o.kind === "HTTPRoute").flatMap((o) => (o.spec as { hostnames: string[] }).hostnames);
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) {
      expect(h.endsWith(`.production.acme.${sub.baseDomain}`), h).toBe(true);
      expect(h).not.toBe(victimHost);
    }
    expect(r.hostnames.every((m) => m.managed !== victimHost)).toBe(true);
  });
});

describe("renderZenithEnvironment wiring", () => {
  const render = (s: ReturnType<typeof substrate>, extra: { egressFqdns?: string[] } = {}) =>
    renderZenithEnvironment({ tenant: TENANT, substrate: s, nodes: TYPICAL_GRAPH, toolkit: new FakeToolkit(), ...extra });

  it("stamps the mandated runtime class on every tenant pod and the gate accepts it", () => {
    const s = substrate({ ...FULL_ENV, ZENITH_MANAGED_RUNTIME_CLASS: "gvisor" });
    const r = render(s);
    const pods = r.workloads.filter((o) => o.kind === "Deployment");
    expect(pods.length).toBeGreaterThan(0);
    for (const d of pods) expect((d.spec as { template: { spec: { runtimeClassName?: string } } }).template.spec.runtimeClassName, d.metadata.name).toBe("gvisor");
    expect(() => assertTenantObjects([...r.baseline, ...r.workloads], { tenant: TENANT, substrate: s })).not.toThrow();
  });

  it("leaves pods untouched when no runtime class is mandated", () => {
    const r = render(substrate());
    for (const d of r.workloads.filter((o) => o.kind === "Deployment")) expect((d.spec as { template: { spec: Record<string, unknown> } }).template.spec.runtimeClassName).toBeUndefined();
  });

  it("returns the isolation bundle with the render and carries the tenant's hostnames into it", () => {
    const r = render(cilium, { egressFqdns: ["api.example.com"] });
    expect(r.isolation.namespace).toBe(NS);
    expect(r.isolation.egressFqdns).toContain("api.example.com");
    expect(r.isolation.fqdnEgress).toHaveLength(1);
    expect(r.notes.join(" ")).toContain("Hostname egress");
  });

  it("refuses a hostname request on a substrate without a hostname engine instead of widening egress", () => {
    expect(() => render(substrate(), { egressFqdns: ["api.example.com"] })).toThrow(/addresses, not names/);
  });
});

describe("resource limits (PROD-MAN-05 policy)", () => {
  it("gives every container an ephemeral-storage default, request and ceiling on every tier", () => {
    for (const tier of ["free", "starter", "pro"] as const) {
      const c = PLAN_LIMITS[tier].container;
      for (const part of [c.default, c.defaultRequest, c.max]) expect(part["ephemeral-storage"], tier).toMatch(/^\d+(Mi|Gi)$/);
      const toMi = (q: string) => (q.endsWith("Gi") ? Number.parseInt(q, 10) * 1024 : Number.parseInt(q, 10));
      expect(toMi(c.defaultRequest["ephemeral-storage"]!)).toBeLessThanOrEqual(toMi(c.default["ephemeral-storage"]!));
      expect(toMi(c.default["ephemeral-storage"]!)).toBeLessThanOrEqual(toMi(c.max["ephemeral-storage"]!));
      // one container at its ceiling must fit the namespace quota, or the ceiling is unreachable and misleading
      expect(toMi(c.max["ephemeral-storage"]!)).toBeLessThanOrEqual(toMi(PLAN_LIMITS[tier].quota["limits.ephemeral-storage"]));
    }
  });

  it("bounds the number of pods, services, secrets and total compute in every tier's quota", () => {
    for (const tier of ["free", "starter", "pro"] as const) {
      const hard = PLAN_LIMITS[tier].quota;
      for (const key of ["pods", "services", "secrets", "configmaps", "limits.cpu", "limits.memory", "requests.cpu", "requests.memory", "limits.ephemeral-storage", "requests.storage"]) expect(hard[key], `${tier} ${key}`).toBeDefined();
    }
  });

  it("renders the ephemeral-storage defaults into the LimitRange", () => {
    const lr = renderTenancy(TENANT, substrate()).objects.find((o) => o.kind === "LimitRange")!;
    const c = (lr.spec as { limits: { type: string; default: Record<string, string>; max: Record<string, string> }[] }).limits.find((l) => l.type === "Container")!;
    expect(c.default["ephemeral-storage"]).toBe(PLAN_LIMITS.starter.container.default["ephemeral-storage"]);
    expect(c.max["ephemeral-storage"]).toBe(PLAN_LIMITS.starter.container.max["ephemeral-storage"]);
  });
});

describe("baseline stays the verified shape", () => {
  it("still renders exactly six kinds in the same order whatever the profile", () => {
    for (const s of [substrate(), cilium]) {
      expect(renderTenancy(TENANT, s).objects.map((o) => o.kind)).toEqual(["Namespace", "ServiceAccount", "ResourceQuota", "LimitRange", "NetworkPolicy", "NetworkPolicy"]);
    }
  });

  it("documents every new variable", () => {
    const doc = fs.readFileSync(path.resolve(__dirname, "../../../docs/platform/MANAGED-PLATFORM.md"), "utf8");
    for (const v of ["ZENITH_MANAGED_FQDN_ENGINE", "ZENITH_MANAGED_EGRESS_FQDNS", "ZENITH_MANAGED_RUNTIME_CLASS", "ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX"]) expect(doc, v).toContain(v);
  });
});
