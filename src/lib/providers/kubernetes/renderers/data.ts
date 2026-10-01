/**
 * postgres / redis → headless Service + PersistentVolumeClaim + StatefulSet
 * (+ a credentials Secret for postgres and redis).
 *
 * HONESTY (read this before relying on it): this is a DEV-TIER database. Every
 * object is labeled `zenith.dev/tier: dev-only` and carries an honesty note.
 * It is one replica on whatever storage class the cluster offers: no high
 * availability, no automated backups, no point-in-time recovery, no managed
 * upgrades. It is not a production-grade managed database. Expansion and
 * placement should prefer a managed database service (RDS, Cloud SQL, …) for
 * production environments; selecting this driver for one is a placement
 * decision the orchestrator should surface, not something to hide here.
 *
 * Credentials: the spec carries none (`credentials: "generated"`). The
 * rendered Secret has NO data; its `zenith.dev/secret-ref` annotation names a
 * generated-credential reference (`generatedCredentialRef`) the executor's
 * `resolveSecret` must resolve: create a random value on first use, return the
 * same value thereafter, never write it anywhere but the vault and the
 * in-memory apply request.
 *
 * Stateful safety: the PVC and StatefulSet are never auto-pruned (see
 * `NEVER_AUTO_PRUNE`); removing the node leaves the data in place and reports it.
 */
import type { PostgresSpec, RedisSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { ANNOTATION, LABEL, MANAGED_BY_VALUE, SECRET_DATA_KEY, type K8sObject, type K8sRenderContext, type RenderResult } from "../types";
import { dnsLabel, objectName } from "../naming";
import { isRecord } from "../util";
import { DEV_ONLY_NOTE, TMP_MOUNT, TMP_VOLUME, ctxNamespace, metadata, renderError, selectorLabels, specOf } from "./common";

interface SizeProfile {
  cpu: string;
  memory: string;
  storageGi: number;
}

const SIZES: Record<string, SizeProfile> = {
  nano: { cpu: "100m", memory: "256Mi", storageGi: 1 },
  small: { cpu: "250m", memory: "512Mi", storageGi: 5 },
  standard: { cpu: "500m", memory: "1Gi", storageGi: 20 },
  performance: { cpu: "1000m", memory: "2Gi", storageGi: 100 },
};

const DATA_UID = 999;

/** The vault reference of a data store's generated master credential. The executor's `resolveSecret` owns it. */
export function generatedCredentialRef(environmentId: string, address: string): string {
  return `vault:generated/${environmentId}/${address}/password`;
}

export const credentialsSecretName = (node: Pick<ResourceNode, "address">): string => dnsLabel(`${objectName(node)}-credentials`);
export const dataVolumeName = (node: Pick<ResourceNode, "address">): string => dnsLabel(`${objectName(node)}-data`);

function profileOf(node: ResourceNode): SizeProfile & { storageGi: number } {
  const spec = specOf(node) as unknown as Partial<PostgresSpec | RedisSpec>;
  const size = typeof spec.size === "string" ? spec.size : "small";
  const base = SIZES[size];
  if (!base) throw renderError(`${node.address}: unknown size "${size.slice(0, 40)}" (expected one of ${Object.keys(SIZES).join(", ")}).`);
  const cfg = isRecord(spec.config) ? spec.config : {};
  const gb = cfg.storageGb;
  if (gb !== undefined) {
    if (typeof gb !== "number" || !Number.isInteger(gb) || gb < 1 || gb > 16384) throw renderError(`${node.address}: config.storageGb must be an integer between 1 and 16384.`);
    return { ...base, storageGi: gb };
  }
  return base;
}

/** The container image a data node runs; shared with `expectedAttributes`. */
export function dataImage(node: ResourceNode): string {
  const spec = specOf(node) as unknown as Partial<PostgresSpec>;
  if (node.kind === "postgres") {
    const v = typeof spec.version === "string" ? spec.version : "16";
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(v)) throw renderError(`${node.address}: postgres version "${v.slice(0, 20)}" is not a plain major or major.minor version.`);
    return `postgres:${v}`;
  }
  if (node.kind === "redis") return "redis:7-alpine";
  throw renderError(`${node.address}: ${node.kind} is not supported on Kubernetes (only postgres and redis have a dev-tier rendering).`);
}

function devMeta(node: ResourceNode, ctx: K8sRenderContext, name: string, namespace: string, component: string) {
  return metadata(node, ctx, {
    name,
    namespace,
    devOnly: true,
    labels: { [LABEL.name]: objectName(node), [LABEL.component]: component },
    annotations: { [ANNOTATION.honestyNote]: DEV_ONLY_NOTE },
  });
}

export function renderDataStore(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const image = dataImage(node); // throws for unsupported engines before anything is built
  const isPg = node.kind === "postgres";
  const notes: string[] = [`${node.address}: dev-tier ${node.kind} on Kubernetes (single replica, cluster storage). Not production-grade; prefer a managed database service for production.`];
  const spec = specOf(node) as unknown as Partial<PostgresSpec | RedisSpec>;
  if (spec.highAvailability === true) notes.push(`${node.address}: highAvailability was requested but this driver renders one replica.`);
  if (spec.backup !== undefined && spec.backup !== "none") notes.push(`${node.address}: backup "${spec.backup}" was requested but this driver takes no backups.`);
  if (spec.storageClass !== undefined && typeof spec.storageClass !== "string") throw renderError(`${node.address}: spec.storageClass must be a string.`);

  const namespace = ctxNamespace(node, ctx);
  const name = objectName(node);
  const credName = credentialsSecretName(node);
  const pvcName = dataVolumeName(node);
  const profile = profileOf(node);
  const selector = selectorLabels(node, ctx);
  const component = isPg ? "postgres" : "redis";

  const secret: K8sObject = {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: metadata(node, ctx, {
      name: credName,
      namespace,
      devOnly: true,
      labels: { [LABEL.name]: name, [LABEL.component]: component },
      annotations: { [ANNOTATION.secretRef]: generatedCredentialRef(ctx.environmentId, node.address), [ANNOTATION.honestyNote]: DEV_ONLY_NOTE },
    }),
  };

  const pvc: K8sObject = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: devMeta(node, ctx, pvcName, namespace, component),
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${profile.storageGi}Gi` } },
      ...(typeof spec.storageClass === "string" && spec.storageClass !== "" ? { storageClassName: spec.storageClass } : {}),
    },
  };

  const passwordEnv = { name: isPg ? "POSTGRES_PASSWORD" : "REDIS_PASSWORD", valueFrom: { secretKeyRef: { name: credName, key: SECRET_DATA_KEY } } };
  const resources = { requests: { cpu: profile.cpu, memory: profile.memory }, limits: { cpu: profile.cpu, memory: profile.memory } };
  const container: Record<string, unknown> = isPg
    ? {
        name: "postgres",
        image,
        ports: [{ name: "postgres", containerPort: 5432, protocol: "TCP" }],
        env: [passwordEnv, { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" }],
        resources,
        readinessProbe: { exec: { command: ["pg_isready", "-U", "postgres"] }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 },
        livenessProbe: { exec: { command: ["pg_isready", "-U", "postgres"] }, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
        // postgres writes its socket under /var/run/postgresql and needs a writable root for initdb helpers;
        // read-only root is left off and stated here rather than guessed to work.
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
        volumeMounts: [
          { name: "data", mountPath: "/var/lib/postgresql/data" },
          { name: "run", mountPath: "/var/run/postgresql" },
          TMP_MOUNT,
        ],
      }
    : {
        name: "redis",
        image,
        command: ["redis-server"],
        args: ["--appendonly", "yes", "--dir", "/data", "--requirepass", "$(REDIS_PASSWORD)"],
        ports: [{ name: "redis", containerPort: 6379, protocol: "TCP" }],
        env: [passwordEnv],
        resources,
        readinessProbe: { exec: { command: ["sh", "-c", 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG'] }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 },
        livenessProbe: { exec: { command: ["sh", "-c", 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG'] }, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 6 },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
        volumeMounts: [{ name: "data", mountPath: "/data" }, TMP_MOUNT],
      };

  const podLabels = { ...selector, [LABEL.managedBy]: MANAGED_BY_VALUE, [LABEL.tier]: "dev-only", [LABEL.component]: component };
  const sts: K8sObject = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: devMeta(node, ctx, name, namespace, component),
    spec: {
      serviceName: name,
      replicas: 1,
      podManagementPolicy: "OrderedReady",
      updateStrategy: { type: "RollingUpdate" },
      selector: { matchLabels: selector },
      template: {
        metadata: { labels: podLabels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 60,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: DATA_UID,
            runAsGroup: DATA_UID,
            fsGroup: DATA_UID,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [container],
          volumes: [
            { name: "data", persistentVolumeClaim: { claimName: pvcName } },
            ...(isPg ? [{ name: "run", emptyDir: {} }] : []),
            TMP_VOLUME,
          ],
        },
      },
    },
  };

  const port = isPg ? 5432 : 6379;
  const svc: K8sObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: devMeta(node, ctx, name, namespace, component),
    spec: { clusterIP: "None", selector, ports: [{ name: component, port, targetPort: component, protocol: "TCP" }] },
  };

  return { objects: [secret, pvc, svc, sts], notes };
}

export function dataExpectations(node: ResourceNode): Record<string, unknown> {
  return { managedByZenith: true, replicas: 1, image: dataImage(node), tier: "dev-only" };
}

