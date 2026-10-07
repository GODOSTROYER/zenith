/**
 * Builders shared by the PROD-LIFE-07 suites: native StatefulSet / CronJob nodes,
 * an egress-isolated network and a few fake-cluster seeders. Nothing here talks
 * to a cluster; the acceptance suite uses the same node builders against a real one.
 */
import type { ResourceNode } from "@/lib/resources/types";
import type { K8sRenderContext } from "@/lib/providers/kubernetes/types";
import { ENV_ID, NS, ctxFor, node } from "./helpers";
import type { FakeK8s } from "./fake-api";

/** A well-formed digest-pinned reference. The bytes are arbitrary: nothing here pulls it. */
export const PINNED_IMAGE = `registry.example.com/acme/store@sha256:${"a".repeat(64)}`;

export function stsConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: NS,
    image: PINNED_IMAGE,
    replicas: 2,
    port: 5000,
    vcpu: 0.25,
    memoryMb: 256,
    runAsUser: 1000,
    volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 5 }],
    ...over,
  };
}

export function stsNode(over: Record<string, unknown> = {}, address = "provider_native/ledger"): ResourceNode {
  return node({
    address,
    kind: "provider_native",
    nativeType: "k8s:StatefulSet",
    dependsOn: ["network/main"],
    spec: { type: "k8s:StatefulSet", config: stsConfig(over) },
  });
}

export function cronConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { namespace: NS, image: PINNED_IMAGE, vcpu: 0.1, memoryMb: 64, schedule: "*/5 * * * *", runAsUser: 1000, ...over };
}

export function nativeCronNode(over: Record<string, unknown> = {}, address = "provider_native/sweeper"): ResourceNode {
  return node({
    address,
    kind: "provider_native",
    nativeType: "k8s:CronJob",
    dependsOn: ["network/main"],
    spec: { type: "k8s:CronJob", config: cronConfig(over) },
  });
}

/** A render context over a whole graph, for an environment other than the default test one. */
export const ctxForGraph = (nodes: readonly ResourceNode[], environmentId: string): K8sRenderContext => ctxFor(nodes, { environmentId });

/** The namespace node with default-deny egress switched on. */
export const isolatedNetwork = (): ResourceNode =>
  node({ address: "network/main", kind: "network", spec: { zones: 1, namespace: NS, isolation: { egress: "default-deny" } } });

/** A Zenith-owned PVC as a StatefulSet controller would have made it from a claim template. */
export function claimOf(name: string, phase = "Bound", over: { env?: string; owned?: boolean; labels?: Record<string, string> } = {}): Record<string, unknown> {
  const owned = over.owned !== false;
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name,
      namespace: NS,
      labels: {
        ...(owned ? { "app.kubernetes.io/managed-by": "zenith" } : {}),
        "app.kubernetes.io/name": "ledger",
        "app.kubernetes.io/part-of": over.env ?? ENV_ID,
        ...(over.labels ?? {}),
      },
      annotations: owned ? { "zenith.dev/resource": "provider_native/ledger", "zenith.dev/environment": over.env ?? ENV_ID } : {},
    },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } }, volumeName: `pv-${name}`, storageClassName: "standard" },
    status: { phase },
  };
}

/** Seed every claim a `ledger` StatefulSet of N replicas gets, bound. */
export function seedClaims(fake: FakeK8s, replicas: number, phase = "Bound"): void {
  for (let i = 0; i < replicas; i++) {
    const c = claimOf(`data-ledger-${i}`, phase);
    fake.seed(c);
    fake.setStatus("PersistentVolumeClaim", NS, `data-ledger-${i}`, { phase });
  }
}

/** A pod of the `ledger` StatefulSet; `ready` controls its Ready condition. */
export function ledgerPod(ordinal: number, ready: boolean, extra: Record<string, unknown> = {}, env: string = ENV_ID): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `ledger-${ordinal}`,
      namespace: NS,
      creationTimestamp: "2026-09-30T11:00:00Z",
      labels: { "app.kubernetes.io/name": "ledger", "app.kubernetes.io/part-of": env },
    },
    status: { phase: "Running", conditions: [{ type: "Ready", status: ready ? "True" : "False" }], ...extra },
  };
}
