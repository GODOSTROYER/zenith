/**
 * Resource model contract: desired, observed and runtime state (spec §6, §8).
 *
 * Three levels (ADR-0003):
 *   Level 1 — portable primitives (`PortableKind`), the vocabulary drivers,
 *             placement, cost, policy and incident traversal all speak.
 *   Level 2 — provider capabilities: which native service realizes a
 *             primitive (`nativeType`, e.g. `aws:ecs_service`,
 *             `gcp:cloud_run_service`, `k8s:Deployment`).
 *   Level 3 — the escape hatch: `providerNative` nodes carrying a provider,
 *             a native type and schema-validated config, never flattened into
 *             the portable model.
 *
 * The application manifest (V1, or V2 which is a strict superset) describes
 * an app: services, resources, routes and bindings, plus V2's placement,
 * constraints, policies and provider config. `expandManifest()` compiles it
 * into a `ResourceGraph` of portable primitives — the network, subnets,
 * firewall rules, load balancer, DNS records and certificates are DERIVED from
 * routes and bindings, not written by the user. Every derived node records the
 * manifest node(s) it came from (`origin`).
 *
 * Three states, never conflated:
 *   desired  — what the graph says (`ResourceNode.spec`)
 *   observed — what the provider's configuration API returned (`Observation`)
 *   runtime  — what is actually running right now (`RuntimeState`)
 * e.g. desired replicas 3 · observed ECS desiredCount 3 · runtime running 2,
 * pending 1, unhealthy 1. An attribute nobody read is `unknown`, never
 * "matches".
 */

/* --------------------------- Level 1: primitives -------------------------- */

export const PORTABLE_KINDS = [
  "network",
  "subnet",
  "firewall",
  "load_balancer",
  "dns_zone",
  "dns_record",
  "tls_certificate",
  "container_service",
  "container_registry",
  "compute_instance",
  "function",
  "static_site",
  "scheduled_job",
  "postgres",
  "mysql",
  "redis",
  "object_store",
  "queue",
  "pubsub",
  "secret",
  "identity",
  "log_group",
  "kubernetes_cluster",
  "kubernetes_namespace",
  "volume",
  "build_pipeline",
] as const;
export type PortableKind = (typeof PORTABLE_KINDS)[number];

/** Stateful kinds: destroying them destroys data that rollback cannot restore. */
export const STATEFUL_KINDS: readonly PortableKind[] = ["postgres", "mysql", "redis", "object_store", "queue", "pubsub", "volume", "secret"];

export type ProviderKey = "aws" | "gcp" | "azure" | "oci" | "kubernetes" | "zenith" | "sandbox" | "localstack";

/** How Zenith relates to a node. Ownership is explicit and never inferred. */
export type ResourceOwnership = "managed" | "referenced" | "external";

/* ------------------------------ desired graph ----------------------------- */

export interface ResourceNode {
  /**
   * Stable logical address within one environment, deterministic from the
   * manifest: e.g. `service/web`, `resource/db`, `network/main`,
   * `firewall/web-to-db`, `dns_record/app.example.com`. Addresses are how
   * OpenTofu addresses, observations and incidents are joined.
   */
  address: string;
  kind: PortableKind | "provider_native";
  provider: ProviderKey;
  region: string;
  /** Level 2: the native service realizing it, e.g. `aws:ecs_service` */
  nativeType: string;
  ownership: ResourceOwnership;
  /** for referenced/external nodes: the provider-side identifier (ARN, URL…) */
  externalRef?: string;
  /**
   * Desired configuration in portable terms (plus provider-specific keys under
   * `provider`). Values are plain JSON; secrets appear only as references
   * (`{ "secretRef": "vault:…" }`), never values.
   */
  spec: Record<string, unknown>;
  /** manifest node ids this primitive was derived from */
  origin: string[];
  /** addresses this node depends on (network before subnet before service…) */
  dependsOn: string[];
  /** stable content digest of { kind, provider, region, nativeType, ownership, spec } */
  specDigest: string;
  labels: Record<string, string>;
}

/** Directed edges used by incident traversal and ordering. */
export interface ResourceEdge {
  from: string;
  to: string;
  /** what flows: request traffic, data access, name resolution, … */
  relation: "routes_to" | "connects_to" | "resolves_to" | "secures" | "contains" | "reads_secret" | "publishes_to" | "consumes_from" | "depends_on";
  /** binding capability or port, when relevant */
  detail?: string;
}

export interface ResourceGraph {
  /** schema version of the graph shape */
  version: 1;
  environmentId: string;
  /** digest of the manifest it was expanded from */
  manifestDigest: string;
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  /** digest over nodes+edges (sorted), the graph's identity */
  graphDigest: string;
  /** explanations of derivations and defaults applied, for the plan UI */
  notes: string[];
}

/* -------------------------------- observed -------------------------------- */

/** One observed attribute. `unknown` carries why it was not read. */
export type ObservedValue<T = unknown> =
  | { state: "known"; value: T; observedAt: string }
  | { state: "unknown"; reason: "not_supported" | "not_inspected" | "access_denied" | "error" | "not_applicable"; detail?: string };

export type Presence = "present" | "missing" | "inaccessible" | "unknown";

export interface Observation {
  address: string;
  /** provider-side id (ARN, resource id) when found */
  externalId?: string;
  presence: Presence;
  /** portable attribute name → observed value (only what was actually read) */
  attributes: Record<string, ObservedValue>;
  /** bounded, redacted native response fields worth keeping (preserved, not normalized away) */
  native?: Record<string, unknown>;
  observedAt: string;
  /** driver id that produced it, e.g. `aws.ecs_service@1` */
  source: string;
  simulated: boolean;
  error?: string;
}

/* --------------------------------- runtime -------------------------------- */

export type HealthState = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface RuntimeState {
  address: string;
  health: HealthState;
  /** e.g. { desired: 3, running: 2, pending: 1, unhealthy: 1 } — only counts actually read */
  counts: Record<string, number>;
  /** short machine-readable reasons, e.g. `target_unhealthy:2`, `task_stopped:OutOfMemory` */
  signals: string[];
  observedAt: string;
  source: string;
  simulated: boolean;
}

/* ---------------------------------- drift --------------------------------- */

/**
 * Drift classes (spec §39). `unknown` and `inaccessible` are drift results,
 * not silence: a resource Zenith could not read is reported, not assumed fine.
 */
export type DriftClass = "missing" | "changed" | "extra" | "unknown" | "inaccessible";

export interface DriftFinding {
  address: string;
  class: DriftClass;
  severity: "low" | "medium" | "high";
  /** for `changed`: which attributes differ */
  fields?: { attribute: string; desired: unknown; observed: unknown }[];
  /** only managed resources are ever repair candidates */
  repairable: boolean;
  /** high-risk drift (stateful, identity, firewall-open) is never auto-repaired */
  autoRepairEligible: boolean;
  explanation: string;
}

export interface DriftReport {
  environmentId: string;
  graphDigest: string;
  computedAt: string;
  findings: DriftFinding[];
  /** addresses whose state could not be determined at all */
  unobserved: string[];
  simulated: boolean;
}
