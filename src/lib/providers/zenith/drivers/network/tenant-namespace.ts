/**
 * `network` / `kubernetes_namespace` on the managed platform: the tenant
 * namespace and its isolation baseline.
 *
 * The baseline is created by `applyZenithEnvironment` (server-side apply), not
 * by this driver; this driver READS it back and reports, honestly, whether the
 * cluster actually holds what `renderTenancy` said it should: the Namespace
 * with restricted Pod Security enforcement and this tenant's labels, the
 * default-deny and allow-platform NetworkPolicies, the plan's ResourceQuota
 * (compared value by value), the LimitRange and the token-less ServiceAccount.
 *
 * Registered under the native type the contract table gives both kinds
 * (`k8s:Namespace`); one driver serves `network` and `kubernetes_namespace`.
 *
 * What "present" does NOT prove: that the CNI enforces NetworkPolicy, that Pod
 * Security Admission is enabled on the API server, or that the quota is being
 * counted. Those are cluster properties the operator must verify
 * (deploy/zenith-managed/README.md); the driver reads objects, not behavior.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import { dig, isRecord, OWNERSHIP, type KubernetesToolkit } from "../../k8s-port";
import { planLimits } from "../../plans";
import { assertSessionMatches, type ZenithSession } from "../../session";
import { tenantNamespace } from "../../tenancy";
import { TENANCY_OBJECTS } from "../../types";
import { contractEvidence, known, observation, presenceFromError, runtimeState, verifyAgainst } from "../common";

export const TENANT_NAMESPACE_DRIVER_ID = "zenith.tenant_namespace@1";

const EXPECTED = {
  ownedByZenith: true,
  podSecurityEnforce: "restricted",
  serviceAccountPresent: true,
  quotaPresent: true,
  quotaMatchesPlan: true,
  limitRangePresent: true,
  defaultDenyPresent: true,
  allowPlatformPresent: true,
};

export function createTenantNamespaceDriver(toolkit: KubernetesToolkit): ResourceDriver<ZenithSession> {
  const id = TENANT_NAMESPACE_DRIVER_ID;
  return {
    id,
    provider: "zenith",
    kind: "network",
    nativeType: "k8s:Namespace",
    capabilities: {
      compile: false,
      observe: true,
      runtime: true,
      verify: true,
      discover: false,
      operations: [],
      evidence: contractEvidence(["observe", "runtime", "verify"]),
    },

    async observe(ctx, node) {
      assertSessionMatches(ctx.session, ctx);
      const { tenant } = ctx.session;
      const ns = tenantNamespace(tenant.workspaceId, tenant.environmentId);
      const k = ctx.session.kubernetes;
      const read = (kind: string, apiVersion: string, name: string, namespace?: string) =>
        toolkit.read(k, { apiVersion, kind, name, ...(namespace ? { namespace } : {}) }, ctx.signal);
      try {
        const nsObj = await read("Namespace", "v1", ns);
        if (!nsObj) return observation({ ctx, node, source: id, presence: "missing", native: { namespace: ns } });
        const [sa, quota, limits, deny, allow] = await Promise.all([
          read("ServiceAccount", "v1", TENANCY_OBJECTS.serviceAccount, ns),
          read("ResourceQuota", "v1", TENANCY_OBJECTS.quota, ns),
          read("LimitRange", "v1", TENANCY_OBJECTS.limits, ns),
          read("NetworkPolicy", "networking.k8s.io/v1", TENANCY_OBJECTS.defaultDeny, ns),
          read("NetworkPolicy", "networking.k8s.io/v1", TENANCY_OBJECTS.allowPlatform, ns),
        ]);
        const now = ctx.now();
        const labels = dig(nsObj, "metadata", "labels");
        const annotations = dig(nsObj, "metadata", "annotations");
        const owned = isRecord(labels) && labels[OWNERSHIP.managedByLabel] === OWNERSHIP.managedByValue && isRecord(annotations) && annotations[OWNERSHIP.environmentAnnotation] === tenant.environmentId;
        const enforce = isRecord(labels) && typeof labels["pod-security.kubernetes.io/enforce"] === "string" ? labels["pod-security.kubernetes.io/enforce"] : "none";
        const hard = dig(quota, "spec", "hard");
        const want = planLimits(tenant.planTier).quota;
        const quotaMatches = isRecord(hard) && Object.entries(want).every(([key, value]) => hard[key] === value);
        return observation({
          ctx,
          node,
          source: id,
          presence: "present",
          externalId: ns,
          attributes: {
            ownedByZenith: known(owned, now),
            podSecurityEnforce: known(enforce, now),
            serviceAccountPresent: known(sa !== undefined, now),
            quotaPresent: known(quota !== undefined, now),
            quotaMatchesPlan: known(quotaMatches, now),
            limitRangePresent: known(limits !== undefined, now),
            defaultDenyPresent: known(deny !== undefined, now),
            allowPlatformPresent: known(allow !== undefined, now),
          },
          native: { namespace: ns, planTier: tenant.planTier, phase: dig(nsObj, "status", "phase") ?? null },
        });
      } catch (e) {
        const p = presenceFromError(e);
        return observation({ ctx, node, source: id, presence: p.presence, error: p.message, native: { namespace: ns } });
      }
    },

    async runtime(ctx, node) {
      assertSessionMatches(ctx.session, ctx);
      const ns = tenantNamespace(ctx.session.tenant.workspaceId, ctx.session.tenant.environmentId);
      try {
        const nsObj = await toolkit.read(ctx.session.kubernetes, { apiVersion: "v1", kind: "Namespace", name: ns }, ctx.signal);
        if (!nsObj) return runtimeState(ctx, node, id, { health: "unhealthy", signals: ["namespace_missing"] });
        const phase = dig(nsObj, "status", "phase");
        if (phase === "Active") return runtimeState(ctx, node, id, { health: "healthy" });
        if (phase === "Terminating") return runtimeState(ctx, node, id, { health: "unhealthy", signals: ["namespace_terminating"] });
        return runtimeState(ctx, node, id, { health: "unknown", signals: ["namespace_phase_unknown"] });
      } catch {
        return runtimeState(ctx, node, id, { health: "unknown", signals: ["read_failed"] });
      }
    },

    async verify(ctx, node, observed) {
      return verifyAgainst(ctx, node, observed, EXPECTED);
    },

    expectedAttributes() {
      return { ...EXPECTED };
    },
  };
}
