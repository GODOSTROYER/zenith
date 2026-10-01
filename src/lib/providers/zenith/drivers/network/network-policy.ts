/**
 * `firewall` on the managed platform.
 *
 * Two kinds of firewall node reach this driver:
 *   - binding-derived service → service rules: rendered by the Kubernetes
 *     provider as NetworkPolicies on top of the tenancy baseline. This driver
 *     delegates those to the wrapped Kubernetes driver (when one is supplied).
 *   - PLATFORM-MANAGED rules: public ingress (`source.cidr`), traffic from the
 *     load balancer, and rules that protect a managed database. They render
 *     nothing; the tenancy baseline (`zenith-allow-platform`) is what allows the
 *     platform gateway in and governs egress. For these, observe reports
 *     `present` when that baseline policy exists.
 *
 * The split is decided by the same function the render pipeline uses
 * (`firewallPlatformReason`), with node addresses' kind prefix standing in for
 * the graph (a driver has no graph), so plan, apply and observation agree.
 *
 * "Present" is an object read, not proof the CNI enforces NetworkPolicy.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import { type KubernetesToolkit } from "../../k8s-port";
import { firewallPlatformReason } from "../../platform";
import { assertSessionMatches, type ZenithSession } from "../../session";
import { tenantNamespace } from "../../tenancy";
import { TENANCY_OBJECTS } from "../../types";
import { addressPrefix, contractEvidence, known, observation, presenceFromError, verifyAgainst } from "../common";
import { wrapKubernetesDriver } from "../kubernetes/wrap";

export const NETWORK_POLICY_DRIVER_ID = "zenith.network_policy@1";

const EXPECTED_PLATFORM = { platformManaged: true };

export function createNetworkPolicyDriver(toolkit: KubernetesToolkit, baseNetworkPolicy?: ResourceDriver<KubernetesSession>): ResourceDriver<ZenithSession> {
  const id = NETWORK_POLICY_DRIVER_ID;
  const delegate = baseNetworkPolicy ? wrapKubernetesDriver(baseNetworkPolicy) : undefined;
  const platformReason = (node: Parameters<typeof firewallPlatformReason>[0]) => firewallPlatformReason(node, addressPrefix);

  return {
    id,
    provider: "zenith",
    kind: "firewall",
    nativeType: "k8s:NetworkPolicy",
    capabilities: {
      compile: false,
      observe: true,
      runtime: false,
      verify: true,
      discover: false,
      operations: [],
      evidence: contractEvidence(["observe", "verify"]),
    },

    async observe(ctx, node, externalId) {
      assertSessionMatches(ctx.session, ctx);
      const why = platformReason(node);
      if (why === undefined) {
        if (delegate?.observe) return delegate.observe(ctx, node, externalId);
        return observation({ ctx, node, source: id, presence: "unknown", error: "No Kubernetes NetworkPolicy driver was supplied to observe this binding rule." });
      }
      const ns = tenantNamespace(ctx.session.tenant.workspaceId, ctx.session.tenant.environmentId);
      try {
        const live = await toolkit.read(ctx.session.kubernetes, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", namespace: ns, name: TENANCY_OBJECTS.allowPlatform }, ctx.signal);
        if (!live) return observation({ ctx, node, source: id, presence: "missing", native: { platformManaged: true, reason: why } });
        return observation({
          ctx,
          node,
          source: id,
          presence: "present",
          externalId: `${ns}/${TENANCY_OBJECTS.allowPlatform}`,
          attributes: { platformManaged: known(true, ctx.now()) },
          native: { platformManaged: true, reason: why },
        });
      } catch (e) {
        const r = presenceFromError(e);
        return observation({ ctx, node, source: id, presence: r.presence, error: r.message });
      }
    },

    async verify(ctx, node, observed, runtime) {
      assertSessionMatches(ctx.session, ctx);
      if (platformReason(node) === undefined && delegate?.verify) return delegate.verify(ctx, node, observed, runtime);
      return verifyAgainst(ctx, node, observed, EXPECTED_PLATFORM);
    },

    expectedAttributes(node) {
      if (platformReason(node) === undefined && delegate?.expectedAttributes) return delegate.expectedAttributes(node);
      return { ...EXPECTED_PLATFORM };
    },
  };
}
