/**
 * `dns_record` and `tls_certificate` on the managed platform: PLATFORM-MANAGED.
 *
 * Managed hostnames resolve through the platform's wildcard DNS and are served
 * with the platform gateway's certificates; Zenith writes no per-app record and
 * issues no per-app certificate, so these drivers render and create nothing. What
 * they do is answer, honestly, the observation question: observe returns
 * `present` exactly when a managed route (HTTPRoute, or the retained Ingress in
 * ingress mode) in the tenant namespace stands in for the node's host — the
 * source host is recorded on the route (`zenith.dev/source-hosts`) — and
 * `missing` when no such route exists.
 *
 * `present` here means "the platform will serve this name because a route
 * exists". It does NOT mean the wildcard DNS record or certificate exist or are
 * valid: those are operator-provisioned (deploy/zenith-managed) and outside
 * anything a tenant-scoped session can read. The observation says
 * `platformManaged: true` so nothing mistakes it for a Zenith-created record.
 *
 * A list that was truncated and did not find the host is `unknown`, never
 * `missing`: absence is only claimed when the whole list was read.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { dig, isRecord, type KubernetesToolkit } from "../../k8s-port";
import { HTTPROUTE_API_VERSION } from "../../routing";
import { assertSessionMatches, type ZenithSession } from "../../session";
import { tenantNamespace } from "../../tenancy";
import { TENANT_ANNOTATION, TENANT_LABEL } from "../../types";
import { contractEvidence, known, observation, presenceFromError, unknownValue, verifyAgainst } from "../common";

interface PlatformKind {
  id: string;
  kind: "dns_record" | "tls_certificate";
  nativeType: string;
  /** which spec field holds the host */
  hostField: "name" | "domain";
}

export const PLATFORM_DNS: PlatformKind = { id: "zenith.platform_dns@1", kind: "dns_record", nativeType: "k8s:DNSEndpoint", hostField: "name" };
export const PLATFORM_TLS: PlatformKind = { id: "zenith.platform_tls@1", kind: "tls_certificate", nativeType: "k8s:Certificate", hostField: "domain" };

const EXPECTED = { platformManaged: true };

export function createPlatformManagedDriver(toolkit: KubernetesToolkit, p: PlatformKind): ResourceDriver<ZenithSession> {
  const hostOf = (node: ResourceNode): string | undefined => {
    const v = isRecord(node.spec) ? node.spec[p.hostField] : undefined;
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return {
    id: p.id,
    provider: "zenith",
    kind: p.kind,
    nativeType: p.nativeType,
    capabilities: {
      compile: false,
      observe: true,
      runtime: false,
      verify: true,
      discover: false,
      operations: [],
      evidence: contractEvidence(["observe", "verify"]),
    },

    async observe(ctx, node) {
      assertSessionMatches(ctx.session, ctx);
      const host = hostOf(node);
      if (host === undefined) return observation({ ctx, node, source: p.id, presence: "unknown", error: `The node has no spec.${p.hostField}.` });
      const ns = tenantNamespace(ctx.session.tenant.workspaceId, ctx.session.tenant.environmentId);
      const gatewayMode = ctx.session.substrate.gateway.mode;
      try {
        const listed = await toolkit.list(
          ctx.session.kubernetes,
          {
            apiVersion: gatewayMode === "gateway_api" ? HTTPROUTE_API_VERSION : "networking.k8s.io/v1",
            kind: gatewayMode === "gateway_api" ? "HTTPRoute" : "Ingress",
            namespace: ns,
            labelSelector: `${TENANT_LABEL.route}=true`,
            limit: 200,
          },
          ctx.signal
        );
        if (listed.unavailable) {
          return observation({ ctx, node, source: p.id, presence: "unknown", attributes: { platformManaged: unknownValue("not_supported", "the cluster does not serve the routing kind") }, error: "The cluster does not serve the routing API kind this platform uses." });
        }
        const now = ctx.now();
        const match = listed.items.find((r) => {
          const src = dig(r, "metadata", "annotations", TENANT_ANNOTATION.sourceHosts);
          return typeof src === "string" && src.split(",").includes(host);
        });
        if (!match) {
          return observation({
            ctx,
            node,
            source: p.id,
            presence: listed.truncated ? "unknown" : "missing",
            native: { host, reason: listed.truncated ? "route list truncated; absence not claimed" : "no managed route serves this host" },
            ...(listed.truncated ? { error: "The route list was truncated before this host was found." } : {}),
          });
        }
        const hostnames = dig(match, "spec", "hostnames");
        const servedAt = Array.isArray(hostnames) && typeof hostnames[0] === "string" ? hostnames[0] : undefined;
        return observation({
          ctx,
          node,
          source: p.id,
          presence: "present",
          externalId: servedAt ?? host,
          attributes: { platformManaged: known(true, now) },
          native: { platformManaged: true, sourceHost: host, ...(servedAt ? { servedAt } : {}) },
        });
      } catch (e) {
        const r = presenceFromError(e);
        return observation({ ctx, node, source: p.id, presence: r.presence, error: r.message });
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
