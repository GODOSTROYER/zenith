/**
 * `load_balancer` on the managed platform: Gateway API `HTTPRoute`s attached to
 * the platform Gateway (or, when the substrate's gateway mode is `ingress`, the
 * Kubernetes provider's Ingress driver).
 *
 * Registered under the contract table's native type for the kind
 * (`k8s:Ingress`); in gateway mode the objects it reads are HTTPRoutes, one per
 * managed host, named by `routeObjectName`.
 *
 * Observed attributes, all read from the cluster:
 *   allRoutesPresent            every managed host has its HTTPRoute
 *   allRoutesAccepted           every route's parent status says Accepted and
 *                               ResolvedRefs are True (unknown until the gateway
 *                               controller has reported)
 *   attachedToPlatformGateway   every parentRef names the platform Gateway
 *
 * "Accepted" is the gateway controller's claim that the route is valid and
 * attached; it does not prove DNS resolves, a certificate covers the host, or a
 * request succeeds. A passing `verify` here means exactly that claim and no
 * more; probing the public hostname is a separate, network-facing check.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import type { ObservedValue, ResourceNode } from "@/lib/resources/types";
import { dig, isRecord, type KubernetesToolkit } from "../../k8s-port";
import { HTTPROUTE_API_VERSION, rewriteRoutes, routeObjectName, servableCustomHosts } from "../../routing";
import { assertSessionMatches, type ZenithSession } from "../../session";
import { tenantNamespace } from "../../tenancy";
import { isRouteParentFor } from "../../tls";
import { wrapKubernetesDriver } from "../kubernetes/wrap";
import { contractEvidence, known, observation, presenceFromError, runtimeState, unknownValue, verifyAgainst } from "../common";

export const HTTP_ROUTE_DRIVER_ID = "zenith.http_route@1";

const EXPECTED = { allRoutesPresent: true, allRoutesAccepted: true, attachedToPlatformGateway: true };

function managedHosts(node: ResourceNode, session: ZenithSession): string[] {
  const routes = rewriteRoutes(isRecord(node.spec) ? node.spec.routes : undefined, session.tenant, session.substrate, servableCustomHosts(session.substrate, session.customDomains)).routes;
  return [...new Set(routes.filter(isRecord).map((r) => r.host).filter((h): h is string => typeof h === "string"))].sort();
}

/** Accepted and ResolvedRefs True on every parent: true/false, or undefined when the controller has not reported. */
function acceptance(route: Record<string, unknown>): boolean | undefined {
  const parents = dig(route, "status", "parents");
  if (!Array.isArray(parents) || parents.length === 0) return undefined;
  return parents.every((p) => {
    const conds = dig(p, "conditions");
    if (!Array.isArray(conds)) return false;
    const ok = (type: string) => conds.some((c) => isRecord(c) && c.type === type && c.status === "True");
    return ok("Accepted") && ok("ResolvedRefs");
  });
}

export function createHttpRouteDriver(toolkit: KubernetesToolkit, baseIngress?: ResourceDriver<KubernetesSession>): ResourceDriver<ZenithSession> {
  const id = HTTP_ROUTE_DRIVER_ID;
  const ingressMode = baseIngress ? wrapKubernetesDriver(baseIngress) : undefined;

  async function readRoutes(ctx: Parameters<NonNullable<ResourceDriver<ZenithSession>["observe"]>>[0], node: ResourceNode) {
    const ns = tenantNamespace(ctx.session.tenant.workspaceId, ctx.session.tenant.environmentId);
    const hosts = managedHosts(node, ctx.session);
    const found: { host: string; route: Record<string, unknown> }[] = [];
    for (const host of hosts) {
      const route = await toolkit.read(ctx.session.kubernetes, { apiVersion: HTTPROUTE_API_VERSION, kind: "HTTPRoute", namespace: ns, name: routeObjectName(host) }, ctx.signal);
      if (route) found.push({ host, route });
    }
    return { ns, hosts, found };
  }

  return {
    id,
    provider: "zenith",
    kind: "load_balancer",
    nativeType: "k8s:Ingress",
    capabilities: {
      compile: false,
      observe: true,
      runtime: true,
      verify: true,
      discover: false,
      operations: [],
      evidence: contractEvidence(["observe", "runtime", "verify"]),
    },

    async observe(ctx, node, externalId) {
      assertSessionMatches(ctx.session, ctx);
      if (ctx.session.substrate.gateway.mode === "ingress") {
        if (ingressMode?.observe) return ingressMode.observe(ctx, node, externalId);
        return observation({ ctx, node, source: id, presence: "unknown", attributes: { allRoutesPresent: unknownValue("not_supported", "gateway mode is ingress and no Ingress driver was supplied") } });
      }
      try {
        const { hosts, found } = await readRoutes(ctx, node);
        if (hosts.length === 0) return observation({ ctx, node, source: id, presence: "unknown", error: "The load balancer declares no routes." });
        if (found.length === 0) return observation({ ctx, node, source: id, presence: "missing", native: { expectedHosts: hosts.slice(0, 20) } });
        const now = ctx.now();
        const attached = found.every(({ route }) => {
          const parents = dig(route, "spec", "parentRefs");
          const hostnames = dig(route, "spec", "hostnames");
          return Array.isArray(parents) && parents.length === 1 && Array.isArray(hostnames) && isRouteParentFor(parents[0], hostnames, ctx.session.tenant, ctx.session.substrate);
        });
        const accepted = found.map(({ route }) => acceptance(route));
        const acceptedAttr: ObservedValue =
          found.length < hosts.length
            ? known(false, now)
            : accepted.some((a) => a === undefined)
              ? unknownValue("not_inspected", "the gateway controller has not reported route status yet")
              : known(accepted.every((a) => a === true), now);
        return observation({
          ctx,
          node,
          source: id,
          presence: "present",
          externalId: found.map((f) => f.host).join(","),
          attributes: {
            allRoutesPresent: known(found.length === hosts.length, now),
            allRoutesAccepted: acceptedAttr,
            attachedToPlatformGateway: known(attached, now),
          },
          native: { hosts: found.map((f) => f.host).slice(0, 20), missingHosts: hosts.filter((h) => !found.some((f) => f.host === h)).slice(0, 20) },
        });
      } catch (e) {
        const p = presenceFromError(e);
        return observation({ ctx, node, source: id, presence: p.presence, error: p.message });
      }
    },

    async runtime(ctx, node, externalId) {
      assertSessionMatches(ctx.session, ctx);
      if (ctx.session.substrate.gateway.mode === "ingress") {
        return ingressMode?.runtime ? ingressMode.runtime(ctx, node, externalId) : runtimeState(ctx, node, id, { signals: ["ingress_mode_without_driver"] });
      }
      try {
        const { hosts, found } = await readRoutes(ctx, node);
        const accepted = found.map(({ route }) => acceptance(route));
        const counts = { routes: hosts.length, present: found.length, accepted: accepted.filter((a) => a === true).length };
        if (found.length < hosts.length) return runtimeState(ctx, node, id, { health: "unhealthy", counts, signals: [`routes_missing:${hosts.length - found.length}`] });
        if (accepted.some((a) => a === undefined)) return runtimeState(ctx, node, id, { health: "unknown", counts, signals: ["route_status_not_reported"] });
        if (accepted.every((a) => a === true)) return runtimeState(ctx, node, id, { health: "healthy", counts });
        return runtimeState(ctx, node, id, { health: "degraded", counts, signals: [`routes_not_accepted:${accepted.filter((a) => a === false).length}`] });
      } catch {
        return runtimeState(ctx, node, id, { signals: ["read_failed"] });
      }
    },

    async verify(ctx, node, observed, runtime) {
      assertSessionMatches(ctx.session, ctx);
      if (ctx.session.substrate.gateway.mode === "ingress" && ingressMode?.verify) return ingressMode.verify(ctx, node, observed, runtime);
      return verifyAgainst(ctx, node, observed, EXPECTED);
    },

    expectedAttributes() {
      return { ...EXPECTED };
    },
  };
}
