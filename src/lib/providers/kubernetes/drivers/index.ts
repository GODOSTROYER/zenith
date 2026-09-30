/**
 * Kubernetes resource drivers: one per native type in the KUBERNETES row of
 * `src/lib/resources/native-types.ts`, registered under provider `kubernetes`,
 * and — from the same definitions — under provider `zenith` for clusters
 * Zenith manages itself (those are Kubernetes underneath; `NATIVE_PREFIX.zenith`
 * is `k8s` too).
 *
 *   k8s:Namespace            network, kubernetes_namespace
 *   k8s:NetworkPolicy        firewall
 *   k8s:Ingress              load_balancer
 *   k8s:DNSEndpoint          dns_record
 *   k8s:Certificate          tls_certificate
 *   k8s:Deployment           container_service, static_site
 *   k8s:CronJob              scheduled_job
 *   k8s:StatefulSet          postgres, redis (mysql: not rendered)   DEV TIER ONLY
 *   k8s:Secret               secret
 *   k8s:ServiceAccount       identity
 *   k8s:PersistentVolumeClaim volume
 *
 * These drivers declare `compile: false`: Kubernetes lifecycle is
 * `renderObjects` → `serverSideApply` (ADR-0015), not OpenTofu. The execution
 * worker calls those directly; it does not go through `driver.compile`.
 *
 * `registerKubernetesDrivers` is idempotent.
 */
import { registerDriver, type ResourceDriver } from "@/lib/drivers/types";
import { certificateDef } from "./network/certificate";
import { dnsEndpointDef } from "./network/dnsendpoint";
import { ingressDef } from "./network/ingress";
import { namespaceDef } from "./network/namespace";
import { networkPolicyDef } from "./network/networkpolicy";
import { secretDef } from "./identity/secret";
import { serviceAccountDef } from "./identity/serviceaccount";
import { persistentVolumeClaimDef } from "./storage/persistentvolumeclaim";
import { cronJobDef } from "./workload/cronjob";
import { deploymentDef } from "./workload/deployment";
import { statefulSetDef } from "./workload/statefulset";
import { identityDrivers } from "./identity";
import { networkDrivers } from "./network";
import { makeKubernetesDriver, type KindDef, type KubernetesDriver } from "./shared";
import { storageDrivers } from "./storage";
import { workloadDrivers } from "./workload";

export type KubernetesProvider = "kubernetes" | "zenith";

/** Every driver, registered under provider `kubernetes`. */
export const kubernetesDrivers: KubernetesDriver[] = [...networkDrivers, ...workloadDrivers, ...identityDrivers, ...storageDrivers];

export const kubernetesDriverDefs: readonly KindDef[] = [
  namespaceDef,
  networkPolicyDef,
  ingressDef,
  dnsEndpointDef,
  certificateDef,
  deploymentDef,
  cronJobDef,
  statefulSetDef,
  secretDef,
  serviceAccountDef,
  persistentVolumeClaimDef,
];

/** The same drivers built for another provider key (ids become `<provider>.<type>@1`). */
export function driversFor(provider: KubernetesProvider): KubernetesDriver[] {
  return provider === "kubernetes" ? kubernetesDrivers : kubernetesDriverDefs.map((d) => makeKubernetesDriver(d, provider));
}

export function registerKubernetesDrivers(providers: readonly KubernetesProvider[] = ["kubernetes"]): KubernetesDriver[] {
  const registered: KubernetesDriver[] = [];
  for (const p of providers) {
    for (const d of driversFor(p)) {
      // the registry holds drivers of every session type behind `unknown`; a Kubernetes driver only ever receives a Kubernetes session
      registerDriver(d as unknown as ResourceDriver);
      registered.push(d);
    }
  }
  return registered;
}

/** Register the same drivers for Zenith-managed clusters (provider `zenith`). */
export const registerZenithManagedDrivers = (): KubernetesDriver[] => registerKubernetesDrivers(["zenith"]);

export type { KubernetesDriver } from "./shared";
