/**
 * What the managed platform provides itself, offers no equivalent for, or
 * cannot honor, by portable kind. One table, read by the render pipeline and by
 * the drivers, so the plan, the apply and the observation never disagree about
 * which nodes are the platform's business.
 *
 * "Platform-managed" means a node that renders NOTHING because the tenancy
 * baseline, the platform wildcard DNS and the gateway already provide it; its
 * driver reports `platform-managed` and never claims Zenith created it.
 */
import { isRecord } from "./k8s-port";
import type { ResourceNode } from "@/lib/resources/types";

export const PLATFORM_MANAGED: Readonly<Record<string, string>> = {
  network: "the tenant namespace and its isolation baseline are created by the tenancy layer",
  kubernetes_namespace: "the tenant namespace and its isolation baseline are created by the tenancy layer",
  dns_zone: "DNS for managed hostnames is the platform's wildcard zone",
  dns_record: "managed hostnames resolve through the platform's wildcard DNS; Zenith writes no per-app record",
  tls_certificate: "managed hostnames are served with the platform gateway's certificates; Zenith issues none per app",
};

export const NOT_OFFERED: Readonly<Record<string, string>> = {
  subnet: "Kubernetes namespaces have no subnets",
  log_group: "the managed platform does not collect or retain application logs yet",
  container_registry: "the managed platform's registry is substrate configuration, not a per-app resource",
  build_pipeline: "source builds run as platform build Jobs in the build namespace (ZENITH_MANAGED_BUILDER_IMAGE, ZENITH_MANAGED_REGISTRY), not as a per-app resource; without them a built artifact needs an image reference supplied by the caller",
};

export const UNSUPPORTED: Readonly<Record<string, string>> = {
  mysql: "the managed platform offers managed Postgres only; it runs no in-cluster databases",
  redis: "the managed platform offers managed Postgres only; it runs no in-cluster data stores",
  object_store: "per-tenant object storage credentials are not implemented, so a tenant bucket prefix cannot be isolated honestly",
  queue: "no queue service is offered on the managed platform",
  pubsub: "no pub/sub service is offered on the managed platform",
  function: "functions are not offered on the managed platform",
  compute_instance: "virtual machines are not offered on the managed platform",
  kubernetes_cluster: "a managed environment cannot create clusters",
  provider_native: "provider-native nodes are not supported on the managed platform",
};

export function firewallPlatformReason(node: ResourceNode, kindOf: (address: string) => string | undefined): string | undefined {
  const spec = isRecord(node.spec) ? node.spec : {};
  const source = isRecord(spec.source) ? spec.source : {};
  if (typeof source.cidr === "string") return "public ingress is allowed only from the platform gateway, by the tenancy baseline; no per-rule NetworkPolicy is rendered";
  if (typeof source.address === "string" && kindOf(source.address) === "load_balancer") return "traffic from the platform gateway is allowed by the tenancy baseline";
  const targetKind = typeof spec.target === "string" ? kindOf(spec.target) : undefined;
  if (targetKind === undefined) return "its target is not a workload of this environment on the managed platform";
  if (targetKind === "postgres") return "the managed database runs outside the cluster; egress to it is governed by the tenancy baseline";
  if (targetKind === "load_balancer") return "the load balancer is the platform gateway; its exposure is governed by the tenancy baseline";
  if (!["container_service", "static_site"].includes(targetKind)) return `it targets a ${targetKind}, which the managed platform does not run as an in-cluster workload`;
  return undefined;
}

