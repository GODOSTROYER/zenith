/**
 * The isolation BUNDLE: platform-owned objects that complete a tenant's isolation
 * but are deliberately NOT part of `baseline` (the tenancy objects the
 * Kubernetes provider's apply path writes) or `workloads`:
 *
 *   fqdnEgress      a CiliumNetworkPolicy that allows DNS and TCP 443 to an
 *                   allowlist of HOSTNAMES, and denies metadata and link-local
 *                   space outright. Rendered only when the substrate names a
 *                   hostname-capable CNI (`ZENITH_MANAGED_FQDN_ENGINE=cilium`);
 *                   a request for hostnames without one is refused, never
 *                   widened to an address range.
 *   priorityQuota   a ResourceQuota that admits zero pods of the system
 *                   priority classes, so even a pod that slipped past the
 *                   gate cannot preempt its neighbours.
 *   operatorAccess  the least-authority identity for operating THIS tenant:
 *                   a ServiceAccount, a namespaced Role + RoleBinding, and a
 *                   cluster-scoped grant limited by `resourceNames` to this one
 *                   namespace. Applied with the PLATFORM bootstrap identity (it
 *                   creates RBAC, so it is never the tenant operator's own
 *                   authority); its token is what
 *                   `substrateConnectionConfig` resolves per tenant when
 *                   `ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX` is set.
 *
 * Why these are not in `baseline`: the Kubernetes provider's apply set
 * (`KIND_INFO`) does not contain Cilium CRDs and its RBAC validator accepts only
 * exact-name Roles for workload identity. Widening the verified provider for
 * this requirement would change its prune and teardown behaviour on clusters
 * without those CRDs. The bundle is validated here (`validateIsolationBundle`)
 * and applied by the platform's bootstrap path; the acceptance suite applies it
 * with kubectl. See docs/platform/TENANT-ISOLATION.md "Joins".
 *
 * Pure: no I/O, byte-stable for the same inputs.
 */
import { OWNERSHIP, type K8sObject } from "./k8s-port";
import { METADATA_ENDPOINT_CIDRS, checkFqdnRule, effectiveFqdns, usesFqdnEgress } from "./isolation-profile";
import type { IsolationViolation } from "./isolation";
import { assertTenant, type ZenithSubstrate } from "./substrate";
import { labelValue, tenancyMetadata, tenantNamespace } from "./tenancy";
import { ZenithError, type ZenithTenant } from "./types";

/** Namespace of the platform's own ServiceAccounts (matches deploy/zenith-managed/40-operator-rbac.yaml). */
export const OPERATOR_NAMESPACE = "zenith-system";
export const TENANT_OPERATOR_ROLE = "zenith-tenant-operator";
export const FQDN_POLICY_NAME = "zenith-egress-fqdn";
export const PRIORITY_QUOTA_NAME = "zenith-quota-priority";
export const SYSTEM_PRIORITY_CLASSES = ["system-cluster-critical", "system-node-critical"] as const;

const ADDRESS = {
  fqdn: "isolation/egress-fqdn",
  priorityQuota: "isolation/priority-quota",
  operatorSa: "isolation/operator-service-account",
  operatorRole: "isolation/operator-role",
  operatorBinding: "isolation/operator-role-binding",
  operatorClusterRole: "isolation/operator-namespace-role",
  operatorClusterBinding: "isolation/operator-namespace-binding",
} as const;

export interface OperatorSubject {
  namespace: string;
  name: string;
}

/** The per-tenant operator identity: one ServiceAccount per tenant namespace, never shared. */
export const operatorSubjectOf = (tenantNs: string): OperatorSubject => ({ namespace: OPERATOR_NAMESPACE, name: `zenith-op-${tenantNs}` });
const clusterRoleName = (tenantNs: string): string => `zop-ns-${tenantNs}`;

export interface RbacRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
}

/**
 * The most a tenant operator session may do inside ITS namespace. Mirrors
 * deploy/zenith-managed/40-operator-rbac.yaml but namespaced. Deliberately
 * absent: RBAC objects, pods/exec, pods/attach, pods/portforward, pods/eviction,
 * serviceaccounts/token, nodes, persistentvolumes, CRDs, webhooks, wildcards,
 * and the verbs escalate, bind, impersonate and deletecollection.
 */
export const TENANT_OPERATOR_RULES: readonly RbacRule[] = [
  { apiGroups: [""], resources: ["serviceaccounts", "secrets", "services", "persistentvolumeclaims", "resourcequotas", "limitranges"], verbs: ["get", "list", "watch", "create", "patch", "delete"] },
  { apiGroups: [""], resources: ["pods", "pods/log", "events"], verbs: ["get", "list", "watch"] },
  { apiGroups: ["apps"], resources: ["deployments", "replicasets"], verbs: ["get", "list", "watch", "create", "patch", "delete"] },
  { apiGroups: ["batch"], resources: ["cronjobs", "jobs"], verbs: ["get", "list", "watch", "create", "patch", "delete"] },
  { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"], verbs: ["get", "list", "watch", "create", "patch", "delete"] },
  { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies", "ingresses"], verbs: ["get", "list", "watch", "create", "patch", "delete"] },
  { apiGroups: ["gateway.networking.k8s.io"], resources: ["httproutes"], verbs: ["get", "list", "watch", "create", "patch", "delete"] },
];

const NAMESPACE_VERBS = ["get", "patch"] as const;

export interface IsolationBundle {
  namespace: string;
  /** CiliumNetworkPolicy objects (empty unless the substrate names a hostname engine) */
  fqdnEgress: K8sObject[];
  /** system-priority-class quota */
  priorityQuota: K8sObject[];
  /** ServiceAccount, Role, RoleBinding, ClusterRole, ClusterRoleBinding for this tenant's operator identity */
  operatorAccess: K8sObject[];
  operatorSubject: OperatorSubject;
  /** the hostnames the egress policy allows (platform list plus this tenant's), sorted */
  egressFqdns: string[];
  notes: string[];
}

export interface IsolationBundleOptions {
  egressFqdns?: readonly string[];
}

const dnsRule = () => ({
  toEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s:k8s-app": "kube-dns" } }],
  toPorts: [{ ports: [{ port: "53", protocol: "ANY" }], rules: { dns: [{ matchPattern: "*" }] } }],
});

/** Render the platform-owned isolation extras for one tenant. Throws `ZenithError` for a hostname request the substrate cannot enforce. */
export function renderIsolationBundle(tenantInput: ZenithTenant, substrate: ZenithSubstrate, opts: IsolationBundleOptions = {}): IsolationBundle {
  const tenant = assertTenant(tenantInput);
  const ns = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const notes: string[] = [];
  const fqdns = effectiveFqdns(substrate.isolation, opts.egressFqdns);

  const fqdnEgress: K8sObject[] = [];
  if (usesFqdnEgress(substrate.isolation)) {
    fqdnEgress.push({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: tenancyMetadata(tenant, ADDRESS.fqdn, FQDN_POLICY_NAME, ns),
      spec: {
        endpointSelector: {},
        egress: [
          dnsRule(),
          ...(fqdns.length > 0
            ? [
                {
                  toFQDNs: fqdns.map((f) => (f.startsWith("*.") ? { matchPattern: f } : { matchName: f })),
                  toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }],
                },
              ]
            : []),
        ],
        // a deny beats every allow: a name that resolves into metadata or link-local space still cannot be reached
        egressDeny: [{ toCIDRSet: METADATA_ENDPOINT_CIDRS.map((cidr) => ({ cidr })) }],
      },
    });
    notes.push(
      fqdns.length === 0
        ? "Hostname egress: this environment's allowlist is empty, so workloads reach DNS and nothing else."
        : `Hostname egress: workloads may reach ${fqdns.length} hostname(s) on TCP 443 through the CNI; apply the isolation bundle's CiliumNetworkPolicy with the platform bootstrap identity.`
    );
  }

  const priorityQuota: K8sObject[] = [
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: tenancyMetadata(tenant, ADDRESS.priorityQuota, PRIORITY_QUOTA_NAME, ns),
      spec: {
        hard: { pods: "0" },
        scopeSelector: { matchExpressions: [{ scopeName: "PriorityClass", operator: "In", values: [...SYSTEM_PRIORITY_CLASSES] }] },
      },
    },
  ];

  const subject = operatorSubjectOf(ns);
  const roleMeta = (address: string, name: string, namespace: string | undefined) => {
    const m = tenancyMetadata(tenant, address, name, namespace);
    return { ...m, labels: { ...(m.labels ?? {}), "zenith.dev/operator-of": labelValue(ns) } };
  };
  const operatorAccess: K8sObject[] = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: roleMeta(ADDRESS.operatorSa, subject.name, subject.namespace),
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: roleMeta(ADDRESS.operatorRole, TENANT_OPERATOR_ROLE, ns),
      rules: TENANT_OPERATOR_RULES.map((r) => ({ apiGroups: [...r.apiGroups], resources: [...r.resources], verbs: [...r.verbs] })),
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: roleMeta(ADDRESS.operatorBinding, TENANT_OPERATOR_ROLE, ns),
      subjects: [{ kind: "ServiceAccount", name: subject.name, namespace: subject.namespace }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: TENANT_OPERATOR_ROLE },
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: roleMeta(ADDRESS.operatorClusterRole, clusterRoleName(ns), undefined),
      rules: [{ apiGroups: [""], resources: ["namespaces"], resourceNames: [ns], verbs: [...NAMESPACE_VERBS] }],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: roleMeta(ADDRESS.operatorClusterBinding, clusterRoleName(ns), undefined),
      subjects: [{ kind: "ServiceAccount", name: subject.name, namespace: subject.namespace }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: clusterRoleName(ns) },
    },
  ];
  if (substrate.isolation?.operatorCredentialPrefix === undefined) {
    notes.push("Operator separation is not active: ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX is unset, so sessions still use the platform-wide operator credential (a ClusterRole over every tenant namespace). The per-tenant operator identity is rendered but unused.");
  }

  return { namespace: ns, fqdnEgress, priorityQuota, operatorAccess, operatorSubject: subject, egressFqdns: fqdns, notes };
}

/* ------------------------------- validation -------------------------------- */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const label = (o: K8sObject): string => `${o.kind}/${String(o.metadata?.name ?? "?")}`;

function subjectOk(subjects: unknown, want: OperatorSubject): boolean {
  return Array.isArray(subjects) && subjects.length === 1 && isRecord(subjects[0]) && subjects[0].kind === "ServiceAccount" && subjects[0].name === want.name && subjects[0].namespace === want.namespace && (subjects[0].apiGroup === undefined || subjects[0].apiGroup === "");
}

/** Whether every (group, resource, verb) of `rule` is within the canonical tenant-operator rules. */
function ruleWithinCanonical(rule: unknown): string | undefined {
  if (!isRecord(rule)) return "a rule is not an object";
  const groups = strings(rule.apiGroups);
  const resources = strings(rule.resources);
  const verbs = strings(rule.verbs);
  if (groups.length === 0 || resources.length === 0 || verbs.length === 0) return "a rule names no group, resource or verb";
  if ([...groups, ...resources, ...verbs, ...strings(rule.resourceNames)].some((x) => x.includes("*"))) return "a rule uses a wildcard";
  if (Array.isArray(rule.nonResourceURLs)) return "a rule grants nonResourceURLs";
  for (const g of groups) {
    for (const r of resources) {
      for (const v of verbs) {
        const ok = TENANT_OPERATOR_RULES.some((c) => c.apiGroups.includes(g) && c.resources.includes(r) && c.verbs.includes(v));
        if (!ok) return `${v} on ${g === "" ? "core" : g}/${r} is outside the tenant operator's authority`;
      }
    }
  }
  return undefined;
}

/** Every way `objects` (the operator-access objects of ONE tenant) exceeds the least-authority shape. */
export function validateOperatorAccess(objects: readonly K8sObject[], tenant: ZenithTenant, _substrate?: ZenithSubstrate): IsolationViolation[] {
  const ns = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const subject = operatorSubjectOf(ns);
  const out: IsolationViolation[] = [];
  const push = (o: K8sObject, rule: string, detail: string) => out.push({ object: label(o), rule, detail });
  let kinds = 0;
  for (const o of objects) {
    if (!isRecord(o) || typeof o.kind !== "string" || !isRecord(o.metadata) || typeof o.metadata.name !== "string") {
      out.push({ object: "?", rule: "object_shape", detail: "Object needs kind and metadata.name." });
      continue;
    }
    kinds++;
    if (o.metadata.annotations?.[OWNERSHIP.environmentAnnotation] !== tenant.environmentId) push(o, "ownership", `${OWNERSHIP.environmentAnnotation} is not this tenant's environment.`);
    switch (o.kind) {
      case "ServiceAccount":
        if (o.metadata.name !== subject.name || o.metadata.namespace !== subject.namespace) push(o, "operator_identity", `ServiceAccount must be ${subject.namespace}/${subject.name}.`);
        if (o.automountServiceAccountToken !== false) push(o, "service_account_token", "must set automountServiceAccountToken: false.");
        break;
      case "Role": {
        if (o.metadata.namespace !== ns) push(o, "namespace_scope", `Role must live in the tenant namespace ${ns}.`);
        const rules = Array.isArray(o.rules) ? o.rules : [];
        if (rules.length === 0) push(o, "rbac_rule", "Role has no rules.");
        for (const r of rules) {
          const problem = ruleWithinCanonical(r);
          if (problem) push(o, "rbac_rule", problem);
        }
        break;
      }
      case "RoleBinding":
        if (o.metadata.namespace !== ns) push(o, "namespace_scope", `RoleBinding must live in the tenant namespace ${ns}.`);
        if (!subjectOk(o.subjects, subject)) push(o, "operator_identity", `RoleBinding must bind exactly ${subject.namespace}/${subject.name}.`);
        if (!isRecord(o.roleRef) || o.roleRef.kind !== "Role" || o.roleRef.name !== TENANT_OPERATOR_ROLE) push(o, "rbac_rule", `RoleBinding must reference Role ${TENANT_OPERATOR_ROLE} (never a ClusterRole, which would carry cluster-wide authority into the namespace).`);
        break;
      case "ClusterRole": {
        if (o.metadata.name !== clusterRoleName(ns)) push(o, "operator_identity", `ClusterRole must be named ${clusterRoleName(ns)}.`);
        const rules = Array.isArray(o.rules) ? o.rules : [];
        for (const r of rules) {
          const rule = isRecord(r) ? r : {};
          const names = strings(rule.resourceNames);
          const onlyNamespaces = strings(rule.resources).length === 1 && strings(rule.resources)[0] === "namespaces" && strings(rule.apiGroups).length === 1 && strings(rule.apiGroups)[0] === "";
          const verbsOk = strings(rule.verbs).length > 0 && strings(rule.verbs).every((v) => (NAMESPACE_VERBS as readonly string[]).includes(v));
          if (!onlyNamespaces || !verbsOk || names.length !== 1 || names[0] !== ns || Array.isArray(rule.nonResourceURLs)) {
            push(o, "rbac_rule", `a cluster-scoped rule may only get/patch the single namespace ${ns} by resourceNames.`);
          }
        }
        if (rules.length === 0) push(o, "rbac_rule", "ClusterRole has no rules.");
        break;
      }
      case "ClusterRoleBinding":
        if (!subjectOk(o.subjects, subject)) push(o, "operator_identity", `ClusterRoleBinding must bind exactly ${subject.namespace}/${subject.name}.`);
        if (!isRecord(o.roleRef) || o.roleRef.kind !== "ClusterRole" || o.roleRef.name !== clusterRoleName(ns)) push(o, "rbac_rule", `ClusterRoleBinding must reference only ClusterRole ${clusterRoleName(ns)}.`);
        break;
      default:
        push(o, "kind_not_allowed", `${o.kind} is not part of the operator access bundle.`);
    }
  }
  if (kinds > 0) {
    for (const need of ["ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]) {
      if (!objects.some((o) => o.kind === need)) out.push({ object: need, rule: "operator_identity", detail: `the bundle is missing its ${need}.` });
    }
  }
  return out;
}

const CNP_ALLOWED_KEYS = new Set(["toEndpoints", "toPorts", "toFQDNs"]);

function validateFqdnEgress(objects: readonly K8sObject[], tenant: ZenithTenant, substrate: ZenithSubstrate, ns: string): IsolationViolation[] {
  const out: IsolationViolation[] = [];
  for (const o of objects) {
    const push = (rule: string, detail: string) => out.push({ object: label(o), rule, detail });
    if (!usesFqdnEgress(substrate.isolation)) {
      push("fqdn_engine", "a hostname policy is present but the substrate names no hostname engine.");
      continue;
    }
    if (o.kind !== "CiliumNetworkPolicy" || o.apiVersion !== "cilium.io/v2") {
      push("kind_not_allowed", `${o.kind} is not the hostname policy kind for the cilium engine.`);
      continue;
    }
    if (o.metadata.namespace !== ns) push("namespace_scope", `policy is not in the tenant namespace ${ns}.`);
    if (o.metadata.annotations?.[OWNERSHIP.environmentAnnotation] !== tenant.environmentId) push("ownership", "environment annotation is not this tenant's.");
    const spec = isRecord(o.spec) ? o.spec : {};
    if (!isRecord(spec.endpointSelector) || Object.keys(spec.endpointSelector).length !== 0) push("network_policy", "must select every pod of the namespace (empty endpointSelector).");
    for (const k of Object.keys(spec)) if (!["endpointSelector", "egress", "egressDeny"].includes(k)) push("network_policy", `unexpected spec field ${k}; ingress and other directions belong to the tenancy baseline.`);
    for (const rule of Array.isArray(spec.egress) ? spec.egress : []) {
      if (!isRecord(rule)) continue;
      for (const k of Object.keys(rule)) if (!CNP_ALLOWED_KEYS.has(k)) push("network_policy", `egress rule uses ${k}; only DNS to kube-dns and toFQDNs on 443 are allowed (no CIDR, entity or service peers).`);
      if (rule.toFQDNs !== undefined) {
        for (const f of Array.isArray(rule.toFQDNs) ? rule.toFQDNs : []) {
          const v = isRecord(f) ? (f.matchName ?? f.matchPattern) : undefined;
          const keys = isRecord(f) ? Object.keys(f) : [];
          const c = typeof v === "string" ? checkFqdnRule(v) : { ok: false, problem: "is not a string" };
          if (keys.length !== 1 || !c.ok || (isRecord(f) && f.matchName !== undefined && String(f.matchName).startsWith("*"))) push("fqdn_rule", `hostname "${String(v).slice(0, 80)}" ${c.ok ? "has an invalid shape" : c.problem}.`);
        }
        const ports = Array.isArray(rule.toPorts) ? rule.toPorts : [];
        const only443 = ports.length === 1 && isRecord(ports[0]) && Array.isArray(ports[0].ports) && ports[0].ports.length === 1 && isRecord(ports[0].ports[0]) && ports[0].ports[0].port === "443" && ports[0].ports[0].protocol === "TCP" && ports[0].rules === undefined;
        if (!only443) push("fqdn_port", "hostname egress is TCP 443 only.");
      } else if (rule.toEndpoints !== undefined) {
        const ep = Array.isArray(rule.toEndpoints) ? rule.toEndpoints : [];
        const dnsOnly = ep.length === 1 && isRecord(ep[0]) && isRecord(ep[0].matchLabels) && ep[0].matchLabels["k8s:io.kubernetes.pod.namespace"] === "kube-system" && ep[0].matchLabels["k8s:k8s-app"] === "kube-dns";
        if (!dnsOnly) push("network_policy", "the only endpoint peer allowed is kube-dns in kube-system.");
      }
    }
    const deny = Array.isArray(spec.egressDeny) ? spec.egressDeny : [];
    const denied = new Set<string>();
    for (const d of deny) for (const c of isRecord(d) && Array.isArray(d.toCIDRSet) ? d.toCIDRSet : []) if (isRecord(c) && typeof c.cidr === "string") denied.add(c.cidr);
    for (const need of METADATA_ENDPOINT_CIDRS) if (!denied.has(need)) push("metadata_deny", `egressDeny must cover ${need}.`);
  }
  return out;
}

function validatePriorityQuota(objects: readonly K8sObject[], ns: string): IsolationViolation[] {
  const out: IsolationViolation[] = [];
  for (const o of objects) {
    const push = (rule: string, detail: string) => out.push({ object: label(o), rule, detail });
    if (o.kind !== "ResourceQuota" || o.metadata.namespace !== ns) {
      push("namespace_scope", "priority quota must be a ResourceQuota in the tenant namespace.");
      continue;
    }
    const spec = isRecord(o.spec) ? o.spec : {};
    const hard = isRecord(spec.hard) ? spec.hard : {};
    if (Object.keys(hard).length !== 1 || hard.pods !== "0") push("priority_quota", 'must hard-limit pods to "0" for the system priority classes.');
    const sel = isRecord(spec.scopeSelector) && Array.isArray(spec.scopeSelector.matchExpressions) ? spec.scopeSelector.matchExpressions : [];
    const values = sel.length === 1 && isRecord(sel[0]) && sel[0].scopeName === "PriorityClass" && sel[0].operator === "In" ? strings(sel[0].values).sort() : [];
    if (JSON.stringify(values) !== JSON.stringify([...SYSTEM_PRIORITY_CLASSES].sort())) push("priority_quota", "must scope to exactly the two system priority classes.");
  }
  return out;
}

/** Every violation in the bundle; empty means none found. */
export function collectIsolationBundleViolations(bundle: IsolationBundle, ctx: { tenant: ZenithTenant; substrate: ZenithSubstrate }): IsolationViolation[] {
  const ns = tenantNamespace(ctx.tenant.workspaceId, ctx.tenant.environmentId);
  if (bundle.namespace !== ns) return [{ object: "bundle", rule: "namespace_scope", detail: `bundle is for ${bundle.namespace}, not ${ns}.` }];
  return [
    ...validateFqdnEgress(bundle.fqdnEgress, ctx.tenant, ctx.substrate, ns),
    ...validatePriorityQuota(bundle.priorityQuota, ns),
    ...validateOperatorAccess(bundle.operatorAccess, ctx.tenant, ctx.substrate),
  ];
}

/** Throw one `isolation_violation` naming the first violations (bounded), or return. */
export function validateIsolationBundle(bundle: IsolationBundle, ctx: { tenant: ZenithTenant; substrate: ZenithSubstrate }): void {
  const v = collectIsolationBundleViolations(bundle, ctx);
  if (v.length === 0) return;
  const shown = v.slice(0, 5).map((x) => `${x.object} [${x.rule}] ${x.detail}`);
  throw new ZenithError("isolation_violation", `${v.length} isolation bundle violation(s): ${shown.join(" | ")}${v.length > 5 ? ` | and ${v.length - 5} more` : ""}`);
}

/** All objects of a bundle in the order a bootstrap identity applies them (RBAC identity first, policy last). */
export const bundleObjects = (b: IsolationBundle): K8sObject[] => [...b.operatorAccess, ...b.priorityQuota, ...b.fqdnEgress];

/* --------------------------- cross-tenant separation ------------------------ */

export interface OperatorGrant {
  /** a namespace, or `cluster` for a cluster-scoped grant */
  scope: string;
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
}

export interface SeparationFinding {
  subject: string;
  rule: "cross_tenant_namespace" | "cluster_scope" | "shared_identity" | "unknown_binding";
  detail: string;
}

/**
 * Effective grants of every operator ServiceAccount across a set of tenants'
 * operator-access objects, resolved the way RBAC resolves them (RoleBinding ->
 * Role in its namespace, ClusterRoleBinding -> ClusterRole), plus the findings:
 * a grant in a namespace that is not the subject's own, a cluster-scope grant
 * beyond `get/patch` on its own namespace by name, two tenants sharing one
 * subject, or a binding that points at a role this analysis cannot see.
 *
 * Static analysis of what Zenith renders, not of a live cluster: the live
 * counterpart is `kubectl auth can-i --as` in the acceptance suite.
 */
export function analyzeOperatorSeparation(tenants: readonly { tenant: ZenithTenant; objects: readonly K8sObject[] }[]): { grants: Record<string, OperatorGrant[]>; findings: SeparationFinding[] } {
  const roles = new Map<string, RbacRule[]>();
  const clusterRoles = new Map<string, RbacRule[]>();
  const bindings: { scope: string; subjects: { key: string }[]; kind: "Role" | "ClusterRole"; role: string; from: string }[] = [];
  const findings: SeparationFinding[] = [];
  const ownerOf = new Map<string, string>();
  const nsOf = new Map<string, string>();
  const ruleList = (o: K8sObject): RbacRule[] =>
    (Array.isArray(o.rules) ? o.rules : []).filter(isRecord).map((r) => ({ apiGroups: strings(r.apiGroups), resources: strings(r.resources), verbs: strings(r.verbs), ...(r.resourceNames ? { resourceNames: strings(r.resourceNames) } : {}) }));

  for (const { tenant, objects } of tenants) {
    const ns = tenantNamespace(tenant.workspaceId, tenant.environmentId);
    for (const o of objects) {
      if (o.kind === "Role") roles.set(`${o.metadata.namespace}/${o.metadata.name}`, ruleList(o));
      else if (o.kind === "ClusterRole") clusterRoles.set(o.metadata.name, ruleList(o));
      else if (o.kind === "ServiceAccount") {
        const key = `${o.metadata.namespace}/${o.metadata.name}`;
        const prev = ownerOf.get(key);
        if (prev !== undefined && prev !== ns) findings.push({ subject: key, rule: "shared_identity", detail: `ServiceAccount is rendered for both ${prev} and ${ns}.` });
        ownerOf.set(key, ns);
        nsOf.set(key, ns);
      } else if (o.kind === "RoleBinding" || o.kind === "ClusterRoleBinding") {
        const ref = isRecord(o.roleRef) ? o.roleRef : {};
        bindings.push({
          scope: o.kind === "RoleBinding" ? String(o.metadata.namespace) : "cluster",
          subjects: (Array.isArray(o.subjects) ? o.subjects : []).filter(isRecord).map((s) => ({ key: `${String(s.namespace)}/${String(s.name)}` })),
          kind: ref.kind === "ClusterRole" ? "ClusterRole" : "Role",
          role: String(ref.name),
          from: ns,
        });
      }
    }
  }

  const grants: Record<string, OperatorGrant[]> = {};
  for (const b of bindings) {
    const rules = b.kind === "ClusterRole" ? clusterRoles.get(b.role) : roles.get(`${b.scope}/${b.role}`);
    for (const s of b.subjects) {
      if (rules === undefined) {
        findings.push({ subject: s.key, rule: "unknown_binding", detail: `binding references ${b.kind} ${b.role} that is not part of the analysed bundles.` });
        continue;
      }
      // a ClusterRole bound by a RoleBinding would grant its rules inside the binding namespace only; treat the scope by binding kind
      const scope = b.scope;
      for (const r of rules) (grants[s.key] ??= []).push({ scope, apiGroups: r.apiGroups, resources: r.resources, verbs: r.verbs, ...(r.resourceNames ? { resourceNames: r.resourceNames } : {}) });
    }
  }

  for (const [subject, list] of Object.entries(grants)) {
    const own = nsOf.get(subject);
    for (const g of list) {
      if (g.scope === "cluster") {
        const ok = g.resources.length === 1 && g.resources[0] === "namespaces" && g.apiGroups.length === 1 && g.apiGroups[0] === "" && g.verbs.every((v) => v === "get" || v === "patch") && g.resourceNames?.length === 1 && g.resourceNames[0] === own;
        if (!ok) findings.push({ subject, rule: "cluster_scope", detail: `cluster-scope grant ${g.verbs.join("/")} on ${g.resources.join(",")} is beyond get/patch of the subject's own namespace.` });
      } else if (g.scope !== own) {
        findings.push({ subject, rule: "cross_tenant_namespace", detail: `holds ${g.verbs.join("/")} on ${g.resources.join(",")} in namespace ${g.scope}, which is not its own (${String(own)}).` });
      }
    }
  }
  return { grants, findings };
}
