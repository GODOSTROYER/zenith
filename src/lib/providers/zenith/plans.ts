/**
 * Plan tiers → the ResourceQuota and LimitRange every managed namespace gets.
 *
 * Every number is a named constant so a tier change is one reviewed edit, not a
 * hunt. The numbers are a STARTING POINT chosen for safety (one tenant cannot
 * starve a node or run up an unbounded bill), not a commercial decision and not
 * derived from any measured cost: nobody operates the cluster yet. Pricing and
 * final limits belong to whoever operates it.
 *
 * Quantities are Kubernetes quantity strings so the rendered objects are
 * byte-stable.
 *
 * What the limits bound:
 *   - compute: requests and limits for CPU and memory across the namespace,
 *     plus a per-container ceiling and floor (LimitRange) and a default for
 *     containers that set nothing, so the quota always has a number to count.
 *   - shape: pods, services, secrets, configmaps, PVCs, total storage, and
 *     ephemeral storage.
 *   - exposure: `services.loadbalancers` and `services.nodeports` are ZERO on
 *     every tier. A tenant reaches the internet only through the platform
 *     gateway, never by asking the cloud for a public load balancer or a node
 *     port.
 */
import type { PlanTier } from "./types";

export interface ContainerBounds {
  cpu: string;
  memory: string;
  /** container scratch + log + writable-layer ceiling; the quota demands one, so every container gets a default (MAN-05) */
  "ephemeral-storage"?: string;
}

export interface PlanLimits {
  tier: PlanTier;
  /** ResourceQuota `hard` */
  quota: Record<string, string>;
  /** LimitRange, type Container */
  container: {
    default: ContainerBounds;
    defaultRequest: ContainerBounds;
    max: ContainerBounds;
    min: ContainerBounds;
  };
  /** LimitRange, type PersistentVolumeClaim (omitted when the tier has no storage) */
  pvc?: { min: string; max: string };
  /** managed Postgres projects one environment may hold */
  maxManagedDatabases: number;
  /** tenant object stores (a scoped prefix of the shared bucket each) one environment may hold; PROVISIONAL */
  maxObjectStores: number;
  /** ceiling a HorizontalPodAutoscaler's maxReplicas is clamped to; 0 = autoscaling is not part of the tier. PROVISIONAL */
  maxAutoscaleReplicas: number;
}

/* ------------------------------- free tier -------------------------------- */

const FREE_CPU = "1";
const FREE_MEMORY = "2Gi";
const FREE_PODS = 10;
const FREE_SERVICES = 5;
const FREE_SECRETS = 20;
const FREE_CONFIGMAPS = 20;
const FREE_EPHEMERAL = "5Gi";

/* ----------------------------- starter tier ------------------------------- */

const STARTER_CPU = "4";
const STARTER_MEMORY = "8Gi";
const STARTER_PODS = 40;
const STARTER_SERVICES = 15;
const STARTER_SECRETS = 60;
const STARTER_CONFIGMAPS = 60;
const STARTER_EPHEMERAL = "20Gi";
const STARTER_PVCS = 2;
const STARTER_STORAGE = "20Gi";

/* -------------------------------- pro tier -------------------------------- */

const PRO_CPU = "16";
const PRO_MEMORY = "32Gi";
const PRO_PODS = 150;
const PRO_SERVICES = 40;
const PRO_SECRETS = 200;
const PRO_CONFIGMAPS = 200;
const PRO_EPHEMERAL = "100Gi";
const PRO_PVCS = 10;
const PRO_STORAGE = "200Gi";

/** The smallest request any container may make; below the lightest thing Zenith renders (a static site asks 100m / 128Mi). */
const CONTAINER_MIN: ContainerBounds = { cpu: "10m", memory: "16Mi" };
/**
 * Ephemeral storage defaults: the ResourceQuota requires requests and limits for ephemeral-storage, and a pod
 * that names none is refused unless the LimitRange supplies them. The default LIMIT is what bounds a container
 * that writes without end: the kubelet evicts a pod that exceeds it, so one tenant's disk fill cannot take the
 * node's disk from its neighbours (verified by the PROD-MAN-05 acceptance suite, never assumed).
 */
const CONTAINER_DEFAULT_REQUEST: ContainerBounds = { cpu: "100m", memory: "128Mi", "ephemeral-storage": "64Mi" };
const CONTAINER_DEFAULT_LIMIT: ContainerBounds = { cpu: "250m", memory: "256Mi", "ephemeral-storage": "512Mi" };

const base = (cpu: string, memory: string, pods: number, services: number, secrets: number, configmaps: number, ephemeral: string, pvcs: number, storage: string): Record<string, string> => ({
  "requests.cpu": cpu,
  "limits.cpu": cpu,
  "requests.memory": memory,
  "limits.memory": memory,
  "requests.ephemeral-storage": ephemeral,
  "limits.ephemeral-storage": ephemeral,
  pods: String(pods),
  services: String(services),
  secrets: String(secrets),
  configmaps: String(configmaps),
  persistentvolumeclaims: String(pvcs),
  "requests.storage": storage,
  "services.loadbalancers": "0",
  "services.nodeports": "0",
});

export const PLAN_LIMITS: Readonly<Record<PlanTier, PlanLimits>> = {
  free: {
    tier: "free",
    quota: base(FREE_CPU, FREE_MEMORY, FREE_PODS, FREE_SERVICES, FREE_SECRETS, FREE_CONFIGMAPS, FREE_EPHEMERAL, 0, "0"),
    container: {
      default: CONTAINER_DEFAULT_LIMIT,
      defaultRequest: CONTAINER_DEFAULT_REQUEST,
      min: CONTAINER_MIN,
      max: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi" },
    },
    maxManagedDatabases: 1,
    maxObjectStores: 0,
    maxAutoscaleReplicas: 0,
  },
  starter: {
    tier: "starter",
    quota: base(STARTER_CPU, STARTER_MEMORY, STARTER_PODS, STARTER_SERVICES, STARTER_SECRETS, STARTER_CONFIGMAPS, STARTER_EPHEMERAL, STARTER_PVCS, STARTER_STORAGE),
    container: {
      default: CONTAINER_DEFAULT_LIMIT,
      defaultRequest: CONTAINER_DEFAULT_REQUEST,
      min: CONTAINER_MIN,
      max: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
    },
    pvc: { min: "1Gi", max: "10Gi" },
    maxManagedDatabases: 3,
    maxObjectStores: 2,
    maxAutoscaleReplicas: 5,
  },
  pro: {
    tier: "pro",
    quota: base(PRO_CPU, PRO_MEMORY, PRO_PODS, PRO_SERVICES, PRO_SECRETS, PRO_CONFIGMAPS, PRO_EPHEMERAL, PRO_PVCS, PRO_STORAGE),
    container: {
      default: CONTAINER_DEFAULT_LIMIT,
      defaultRequest: CONTAINER_DEFAULT_REQUEST,
      min: CONTAINER_MIN,
      max: { cpu: "4", memory: "8Gi", "ephemeral-storage": "10Gi" },
    },
    pvc: { min: "1Gi", max: "50Gi" },
    maxManagedDatabases: 10,
    maxObjectStores: 10,
    maxAutoscaleReplicas: 20,
  },
};

export function planLimits(tier: PlanTier): PlanLimits {
  const limits = PLAN_LIMITS[tier];
  if (!limits) throw new Error(`Unknown plan tier "${String(tier).slice(0, 40)}".`);
  return limits;
}
