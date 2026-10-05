/**
 * The spec shapes `expandManifest()` writes into `ResourceNode.spec`, per
 * portable kind. Drivers, placement, cost and policy read these by name, so
 * they are typed here rather than left as folklore in `Record<string, unknown>`.
 *
 * All specs are PORTABLE desired attributes; provider translation (instance
 * classes, IAM policy documents, SG ids…) is the driver's job and lives in
 * `expectedAttributes` / `compile`. Every spec is plain JSON and holds NO
 * secret value: a secret appears only as `{ key, secretRef }`.
 *
 * Kinds not listed (compute_instance, function, mysql, pubsub, kubernetes_*)
 * and the typed volume kind are never produced by expansion today;
 * `provider_native` nodes carry `{ type, config }` where `config` is validated
 * by the native registry.
 */

/** Where a workload's runnable artifact comes from. */
export type ArtifactSpec =
  | { type: "image"; ref: string }
  /** built by `build_pipeline/<name>` in the customer's account (ADR-0016) */
  | { type: "built"; pipeline: string; registry?: string }
  | { type: "blueprint"; blueprint: string };

export type EnvEntry = { key: string; value: string } | { key: string; secretRef: string };

export interface NetworkSpec {
  /** absent on Kubernetes, where the network is a namespace */
  cidr?: string;
  zones: number;
  egress?: { natGateways: "none" | "single" | "per_az" };
  namespace?: string;
}

export interface SubnetSpec {
  tier: "public" | "private";
  /** `a`, `b`, `c`: the driver maps it to the provider's zone in the node's region */
  zone: string;
  cidr: string;
  network: string;
}

export interface FirewallSpec {
  namespace?: string;
  direction: "ingress";
  protocol: "tcp";
  port: number;
  /** who may connect: another node, or a CIDR (the public internet rule) */
  source: { address: string } | { cidr: string };
  /** the node being protected */
  target: string;
  /** binding capability, or `public_http` for the internet → load balancer rule */
  capability: string;
  description: string;
  /** present when source and target are in different providers / regions */
  crossBoundary?: "cross_cloud" | "cross_region";
}

export interface LoadBalancerRoute {
  host: string;
  pathPrefix: string;
  tls: boolean;
  target: string;
  port?: number;
  healthPath?: string;
}

export interface LoadBalancerSpec {
  namespace?: string;
  scheme: "internet-facing";
  tier: "public";
  listeners: { port: number; protocol: "http" | "https"; redirectToHttps?: boolean }[];
  routes: LoadBalancerRoute[];
  ingressClass?: string;
}

export interface DnsZoneSpec {
  name: string;
  private: false;
}

export interface DnsRecordSpec {
  namespace?: string;
  name: string;
  /** `alias` = provider alias/CNAME to the target node; the driver picks the record type */
  type: "alias";
  target: string;
  zone: string;
}

export interface TlsCertificateSpec {
  namespace?: string;
  domain: string;
  /** `dns_manual`: the route sets managedDns=false, so the user creates the validation record */
  validation: "dns_automatic" | "dns_manual";
  zone?: string;
}

interface WorkloadCommon {
  /** Kubernetes namespace carried on the node so reads and operations need no graph. */
  namespace?: string;
  size: string;
  vcpu: number;
  memoryMb: number;
  artifact: ArtifactSpec;
  env: EnvEntry[];
  zones: number;
  subnetTier: "private";
  platformVersion?: string;
  shape?: string;
  ingress?: string;
}

export interface ContainerServiceSpec extends WorkloadCommon {
  workload: "web" | "worker";
  replicas: number;
  port?: number;
  healthPath?: string;
}

export interface ScheduledJobSpec extends WorkloadCommon {
  schedule?: string;
}

export interface StaticSiteSpec {
  namespace?: string;
  size: string;
  artifact: ArtifactSpec;
}

/** Declared attributes only, for a `referenced`/`external` service Zenith does not run. */
export interface ForeignServiceSpec {
  namespace?: string;
  workload: string;
  size: string;
  replicas?: number;
  port?: number;
  healthPath?: string;
}

export interface DataStoreCommon {
  namespace?: string;
  size: string;
  /** the manifest's kind-specific settings, verbatim */
  config?: Record<string, string | number | boolean>;
}

export interface ManagedDataCommon extends DataStoreCommon {
  deletionPolicy: "deny" | "approval" | "allow";
  encryption: true;
}

export interface PostgresSpec extends ManagedDataCommon {
  engine: "postgres";
  version: string;
  highAvailability: boolean;
  backup: "none" | "daily" | "hourly";
  /** master credentials are generated and held by the provider's secret store; never in the spec */
  credentials: "generated";
  subnetTier: "private";
  zones: number;
  instanceClass?: string;
  storageClass?: string;
}

export interface RedisSpec extends ManagedDataCommon {
  engine: "redis";
  highAvailability: boolean;
  backup: "none" | "daily" | "hourly";
  subnetTier: "private";
  zones: number;
  instanceClass?: string;
  storageClass?: string;
}

export interface ObjectStoreSpec extends ManagedDataCommon {
  versioning: boolean;
  publicAccess: false;
}

export type QueueSpec = ManagedDataCommon;

export interface SecretSpec {
  namespace?: string;
  /** the reference, never a value */
  secretRef: string;
  store: "zenith_vault" | "provider_secret_manager";
  purpose: "environment";
}

/** One least-privilege statement: exact target address, explicit verbs, no wildcard. */
export interface IdentityGrant {
  target: string;
  access: string[];
  /** why: `binding:<capability>`, `env:<KEY>`, `own_log_group`, `image_pull` */
  via: string[];
}

export interface IdentitySpec {
  namespace?: string;
  principal: "workload";
  workload: string;
  grants: IdentityGrant[];
}

export interface LogGroupSpec {
  workload: string;
  retentionDays: number;
}

export interface ContainerRegistrySpec {
  scanOnPush: true;
  immutableTags: false;
}

export interface BuildPipelineSpec {
  source: {
    repo: string;
    ref: string;
    dockerfile?: string;
    /** build context subdirectory inside the repository (monorepo root), relative and normalized; default the repository root */
    contextDir?: string;
    /** how the image is built; only `dockerfile` has an isolated builder, `buildpacks` is refused at admission */
    builder?: "dockerfile" | "buildpacks";
  };
  output: { registry: string } | { staticSite: string };
  /** builds run in the customer's account (ADR-0016) */
  location: "customer_account";
  /** build isolation inputs (PROD-LIFE-09); absent means the provider defaults, which release admission may refuse */
  isolation?: BuildIsolationSpec;
}

export interface BuildIsolationSpec {
  /** AWS: extra DNS names (port 443) a Dockerfile may reach besides the default package registries */
  allowedHosts?: string[];
  /** GCP: Cloud Build private worker pool resource name; Azure: ACR dedicated agent pool name */
  workerPool?: string;
}

/** Desired volume attributes; expansion does not emit volume nodes yet. */
export interface VolumeSpec {
  namespace?: string;
  sizeGb: number;
  storageClass?: string;
  accessModes?: ("ReadWriteOnce" | "ReadOnlyMany" | "ReadWriteMany" | "ReadWriteOncePod")[];
}
