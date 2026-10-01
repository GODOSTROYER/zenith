/**
 * The Zenith-managed provider's drivers, and their idempotent registration
 * under `provider = "zenith"`.
 *
 * One driver per native type the contract table gives the `zenith` provider:
 *
 *   native type                 kinds                    driver
 *   k8s:Namespace               network, k8s namespace   zenith.tenant_namespace@1   (own)
 *   k8s:NetworkPolicy           firewall                 zenith.network_policy@1     (own + wraps the k8s driver)
 *   k8s:Ingress                 load_balancer            zenith.http_route@1         (own; Ingress driver in ingress mode)
 *   k8s:DNSEndpoint             dns_record               zenith.platform_dns@1       (platform-managed)
 *   k8s:Certificate             tls_certificate          zenith.platform_tls@1       (platform-managed)
 *   zenith:managed_postgres     postgres                 zenith.managed_postgres@1   (managed database)
 *   zenith:object_store         object_store             zenith.object_store@1       (unsupported, with the reason)
 *   k8s:Deployment              container_service,       zenith.deployment@1         (wraps the k8s driver)
 *                               static_site
 *   k8s:CronJob                 scheduled_job            zenith.cronjob@1            (wraps the k8s driver)
 *   k8s:Secret                  secret                   zenith.secret@1            (wraps the k8s driver)
 *   k8s:ServiceAccount          identity                 zenith.serviceaccount@1     (wraps the k8s driver)
 *   k8s:PersistentVolumeClaim   volume                   zenith.persistentvolumeclaim@1 (wraps the k8s driver)
 *
 * The Kubernetes drivers are not copied: they are passed in (or, by default,
 * looked up in the driver registry under `kubernetes`). A wrapped type whose
 * Kubernetes driver is not available is REPORTED in `missingKubernetesDrivers`
 * and not registered; there is no stub standing in for it.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import { listDrivers, registerDriver, type ResourceDriver } from "@/lib/drivers/types";
import { nativeTypeFor } from "@/lib/resources/native-types";
import type { KubernetesToolkit } from "../k8s-port";
import type { ZenithSession } from "../session";
import { createObjectStoreDriver, PROPOSED_OBJECT_STORE_NATIVE_TYPE } from "./data/object-store";
import { createManagedPostgresDriver } from "./data/managed-postgres";
import { wrapKubernetesDriver } from "./kubernetes/wrap";
import { createHttpRouteDriver } from "./network/http-route";
import { createNetworkPolicyDriver } from "./network/network-policy";
import { createPlatformManagedDriver, PLATFORM_DNS, PLATFORM_TLS } from "./network/platform-managed";
import { createTenantNamespaceDriver } from "./network/tenant-namespace";

export interface ZenithDriverOptions {
  toolkit: KubernetesToolkit;
  /** the Kubernetes provider's drivers; defaults to whatever is registered under `kubernetes` */
  kubernetesDrivers?: readonly ResourceDriver<KubernetesSession>[];
}

export interface ZenithDriverSet {
  drivers: ResourceDriver<ZenithSession>[];
  /** native types that wrap a Kubernetes driver that was not available; nothing is registered for them */
  missingKubernetesDrivers: string[];
}

/** Native types served by wrapping the Kubernetes driver as-is. */
const WRAPPED: readonly string[] = ["k8s:Deployment", "k8s:CronJob", "k8s:Secret", "k8s:ServiceAccount", "k8s:PersistentVolumeClaim"];

export function createZenithDrivers(opts: ZenithDriverOptions): ZenithDriverSet {
  const base = opts.kubernetesDrivers ?? (listDrivers("kubernetes") as unknown as ResourceDriver<KubernetesSession>[]);
  const byType = new Map(base.map((d) => [d.nativeType, d]));
  const { toolkit } = opts;
  const drivers: ResourceDriver<ZenithSession>[] = [
    createTenantNamespaceDriver(toolkit),
    createNetworkPolicyDriver(toolkit, byType.get("k8s:NetworkPolicy")),
    createHttpRouteDriver(toolkit, byType.get("k8s:Ingress")),
    createPlatformManagedDriver(toolkit, PLATFORM_DNS),
    createPlatformManagedDriver(toolkit, PLATFORM_TLS),
    createManagedPostgresDriver(nativeTypeFor("zenith", "postgres") ?? "zenith:managed_postgres"),
    createObjectStoreDriver(nativeTypeFor("zenith", "object_store") ?? PROPOSED_OBJECT_STORE_NATIVE_TYPE),
  ];
  const missing: string[] = [];
  for (const nativeType of WRAPPED) {
    const b = byType.get(nativeType);
    if (b) drivers.push(wrapKubernetesDriver(b));
    else missing.push(nativeType);
  }
  return { drivers, missingKubernetesDrivers: missing };
}

/** Register the drivers under `zenith`. Idempotent: the registry replaces by (provider, native type). */
export function registerZenithDrivers(opts: ZenithDriverOptions): ZenithDriverSet {
  const set = createZenithDrivers(opts);
  for (const d of set.drivers) registerDriver(d as unknown as ResourceDriver);
  return set;
}

export { wrapKubernetesDriver, zenithDriverId } from "./kubernetes/wrap";
export { createTenantNamespaceDriver, TENANT_NAMESPACE_DRIVER_ID } from "./network/tenant-namespace";
export { createHttpRouteDriver, HTTP_ROUTE_DRIVER_ID } from "./network/http-route";
export { createNetworkPolicyDriver, NETWORK_POLICY_DRIVER_ID } from "./network/network-policy";
export { createPlatformManagedDriver, PLATFORM_DNS, PLATFORM_TLS } from "./network/platform-managed";
export { createManagedPostgresDriver, MANAGED_POSTGRES_DRIVER_ID } from "./data/managed-postgres";
export { createObjectStoreDriver, OBJECT_STORE_DRIVER_ID, OBJECT_STORE_UNSUPPORTED_REASON, PROPOSED_OBJECT_STORE_NATIVE_TYPE } from "./data/object-store";
