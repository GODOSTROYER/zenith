/**
 * The tenant isolation layer: what every managed environment gets around its
 * workloads, rendered as pure Kubernetes objects.
 *
 *   tenantNamespace(ws, env)        deterministic, collision-resistant namespace name
 *   renderTenancy(tenant, substrate) → the baseline objects for that namespace
 *
 * The baseline, per environment namespace:
 *   Namespace        labels `zenith.dev/workspace`, `zenith.dev/environment`,
 *                    `pod-security.kubernetes.io/enforce: restricted` (plus
 *                    audit and warn), so the API server itself rejects a
 *                    privileged, host-mounting or root pod that slipped past the
 *                    renderers.
 *   NetworkPolicy    `zenith-default-deny`: every pod, both directions, no rules.
 *                    `zenith-allow-platform`: ingress ONLY from the platform
 *                    gateway namespace; egress ONLY to cluster DNS, to the
 *                    public internet on TCP 443 (never private, link-local or
 *                    cluster ranges), and to the explicitly configured managed
 *                    endpoints when the environment has a managed database.
 *   ResourceQuota    from the plan tier (`plans.ts`).
 *   LimitRange       from the plan tier.
 *   ServiceAccount   `zenith-tenant`, `automountServiceAccountToken: false`, no
 *                    role bindings: a tenant pod has no Kubernetes API access.
 *
 * Application-level allow rules (service → service) are the Kubernetes
 * provider's firewall NetworkPolicies, rendered from the graph's bindings and
 * additive to this baseline.
 *
 * Honest limits:
 *   - NetworkPolicy and Pod Security Admission are only as real as the cluster's
 *     CNI and admission configuration. This module renders the intent; it cannot
 *     prove the cluster enforces it (deploy/zenith-managed/README.md lists what
 *     the operator must verify).
 *   - NetworkPolicy matches IP addresses, not hostnames: "internet 443" is
 *     "public address space on 443", not "only the hosts the app needs".
 *   - Nothing here has run against a real cluster.
 */
import { createHash } from "node:crypto";
import { OWNERSHIP, type K8sObject } from "./k8s-port";
import { planLimits } from "./plans";
import type { ZenithSubstrate } from "./substrate";
import { assertTenant } from "./substrate";
import {
  TENANCY_ADDRESS,
  TENANCY_OBJECTS,
  TENANT_ANNOTATION,
  TENANT_LABEL,
  TENANT_SERVICE_ACCOUNT,
  type ZenithTenant,
} from "./types";

/* --------------------------------- naming ---------------------------------- */

/** Everything the namespace name is built from: versioned so a future scheme cannot collide with this one. */
const NAMESPACE_SCHEME = "zenith-tenant-v1";

const readable = (id: string, max: number): string => {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return cleaned === "" ? "x" : cleaned;
};

/**
 * The namespace of one workspace's environment: `zt-<workspace>-<env>-<hash>`,
 * a DNS-1123 label of at most 51 characters.
 *
 * The readable parts are for humans and are truncated; the 10-hex (40-bit)
 * suffix is a SHA-256 over the NUL-separated, full ids, so two different
 * (workspace, environment) pairs differ in the suffix even when their readable
 * parts truncate to the same text, and `("a","bc")` cannot collide with
 * `("ab","c")`. The `zt-` prefix keeps the name disjoint from every platform
 * namespace (`kube-*`, `zenith-*`, `cert-manager`).
 */
export function tenantNamespace(workspaceId: string, environmentId: string): string {
  if (typeof workspaceId !== "string" || workspaceId === "" || typeof environmentId !== "string" || environmentId === "") {
    throw new Error("A tenant namespace needs a workspace id and an environment id.");
  }
  const hash = createHash("sha256").update(`${NAMESPACE_SCHEME}\0${workspaceId}\0${environmentId}`).digest("hex").slice(0, 10);
  return `zt-${readable(workspaceId, 18)}-${readable(environmentId, 18)}-${hash}`;
}

/** A valid label VALUE (`[A-Za-z0-9._-]`, alphanumeric ends, at most 63); altered or long input gets a hash suffix so distinct ids stay distinct. */
export function labelValue(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (cleaned === input && cleaned.length > 0 && cleaned.length <= 63) return input;
  const suffix = `-${createHash("sha256").update(input).digest("hex").slice(0, 8)}`;
  const base = cleaned.slice(0, 63 - suffix.length).replace(/[^A-Za-z0-9]+$/g, "");
  return `${base || "x"}${suffix}`;
}

/** A DNS-1123 label derived from free text, with a hash suffix whenever the text had to change. */
export function dnsLabelOf(input: string, max = 63): string {
  let out = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (out === "") out = "x";
  if (!/^[a-z]/.test(out)) out = `n${out}`;
  if (out === input && out.length <= max) return out;
  const suffix = `-${createHash("sha256").update(input).digest("hex").slice(0, 6)}`;
  return `${out.slice(0, max - suffix.length).replace(/-+$/g, "") || "x"}${suffix}`;
}

/* ------------------------------ private ranges ------------------------------ */

/** Address space a tenant must never reach through the "internet 443" rule. */
export const PRIVATE_IPV4_RANGES: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16", // link-local, including cloud metadata services
  "100.64.0.0/10", // carrier-grade NAT, used by some clusters for pods
  "127.0.0.0/8",
];
export const PRIVATE_IPV6_RANGES: readonly string[] = ["fc00::/7", "fe80::/10", "::1/128"];

/* --------------------------------- objects --------------------------------- */

function meta(tenant: ZenithTenant, address: string, name: string, namespace: string | undefined, extra?: { labels?: Record<string, string> }): K8sObject["metadata"] {
  return {
    name,
    ...(namespace ? { namespace } : {}),
    labels: {
      [OWNERSHIP.managedByLabel]: OWNERSHIP.managedByValue,
      [OWNERSHIP.partOfLabel]: labelValue(tenant.environmentId),
      [TENANT_LABEL.workspace]: labelValue(tenant.workspaceId),
      ...(extra?.labels ?? {}),
    },
    annotations: {
      [OWNERSHIP.resourceAnnotation]: address,
      [OWNERSHIP.environmentAnnotation]: tenant.environmentId,
      [TENANT_ANNOTATION.workspaceId]: tenant.workspaceId,
    },
  };
}

const nsSelector = (name: string) => ({ matchLabels: { "kubernetes.io/metadata.name": name } });

export interface TenancyOptions {
  /** the environment holds a managed database node, so its egress rules apply */
  withManagedDatabase?: boolean;
}

export interface TenancyBaseline {
  namespace: string;
  objects: K8sObject[];
  notes: string[];
}

/**
 * The baseline objects for one tenant, in apply order. Pure: the same tenant and
 * substrate render byte-identical objects.
 */
export function renderTenancy(tenantInput: ZenithTenant, substrate: ZenithSubstrate, opts: TenancyOptions = {}): TenancyBaseline {
  const tenant = assertTenant(tenantInput);
  const ns = tenantNamespace(tenant.workspaceId, tenant.environmentId);
  const limits = planLimits(tenant.planTier);
  const notes: string[] = [];

  const namespace: K8sObject = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      ...meta(tenant, TENANCY_ADDRESS.namespace, ns, undefined, {
        labels: {
          [TENANT_LABEL.environment]: labelValue(tenant.environmentId),
          [TENANT_LABEL.tenant]: "true",
          [TENANT_LABEL.plan]: tenant.planTier,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "latest",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/audit-version": "latest",
          "pod-security.kubernetes.io/warn": "restricted",
          "pod-security.kubernetes.io/warn-version": "latest",
        },
      }),
      annotations: {
        [OWNERSHIP.resourceAnnotation]: TENANCY_ADDRESS.namespace,
        [OWNERSHIP.environmentAnnotation]: tenant.environmentId,
        [TENANT_ANNOTATION.workspaceId]: tenant.workspaceId,
        [TENANT_ANNOTATION.planTier]: tenant.planTier,
      },
    },
  };

  const serviceAccount: K8sObject = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: meta(tenant, TENANCY_ADDRESS.serviceAccount, TENANT_SERVICE_ACCOUNT, ns),
    automountServiceAccountToken: false,
  };

  const quota: K8sObject = {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: meta(tenant, TENANCY_ADDRESS.quota, TENANCY_OBJECTS.quota, ns),
    spec: { hard: { ...limits.quota } },
  };

  const limitRange: K8sObject = {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: meta(tenant, TENANCY_ADDRESS.limits, TENANCY_OBJECTS.limits, ns),
    spec: {
      limits: [
        {
          type: "Container",
          default: { ...limits.container.default },
          defaultRequest: { ...limits.container.defaultRequest },
          max: { ...limits.container.max },
          min: { ...limits.container.min },
        },
        ...(limits.pvc ? [{ type: "PersistentVolumeClaim", min: { storage: limits.pvc.min }, max: { storage: limits.pvc.max } }] : []),
      ],
    },
  };

  const defaultDeny: K8sObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(tenant, TENANCY_ADDRESS.defaultDeny, TENANCY_OBJECTS.defaultDeny, ns),
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  };

  const except4 = [...PRIVATE_IPV4_RANGES, ...substrate.internalCidrs.filter((c) => !c.includes(":"))];
  const except6 = [...PRIVATE_IPV6_RANGES, ...substrate.internalCidrs.filter((c) => c.includes(":"))];
  const egress: Record<string, unknown>[] = [
    {
      to: [{ namespaceSelector: nsSelector("kube-system"), podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
    {
      to: [{ ipBlock: { cidr: "0.0.0.0/0", except: except4 } }, { ipBlock: { cidr: "::/0", except: except6 } }],
      ports: [{ protocol: "TCP", port: 443 }],
    },
  ];
  if (opts.withManagedDatabase === true) {
    const endpoints = substrate.database?.egress ?? [];
    if (endpoints.length === 0) {
      notes.push("This environment has a managed database but the substrate configures no database egress (ZENITH_MANAGED_DB_EGRESS); workloads have no network path to it.");
    }
    for (const e of endpoints) {
      // a broad allow still never reaches private, link-local or cluster ranges
      const broad = e.cidr === "0.0.0.0/0" || e.cidr === "::/0";
      const v6 = e.cidr.includes(":");
      egress.push({
        to: [{ ipBlock: { cidr: e.cidr, ...(broad ? { except: v6 ? except6 : except4 } : {}) } }],
        ports: [{ protocol: "TCP", port: e.port }],
      });
    }
  }

  const allowPlatform: K8sObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(tenant, TENANCY_ADDRESS.allowPlatform, TENANCY_OBJECTS.allowPlatform, ns),
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [{ namespaceSelector: nsSelector(substrate.gateway.namespace) }] }],
      egress,
    },
  };

  return { namespace: ns, objects: [namespace, serviceAccount, quota, limitRange, defaultDeny, allowPlatform], notes };
}
